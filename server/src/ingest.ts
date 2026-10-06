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
const setMeta = db.prepare(`UPDATE collections SET image = ?, description = ? WHERE symbol = ?`);

// Live tier = top collections by current 7-day volume (static order until stats exist).
const byVolume = db.prepare(`SELECT symbol FROM collections ORDER BY COALESCE(volume_7d, 0) DESC`);
export function liveSymbols(): string[] {
  const ranked = (byVolume.all() as { symbol: string }[]).map((r) => r.symbol)
    .filter((s) => COLLECTIONS.some((c) => c.symbol === s));
  const order = ranked.length >= LIVE_TIER_SIZE ? ranked : COLLECTIONS.map((c) => c.symbol);
  return order.slice(0, LIVE_TIER_SIZE);
}

export async function refreshStats() {
  let metaBudget = 3; // drip-fill missing images: the metadata endpoint 429s easily
  for (const { symbol } of COLLECTIONS) {
    try {
      const stats = await getStats(symbol);
      const now = Date.now();
      upsertStats.run({ symbol, ...stats, now });
      // Magic Eden has no public floor history, so we build our own.
      insertSnapshot.run(symbol, now, stats.floor, stats.listed);
      if (metaBudget > 0 && (needsMeta.get(symbol) as { missing: number } | undefined)?.missing) {
        metaBudget--;
        // Metadata is cosmetic and its endpoint is heavily rate-limited: one try.
        await getCollectionMeta(symbol)
          .then((meta) => setMeta.run(meta.image, meta.description, symbol))
          .catch(() => {});
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

export async function refreshSales() {
  let added = 0;
  for (const symbol of liveSymbols()) {
    try {
      added += saveSales(symbol, await getSales(symbol));
    } catch (err) {
      console.warn(`[sales] ${symbol}:`, (err as Error).message);
    }
  }
  if (added) console.log(`[sales] +${added} trades`);
}

// One-time history fill so collection charts have ~a month of sales from day one.
// The public API pages back to offset ~500; collections already filled are skipped.
const BACKFILL_TARGET = 400;
const countFor = db.prepare(`SELECT COUNT(*) n FROM trades WHERE collection = ?`);

async function backfillOne(symbol: string, priority: number = PRIORITY.background) {
  if ((countFor.get(symbol) as { n: number }).n >= BACKFILL_TARGET) return;
  let added = 0;
  for (let offset = 100; offset <= 500; offset += 100) {
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

export async function backfillSales() {
  for (const symbol of liveSymbols()) await backfillOne(symbol);
}

// Collections outside the live tier get sales when someone opens them: the
// latest page right away (user priority), deeper history in the background.
const lastOnDemand = new Map<string, number>();
export async function ensureSales(symbol: string) {
  if (liveSymbols().includes(symbol)) return;
  const at = lastOnDemand.get(symbol) ?? 0;
  if (Date.now() - at < 10 * 60_000) return;
  lastOnDemand.set(symbol, Date.now());
  try {
    const n = saveSales(symbol, await getSales(symbol, 100, 0, PRIORITY.user));
    if (n) console.log(`[on-demand] ${symbol}: +${n}`);
  } catch (err) {
    console.warn(`[on-demand] ${symbol}:`, (err as Error).message);
    lastOnDemand.delete(symbol);
    return;
  }
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
  `UPDATE collections SET image = ?, description = ?, supply = ?, external_url = ? WHERE symbol = ?`,
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
