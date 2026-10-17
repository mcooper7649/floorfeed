import { statSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { formatEther, type Hex } from "viem";
import { dropAbi, factoryAbi } from "./abi/launchpad.ts";
import "./activity.ts"; // adds the wallet_activity fee columns read below
import { summary } from "./analytics.ts";
import { privyUser } from "./auth.ts";
import { EVM_CHAINS, config } from "./config.ts";
import { db } from "./db.ts";
import { adminOk, bearer, secretMatches } from "./http.ts";
import { toUsd } from "./prices.ts";
import { listReports } from "./support.ts";
import { evmPublicClient } from "./trade-evm.ts";

// The owner's admin panel (app /admin): what FloorFeed earns and from where,
// who uses it, where they come from, what moves through it, what needs
// moderating, and whether the data is fresh. Admins are the Privy accounts in
// ADMIN_USER_IDS (comma-separated), or anyone holding ADMIN_TOKEN.
//
// FloorFeed's revenue streams:
// - Bridges: Relay "app fee" (RELAY_FEE_BPS) on each bridge, credited to an
//   off-chain USDC balance for RELAY_FEE_RECIPIENT and claimed from Relay.
//   The exact fee per bridge is read back from Relay once the bridge lands.
// - OpenSea buys: BUY_FEE_BPS on top of the price, paid to the fee wallet in
//   the same transaction (estimated from the amount paid; off when 0).
// - Launchpad: the per-token mint fee each collection locked in at launch,
//   sent to the factory's fee recipient on every mint (read on chain).

const ADMINS = new Set((process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const RELAY = "https://api.relay.link";
const FEE_WALLET = (process.env.RELAY_FEE_RECIPIENT ?? "").toLowerCase();
const FACTORY = (process.env.LAUNCH_FACTORY ?? "").toLowerCase() as Hex | "";
const LAUNCH_CHAINS = (process.env.LAUNCH_CHAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Changes (moderation) take a bearer only, never the dashboard cookie, so a
// link on another site can't act as the admin.
export async function isAdmin(req: FastifyRequest, { changes = false } = {}) {
  if (changes ? secretMatches(bearer(req) ?? "", config.adminToken) : adminOk(req)) return true;
  if (!ADMINS.size || !req.headers.authorization) return false;
  const u = await privyUser(req);
  return !!u && ADMINS.has(u);
}

// --- Bridge fees, per bridge, from Relay ---

type RelayFee = { recipient?: string; amountUsd?: string };
const unchecked = db.prepare(`SELECT hash, request_id FROM wallet_activity
  WHERE kind = 'bridge' AND status = 'confirmed' AND request_id IS NOT NULL AND app_fee_checked = 0 ORDER BY created_at DESC LIMIT ?`);
const saveFee = db.prepare(`UPDATE wallet_activity SET app_fee_usd = ?, app_fee_checked = 1 WHERE hash = ?`);

/** Reads the app fee of landed bridges that haven't been read yet (a few at a
 * time, spaced out: Relay rate-limits bursts and answers 429). */
export async function syncBridgeFees(limit = 20) {
  const rows = unchecked.all(limit) as { hash: string; request_id: string }[];
  for (const [i, r] of rows.entries()) {
    if (i) await new Promise((ok) => setTimeout(ok, 1_500));
    try {
      const res = await fetch(`${RELAY}/requests/v2?id=${encodeURIComponent(r.request_id)}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 429) break;
      if (!res.ok) continue;
      const d = (await res.json()) as { requests?: { data?: { paidAppFees?: RelayFee[]; appFees?: RelayFee[] } }[] };
      const data = d.requests?.[0]?.data;
      if (!data) continue;
      const fees = data.paidAppFees ?? data.appFees ?? [];
      const ours = fees.filter((f) => !FEE_WALLET || f.recipient?.toLowerCase() === FEE_WALLET);
      saveFee.run(ours.reduce((a, f) => a + (Number(f.amountUsd) || 0), 0), r.hash);
    } catch { /* next pass */ }
  }
  return rows.length;
}

// Relay's unclaimed balance for the fee wallet (USD), cached a few minutes.
let claimable: { at: number; usd: number | null; currency: string | null } = { at: 0, usd: null, currency: null };
async function relayClaimable() {
  if (!FEE_WALLET) return null;
  if (Date.now() - claimable.at < 5 * 60_000) return claimable;
  try {
    const res = await fetch(`${RELAY}/app-fees/${FEE_WALLET}/balances`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const d = (await res.json()) as { totalBalanceUsd?: number; balances?: { currency?: { symbol?: string; chainId?: number } }[] };
    const cur = d.balances?.[0]?.currency;
    claimable = { at: Date.now(), usd: d.totalBalanceUsd ?? 0, currency: cur?.symbol ? `${cur.symbol}${cur.chainId === 8453 ? " on Base" : ""}` : null };
  } catch {
    claimable = { ...claimable, at: Date.now() - 4 * 60_000 }; // retry in a minute
  }
  return claimable;
}

// --- Launchpad mint fees, on chain ---

type LaunchFee = { id: string; name: string; chain: string; address: string; status: string; minted: number; max: number; feeEach: number; unit: string; fees: number; usd: number | null };
let launchCache: { at: number; rows: LaunchFee[] } = { at: 0, rows: [] };
async function launchFees() {
  if (Date.now() - launchCache.at < 10 * 60_000) return launchCache.rows;
  const launched = db.prepare(`SELECT id, name, chain, address, status FROM launches WHERE address IS NOT NULL ORDER BY updated_at DESC LIMIT 50`)
    .all() as { id: string; name: string; chain: string; address: string; status: string }[];
  const rows = await Promise.all(launched.map(async (l): Promise<LaunchFee | null> => {
    try {
      const c = evmPublicClient(l.chain);
      const read = <T,>(fn: string) => c.readContract({ address: l.address as Hex, abi: dropAbi, functionName: fn as never }) as Promise<T>;
      const [minted, max, fee] = await Promise.all([read<number>("totalMinted"), read<number>("maxSupply"), read<bigint>("mintFee")]);
      const unit = EVM_CHAINS[l.chain as keyof typeof EVM_CHAINS]?.native ?? "ETH";
      const feeEach = Number(formatEther(fee));
      const fees = feeEach * Number(minted);
      return { ...l, minted: Number(minted), max: Number(max), feeEach, unit, fees, usd: toUsd(fees, unit) };
    } catch {
      return null;
    }
  }));
  launchCache = { at: Date.now(), rows: rows.filter((r): r is LaunchFee => !!r) };
  return launchCache.rows;
}

// What a collection launched now would lock in, per network.
let factoryCache: { at: number; rows: { chain: string; mintFee: number; unit: string; recipient: string | null }[] } = { at: 0, rows: [] };
async function factoryFees() {
  if (!FACTORY) return [];
  if (Date.now() - factoryCache.at < 30 * 60_000) return factoryCache.rows;
  const rows = await Promise.all(LAUNCH_CHAINS.map(async (chain) => {
    try {
      const c = evmPublicClient(chain);
      const read = <T,>(fn: string) => c.readContract({ address: FACTORY as Hex, abi: factoryAbi, functionName: fn as never }) as Promise<T>;
      const [fee, recipient] = await Promise.all([read<bigint>("mintFee"), read<string>("feeRecipient")]);
      return { chain, mintFee: Number(formatEther(fee)), unit: EVM_CHAINS[chain as keyof typeof EVM_CHAINS]?.native ?? "ETH", recipient };
    } catch {
      return { chain, mintFee: NaN, unit: "ETH", recipient: null };
    }
  }));
  factoryCache = { at: Date.now(), rows };
  return rows;
}

// --- Revenue ---

const sinceSec = (days: number) => Math.floor(Date.now() / 1000) - days * 86_400;
const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

export async function revenue(days: number) {
  await syncBridgeFees(2).catch(() => 0); // the newest; the rest catch up in the background
  const since = sinceSec(days);
  const bridges = db.prepare(`SELECT created_at, chain, to_chain, amount, unit, app_fee_usd, app_fee_checked FROM wallet_activity
    WHERE kind = 'bridge' AND status = 'confirmed'`).all() as
    { created_at: number; chain: string; to_chain: string | null; amount: number | null; unit: string | null; app_fee_usd: number | null; app_fee_checked: number }[];
  const buys = db.prepare(`SELECT created_at, chain, amount, unit, app_fee_bps FROM wallet_activity
    WHERE kind = 'buy' AND status = 'confirmed' AND app_fee_bps > 0`).all() as
    { created_at: number; chain: string; amount: number | null; unit: string | null; app_fee_bps: number }[];
  const buyFee = (b: (typeof buys)[number]) => toUsd((b.amount ?? 0) * b.app_fee_bps / (10_000 + b.app_fee_bps), b.unit ?? "ETH") ?? 0;
  const [claim, launches, factory] = await Promise.all([relayClaimable(), launchFees(), factoryFees()]);

  // By day (window only); launch fees aren't dated, so they only count in totals.
  const daily = new Map<string, { bridge: number; buy: number }>();
  for (let i = days - 1; i >= 0; i--) daily.set(dayOf(Math.floor(Date.now() / 1000) - i * 86_400), { bridge: 0, buy: 0 });
  for (const b of bridges) if (b.created_at >= since) { const d = daily.get(dayOf(b.created_at)); if (d) d.bridge += b.app_fee_usd ?? 0; }
  for (const b of buys) if (b.created_at >= since) { const d = daily.get(dayOf(b.created_at)); if (d) d.buy += buyFee(b); }

  // Bridge fees by route ("Ink → Robinhood").
  const routes = new Map<string, { route: string; bridges: number; usd: number }>();
  for (const b of bridges) {
    if (b.created_at < since) continue;
    const name = (c: string | null) => (c === "solana" ? "Solana" : EVM_CHAINS[c as keyof typeof EVM_CHAINS]?.name ?? c ?? "?");
    const key = `${name(b.chain)} → ${name(b.to_chain)}`;
    const r = routes.get(key) ?? routes.set(key, { route: key, bridges: 0, usd: 0 }).get(key)!;
    r.bridges++;
    r.usd += b.app_fee_usd ?? 0;
  }

  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const inWindow = <T extends { created_at: number }>(xs: T[]) => xs.filter((x) => x.created_at >= since);
  const launchUsd = sum(launches, (l) => l.usd ?? 0);
  const streams = [
    { id: "bridge", label: "Bridges", allTime: sum(bridges, (b) => b.app_fee_usd ?? 0), window: sum(inWindow(bridges), (b) => b.app_fee_usd ?? 0),
      count: inWindow(bridges).length, pending: bridges.filter((b) => !b.app_fee_checked).length,
      setting: Number(process.env.RELAY_FEE_BPS ?? 0) > 0 ? `${Number(process.env.RELAY_FEE_BPS) / 100}% of each bridge (Relay app fee)` : "Off" },
    { id: "buy", label: "OpenSea buys", allTime: sum(buys, buyFee), window: sum(inWindow(buys), buyFee), count: inWindow(buys).length, pending: 0,
      setting: Number(process.env.BUY_FEE_BPS ?? 0) > 0 ? `${Number(process.env.BUY_FEE_BPS) / 100}% on top of the price` : "Off (BUY_FEE_BPS=0)" },
    { id: "launch", label: "Launchpad mints", allTime: launchUsd, window: null, count: sum(launches, (l) => l.minted), pending: 0,
      setting: factory.length ? factory.map((f) => `${EVM_CHAINS[f.chain as keyof typeof EVM_CHAINS]?.name ?? f.chain}: ${Number.isNaN(f.mintFee) ? "?" : `${f.mintFee} ${f.unit}`}/token`).join(" · ") : "No factory set" },
  ];
  return {
    days,
    totalAllTime: sum(streams, (s) => s.allTime),
    totalWindow: sum(streams, (s) => s.window ?? 0),
    streams,
    daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
    routes: [...routes.values()].sort((a, b) => b.usd - a.usd),
    relay: { feeWallet: FEE_WALLET || null, claimableUsd: claim?.usd ?? null, currency: claim?.currency ?? null, claimUrl: "https://relay.link/claim-app-fees" },
    launches,
    factory,
  };
}

// --- Users (Privy is the account list; profiles and our tables add the rest) ---

type PrivyUser = { id: string; created_at: number; linked_accounts?: { type: string; address?: string; email?: string; chain_type?: string }[]; mfa_methods?: unknown[] };
let usersCache: { at: number; users: PrivyUser[] } = { at: 0, users: [] };
async function privyUsers() {
  if (Date.now() - usersCache.at < 10 * 60_000) return usersCache.users;
  if (!config.privyAppId || !process.env.PRIVY_APP_SECRET) return [];
  const out: PrivyUser[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const res: Response = await fetch(`https://auth.privy.io/api/v1/users?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${config.privyAppId}:${process.env.PRIVY_APP_SECRET}`).toString("base64")}`,
          "privy-app-id": config.privyAppId,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`privy ${res.status}`);
      const d = (await res.json()) as { data: PrivyUser[]; next_cursor?: string | null };
      out.push(...d.data);
      if (!d.next_cursor || !d.data.length || d.data.length < 100) break;
      cursor = d.next_cursor;
    }
    usersCache = { at: Date.now(), users: out };
  } catch (e) {
    console.warn("admin users:", (e as Error).message);
    return usersCache.users;
  }
  return out;
}

const loginOf = (u: PrivyUser) => {
  const a = u.linked_accounts ?? [];
  const google = a.find((x) => x.type === "google_oauth");
  const email = a.find((x) => x.type === "email");
  return {
    method: google ? "Google" : email ? "Email" : a.some((x) => x.type === "passkey") ? "Passkey" : a.some((x) => x.type === "wallet") ? "Wallet" : "?",
    contact: email?.address ?? google?.email ?? null,
  };
};

export async function users(days: number) {
  const list = await privyUsers();
  const since = sinceSec(days);
  const names = new Map((db.prepare(`SELECT user_id, name FROM profiles`).all() as { user_id: string; name: string }[]).map((r) => [r.user_id, r.name]));
  const count = (sql: string) => new Map((db.prepare(sql).all() as { u: string; n: number }[]).map((r) => [r.u, r.n]));
  const practice = count(`SELECT user_id u, COUNT(*) n FROM paper_positions GROUP BY user_id`);
  const follows = count(`SELECT user_id u, COUNT(*) n FROM follows GROUP BY user_id`);
  const theses = count(`SELECT user_id u, COUNT(*) n FROM user_takes GROUP BY user_id`);
  // Real transactions, by the account's wallets (user_wallets links them).
  const real = count(`SELECT uw.user_id u, COUNT(*) n FROM wallet_activity wa JOIN user_wallets uw ON uw.wallet = wa.wallet
    WHERE wa.status = 'confirmed' AND wa.kind != 'approve' GROUP BY uw.user_id`);
  const signups = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) signups.set(dayOf(Math.floor(Date.now() / 1000) - i * 86_400), 0);
  for (const u of list) { const d = dayOf(u.created_at); if (signups.has(d)) signups.set(d, signups.get(d)! + 1); }
  const rows = list.map((u) => ({
    id: u.id, name: names.get(u.id) ?? null, joinedAt: u.created_at, ...loginOf(u),
    twoStep: (u.mfa_methods?.length ?? 0) > 0,
    wallets: (u.linked_accounts ?? []).filter((a) => a.type === "wallet").length,
    practiceTrades: practice.get(u.id) ?? 0, follows: follows.get(u.id) ?? 0, theses: theses.get(u.id) ?? 0, realTxs: real.get(u.id) ?? 0,
  })).sort((a, b) => b.joinedAt - a.joinedAt);
  const anon = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    days,
    total: list.length,
    newInWindow: list.filter((u) => u.created_at >= since).length,
    named: rows.filter((r) => r.name).length,
    twoStep: rows.filter((r) => r.twoStep).length,
    traders: rows.filter((r) => r.realTxs > 0).length,
    signups: [...signups.entries()].map(([day, n]) => ({ day, n })),
    // Devices that use FloorFeed without an account.
    anonymous: {
      practice: anon(`SELECT COUNT(DISTINCT user_id) n FROM paper_positions WHERE user_id LIKE 'dev-%'`),
      follows: anon(`SELECT COUNT(DISTINCT user_id) n FROM follows WHERE user_id LIKE 'dev-%'`),
      push: anon(`SELECT COUNT(DISTINCT user_id) n FROM push_subs`),
    },
    rows: rows.slice(0, 200),
  };
}

// --- Marketing ---

export function marketing(days: number) {
  const s = summary(days);
  const since = s.since;
  const campaigns = db.prepare(`SELECT COALESCE(source, '—') source, COALESCE(medium, '—') medium, COALESCE(campaign, '—') campaign,
      COUNT(DISTINCT day || visitor) visitors, COUNT(DISTINCT CASE WHEN name = 'sign_in' THEN day || visitor END) signins
    FROM events WHERE day >= ? AND (source IS NOT NULL OR campaign IS NOT NULL) GROUP BY 1, 2, 3 ORDER BY visitors DESC LIMIT 20`).all(since);
  // Which sources bring people who sign in or trade, not just visit.
  // A visitor's source is any tagged or external one they arrived with that day
  // (sign-in redirects aren't a source).
  const quality = db.prepare(`WITH v AS (SELECT day || visitor k, COALESCE(MAX(COALESCE(source,
      CASE WHEN referrer IN ('accounts.google.com', 'auth.privy.io') THEN NULL ELSE referrer END)), 'Direct') src FROM events WHERE day >= ? GROUP BY k)
    SELECT v.src source, COUNT(*) visitors,
      SUM(EXISTS (SELECT 1 FROM events e WHERE e.day || e.visitor = v.k AND e.name = 'sign_in')) signins,
      SUM(EXISTS (SELECT 1 FROM events e WHERE e.day || e.visitor = v.k AND e.name IN ('paper_buy', 'buy_signed', 'bridge_signed', 'mint_signed'))) traders
    FROM v GROUP BY v.src ORDER BY visitors DESC LIMIT 12`).all(since);
  const msSince = Date.now() - days * 86_400_000;
  const x = {
    posted: (db.prepare(`SELECT kind, COUNT(*) n FROM social_posts WHERE status = 'posted' AND posted_at >= ? GROUP BY kind ORDER BY n DESC`).all(msSince)) as { kind: string; n: number }[],
    queued: (db.prepare(`SELECT COUNT(*) n FROM social_posts WHERE status IN ('draft', 'approved') AND expires_at > ?`).get(Date.now()) as { n: number }).n,
    failed: (db.prepare(`SELECT COUNT(*) n FROM social_posts WHERE status = 'failed' AND created_at >= ?`).get(msSince) as { n: number }).n,
    lastPostedAt: (db.prepare(`SELECT MAX(posted_at) t FROM social_posts WHERE status = 'posted'`).get() as { t: number | null }).t,
    recent: db.prepare(`SELECT kind, text, post_url url, posted_at postedAt FROM social_posts WHERE status = 'posted' ORDER BY posted_at DESC LIMIT 8`).all(),
    fromX: (db.prepare(`SELECT COUNT(DISTINCT day || visitor) n FROM events WHERE day >= ? AND (referrer IN ('x.com', 't.co', 'twitter.com') OR LOWER(source) IN ('x', 'twitter'))`).get(since) as { n: number }).n,
  };
  // Every day in the window, quiet ones included.
  const byDay = new Map(s.daily.map((x) => [x.day, x]));
  const daily = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(d) ?? { day: d, visitors: 0, pageviews: 0 };
  });
  return { days, totals: s.totals, daily, sources: s.sources, pages: s.pages, countries: s.countries, devices: s.devices, funnel: s.funnel, events: s.events, campaigns, quality, x };
}

// --- Activity through FloorFeed (real transactions) ---

export function activity(days: number) {
  const since = sinceSec(days);
  const byKind = db.prepare(`SELECT kind, COUNT(*) n, COUNT(DISTINCT wallet) wallets FROM wallet_activity
    WHERE status = 'confirmed' AND kind != 'approve' AND created_at >= ? GROUP BY kind ORDER BY n DESC`).all(since);
  const volume = (db.prepare(`SELECT kind, unit, SUM(amount) amount, COUNT(*) n FROM wallet_activity
    WHERE status = 'confirmed' AND amount IS NOT NULL AND unit IS NOT NULL AND kind IN ('buy', 'sell', 'bridge', 'mint') AND created_at >= ?
    GROUP BY kind, unit`).all(since) as { kind: string; unit: string; amount: number; n: number }[])
    .map((r) => ({ ...r, usd: toUsd(r.amount, r.unit) }));
  const byChain = db.prepare(`SELECT chain, COUNT(*) n FROM wallet_activity WHERE status = 'confirmed' AND kind != 'approve' AND created_at >= ?
    GROUP BY chain ORDER BY n DESC`).all(since);
  const failed = db.prepare(`SELECT status, COUNT(*) n FROM wallet_activity WHERE status IN ('failed', 'dropped', 'refunded', 'pending', 'delivering')
    AND created_at >= ? GROUP BY status`).all(since);
  const recent = (db.prepare(`SELECT wa.created_at createdAt, wa.kind, wa.title, wa.chain, wa.amount, wa.unit, wa.status, wa.app_fee_usd feeUsd, p.name
    FROM wallet_activity wa LEFT JOIN user_wallets uw ON uw.wallet = wa.wallet LEFT JOIN profiles p ON p.user_id = uw.user_id
    WHERE wa.kind != 'approve' ORDER BY wa.created_at DESC LIMIT 30`).all());
  const practice = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT user_id) traders FROM paper_positions WHERE opened_at >= ?`).get(since * 1000);
  return { days, byKind, volume, byChain, failed, recent, practice };
}

// --- Moderation ---

export function moderation() {
  const takes = db.prepare(`SELECT t.id, t.collection, t.text, t.reports, t.hidden, t.created_at createdAt, p.name
    FROM user_takes t LEFT JOIN profiles p ON p.user_id = t.user_id WHERE t.reports > 0 OR t.hidden = 1 ORDER BY t.hidden DESC, t.reports DESC, t.id DESC LIMIT 50`).all();
  const launches = db.prepare(`SELECT l.id, l.name, l.symbol, l.chain, l.status, l.address, l.updated_at updatedAt, p.name owner,
      (SELECT COUNT(*) FROM launch_items i WHERE i.launch_id = l.id) items
    FROM launches l LEFT JOIN profiles p ON p.user_id = l.user_id ORDER BY l.updated_at DESC LIMIT 50`).all();
  return { takes, support: listReports("open", 50), launches };
}

export const restoreTake = (id: number) => {
  if (!db.prepare(`UPDATE user_takes SET hidden = 0, reports = 0 WHERE id = ?`).run(id).changes) return false;
  db.prepare(`DELETE FROM take_reports WHERE take_id = ?`).run(id);
  return true;
};

// Hidden launches drop off the mint hub and their public page; showing one
// puts it back as it was (live once deployed, else a draft).
export const setLaunchHidden = (id: string, hidden: boolean) =>
  db.prepare(`UPDATE launches SET status = CASE WHEN ? THEN 'hidden' WHEN address IS NOT NULL THEN 'live' ELSE 'draft' END, updated_at = ? WHERE id = ?`)
    .run(hidden ? 1 : 0, Date.now(), id).changes > 0;

// --- System ---

const started = Date.now();
export function system() {
  let dbBytes: number | null = null;
  try { dbBytes = statSync(config.dbPath).size + (statSync(`${config.dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0); } catch { /* unknown */ }
  const fresh = db.prepare(`SELECT COALESCE(c.chain, 'solana') chain, MAX(t.block_time) last, COUNT(*) n FROM trades t JOIN collections c ON c.symbol = t.collection
    WHERE t.block_time >= ? GROUP BY 1 ORDER BY last DESC`).all(sinceSec(1)) as { chain: string; last: number; n: number }[];
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    uptimeSec: Math.round((Date.now() - started) / 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    dbBytes,
    tradesByChain24h: fresh,
    lastEventAt: (db.prepare(`SELECT MAX(ts) t FROM events`).get() as { t: number | null }).t,
    tables: {
      trades: count(`SELECT COUNT(*) n FROM trades`),
      collections: count(`SELECT COUNT(*) n FROM collections`),
      events: count(`SELECT COUNT(*) n FROM events`),
      pushSubscribers: count(`SELECT COUNT(*) n FROM push_subs`),
      alerts: count(`SELECT COUNT(*) n FROM alerts`),
    },
    stuck: count(`SELECT COUNT(*) n FROM wallet_activity WHERE status IN ('pending', 'delivering') AND created_at < ${sinceSec(1)}`),
    config: {
      helius: !!config.heliusApiKey, privy: !!config.privyAppId, adminUsers: ADMINS.size,
      relayFeeBps: Number(process.env.RELAY_FEE_BPS ?? 0), buyFeeBps: Number(process.env.BUY_FEE_BPS ?? 0),
      launchChains: LAUNCH_CHAINS,
    },
  };
}

export function startAdmin() {
  const sync = () => void syncBridgeFees(20).catch(() => 0);
  setTimeout(sync, 30_000).unref();
  setInterval(sync, 10 * 60_000).unref();
}
