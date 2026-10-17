import { COLLECTIONS, EVM_CHAINS, EVM_COLLECTIONS, EVM_SALES, LIVE_TIER_SIZE, config, normalizeUnit } from "./config.ts";
import { invalidateUnits } from "./units.ts";
import { db } from "./db.ts";
import { PRIORITY, getCollectionMeta, getSales, getStats, type MeActivity } from "./magiceden.ts";
import { discoverEvm, discoverFresh } from "./discovery.ts";
import { enrichFees } from "./fees.ts";
import { getOsInfo, getOsSales, getOsStats, hasOsKey, type OsSale } from "./opensea.ts";
import { refreshPrices, usdPrice } from "./prices.ts";

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO trades
    (signature, collection, mint, buyer, seller, price, block_time, image, source)
  VALUES (@signature, @collection, @mint, @buyer, @seller, @price, @blockTime, @image, @source)
`);

const upsertStats = db.prepare(`
  INSERT INTO collections (symbol, floor, listed, avg_24h, volume_7d, updated_at)
  VALUES (@symbol, @floor, @listed, @avg24h, @volume7d, @now)
  ON CONFLICT(symbol) DO UPDATE SET floor=excluded.floor, listed=excluded.listed,
    avg_24h=excluded.avg_24h, volume_7d=excluded.volume_7d, updated_at=excluded.updated_at
`);

const insertSnapshot = db.prepare(
  `INSERT OR IGNORE INTO collection_snapshots (symbol, ts, floor, listed) VALUES (?, ?, ?, ?)`,
);
// EVM: art missing, or fees not read yet (fees.ts)
const needsInfo = db.prepare(`SELECT image IS NULL AS missing, seller_fee_bps IS NULL OR contract IS NULL OR created_ext IS NULL AS noFees FROM collections WHERE symbol = ?`);
const setSellerFee = db.prepare(`UPDATE collections SET seller_fee_bps = ? WHERE symbol = ?`);
const setLinks = db.prepare(`UPDATE collections SET website = ?, twitter = ?, discord = ?, contract = ?, created_ext = COALESCE(?, '') WHERE symbol = ?`);

// Official metadata (logo, description) for Solana collections. Magic Eden's
// metadata endpoint rate-limits hard, so each collection is retried on a
// backoff (1 day, doubling to a week) instead of every stats cycle.
const DAY_MS = 86_400_000;
const metaState = db.prepare(
  `SELECT image_source AS source, meta_checked_at AS checkedAt, meta_failures AS failures FROM collections WHERE symbol = ?`,
);
const setOfficialMeta = db.prepare(`
  UPDATE collections SET image = COALESCE(?, image), description = COALESCE(?, description),
    image_source = CASE WHEN ? IS NOT NULL THEN 'official' ELSE image_source END,
    meta_checked_at = ?, meta_failures = 0
  WHERE symbol = ?`);
const markMetaFailed = db.prepare(
  `UPDATE collections SET meta_checked_at = ?, meta_failures = meta_failures + 1 WHERE symbol = ?`,
);
function metaDue(symbol: string, now: number) {
  const m = metaState.get(symbol) as { source: string | null; checkedAt: number | null; failures: number } | undefined;
  if (!m || m.source === "official") return false;
  if (m.checkedAt == null) return true;
  return now - m.checkedAt >= Math.min(DAY_MS * 2 ** Math.max(0, m.failures - 1), 7 * DAY_MS);
}

// Until official art arrives, pin one recent sale's image so the collection
// keeps a stable picture (no API call: it comes from stored trades).
const fillSaleImages = db.prepare(`
  UPDATE collections SET image_source = 'sale', image = (
    SELECT image FROM trades WHERE collection = collections.symbol AND image IS NOT NULL
    ORDER BY block_time DESC LIMIT 1)
  WHERE image IS NULL AND chain = 'solana'
    AND EXISTS (SELECT 1 FROM trades WHERE collection = collections.symbol AND image IS NOT NULL)`);

// Live tier = top collections by current 7-day volume (static order until stats exist).
const byVolume = db.prepare(`SELECT symbol FROM collections ORDER BY COALESCE(volume_7d, 0) DESC`);
export function liveSymbols(): string[] {
  const ranked = (byVolume.all() as { symbol: string }[]).map((r) => r.symbol)
    .filter((s) => COLLECTIONS.some((c) => c.symbol === s));
  const order = ranked.length >= LIVE_TIER_SIZE ? ranked : COLLECTIONS.map((c) => c.symbol);
  return order.slice(0, LIVE_TIER_SIZE);
}

export async function refreshStats() {
  fillSaleImages.run();
  let metaBudget = 3; // at most a few metadata calls per cycle, on top of the backoff
  for (const { symbol } of COLLECTIONS) {
    try {
      const stats = await getStats(symbol);
      const now = Date.now();
      upsertStats.run({ symbol, ...stats, now });
      // Magic Eden has no public floor history, so we build our own.
      insertSnapshot.run(symbol, now, stats.floor, stats.listed);
      if (metaBudget > 0 && metaDue(symbol, now)) {
        metaBudget--;
        // One try per due collection; a failure pushes the next try out.
        await getCollectionMeta(symbol)
          .then((meta) => setOfficialMeta.run(meta.image, meta.description, meta.image, now, symbol))
          .catch((err: Error) => {
            markMetaFailed.run(now, symbol);
            console.warn(`[meta] ${symbol}: ${err.message} (will retry later)`);
          });
      }
    } catch (err) {
      console.warn(`[stats] ${symbol}:`, (err as Error).message);
    }
  }
}

function saveSales(symbol: string, rows: MeActivity[]) {
  let added = 0;
  for (const a of rows) {
    added += insertTrade.run({
      signature: a.signature,
      collection: symbol,
      mint: a.tokenMint,
      buyer: a.buyer,
      seller: a.seller,
      price: a.price,
      blockTime: a.blockTime,
      image: a.image ?? null,
      source: a.source ?? null,
    }).changes;
  }
  return added;
}

// Collections outside the live tier, refreshed a couple per poll in
// rotation (each about every 30 min) so their charts don't go stale.
const ROTATE_PER_POLL = 2;
let rotation = 0;
const restSymbols = () => {
  const live = new Set(liveSymbols());
  return COLLECTIONS.map((c) => c.symbol).filter((s) => !live.has(s));
};

export async function refreshSales() {
  let added = 0;
  for (const symbol of liveSymbols()) {
    try {
      added += saveSales(symbol, await getSales(symbol));
    } catch (err) {
      console.warn(`[sales] ${symbol}:`, (err as Error).message);
    }
  }
  const rest = restSymbols();
  for (let i = 0; i < ROTATE_PER_POLL && rest.length; i++) {
    const symbol = rest[rotation++ % rest.length];
    added += await catchUp(symbol, PRIORITY.background);
  }
  if (added) console.log(`[sales] +${added} trades`);
}

// Newest sales first, paging back until a page overlaps what's stored
// (or the API's ~500 offset limit), so there's no gap after a quiet spell.
async function catchUp(symbol: string, priority: number) {
  let added = 0;
  for (let offset = 0; offset <= 500; offset += 100) {
    try {
      const rows = await getSales(symbol, 100, offset, priority);
      const n = saveSales(symbol, rows);
      added += n;
      if (rows.length < 100 || n < rows.length) break;
    } catch (err) {
      console.warn(`[sales] ${symbol}@${offset}:`, (err as Error).message);
      break;
    }
  }
  return added;
}

// One-time history fill so collection charts have ~a month of sales from day one.
// The public API pages back to offset ~500; collections already filled are skipped.
const BACKFILL_TARGET = 400;
const countFor = db.prepare(`SELECT COUNT(*) n FROM trades WHERE collection = ?`);

async function backfillOne(symbol: string, priority: number = PRIORITY.background) {
  if ((countFor.get(symbol) as { n: number }).n >= BACKFILL_TARGET) return;
  let added = 0;
  for (let offset = 0; offset <= 500; offset += 100) {
    try {
      const rows = await getSales(symbol, 100, offset, priority);
      if (!rows.length) break;
      added += saveSales(symbol, rows);
    } catch (err) {
      console.warn(`[backfill] ${symbol}@${offset}:`, (err as Error).message);
      break;
    }
  }
  console.log(`[backfill] ${symbol}: +${added}`);
}

// Live tier first, then every other Solana collection, so a chart has
// history before anyone opens it.
export async function backfillSales() {
  for (const symbol of liveSymbols()) await backfillOne(symbol);
  for (const symbol of restSymbols()) await backfillOne(symbol);
}

// Collections outside the live tier get sales when someone opens them: the
// latest page right away (user priority), deeper history in the background.
const lastOnDemand = new Map<string, number>();
export async function ensureSales(symbol: string) {
  if (liveSymbols().includes(symbol)) return;
  const at = lastOnDemand.get(symbol) ?? 0;
  if (Date.now() - at < 10 * 60_000) return;
  lastOnDemand.set(symbol, Date.now());
  const n = await catchUp(symbol, PRIORITY.user);
  if (n) console.log(`[on-demand] ${symbol}: +${n}`);
  else if (!(countFor.get(symbol) as { n: number }).n) lastOnDemand.delete(symbol); // failed: let the next visit retry
  void backfillOne(symbol, PRIORITY.prefetch);
}

// EVM collections: OpenSea stats (floor, owners, 24h/7d/30d volume) + one-time info.
const upsertEvm = db.prepare(`
  INSERT INTO collections (symbol, chain, currency, floor, owners, volume_7d, volume_24h_ext,
                           sales_24h_ext, volume_30d, updated_at)
  VALUES (@symbol, @chain, @currency, @floor, @owners, @volume7d, @volume24h, @sales24h, @volume30d, @now)
  ON CONFLICT(symbol) DO UPDATE SET chain=excluded.chain, currency=excluded.currency, floor=excluded.floor,
    owners=excluded.owners, volume_7d=excluded.volume_7d, volume_24h_ext=excluded.volume_24h_ext,
    sales_24h_ext=excluded.sales_24h_ext, volume_30d=excluded.volume_30d, updated_at=excluded.updated_at`);
const setEvmInfo = db.prepare(
  `UPDATE collections SET image = ?, description = ?, supply = ?, external_url = ?, image_source = 'official' WHERE symbol = ?`,
);

// OpenSea quotes a collection's floor in its floor currency but its volumes
// in ETH on every chain (Hypurr's weekly "574" is ETH, not HYPE). Put both in
// the collection's sale unit at current USD prices, so charts, flips and
// "vs floor" compare like with like (Axie: floor in RON, sales in WETH).
function inSaleUnit(slug: string, st: Awaited<ReturnType<typeof getOsStats>>) {
  const quoted = normalizeUnit(st.currency) ?? st.currency;
  const unit = (unitRow.get(slug) as { sale_currency: string | null } | undefined)?.sale_currency ?? quoted;
  const rate = (from: string) => {
    if (from === unit) return 1;
    const a = usdPrice(from), b = usdPrice(unit);
    return a && b ? a / b : null;
  };
  const fk = rate(quoted), vk = rate("ETH");
  const conv = (v: number | null, k: number | null) => (v == null || k == null ? null : v * k);
  return {
    ...st, currency: unit,
    floor: fk == null ? st.floor : conv(st.floor, fk),
    volume24h: conv(st.volume24h, vk), volume7d: conv(st.volume7d, vk), volume30d: conv(st.volume30d, vk),
  };
}

export async function refreshEvmStats() {
  for (const c of [...EVM_COLLECTIONS]) { // copy: discovery may update the list mid-loop
    try {
      const raw = await getOsStats(c.slug);
      const st = inSaleUnit(c.slug, raw);
      const now = Date.now();
      upsertEvm.run({ symbol: c.slug, chain: c.chain, ...st, now });
      insertSnapshot.run(c.slug, now, st.floor, null);
      const need = needsInfo.get(c.slug) as { missing: number; noFees: number } | undefined;
      if (need?.missing || need?.noFees) {
        const info = await getOsInfo(c.slug);
        setEvmInfo.run(info.image, info.description, info.supply, info.url, c.slug);
        setSellerFee.run(info.feeBps, c.slug);
        setLinks.run(info.website, info.twitter, info.discord, info.contract, info.created, c.slug);
      }
    } catch (err) {
      console.warn(`[opensea] ${c.slug}:`, (err as Error).message);
    }
  }
}

// EVM sales from OpenSea (needs OPENSEA_API_KEY). The first run backfills
// 30 days per collection; after that each poll asks only for sales newer
// than the latest one stored.
const EVM_BACKFILL_DAYS = 30;
const latestFor = db.prepare(`SELECT MAX(block_time) t FROM trades WHERE collection = ?`);
const oldestFor = db.prepare(`SELECT MIN(block_time) t FROM trades WHERE collection = ?`);

// Each EVM collection keeps its P&L in one currency: whatever most of its
// first page of sales was paid in (among the chain's allowed units). Sales in
// any other currency are skipped, so a flip's buy and sell always share a unit.
const unitRow = db.prepare(`SELECT sale_currency FROM collections WHERE symbol = ?`);
// Creates the collection row if stats haven't yet (a newly discovered
// collection can get sales first), so the choice sticks for later pages.
const setUnit = db.prepare(`
  INSERT INTO collections (symbol, chain, currency, sale_currency, updated_at) VALUES (@slug, @chain, @unit, @unit, @now)
  ON CONFLICT(symbol) DO UPDATE SET sale_currency = excluded.sale_currency`);
function collectionUnit(slug: string, sample: OsSale[]) {
  const known = (unitRow.get(slug) as { sale_currency: string | null } | undefined)?.sale_currency;
  if (known) return known;
  const chain = EVM_COLLECTIONS.find((c) => c.slug === slug)?.chain;
  const allowed = chain && chain !== "solana" ? EVM_CHAINS[chain].units : ["ETH"];
  const counts = new Map<string, number>();
  for (const s of sample) if (allowed.includes(s.unit)) counts.set(s.unit, (counts.get(s.unit) ?? 0) + 1);
  const pick = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!pick) return null;
  setUnit.run({ slug, chain: chain ?? "ethereum", unit: pick, now: Date.now() });
  invalidateUnits();
  return pick;
}

function saveOsSales(slug: string, all: OsSale[]) {
  const unit = collectionUnit(slug, all);
  if (!unit) return 0;
  const rows = all.filter((a) => a.unit === unit);
  let added = 0;
  db.transaction(() => {
    for (const a of rows) {
      added += insertTrade.run({
        signature: a.signature, collection: slug, mint: a.mint, buyer: a.buyer, seller: a.seller,
        price: a.price, blockTime: a.blockTime, image: a.image, source: a.source,
      }).changes;
    }
  })();
  return added;
}

// Pages back from now (or from `after`) until `until`, a page that is all
// duplicates, or the end. `maxPages` caps very busy collections.
async function pageOsSales(slug: string, opts: { after?: number; until: number; maxPages: number }) {
  let next: string | undefined;
  let added = 0;
  for (let page = 0; page < opts.maxPages; page++) {
    const r = await getOsSales(slug, { after: opts.after, next });
    const n = saveOsSales(slug, r.sales);
    added += n;
    if (!r.next || r.oldest == null || r.oldest < opts.until) break;
    next = r.next;
  }
  return added;
}

export async function refreshEvmSales() {
  if (!hasOsKey()) return;
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  for (const c of [...EVM_SALES]) {
    try {
      const latest = (latestFor.get(c.slug) as { t: number | null }).t;
      added += latest
        ? await pageOsSales(c.slug, { after: latest - 60, until: latest - 60, maxPages: 20 })
        : await pageOsSales(c.slug, { until: now - EVM_BACKFILL_DAYS * 86_400, maxPages: 60 });
    } catch (err) {
      console.warn(`[os-sales] ${c.slug}:`, (err as Error).message);
    }
  }
  if (added) console.log(`[os-sales] +${added} trades`);
}

// Collections whose first backfill stopped short (busy ones hit the page cap)
// get one more stretch of history per day until 30 days are covered.
export async function deepenEvmSales() {
  if (!hasOsKey()) return;
  const target = Math.floor(Date.now() / 1000) - EVM_BACKFILL_DAYS * 86_400;
  for (const c of [...EVM_SALES]) {
    const oldest = (oldestFor.get(c.slug) as { t: number | null }).t;
    if (oldest == null || oldest <= target + 86_400) continue;
    try {
      // `next` cursors can't start mid-history, so page from the top; stored pages are skipped cheaply.
      const n = await pageOsSales(c.slug, { until: target, maxPages: 120 });
      if (n) console.log(`[os-sales] ${c.slug}: +${n} older`);
    } catch (err) {
      console.warn(`[os-sales] ${c.slug} (deepen):`, (err as Error).message);
    }
  }
}

function every(ms: number, fn: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await fn(); } finally { running = false; }
  };
  void tick();
  setInterval(tick, ms);
}

// Collections someone has open in a portfolio panel (marks.ts) refresh every
// 2 minutes instead of every 10. The cost scales with distinct held
// collections, not with viewers, and is capped per pass. No snapshot rows, so
// chart history keeps its usual spacing.
const hot = new Map<string, number>(); // symbol -> when a panel last asked (ms)
const HOT_TTL = 10 * 60_000, HOT_EVERY = 2 * 60_000, HOT_MAX = 20;
const updatedAt = db.prepare("SELECT updated_at FROM collections WHERE symbol = ?");
export function markHot(symbols: string[]) {
  const now = Date.now();
  for (const s of symbols) hot.set(s, now);
}
async function refreshHot() {
  const now = Date.now();
  const due = [...hot].filter(([s, t]) => {
    if (now - t > HOT_TTL) { hot.delete(s); return false; }
    const u = (updatedAt.get(s) as { updated_at: number | null } | undefined)?.updated_at ?? 0;
    return now - u >= HOT_EVERY - 15_000;
  }).slice(0, HOT_MAX);
  for (const [symbol] of due) {
    const evm = EVM_COLLECTIONS.find((c) => c.slug === symbol);
    try {
      if (evm) upsertEvm.run({ symbol, chain: evm.chain, ...inSaleUnit(symbol, await getOsStats(symbol)), now: Date.now() });
      else if (COLLECTIONS.some((c) => c.symbol === symbol)) upsertStats.run({ symbol, ...(await getStats(symbol)), now: Date.now() });
    } catch (err) {
      console.warn(`[hot] ${symbol}:`, (err as Error).message);
    }
  }
}

export function startIngest() {
  every(HOT_EVERY, refreshHot);
  every(config.statsPollMs, refreshPrices);
  every(24 * 3_600_000, discoverEvm);
  // Newly minted projects that already trade; after the daily pass has claimed what it tracks.
  setTimeout(() => every(3 * 3_600_000, discoverFresh), 10 * 60_000).unref();
  every(config.statsPollMs, refreshEvmStats);
  every(config.activityPollMs, refreshEvmSales);
  // After the first backfill has had time to run.
  setTimeout(() => every(24 * 3_600_000, deepenEvmSales), 3_600_000).unref();
  every(config.statsPollMs, refreshStats);
  // Exact fees for Solana trades (Helius); the backlog drains 1,000 trades a pass.
  setTimeout(() => every(5 * 60_000, () => enrichFees(10)), 2 * 60_000).unref();
  // Backfill runs after the first live poll, through the same rate-limited queue.
  every(config.activityPollMs, (() => {
    let first = true;
    return async () => {
      await refreshSales();
      if (first) { first = false; void backfillSales(); }
    };
  })());
}
