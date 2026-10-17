// Practice trading (stored as paper_positions): marking positions to market,
// the Top practice traders board and its weekly seasons.
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import { feeRates } from "./fees.ts";
import { toUsd, usdPrice } from "./prices.ts";
import { memberName } from "./takes.ts";

export type PositionRow = {
  id: number; user_id: string; collection: string; entry_price: number; opened_at: number;
  copied_from: string | null; exit_price: number | null; closed_at: number | null;
  floor: number | null; currency: string | null; image?: string | null;
};

// What a position is worth now, like a real flip: the buy pays the taker fee
// and royalty on top, the sale (into the top bid, the floor minus a haircut)
// pays the seller's share (fees.ts). Amounts are in the collection's coin.
// `breakEven` is the floor at which selling now would get the cost back.
export function markPosition(p: PositionRow) {
  const mark = p.exit_price ?? (p.floor ?? p.entry_price) * (1 - config.paperSellHaircut);
  const fee = feeRates(p.collection);
  const cost = p.entry_price * (1 + fee.buyTaker);
  const proceeds = mark * (1 - fee.sellTaker);
  const breakEven = cost / ((1 - config.paperSellHaircut) * (1 - fee.sellTaker));
  return { mark, cost, proceeds, pnl: proceeds - cost, fees: cost - p.entry_price + mark - proceeds, breakEven };
}

// "season" is this week's season (Monday 00:00 UTC on), "last" the one that
// just ended, frozen; the others are rolling windows in days.
export type PracticeWindow = "season" | "last" | "7" | "30" | "all";
export type PracticeRow = {
  rank: number; name: string; you: boolean;
  trades: number; open: number; wins: number;
  roiPct: number; pnlUsd: number; costUsd: number;
  best: { symbol: string; collection: string; pct: number } | null;
};
type Ranked = Omit<PracticeRow, "you"> & { id: string };

const MIN_TRADES = 3;
const DAY = 86_400_000;

// Seasons run Monday 00:00 UTC to the next Monday, named by their first day.
export function seasonOf(ms = Date.now()) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return { id: new Date(start).toISOString().slice(0, 10), start, end: start + 7 * DAY };
}

const positionsBetween = db.prepare(`
  SELECT p.*, c.floor, COALESCE(c.sale_currency, c.currency) AS currency
  FROM paper_positions p LEFT JOIN collections c ON c.symbol = p.collection
  WHERE p.opened_at >= ? AND p.opened_at < ?`);
const profileNames = db.prepare(`SELECT user_id, name FROM profiles`);

// Practice traders ranked by return on what they put in. Positions in SOL, ETH,
// HYPE… are counted in dollars at today's prices, so one board covers them all;
// open positions count at today's floor.
function rank(since: number, until: number) {
  const by = new Map<string, Omit<Ranked, "id" | "rank" | "name" | "roiPct">>();
  for (const p of positionsBetween.all(since, until) as PositionRow[]) {
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
    .map((u, i): Ranked => ({ ...u, rank: i + 1, name: names.get(u.id) ?? memberName(u.id) }));
  return { ranked, tradesOf: (id: string) => by.get(id)?.trades ?? 0 };
}

// --- Seasons -------------------------------------------------------------

const seasonRow = db.prepare(`SELECT season, finalized_at, results FROM practice_seasons WHERE season = ?`);
const latestSeason = db.prepare(`SELECT season, finalized_at, results FROM practice_seasons ORDER BY season DESC LIMIT 1`);
const saveSeason = db.prepare(`INSERT OR IGNORE INTO practice_seasons (season, finalized_at, results) VALUES (?, ?, ?)`);
type SeasonRow = { season: string; finalized_at: number; results: string };
let champCache = { at: 0, map: new Map<string, number>() };

// Freezes last week's board once it has ended: closed trades at their exit,
// open ones at the floor when it ends (run hourly, so within the hour).
// Waits for USD prices (loaded after boot): without them every trade would be
// skipped and an empty season frozen.
export function finalizeSeasons(now = Date.now()) {
  const last = seasonOf(seasonOf(now).start - 1);
  if (seasonRow.get(last.id) || usdPrice("SOL") == null || usdPrice("ETH") == null) return;
  saveSeason.run(last.id, now, JSON.stringify(rank(last.start, last.end).ranked));
  champCache.at = 0;
}

// The last finished season: its id, dates and final rows (with user ids).
export function lastSeason() {
  const r = latestSeason.get() as SeasonRow | undefined;
  if (!r) return null;
  const start = Date.parse(r.season);
  return { id: r.season, start, end: start + 7 * DAY, rows: JSON.parse(r.results) as Ranked[] };
}

// Top 3 of the last finished season, by user id: their badge on theses and the
// board. Read for every thesis author, so kept for a minute.
export function champions() {
  if (Date.now() - champCache.at > 60_000) {
    champCache = { at: Date.now(), map: new Map((lastSeason()?.rows ?? []).slice(0, 3).map((r) => [r.id, r.rank])) };
  }
  return champCache.map;
}

export function startPracticeSeasons() {
  setTimeout(() => finalizeSeasons(), 5 * 60_000).unref(); // once prices are in
  setInterval(() => finalizeSeasons(), 3_600_000).unref();
}

// --- The board -----------------------------------------------------------

// Only names leave the server (anonymous user ids work as credentials).
export function practiceLeaderboard(window: PracticeWindow, viewer: string | null, limit = 50) {
  const now = Date.now();
  const current = seasonOf(now);
  let ranked: Ranked[];
  let tradesOf: (id: string) => number;
  let season: { id: string; start: number; end: number } | null = null;
  if (window === "last") {
    const s = lastSeason();
    ranked = s?.rows ?? [];
    tradesOf = (id) => ranked.find((r) => r.id === id)?.trades ?? 0;
    season = s && { id: s.id, start: s.start, end: s.end };
  } else {
    const since = window === "season" ? current.start : window === "all" ? 0 : now - Number(window) * DAY;
    ({ ranked, tradesOf } = rank(since, Infinity));
    if (window === "season") season = current;
  }
  const champs = champions();
  const out = ({ id, ...r }: Ranked): PracticeRow & { champ: number | null } => ({ ...r, you: id === viewer, champ: champs.get(id) ?? null });
  const me = viewer ? ranked.find((r) => r.id === viewer) : undefined;
  const trades = viewer ? tradesOf(viewer) : 0;
  return {
    window, minTrades: MIN_TRADES, season,
    traders: ranked.length,
    rows: ranked.slice(0, limit).map(out),
    // The viewer's own standing, also when they're below the top `limit` or not ranked yet.
    you: me ? out(me) : { trades, needed: Math.max(0, MIN_TRADES - trades) },
  };
}
