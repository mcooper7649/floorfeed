import { db } from "./db.ts";

// P&L is computed from trades we've ingested ("tracked window"), gross of
// marketplace fees and royalties. A flip = a wallet selling a mint it bought.
export type WalletStats = {
  wallet: string;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number;
  buys: number;
  volumeSol: number;
  openPositions: number;
  unrealizedSol: number; // open positions marked at current floor
};

const flipsSql = `
  SELECT s.seller AS wallet, s.price - b.price AS pnl
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
`;

const openSql = `
  SELECT b.buyer AS wallet, COUNT(*) AS n, SUM(c.floor - b.price) AS unrealized
  FROM trades b
  JOIN collections c ON c.symbol = b.collection
  WHERE NOT EXISTS (
    SELECT 1 FROM trades s
    WHERE s.mint = b.mint AND s.seller = b.buyer AND s.block_time > b.block_time)
  GROUP BY b.buyer
`;

export function walletStats(wallet: string): WalletStats {
  const flips = db
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(pnl),0) pnl, COALESCE(SUM(pnl>0),0) wins
              FROM (${flipsSql}) WHERE wallet = ?`)
    .get(wallet) as { n: number; pnl: number; wins: number };
  const buys = db
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(price),0) vol FROM trades WHERE buyer = ?`)
    .get(wallet) as { n: number; vol: number };
  const open = db
    .prepare(`SELECT n, unrealized FROM (${openSql}) WHERE wallet = ?`)
    .get(wallet) as { n: number; unrealized: number } | undefined;
  return {
    wallet,
    flips: flips.n,
    wins: flips.wins,
    winRate: flips.n ? flips.wins / flips.n : null,
    realizedSol: flips.pnl,
    buys: buys.n,
    volumeSol: buys.vol,
    openPositions: open?.n ?? 0,
    unrealizedSol: open?.unrealized ?? 0,
  };
}

// Best flippers of a single collection, scored on that collection's flips only.
export function collectionFlippers(collection: string, limit = 5) {
  return db
    .prepare(`SELECT s.seller AS wallet, COUNT(*) AS flips, SUM(s.price > b.price) AS wins,
                     SUM(s.price - b.price) AS realizedSol
              FROM trades s
              JOIN trades b ON b.signature = (
                SELECT signature FROM trades
                WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
                ORDER BY block_time DESC LIMIT 1)
              WHERE s.collection = ?
              GROUP BY s.seller ORDER BY realizedSol DESC LIMIT ?`)
    .all(collection, limit) as { wallet: string; flips: number; wins: number; realizedSol: number }[];
}
