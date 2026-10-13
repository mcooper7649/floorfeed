import { collectionName } from "./config.ts";
import { COST_SQL, PROCEEDS_SQL } from "./fees.ts";
import { db } from "./db.ts";
import { walletStats } from "./pnl.ts";
import { toUsd } from "./prices.ts";
import { UNIT_SQL } from "./units.ts";

// Detailed trader profiles for the leaderboard and wallet pages. A flip is a
// sale matched to the seller's most recent earlier buy of the same mint; the
// window filters on when the flip closed (the sale). Buy = what the wallet
// paid, sell = what it received: net of marketplace fees and royalties (fees.ts).
const DAY = 86_400;

type Flip = {
  wallet: string;
  collection: string;
  buy: number;
  sell: number;
  boughtAt: number;
  soldAt: number;
};

// Flips in one currency (a collection's sale unit, see units.ts): P&L only adds up within a unit.
const flipsSince = db.prepare(`
  SELECT s.seller AS wallet, s.collection, ${COST_SQL("b", "c")} AS buy, ${PROCEEDS_SQL("s", "c")} AS sell,
         b.block_time AS boughtAt, s.block_time AS soldAt
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
  LEFT JOIN collections c ON c.symbol = s.collection
  WHERE s.block_time >= ? AND ${UNIT_SQL("c")} = ?
  ORDER BY s.block_time`);

// Market-maker signals. Solana: trades through AMM pools (Magic Eden MMM,
// Tensor swap). Ethereum: buys filled by an accepted bid (paid in WETH or
// Blur's BETH); bidding bots fill nearly all their buys that way, then relist.
const activitySince = db.prepare(`
  SELECT wallet, COUNT(*) AS trades, SUM(pool) AS poolTrades, SUM(buy) AS buys, SUM(bid) AS bidBuys, MAX(t) AS lastActive FROM (
    SELECT buyer AS wallet, source IN ('mmm','tensorswap','tcomp') AS pool, 1 AS buy, source IN ('os:WETH','os:BETH') AS bid, block_time AS t FROM trades WHERE block_time >= ?
    UNION ALL
    SELECT seller, source IN ('mmm','tensorswap','tcomp'), 0, 0, block_time FROM trades WHERE block_time >= ?
  ) GROUP BY wallet`);

type Activity = { trades: number; poolTrades: number; buys: number; bidBuys: number; lastActive: number };
export function marketMakerLike(a: Pick<Activity, "trades" | "poolTrades" | "buys" | "bidBuys"> | undefined) {
  if (!a || a.trades < 20) return false;
  return a.poolTrades / a.trades >= 0.6 || (a.buys >= 10 && a.bidBuys / a.buys >= 0.85);
}

export type TraderProfile = ReturnType<typeof profileFrom>;

function profileFrom(wallet: string, flips: Flip[], act: Activity | undefined, unit: string) {
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
  const open = walletStats(wallet, unit);
  return {
    wallet,
    unit, // every amount in this profile is in this currency
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
    bidBuyShare: act && act.buys ? act.bidBuys / act.buys : 0, // EVM: buys filled by accepted bids
    // Heuristic, shown as "likely": most activity runs through AMM pools.
    likelyMarketMaker: marketMakerLike(act),
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
  unit?: string; // the currency the board ranks in (SOL, ETH, HYPE, RON, APE, MON)
}) {
  const t0 = since(opts.windowDays);
  const unit = opts.unit ?? "SOL";
  const flips = flipsSince.all(t0, unit) as Flip[];
  const byWallet = new Map<string, Flip[]>();
  for (const f of flips) (byWallet.get(f.wallet) ?? byWallet.set(f.wallet, []).get(f.wallet)!).push(f);
  const act = new Map(
    (activitySince.all(t0, t0) as ({ wallet: string } & Activity)[])
      .map((a) => [a.wallet, a]),
  );

  const candidates = [...byWallet.entries()].filter(([, fs]) => fs.length >= opts.minFlips);
  let rows = candidates.map(([w, fs]) => profileFrom(w, fs, act.get(w), unit));
  const marketMakers = rows.filter((r) => r.likelyMarketMaker).length;
  if (opts.hideMarketMakers) rows = rows.filter((r) => !r.likelyMarketMaker);
  rows.sort((a, b) => SORTS[opts.sort](b) - SORTS[opts.sort](a));

  return {
    windowDays: opts.windowDays,
    unit,
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
  SELECT s.seller AS wallet, s.collection, ${COST_SQL("b", "c")} AS buy, ${PROCEEDS_SQL("s", "c")} AS sell,
         b.block_time AS boughtAt, s.block_time AS soldAt
  FROM trades s
  JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
    ORDER BY block_time DESC LIMIT 1)
  LEFT JOIN collections c ON c.symbol = s.collection
  WHERE s.seller = ? AND ${UNIT_SQL("c")} = ?
  ORDER BY s.block_time`);

const walletActivity = db.prepare(`
  SELECT COUNT(*) AS trades, COALESCE(SUM(source IN ('mmm','tensorswap','tcomp')), 0) AS poolTrades,
         COALESCE(SUM(buyer = @w), 0) AS buys,
         COALESCE(SUM(buyer = @w AND source IN ('os:WETH','os:BETH')), 0) AS bidBuys,
         MAX(block_time) AS lastActive
  FROM trades WHERE buyer = @w OR seller = @w`);

// Every currency a wallet has traded in, with its flips and realized P&L,
// most-traded first. The first one is the wallet's default view.
const unitsOf = db.prepare(`
  SELECT ${UNIT_SQL("c")} AS unit, COUNT(*) AS trades FROM trades t
  LEFT JOIN collections c ON c.symbol = t.collection
  WHERE t.buyer = @w OR t.seller = @w GROUP BY unit ORDER BY trades DESC`);
export function walletUnits(wallet: string) {
  return (unitsOf.all({ w: wallet }) as { unit: string; trades: number }[]).map((u) => {
    const fs = walletFlips.all(wallet, u.unit) as Flip[];
    const realized = fs.reduce((a, f) => a + f.sell - f.buy, 0);
    return { unit: u.unit, trades: u.trades, flips: fs.length, realized, realizedUsd: toUsd(realized, u.unit) };
  });
}

export function traderProfile(wallet: string, unit?: string) {
  const act = walletActivity.get({ w: wallet }) as Activity;
  const u = unit ?? (unitsOf.get({ w: wallet }) as { unit: string } | undefined)?.unit ?? (wallet.startsWith("0x") ? "ETH" : "SOL");
  return profileFrom(wallet, walletFlips.all(wallet, u) as Flip[], act, u);
}
