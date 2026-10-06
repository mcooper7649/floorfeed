import { collectionName } from "./config.ts";
import { db } from "./db.ts";
import { walletStats } from "./pnl.ts";

// Detailed trader profiles for the leaderboard and wallet pages. A flip is a
// sale matched to the seller's most recent earlier buy of the same mint; the
// window filters on when the flip closed (the sale). Gross of fees.
const DAY = 86_400;

type Flip = {
  wallet: string;
  collection: string;
  buy: number;
  sell: number;
  boughtAt: number;
  soldAt: number;
};

const flipsSince = db.prepare(`
  SELECT s.seller AS wallet, s.collection, b.price AS buy, s.price AS sell,
         b.block_time AS boughtAt, s.block_time AS soldAt
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
  WHERE s.block_time >= ?
  ORDER BY s.block_time`);

const activitySince = db.prepare(`
  SELECT wallet, COUNT(*) AS trades, SUM(pool) AS poolTrades, MAX(t) AS lastActive FROM (
    SELECT buyer AS wallet, source IN ('mmm','tensorswap','tcomp') AS pool, block_time AS t FROM trades WHERE block_time >= ?
    UNION ALL
    SELECT seller, source IN ('mmm','tensorswap','tcomp'), block_time FROM trades WHERE block_time >= ?
  ) GROUP BY wallet`);

export type TraderProfile = ReturnType<typeof profileFrom>;

function profileFrom(wallet: string, flips: Flip[], act: { trades: number; poolTrades: number; lastActive: number } | undefined) {
  const pnls = flips.map((f) => f.sell - f.buy);
  const realized = pnls.reduce((a, b) => a + b, 0);
  const cost = flips.reduce((a, f) => a + f.buy, 0);
  const wins = pnls.filter((p) => p > 0).length;

  // Current streak: consecutive profitable flips counting back from the latest.
  let streak = 0;
  for (let i = pnls.length - 1; i >= 0 && pnls[i] > 0; i--) streak++;

  const best = flips.reduce<Flip | null>((m, f) => (!m || f.sell - f.buy > m.sell - m.buy ? f : m), null);
  const byColl = new Map<string, { flips: number; pnl: number }>();
  for (const f of flips) {
    const c = byColl.get(f.collection) ?? { flips: 0, pnl: 0 };
    c.flips++; c.pnl += f.sell - f.buy;
    byColl.set(f.collection, c);
  }

  // Cumulative realized P&L after each flip, downsampled to <= 24 points.
  let run = 0;
  const cum = pnls.map((p) => (run += p));
  const step = Math.max(1, Math.ceil(cum.length / 24));
  const series = cum.filter((_, i) => i % step === 0 || i === cum.length - 1);

  const poolShare = act && act.trades ? act.poolTrades / act.trades : 0;
  const open = walletStats(wallet);
  return {
    wallet,
    flips: flips.length,
    wins,
    winRate: flips.length ? wins / flips.length : null,
    realizedSol: realized,
    roiPct: cost ? (realized / cost) * 100 : null,
    avgPnlSol: flips.length ? realized / flips.length : null,
    avgHoldHours: flips.length
      ? flips.reduce((a, f) => a + (f.soldAt - f.boughtAt), 0) / flips.length / 3600
      : null,
    bestFlip: best ? { collection: collectionName(best.collection), symbol: best.collection, pnlSol: best.sell - best.buy } : null,
    worstFlipSol: pnls.length ? Math.min(...pnls) : null,
    streak,
    collections: [...byColl.entries()]
      .sort((a, b) => b[1].flips - a[1].flips)
      .slice(0, 3)
      .map(([symbol, c]) => ({ symbol, name: collectionName(symbol), flips: c.flips, pnlSol: c.pnl })),
    trades: act?.trades ?? 0,
    poolShare,
    // Heuristic, shown as "likely": most activity runs through AMM pools.
    likelyMarketMaker: (act?.trades ?? 0) >= 20 && poolShare >= 0.6,
    lastActive: act?.lastActive ?? null,
    openPositions: open.openPositions,
    unrealizedSol: open.unrealizedSol,
    series,
  };
}

function since(windowDays: number | null) {
  return windowDays ? Math.floor(Date.now() / 1000) - windowDays * DAY : 0;
}

const SORTS = {
  pnl: (p: TraderProfile) => p.realizedSol,
  winrate: (p: TraderProfile) => (p.winRate ?? 0) * 1e6 + p.flips, // ties broken by sample size
  roi: (p: TraderProfile) => p.roiPct ?? -Infinity,
  flips: (p: TraderProfile) => p.flips,
} as const;
export type SortKey = keyof typeof SORTS;

export function traderLeaderboard(opts: {
  windowDays: number | null;
  sort: SortKey;
  minFlips: number;
  hideMarketMakers: boolean;
  limit: number;
}) {
  const t0 = since(opts.windowDays);
  const flips = flipsSince.all(t0) as Flip[];
  const byWallet = new Map<string, Flip[]>();
  for (const f of flips) (byWallet.get(f.wallet) ?? byWallet.set(f.wallet, []).get(f.wallet)!).push(f);
  const act = new Map(
    (activitySince.all(t0, t0) as { wallet: string; trades: number; poolTrades: number; lastActive: number }[])
      .map((a) => [a.wallet, a]),
  );

  const candidates = [...byWallet.entries()].filter(([, fs]) => fs.length >= opts.minFlips);
  let rows = candidates.map(([w, fs]) => profileFrom(w, fs, act.get(w)));
  const marketMakers = rows.filter((r) => r.likelyMarketMaker).length;
  if (opts.hideMarketMakers) rows = rows.filter((r) => !r.likelyMarketMaker);
  rows.sort((a, b) => SORTS[opts.sort](b) - SORTS[opts.sort](a));

  return {
    windowDays: opts.windowDays,
    summary: {
      wallets: rows.length,
      flips: rows.reduce((a, r) => a + r.flips, 0),
      realizedSol: rows.reduce((a, r) => a + r.realizedSol, 0),
      profitableWallets: rows.filter((r) => r.realizedSol > 0).length,
      hiddenMarketMakers: opts.hideMarketMakers ? marketMakers : 0,
    },
    rows: rows.slice(0, opts.limit),
  };
}

const walletFlips = db.prepare(`
  SELECT s.seller AS wallet, s.collection, b.price AS buy, s.price AS sell,
         b.block_time AS boughtAt, s.block_time AS soldAt
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
  WHERE s.seller = ?
  ORDER BY s.block_time`);

const walletActivity = db.prepare(`
  SELECT COUNT(*) AS trades, COALESCE(SUM(source IN ('mmm','tensorswap','tcomp')), 0) AS poolTrades,
         MAX(block_time) AS lastActive
  FROM trades WHERE buyer = ? OR seller = ?`);

export function traderProfile(wallet: string) {
  const act = walletActivity.get(wallet, wallet) as { trades: number; poolTrades: number; lastActive: number };
  return profileFrom(wallet, walletFlips.all(wallet) as Flip[], act);
}
