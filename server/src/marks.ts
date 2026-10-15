import { config } from "./config.ts";
import { db } from "./db.ts";
import { markHot } from "./ingest.ts";
import { unitOf } from "./units.ts";

// Live values for the portfolio panel. The app fetches a wallet's holdings
// rarely (that's the costly marketplace call) and polls this often: it reads
// only what ingest already keeps in the database (floors, floor history,
// sales), so it makes no outside API calls. Asking also marks the collections
// "hot" so ingest refreshes their floors every 2 minutes while a panel is open.

const row = db.prepare("SELECT floor, updated_at FROM collections WHERE symbol = ?");
const dayAgo = db.prepare("SELECT floor FROM collection_snapshots WHERE symbol = ? AND ts <= ? AND floor IS NOT NULL ORDER BY ts DESC LIMIT 1");
const lastSale = db.prepare("SELECT price, block_time FROM trades WHERE collection = ? ORDER BY block_time DESC LIMIT 1");
const salesSince = db.prepare("SELECT COUNT(*) n FROM trades WHERE collection = ? AND block_time >= ?");

export type Mark = {
  unit: string;
  floor: number | null;
  value: number | null;      // what one NFT is worth here: floor minus the sell haircut (est. bid), as holdings use
  change24h: number | null;  // floor vs 24h ago, percent
  updatedAt: number | null;  // when the floor was last read (ms)
  lastSale: { price: number; at: number } | null; // latest sale in the collection (at: unix seconds)
  sales24h: number;          // sales in the last 24h (the panel pulses when it grows)
};

export function marks(symbols: string[]): Record<string, Mark> {
  const uniq = [...new Set(symbols)].slice(0, 100);
  markHot(uniq);
  const now = Date.now();
  const out: Record<string, Mark> = {};
  for (const s of uniq) {
    const c = row.get(s) as { floor: number | null; updated_at: number | null } | undefined;
    if (!c) continue;
    const before = (dayAgo.get(s, now - 24 * 3_600_000) as { floor: number } | undefined)?.floor ?? null;
    const sale = lastSale.get(s) as { price: number; block_time: number } | undefined;
    out[s] = {
      unit: unitOf(s),
      floor: c.floor,
      value: c.floor != null ? c.floor * (1 - config.paperSellHaircut) : null,
      change24h: c.floor != null && before ? ((c.floor - before) / before) * 100 : null,
      updatedAt: c.updated_at,
      lastSale: sale ? { price: sale.price, at: sale.block_time } : null,
      sales24h: (salesSince.get(s, Math.floor(now / 1000) - 86_400) as { n: number }).n,
    };
  }
  return out;
}
