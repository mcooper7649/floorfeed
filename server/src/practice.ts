// Practice trading (stored as paper_positions): marking positions to market
// and the Top practice traders board.
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import { feeRates } from "./fees.ts";
import { toUsd } from "./prices.ts";
import { memberName } from "./takes.ts";

export type PositionRow = {
  id: number; user_id: string; collection: string; entry_price: number; opened_at: number;
  copied_from: string | null; exit_price: number | null; closed_at: number | null;
  floor: number | null; currency: string | null; image?: string | null;
};

// What a position is worth now, like a real flip: the buy pays the taker fee
// and royalty on top, the sale (into the top bid, the floor minus a haircut)
// pays the seller's share (fees.ts). Amounts are in the collection's coin.
export function markPosition(p: PositionRow) {
  const mark = p.exit_price ?? (p.floor ?? p.entry_price) * (1 - config.paperSellHaircut);
  const fee = feeRates(p.collection);
  const cost = p.entry_price * (1 + fee.buyTaker);
  const proceeds = mark * (1 - fee.sellTaker);
  return { mark, cost, proceeds, pnl: proceeds - cost, fees: cost - p.entry_price + mark - proceeds };
}

export type PracticeWindow = "7" | "30" | "all";
export type PracticeRow = {
  rank: number; name: string; you: boolean;
  trades: number; open: number; wins: number;
  roiPct: number; pnlUsd: number; costUsd: number;
  best: { symbol: string; collection: string; pct: number } | null;
};

const MIN_TRADES = 3;
const positionsSince = db.prepare(`
  SELECT p.*, c.floor, COALESCE(c.sale_currency, c.currency) AS currency
  FROM paper_positions p LEFT JOIN collections c ON c.symbol = p.collection
  WHERE p.opened_at >= ?`);
const profileNames = db.prepare(`SELECT user_id, name FROM profiles`);

// Practice traders ranked by return on what they put in. Positions in SOL, ETH,
// HYPE… are counted in dollars at today's prices, so one board covers them all;
// open positions count at today's floor. Only names leave the server (anonymous
// user ids work as credentials).
export function practiceLeaderboard(window: PracticeWindow, viewer: string | null, limit = 50) {
  const since = window === "all" ? 0 : Date.now() - Number(window) * 86_400_000;
  const by = new Map<string, { trades: number; open: number; wins: number; pnlUsd: number; costUsd: number; best: PracticeRow["best"] }>();
  for (const p of positionsSince.all(since) as PositionRow[]) {
    const unit = p.currency ?? "SOL";
    const m = markPosition(p);
    const costUsd = toUsd(m.cost, unit);
    const pnlUsd = toUsd(m.pnl, unit);
    if (costUsd == null || pnlUsd == null || costUsd <= 0) continue; // no USD price for this coin yet
    const u = by.get(p.user_id) ?? { trades: 0, open: 0, wins: 0, pnlUsd: 0, costUsd: 0, best: null };
    u.trades++;
    if (p.closed_at == null) u.open++;
    if (m.pnl > 0) u.wins++;
    u.pnlUsd += pnlUsd;
    u.costUsd += costUsd;
    const pct = (m.pnl / m.cost) * 100;
    if (!u.best || pct > u.best.pct) u.best = { symbol: p.collection, collection: collectionName(p.collection), pct };
    by.set(p.user_id, u);
  }
  const names = new Map((profileNames.all() as { user_id: string; name: string }[]).map((r) => [r.user_id, r.name]));
  const ranked = [...by.entries()]
    .filter(([, u]) => u.trades >= MIN_TRADES)
    .map(([id, u]) => ({ id, ...u, roiPct: (u.pnlUsd / u.costUsd) * 100 }))
    .sort((a, b) => b.roiPct - a.roiPct || b.pnlUsd - a.pnlUsd)
    .map(({ id, ...u }, i): PracticeRow & { id: string } => ({
      id, rank: i + 1, name: names.get(id) ?? memberName(id), you: id === viewer, ...u,
    }));
  const strip = ({ id: _id, ...r }: PracticeRow & { id: string }): PracticeRow => r;
  const mine = viewer ? by.get(viewer) : undefined;
  const me = viewer ? ranked.find((r) => r.id === viewer) : undefined;
  return {
    window, minTrades: MIN_TRADES,
    traders: ranked.length,
    rows: ranked.slice(0, limit).map(strip),
    // The viewer's own standing, also when they're below the top `limit` or not ranked yet.
    you: me ? strip(me) : { trades: mine?.trades ?? 0, needed: Math.max(0, MIN_TRADES - (mine?.trades ?? 0)) },
  };
}
