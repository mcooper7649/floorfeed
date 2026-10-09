import { cachedTake } from "./ai.ts";
import { collectionName } from "./config.ts";
import { db } from "./db.ts";
import { getNames, wantNames } from "./sns.ts";

// The feed as events rather than raw buys:
//  - buy:     one wallet bought one NFT
//  - flip:    a wallet sold an NFT it bought earlier (realized P&L)
//  - sweep:   one wallet bought 3+ of a collection within 15 minutes
//  - cluster: 3+ different wallets bought a collection within 6 hours
// Views: "top" ranks the last 72h by signal (who traded, how much, how
// recently); "latest" is chronological; "wins" is profitable flips only.
const HOUR = 3600;
const TOP_WINDOW = 72 * HOUR;
const SWEEP_GAP = 15 * 60;
const SWEEP_MIN = 3;
const CLUSTER_WINDOW = 6 * HOUR;
const CLUSTER_MIN = 3;
const HALF_LIFE = 12 * HOUR;

export type Tier = "elite" | "pro" | "mm" | "new" | null;
export type Trader = {
  wallet: string;
  name: string | null;   // .sol name
  avatar: string | null; // art of an NFT they hold
  tier: Tier;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number;
  quality: number;       // 0..1, win rate shrunk toward 50% for small samples
};
type Coll = { symbol: string; name: string; floor: number | null };
type Base = { id: string; t: number; collection: Coll; score?: number };
export type FeedEvent =
  | (Base & { kind: "buy"; signature: string; mint: string; image: string | null; price: number;
      vsFloorPct: number | null; wallet: Trader; take: { text: string; model: string } | null })
  | (Base & { kind: "flip"; signature: string; mint: string; image: string | null; buy: number; sell: number;
      pnl: number; pnlPct: number; holdHours: number; wallet: Trader; buyer: Trader })
  | (Base & { kind: "sweep"; wallet: Trader; count: number; total: number; avg: number; images: string[];
      vsFloorPct: number | null })
  | (Base & { kind: "cluster"; wallets: Trader[]; count: number; buys: number; avg: number; images: string[];
      vsFloorPct: number | null; since: number });

type Row = {
  signature: string; collection: string; mint: string; buyer: string; seller: string; price: number;
  block_time: number; image: string | null; source: string | null; floor: number | null;
  prev_buy: number | null; prev_at: number | null; // the seller's earlier buy of this mint, if tracked
};

const rowSelect = `
  SELECT t.signature, t.collection, t.mint, t.buyer, t.seller, t.price, t.block_time, t.image, t.source, c.floor,
         b.price AS prev_buy, b.block_time AS prev_at
  FROM trades t
  LEFT JOIN collections c ON c.symbol = t.collection
  LEFT JOIN trades b ON b.signature = (
    SELECT signature FROM trades
    WHERE mint = t.mint AND buyer = t.seller AND block_time < t.block_time
    ORDER BY block_time DESC LIMIT 1)`;

// --- trader stats, cached briefly: the flip join scans every sale ---
type Stat = { flips: number; wins: number; pnl: number; trades: number; pool: number };
let statCache: { at: number; map: Map<string, Stat> } | null = null;
function allStats() {
  if (statCache && Date.now() - statCache.at < 60_000) return statCache.map;
  const map = new Map<string, Stat>();
  const get = (w: string) => map.get(w) ?? map.set(w, { flips: 0, wins: 0, pnl: 0, trades: 0, pool: 0 }).get(w)!;
  for (const r of db.prepare(`
    SELECT s.seller AS wallet, COUNT(*) AS flips, SUM(s.price > b.price) AS wins, SUM(s.price - b.price) AS pnl
    FROM trades s
    JOIN trades b ON b.signature = (
      SELECT signature FROM trades
      WHERE mint = s.mint AND buyer = s.seller AND block_time < s.block_time
      ORDER BY block_time DESC LIMIT 1)
    GROUP BY s.seller`).all() as { wallet: string; flips: number; wins: number; pnl: number }[]) {
    Object.assign(get(r.wallet), { flips: r.flips, wins: r.wins, pnl: r.pnl });
  }
  for (const r of db.prepare(`
    SELECT wallet, COUNT(*) AS trades, SUM(pool) AS pool FROM (
      SELECT buyer AS wallet, source IN ('mmm','tensorswap','tcomp') AS pool FROM trades
      UNION ALL SELECT seller, source IN ('mmm','tensorswap','tcomp') FROM trades
    ) GROUP BY wallet`).all() as { wallet: string; trades: number; pool: number }[]) {
    Object.assign(get(r.wallet), { trades: r.trades, pool: r.pool });
  }
  statCache = { at: Date.now(), map };
  return map;
}

function tierOf(s: Stat | undefined, quality: number): Tier {
  if (!s) return "new";
  // Same heuristic as the leaderboard: most activity through AMM pools.
  if (s.trades >= 20 && s.pool / s.trades >= 0.6) return "mm";
  if (s.flips >= 15 && quality >= 0.68 && s.pnl > 0) return "elite";
  if (s.flips >= 5 && quality >= 0.6 && s.pnl > 0) return "pro";
  if (s.flips < 2) return "new";
  return null;
}

// Most recent art each wallet still holds (bought, not sold since), else any art it bought.
function avatars(wallets: string[]) {
  if (!wallets.length) return new Map<string, string>();
  const rows = db.prepare(`
    SELECT b.buyer AS wallet, b.image,
           NOT EXISTS (SELECT 1 FROM trades s WHERE s.mint = b.mint AND s.seller = b.buyer AND s.block_time > b.block_time) AS held
    FROM trades b
    WHERE b.image IS NOT NULL AND b.buyer IN (${wallets.map(() => "?").join(",")})
    ORDER BY held DESC, b.block_time DESC`).all(...wallets) as { wallet: string; image: string }[];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.wallet)) out.set(r.wallet, r.image);
  return out;
}

function traders(wallets: string[]) {
  const uniq = [...new Set(wallets)];
  const stats = allStats();
  const names = getNames(uniq);
  const pics = avatars(uniq);
  wantNames(uniq);
  return new Map(uniq.map((w): [string, Trader] => {
    const s = stats.get(w);
    const flips = s?.flips ?? 0;
    const wins = s?.wins ?? 0;
    const quality = (wins + 2) / (flips + 4);
    return [w, {
      wallet: w, name: names.get(w) ?? null, avatar: pics.get(w) ?? null, tier: tierOf(s, quality),
      flips, wins, winRate: flips ? wins / flips : null, realizedSol: s?.pnl ?? 0, quality,
    }];
  }));
}

const coll = (r: Row): Coll => ({ symbol: r.collection, name: collectionName(r.collection), floor: r.floor });
const vsFloor = (price: number, floor: number | null) => (floor ? ((price - floor) / floor) * 100 : null);

function build(rows: Row[], withClusters: boolean): FeedEvent[] {
  const who = traders(rows.flatMap((r) => [r.buyer, r.seller]));
  const asc = [...rows].sort((a, b) => a.block_time - b.block_time);
  const events: FeedEvent[] = [];
  const grouped = new Set<string>(); // buys folded into a sweep

  // Sweeps: runs of buys by one wallet in one collection, gaps <= 15 min.
  const runs = new Map<string, Row[]>();
  const flush = (key: string) => {
    const run = runs.get(key);
    runs.delete(key);
    if (!run || run.length < SWEEP_MIN || who.get(run[0].buyer)!.tier === "mm") return;
    const total = run.reduce((a, r) => a + r.price, 0);
    const last = run[run.length - 1];
    events.push({
      kind: "sweep", id: `sweep:${run[0].signature}`, t: last.block_time, collection: coll(last),
      wallet: who.get(last.buyer)!, count: run.length, total, avg: total / run.length,
      images: run.flatMap((r) => (r.image ? [r.image] : [])).filter((u, i, a) => a.indexOf(u) === i).slice(-4), vsFloorPct: vsFloor(total / run.length, last.floor),
    });
    for (const r of run) grouped.add(r.signature);
  };
  for (const r of asc) {
    const key = `${r.buyer}|${r.collection}`;
    const run = runs.get(key);
    if (run && r.block_time - run[run.length - 1].block_time > SWEEP_GAP) flush(key);
    (runs.get(key) ?? runs.set(key, []).get(key)!).push(r);
  }
  for (const key of [...runs.keys()]) flush(key);

  // A sale the seller bought earlier is a flip; anything else is a buy.
  for (const r of rows) {
    if (r.prev_buy != null && r.prev_at != null) {
      const pnl = r.price - r.prev_buy;
      events.push({
        kind: "flip", id: `flip:${r.signature}`, t: r.block_time, collection: coll(r), signature: r.signature,
        mint: r.mint, image: r.image, buy: r.prev_buy, sell: r.price, pnl, pnlPct: (pnl / r.prev_buy) * 100,
        holdHours: (r.block_time - r.prev_at) / HOUR, wallet: who.get(r.seller)!, buyer: who.get(r.buyer)!,
      });
    } else if (!grouped.has(r.signature)) {
      events.push({
        kind: "buy", id: `buy:${r.signature}`, t: r.block_time, collection: coll(r), signature: r.signature,
        mint: r.mint, image: r.image, price: r.price, vsFloorPct: vsFloor(r.price, r.floor),
        wallet: who.get(r.buyer)!, take: cachedTake(r.signature) ?? null,
      });
    }
  }

  // Clusters: per collection, the 6h window with the most distinct
  // (non market-maker) buyers; 3+ makes a card.
  if (withClusters) {
    const byColl = new Map<string, Row[]>();
    for (const r of asc) {
      if (who.get(r.buyer)!.tier === "mm") continue;
      (byColl.get(r.collection) ?? byColl.set(r.collection, []).get(r.collection)!).push(r);
    }
    for (const list of byColl.values()) {
      let best: Row[] = [];
      let bestN = 0;
      for (let i = 0, j = 0; j < list.length; j++) {
        while (list[j].block_time - list[i].block_time > CLUSTER_WINDOW) i++;
        const win = list.slice(i, j + 1);
        const n = new Set(win.map((r) => r.buyer)).size;
        if (n >= bestN) { best = win; bestN = n; }
      }
      if (bestN < CLUSTER_MIN) continue;
      const wallets = [...new Set(best.map((r) => r.buyer))].map((w) => who.get(w)!)
        .sort((a, b) => b.quality * Math.log1p(b.flips) - a.quality * Math.log1p(a.flips));
      const total = best.reduce((a, r) => a + r.price, 0);
      const last = best[best.length - 1];
      events.push({
        kind: "cluster", id: `cluster:${last.collection}:${best[0].signature}`, t: last.block_time, collection: coll(last),
        wallets: wallets.slice(0, 6), count: wallets.length, buys: best.length, avg: total / best.length,
        images: best.flatMap((r) => (r.image ? [r.image] : [])).filter((u, i, a) => a.indexOf(u) === i).slice(-4), vsFloorPct: vsFloor(total / best.length, last.floor),
        since: best[0].block_time,
      });
    }
  }
  return events;
}

// Signal score before recency decay. A trader with 2 flips at 100% is worth
// less than one with 287 at 92%: `quality` shrinks small samples toward 50%,
// and `proven` grows with the number of flips.
const proven = (t: Trader) => (t.tier === "mm" ? 0.1 : t.quality * (1 - Math.exp(-t.flips / 8)));
function signal(e: FeedEvent) {
  switch (e.kind) {
    // Three unknown wallets aping is noise; three proven flippers is the story.
    case "cluster": return (0.5 + 0.2 * e.count) * (0.4 + e.wallets.reduce((a, w) => a + proven(w), 0));
    case "sweep": return (1.2 + 0.2 * Math.min(e.count, 10)) * (0.6 + proven(e.wallet));
    case "flip": return e.pnl > 0
      ? (0.5 + Math.min(1.5, e.pnlPct / 40)) * (0.5 + proven(e.wallet))
      : 0.25 * (0.5 + proven(e.wallet));
    case "buy": return (0.2 + 1.3 * proven(e.wallet)) * (e.vsFloorPct != null && e.vsFloorPct <= 0 ? 1.15 : 1);
  }
}

const involves = (e: FeedEvent, set: Set<string>) =>
  e.kind === "cluster" ? e.wallets.some((w) => set.has(w.wallet)) : set.has(e.wallet.wallet) || (e.kind === "flip" && set.has(e.buyer.wallet));

// Greedy pick by score, discounting each repeat of the same wallet (×0.6)
// and collection (×0.8), so one prolific flipper can't fill the page.
function diversify(events: FeedEvent[], limit: number) {
  const pool = [...events];
  const seenW = new Map<string, number>();
  const seenC = new Map<string, number>();
  const actor = (e: FeedEvent) => (e.kind === "cluster" ? null : e.wallet.wallet);
  const adj = (e: FeedEvent) =>
    e.score! * 0.6 ** (seenW.get(actor(e) ?? "") ?? 0) * 0.8 ** (seenC.get(e.collection.symbol) ?? 0);
  const out: FeedEvent[] = [];
  while (out.length < limit && pool.length) {
    let bi = 0;
    for (let i = 1; i < pool.length; i++) if (adj(pool[i]) > adj(pool[bi])) bi = i;
    const [e] = pool.splice(bi, 1);
    out.push(e);
    const a = actor(e);
    if (a) seenW.set(a, (seenW.get(a) ?? 0) + 1);
    seenC.set(e.collection.symbol, (seenC.get(e.collection.symbol) ?? 0) + 1);
  }
  return out;
}

export type View = "top" | "latest" | "wins";
export function feedEvents(opts: { view: View; before?: number; limit: number; followed?: Set<string> }) {
  const now = Math.floor(Date.now() / 1000);
  const f = opts.followed;
  const who = f ? `AND (t.buyer IN (${[...f].map(() => "?").join(",") || "''"}) OR t.seller IN (${[...f].map(() => "?").join(",") || "''"}))` : "";
  const fargs = f ? [...f, ...f] : [];

  if (opts.view === "top") {
    const rows = db.prepare(`${rowSelect} WHERE t.block_time >= ? ${who} ORDER BY t.block_time DESC LIMIT 2000`)
      .all(now - TOP_WINDOW, ...fargs) as Row[];
    let events = build(rows, true);
    if (f) events = events.filter((e) => involves(e, f));
    for (const e of events) e.score = signal(e) * 0.5 ** ((now - e.t) / HALF_LIFE);
    return { view: opts.view, events: diversify(events, opts.limit), next: null };
  }

  // Chronological views page by block time. Loading a few extra trades past
  // the page lets sweeps near the edge group correctly.
  const before = opts.before ?? now + 1;
  // A +0.3% "win" is noise (and under fees a loss): wins start at +2%.
  const winsOnly = opts.view === "wins" ? "AND b.price IS NOT NULL AND t.price >= b.price * 1.02" : "";
  const rows = db.prepare(`${rowSelect} WHERE t.block_time < ? ${winsOnly} ${who} ORDER BY t.block_time DESC LIMIT ?`)
    .all(before, ...fargs, opts.limit * 2) as Row[];
  if (!rows.length) return { view: opts.view, events: [], next: null };
  let events = build(rows, false);
  // Wins: profitable flips by people, not AMM pool bots.
  if (opts.view === "wins") events = events.filter((e) => e.kind === "flip" && e.wallet.tier !== "mm");
  if (f) events = events.filter((e) => involves(e, f));
  events.sort((a, b) => b.t - a.t);
  // Don't cut a page inside the oldest second we loaded (it may be partial).
  const oldest = rows[rows.length - 1].block_time;
  const full = rows.length === opts.limit * 2;
  const page = full ? events.filter((e) => e.t > oldest) : events;
  return { view: opts.view, events: page, next: full ? oldest + 1 : null };
}
