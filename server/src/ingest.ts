import { COLLECTIONS, config } from "./config.ts";
import { db } from "./db.ts";
import { getSales, getStats } from "./magiceden.ts";

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

export async function refreshStats() {
  for (const { symbol } of COLLECTIONS) {
    try {
      upsertStats.run({ symbol, ...(await getStats(symbol)), now: Date.now() });
    } catch (err) {
      console.warn(`[stats] ${symbol}:`, (err as Error).message);
    }
  }
}

export async function refreshSales() {
  let added = 0;
  for (const { symbol } of COLLECTIONS) {
    try {
      for (const a of await getSales(symbol)) {
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
    } catch (err) {
      console.warn(`[sales] ${symbol}:`, (err as Error).message);
    }
  }
  if (added) console.log(`[sales] +${added} trades`);
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
  every(config.activityPollMs, refreshSales);
}
