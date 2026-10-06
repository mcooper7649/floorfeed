import { COLLECTIONS, collectionName } from "./config.ts";
import { db } from "./db.ts";
import { getListings } from "./magiceden.ts";
import { collectionFlippers } from "./pnl.ts";

type CollectionRow = {
  symbol: string;
  floor: number | null;
  listed: number | null;
  avg_24h: number | null;
  volume_7d: number | null;
  image: string | null;
  description: string | null;
};

const DAY = 86_400;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Group sales into UTC days: low / median / high / count per day.
function daily(sales: { t: number; price: number }[]) {
  const byDay = new Map<number, number[]>();
  for (const s of sales) {
    const d = Math.floor(s.t / DAY) * DAY;
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s.price);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, ps]) => ({ day, low: Math.min(...ps), median: median(ps), high: Math.max(...ps), count: ps.length }));
}

const salesSince = db.prepare(
  `SELECT signature, mint, buyer, seller, price, block_time AS t, image
   FROM trades WHERE collection = ? AND block_time >= ? ORDER BY block_time`,
);
// Falls back to the newest sale's NFT image when collection metadata is missing.
const statsRow = db.prepare(`
  SELECT c.*, COALESCE(c.image,
    (SELECT image FROM trades WHERE collection = c.symbol AND image IS NOT NULL
     ORDER BY block_time DESC LIMIT 1)) AS image
  FROM collections c WHERE c.symbol = ?`);
const window24h = db.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS vol FROM trades WHERE collection = ? AND block_time >= ?`,
);

// Markets list: one row per tracked collection with a 14-day median sparkline.
export function listCollections() {
  const now = Math.floor(Date.now() / 1000);
  return COLLECTIONS.map(({ symbol }) => {
    const c = (statsRow.get(symbol) as CollectionRow | undefined) ?? ({ symbol } as CollectionRow);
    const sales = salesSince.all(symbol, now - 14 * DAY) as { t: number; price: number }[];
    const w = window24h.get(symbol, now - DAY) as { n: number; vol: number };
    return {
      symbol,
      name: collectionName(symbol),
      image: c.image ?? null,
      floor: c.floor ?? null,
      listed: c.listed ?? null,
      volume7d: c.volume_7d ?? null,
      sales24h: w.n,
      volume24h: w.vol,
      spark: daily(sales).map((d) => ({ day: d.day, median: d.median })),
    };
  }).sort((a, b) => (b.volume7d ?? 0) - (a.volume7d ?? 0));
}

// Listings change constantly but the API is rate-limited: cache per collection.
const listingCache = new Map<string, { at: number; data: { mint: string; price: number }[] }>();
async function cheapestListings(symbol: string) {
  const hit = listingCache.get(symbol);
  if (hit && Date.now() - hit.at < 120_000) return hit.data;
  try {
    const data = await getListings(symbol, 20);
    listingCache.set(symbol, { at: Date.now(), data });
    return data;
  } catch {
    return hit?.data ?? [];
  }
}

export async function collectionDetail(symbol: string, rangeDays: number) {
  if (!COLLECTIONS.some((c) => c.symbol === symbol)) return null;
  const now = Math.floor(Date.now() / 1000);
  const c = (statsRow.get(symbol) as CollectionRow | undefined) ?? ({ symbol } as CollectionRow);
  const sales = salesSince.all(symbol, now - rangeDays * DAY) as {
    signature: string; mint: string; buyer: string; seller: string; price: number; t: number; image: string | null;
  }[];
  const w = window24h.get(symbol, now - DAY) as { n: number; vol: number };
  const firstTracked = (db.prepare(`SELECT MIN(block_time) t FROM trades WHERE collection = ?`).get(symbol) as { t: number | null }).t;

  return {
    symbol,
    name: collectionName(symbol),
    image: c.image ?? null,
    description: c.description ?? null,
    stats: {
      floor: c.floor ?? null,
      listed: c.listed ?? null,
      avg24h: c.avg_24h ?? null,
      volume7d: c.volume_7d ?? null,
      sales24h: w.n,
      volume24h: w.vol,
    },
    rangeDays,
    asOf: now,
    historyStartsAt: firstTracked,
    sales: sales.map(({ signature, price, t }) => ({ signature, price, t })),
    daily: daily(sales),
    floorHistory: db.prepare(
      `SELECT ts, floor FROM collection_snapshots WHERE symbol = ? AND ts >= ? ORDER BY ts`,
    ).all(symbol, (now - rangeDays * DAY) * 1000),
    listings: await cheapestListings(symbol),
    topFlippers: collectionFlippers(symbol, 5),
    recentSales: sales.slice(-15).reverse(),
  };
}
