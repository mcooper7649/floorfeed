import { COLLECTIONS, EVM_COLLECTIONS, LIVE_TIER_SIZE, config } from "./config.ts";
import { db } from "./db.ts";
import { PRIORITY, getCollectionMeta, getSales, getStats, type MeActivity } from "./magiceden.ts";
import { getOsInfo, getOsStats } from "./opensea.ts";
import { refreshPrices } from "./prices.ts";

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
const needsMeta = db.prepare(`SELECT image IS NULL AS missing FROM collections WHERE symbol = ?`);

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

export async function refreshEvmStats() {
  for (const c of EVM_COLLECTIONS) {
    try {
      const st = await getOsStats(c.slug);
      const now = Date.now();
      upsertEvm.run({ symbol: c.slug, chain: c.chain, ...st, now });
      insertSnapshot.run(c.slug, now, st.floor, null);
      if ((needsMeta.get(c.slug) as { missing: number } | undefined)?.missing) {
        const info = await getOsInfo(c.slug);
        setEvmInfo.run(info.image, info.description, info.supply, info.url, c.slug);
      }
    } catch (err) {
      console.warn(`[opensea] ${c.slug}:`, (err as Error).message);
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

export function startIngest() {
  every(config.statsPollMs, refreshPrices);
  every(config.statsPollMs, refreshEvmStats);
  every(config.statsPollMs, refreshStats);
  // Backfill runs after the first live poll, through the same rate-limited queue.
  every(config.activityPollMs, (() => {
    let first = true;
    return async () => {
      await refreshSales();
      if (first) { first = false; void backfillSales(); }
    };
  })());
}
