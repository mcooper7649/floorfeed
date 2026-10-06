import { COLLECTIONS, EVM_COLLECTIONS, collectionName, isEvm } from "./config.ts";
import { toUsd } from "./prices.ts";
import { ensureSales, liveSymbols } from "./ingest.ts";
import { db } from "./db.ts";
import { getListings } from "./magiceden.ts";
import { collectionFlippers } from "./pnl.ts";

type CollectionRow = {
  symbol: string;
  chain: string;
  currency: string;
  owners: number | null;
  supply: number | null;
  volume_24h_ext: number | null;
  sales_24h_ext: number | null;
  volume_30d: number | null;
  external_url: string | null;
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

// Floor N hours ago = the newest snapshot at least that old (null until our
// own snapshot history reaches back that far).
const floorAt = db.prepare(
  `SELECT floor FROM collection_snapshots WHERE symbol = ? AND ts <= ? AND floor IS NOT NULL ORDER BY ts DESC LIMIT 1`,
);
function changePct(symbol: string, floor: number | null, hoursAgo: number) {
  if (floor == null) return null;
  const then = (floorAt.get(symbol, Date.now() - hoursAgo * 3_600_000) as { floor: number } | undefined)?.floor;
  return then ? ((floor - then) / then) * 100 : null;
}

// Markets list: Solana (Magic Eden) + EVM (OpenSea) collections in one shape.
// Amounts are in each collection's native currency, with USD for ranking.
export function listCollections() {
  const now = Math.floor(Date.now() / 1000);
  const live = new Set(liveSymbols());
  const sol = COLLECTIONS.map(({ symbol, category }) => {
    const c = (statsRow.get(symbol) as CollectionRow | undefined) ?? ({ symbol } as CollectionRow);
    const sales = salesSince.all(symbol, now - 14 * DAY) as { t: number; price: number }[];
    const w = window24h.get(symbol, now - DAY) as { n: number; vol: number };
    const floor = c.floor ?? null;
    const isLive = live.has(symbol);
    return {
      symbol,
      name: collectionName(symbol),
      chain: "solana" as const,
      currency: "SOL",
      source: "magiceden" as const,
      category,
      live: isLive,
      image: c.image ?? null,
      floor,
      floorUsd: toUsd(floor, "SOL"),
      listed: c.listed ?? null,
      owners: null,
      avg24h: c.avg_24h ?? null,
      volume7d: c.volume_7d ?? null,
      volume7dUsd: toUsd(c.volume_7d ?? null, "SOL"),
      change24hPct: changePct(symbol, floor, 24),
      change7dPct: changePct(symbol, floor, 24 * 7),
      // 24h sales are counted from ingested trades, so only exact for the live tier.
      sales24h: isLive ? w.n : null,
      volume24h: isLive ? w.vol : null,
      volume24hUsd: isLive ? toUsd(w.vol, "SOL") : null,
      spark: daily(sales).map((d) => ({ day: d.day, median: d.median })),
    };
  });
  const evm = EVM_COLLECTIONS.map(({ slug, name, chain, category }) => {
    const c = (statsRow.get(slug) as CollectionRow | undefined) ?? ({ symbol: slug } as CollectionRow);
    const floor = c.floor ?? null;
    const currency = c.currency && c.currency !== "SOL" ? c.currency : "ETH";
    return {
      symbol: slug,
      name,
      chain,
      currency,
      source: "opensea" as const,
      category,
      live: false,
      image: c.image ?? null,
      floor,
      floorUsd: toUsd(floor, currency),
      listed: null,
      owners: c.owners ?? null,
      avg24h: null,
      volume7d: c.volume_7d ?? null,
      volume7dUsd: toUsd(c.volume_7d ?? null, currency),
      change24hPct: changePct(slug, floor, 24),
      change7dPct: changePct(slug, floor, 24 * 7),
      sales24h: c.sales_24h_ext ?? null,
      volume24h: c.volume_24h_ext ?? null,
      volume24hUsd: toUsd(c.volume_24h_ext ?? null, currency),
      // No keyless sales history: the trend line is our own floor snapshots.
      spark: floorSpark(slug),
    };
  });
  return [...sol, ...evm].sort((a, b) => (b.volume7dUsd ?? 0) - (a.volume7dUsd ?? 0));
}

const snapshotsSince = db.prepare(
  `SELECT ts, floor FROM collection_snapshots WHERE symbol = ? AND ts >= ? AND floor IS NOT NULL ORDER BY ts`,
);
function floorSpark(symbol: string) {
  const rows = snapshotsSince.all(symbol, Date.now() - 14 * DAY * 1000) as { ts: number; floor: number }[];
  // A trend line over minutes of snapshots exaggerates noise; wait for 6h of history.
  if (rows.length < 2 || rows[rows.length - 1].ts - rows[0].ts < 6 * 3_600_000) return [];
  const step = Math.max(1, Math.ceil(rows.length / 24));
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
    .map((r) => ({ day: Math.floor(r.ts / 1000), median: r.floor }));
}

// EVM collection page: stats only (sales/listings need an OpenSea key).
function evmDetail(slug: string, rangeDays: number) {
  const meta = EVM_COLLECTIONS.find((c) => c.slug === slug)!;
  const c = (statsRow.get(slug) as CollectionRow | undefined) ?? ({ symbol: slug } as CollectionRow);
  const now = Math.floor(Date.now() / 1000);
  const currency = c.currency && c.currency !== "SOL" ? c.currency : "ETH";
  return {
    symbol: slug,
    name: meta.name,
    chain: meta.chain,
    currency,
    source: "opensea" as const,
    externalUrl: c.external_url ?? `https://opensea.io/collection/${slug}`,
    category: meta.category,
    live: false,
    image: c.image ?? null,
    description: c.description ?? null,
    stats: {
      floor: c.floor ?? null,
      listed: null,
      avg24h: null,
      volume7d: c.volume_7d ?? null,
      sales24h: c.sales_24h_ext ?? 0,
      volume24h: c.volume_24h_ext ?? 0,
      owners: c.owners ?? null,
      supply: c.supply ?? null,
      volume30d: c.volume_30d ?? null,
      floorUsd: toUsd(c.floor ?? null, currency),
    },
    rangeDays,
    asOf: now,
    historyStartsAt: null,
    sales: [],
    daily: [],
    floorHistory: snapshotsSince.all(slug, (now - rangeDays * DAY) * 1000),
    listings: [],
    topFlippers: [],
    recentSales: [],
  };
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
  if (isEvm(symbol)) return evmDetail(symbol, rangeDays);
  if (!COLLECTIONS.some((c) => c.symbol === symbol)) return null;
  // Non-live collections: fetch recent sales now, but never hold the page
  // more than a few seconds if the API queue is busy.
  await Promise.race([ensureSales(symbol), new Promise((r) => setTimeout(r, 6000))]);
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
    chain: "solana" as const,
    currency: "SOL",
    source: "magiceden" as const,
    externalUrl: `https://magiceden.io/marketplace/${symbol}`,
    category: COLLECTIONS.find((x) => x.symbol === symbol)!.category,
    live: liveSymbols().includes(symbol),
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
