import { COLLECTIONS, config } from "./config.ts";
import { db } from "./db.ts";
import { getCollectionMeta, getSales, getStats, type MeActivity } from "./magiceden.ts";

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

export async function refreshStats() {
  for (const { symbol } of COLLECTIONS) {
    try {
      const stats = await getStats(symbol);
      const now = Date.now();
      upsertStats.run({ symbol, ...stats, now });
      // Magic Eden has no public floor history, so we build our own.
      insertSnapshot.run(symbol, now, stats.floor, stats.listed);
      if ((needsMeta.get(symbol) as { missing: number } | undefined)?.missing) {
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
  for (const { symbol } of COLLECTIONS) {
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

export async function backfillSales() {
  for (const { symbol } of COLLECTIONS) {
    if ((countFor.get(symbol) as { n: number }).n >= BACKFILL_TARGET) continue;
    let added = 0;
    for (let offset = 100; offset <= 500; offset += 100) {
      try {
        const rows = await getSales(symbol, 100, offset);
        if (!rows.length) break;
        added += saveSales(symbol, rows);
      } catch (err) {
        console.warn(`[backfill] ${symbol}@${offset}:`, (err as Error).message);
        break;
      }
    }
    console.log(`[backfill] ${symbol}: +${added}`);
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
