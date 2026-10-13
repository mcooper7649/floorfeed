import { db } from "./db.ts";
import { COST_SQL, MARK_SQL, PROCEEDS_SQL } from "./fees.ts";
import { UNIT_SQL } from "./units.ts";

// P&L is computed from trades we've ingested ("tracked window"), net of
// marketplace fees and royalties (fees.ts). A flip = a wallet selling a mint it bought.
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

// All sums are within one currency (a collection's sale unit, units.ts).
const flipsSql = `
  SELECT s.seller AS wallet, ${PROCEEDS_SQL("s", "c")} - ${COST_SQL("b", "c")} AS pnl, ${UNIT_SQL("c")} AS unit
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
  LEFT JOIN collections c ON c.symbol = s.collection
`;

const openSql = `
  SELECT b.buyer AS wallet, ${UNIT_SQL("c")} AS unit, COUNT(*) AS n, SUM(${MARK_SQL("c")} - ${COST_SQL("b", "c")}) AS unrealized
  FROM trades b
  JOIN collections c ON c.symbol = b.collection
  WHERE NOT EXISTS (
    SELECT 1 FROM trades s
    WHERE s.mint = b.mint AND s.seller = b.buyer AND s.block_time > b.block_time)
  GROUP BY b.buyer, unit
`;

const mainUnit = db.prepare(`
  SELECT ${UNIT_SQL("c")} AS unit FROM trades t LEFT JOIN collections c ON c.symbol = t.collection
  WHERE t.buyer = @w OR t.seller = @w GROUP BY unit ORDER BY COUNT(*) DESC LIMIT 1`);

// A wallet's stats in one currency; without `unit`, the one it trades most in.
export function walletStats(wallet: string, unit?: string): WalletStats & { unit: string } {
  const u = unit ?? (mainUnit.get({ w: wallet }) as { unit: string } | undefined)?.unit ?? (wallet.startsWith("0x") ? "ETH" : "SOL");
  const flips = db
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(pnl),0) pnl, COALESCE(SUM(pnl>0),0) wins
              FROM (${flipsSql}) WHERE wallet = ? AND unit = ?`)
    .get(wallet, u) as { n: number; pnl: number; wins: number };
  const buys = db
    .prepare(`SELECT COUNT(*) n, COALESCE(SUM(t.price),0) vol FROM trades t LEFT JOIN collections c ON c.symbol = t.collection
              WHERE t.buyer = ? AND ${UNIT_SQL("c")} = ?`)
    .get(wallet, u) as { n: number; vol: number };
  const open = db
    .prepare(`SELECT n, unrealized FROM (${openSql}) WHERE wallet = ? AND unit = ?`)
    .get(wallet, u) as { n: number; unrealized: number } | undefined;
  return {
    wallet,
    unit: u,
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
    .prepare(`SELECT s.seller AS wallet, COUNT(*) AS flips, SUM(${PROCEEDS_SQL("s", "c")} > ${COST_SQL("b", "c")}) AS wins,
                     SUM(${PROCEEDS_SQL("s", "c")} - ${COST_SQL("b", "c")}) AS realizedSol
              FROM trades s
              JOIN trades b ON b.signature = (
                SELECT signature FROM trades
                WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
                ORDER BY block_time DESC LIMIT 1)
              LEFT JOIN collections c ON c.symbol = s.collection
              WHERE s.collection = ?
              GROUP BY s.seller ORDER BY realizedSol DESC LIMIT ?`)
    .all(collection, limit) as { wallet: string; flips: number; wins: number; realizedSol: number }[];
}
