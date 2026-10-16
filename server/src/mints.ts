import { parseAbi, parseAbiItem, zeroAddress, type Hex } from "viem";
import { EVM_CHAINS } from "./config.ts";
import { db } from "./db.ts";
import { mintingDrops, type Drop } from "./discover.ts";
import { pushTo } from "./alerts.ts";
import { provenWallets, traders } from "./feed.ts";
import { getOsInfo } from "./opensea.ts";
import { evmPublicClient, isTradableChain } from "./trade-evm.ts";

// The Mint hub: OpenSea drops (discover.ts mintingDrops) plus what FloorFeed
// measures itself on chain, every 2 minutes, for drops that are minting:
// - supply snapshots (totalSupply / maxSupply) → progress and mint speed;
// - mint events (Transfer from 0x0) → who minted, matched against proven
//   flippers.
// Plus "remind me" pushes a few minutes before an upcoming stage opens.

db.exec(`
CREATE TABLE IF NOT EXISTS drop_supply (
  slug TEXT NOT NULL, ts INTEGER NOT NULL, minted INTEGER NOT NULL,
  PRIMARY KEY (slug, ts)
);
CREATE TABLE IF NOT EXISTS drop_minters (
  chain TEXT NOT NULL, contract TEXT NOT NULL, minter TEXT NOT NULL,
  n INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (chain, contract, minter)
);
CREATE TABLE IF NOT EXISTS drop_meta (
  slug TEXT PRIMARY KEY, verified INTEGER NOT NULL, checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drop_reminders (
  user_id TEXT NOT NULL, slug TEXT NOT NULL, starts_at INTEGER NOT NULL,
  name TEXT NOT NULL, image TEXT, stage TEXT, sent_at INTEGER,
  PRIMARY KEY (user_id, slug, starts_at)
);
`);

const EVERY = 2 * 60_000;
// Max supplies this large are open editions: no progress bar.
const OPEN_EDITION = 10_000_000;
const SUPPLY_ABI = parseAbi(["function totalSupply() view returns (uint256)", "function maxSupply() view returns (uint256)"]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

const state = {
  get: db.prepare(`SELECT value FROM app_state WHERE key = ?`),
  set: db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};
const insertSupply = db.prepare(`INSERT OR REPLACE INTO drop_supply (slug, ts, minted) VALUES (?, ?, ?)`);
const addMinter = db.prepare(`
  INSERT INTO drop_minters (chain, contract, minter, n, first_at, last_at) VALUES (@chain, @contract, @minter, @n, @at, @at)
  ON CONFLICT(chain, contract, minter) DO UPDATE SET n = n + excluded.n, last_at = MAX(last_at, excluded.last_at)`);

const supplyAt = db.prepare(`SELECT minted, ts FROM drop_supply WHERE slug = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`);
const oldestSupply = db.prepare(`SELECT minted, ts FROM drop_supply WHERE slug = ? AND ts >= ? ORDER BY ts ASC LIMIT 1`);
const latestSupply = db.prepare(`SELECT minted, ts FROM drop_supply WHERE slug = ? ORDER BY ts DESC LIMIT 1`);
const maxCache = new Map<string, { at: number; max: number | null }>();
// OpenSea verified badges, kept in drop_meta (rechecked after 12h).
const verified = new Map<string, { at: number; v: boolean }>(
  (db.prepare(`SELECT slug, verified, checked_at FROM drop_meta`).all() as { slug: string; verified: number; checked_at: number }[])
    .map((r) => [r.slug, { at: r.checked_at, v: !!r.verified }]));
const saveMeta = db.prepare(`INSERT OR REPLACE INTO drop_meta (slug, verified, checked_at) VALUES (?, ?, ?)`);

// Block number → time, from two anchor blocks per chain (refreshed hourly).
const clocks = new Map<string, { at: number; block: bigint; ts: number; secsPerBlock: number }>();
async function clock(chain: string) {
  const hit = clocks.get(chain);
  if (hit && Date.now() - hit.at < 3_600_000) return hit;
  const c = evmPublicClient(chain);
  const latest = await c.getBlock();
  const back = latest.number > 1000n ? 1000n : latest.number;
  const older = await c.getBlock({ blockNumber: latest.number - back });
  const secsPerBlock = Math.max(0.05, (Number(latest.timestamp) - Number(older.timestamp)) / Number(back || 1n));
  const v = { at: Date.now(), block: latest.number, ts: Number(latest.timestamp), secsPerBlock };
  clocks.set(chain, v);
  return v;
}
const timeOf = (k: { block: bigint; ts: number; secsPerBlock: number }, block: bigint) =>
  Math.round(k.ts + Number(block - k.block) * k.secsPerBlock);

async function snapshot(d: Drop & { contract: string }) {
  const c = evmPublicClient(d.chain);
  const address = d.contract as Hex;
  const minted = await c.readContract({ address, abi: SUPPLY_ABI, functionName: "totalSupply" }).catch(() => null);
  if (minted != null) insertSupply.run(d.slug, Math.floor(Date.now() / 1000), Number(minted));
  const m = maxCache.get(d.slug);
  if (!m || Date.now() - m.at > 3_600_000) {
    const max = await c.readContract({ address, abi: SUPPLY_ABI, functionName: "maxSupply" }).catch(() => null);
    maxCache.set(d.slug, { at: Date.now(), max: max != null ? Number(max) : null });
  }
}

// New mint events since the last run. A newly seen drop starts a day back and
// catches up a few chunks per run.
async function scanMints(d: Drop & { contract: string }) {
  const c = evmPublicClient(d.chain);
  const k = await clock(d.chain);
  const latest = await c.getBlockNumber();
  const key = `mintcur:${d.chain}:${d.contract.toLowerCase()}`;
  const saved = (state.get.get(key) as { value: string } | undefined)?.value;
  const lookback = BigInt(Math.min(400_000, Math.ceil(86_400 / k.secsPerBlock)));
  let from = saved ? BigInt(saved) + 1n : latest - lookback;
  let size = 2_000n;
  for (let i = 0; i < 10 && from <= latest; i++) {
    const to = from + size - 1n < latest ? from + size - 1n : latest;
    let logs;
    try {
      logs = await c.getLogs({ address: d.contract as Hex, event: TRANSFER, args: { from: zeroAddress }, fromBlock: from, toBlock: to });
    } catch {
      if (size <= 100n) return; // this RPC won't serve it; try again next run
      size /= 4n;
      continue;
    }
    const byMinter = new Map<string, { n: number; at: number }>();
    for (const l of logs) {
      const minter = String(l.args.to).toLowerCase();
      const at = timeOf(k, l.blockNumber);
      const e = byMinter.get(minter) ?? { n: 0, at };
      byMinter.set(minter, { n: e.n + 1, at: Math.max(e.at, at) });
    }
    db.transaction(() => {
      for (const [minter, e] of byMinter) addMinter.run({ chain: d.chain, contract: d.contract.toLowerCase(), minter, n: e.n, at: e.at });
      state.set.run(key, String(to));
    })();
    from = to + 1n;
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const drops = await mintingDrops();
    const live = drops.filter((d): d is Drop & { contract: string } => d.minting && !!d.contract && isTradableChain(d.chain));
    for (const d of live) {
      await snapshot(d).catch(() => {});
      await scanMints(d).catch((err) => console.warn("[mints]", d.slug, (err as Error).message.slice(0, 120)));
    }
    // Ended drops: an hourly count, so "Minted out" can show how far they got.
    for (const d of drops) {
      if (d.minting || !d.contract || !isTradableChain(d.chain)) continue;
      const last = latestSupply.get(d.slug) as { ts: number } | undefined;
      if (last && Date.now() / 1000 - last.ts < 3600) continue;
      await snapshot(d as Drop & { contract: string }).catch(() => {});
    }
    // Verified badges: a few OpenSea lookups per run, kept for 12h.
    let n = 0;
    for (const d of drops) {
      const v = verified.get(d.slug);
      if (v && Date.now() - v.at < 12 * 3_600_000) continue;
      if (n++ >= 12) break;
      const info = await getOsInfo(d.slug).catch(() => null);
      if (info) { verified.set(d.slug, { at: Date.now(), v: info.verified }); saveMeta.run(d.slug, info.verified ? 1 : 0, Date.now()); }
    }
    const cutoff = Math.floor(Date.now() / 1000);
    db.prepare(`DELETE FROM drop_supply WHERE ts < ?`).run(cutoff - 2 * 86_400);
    db.prepare(`DELETE FROM drop_minters WHERE last_at < ?`).run(cutoff - 30 * 86_400);
  } catch (err) {
    console.warn("[mints]", (err as Error).message);
  } finally {
    running = false;
  }
}

// --- the hub ---

const mintersOf = db.prepare(`SELECT minter, n, last_at FROM drop_minters WHERE chain = ? AND contract = ? ORDER BY last_at DESC`);

export type HubDrop = Drop & {
  section: "live" | "upcoming" | "done";
  chainName: string;
  supported: boolean;
  verified: boolean | null;
  minted: number | null;
  max: number | null; // null: unknown or open edition
  openEdition: boolean;
  mints10m: number | null;
  mints1h: number | null;
  minters: number;
  proven: { count: number; wallets: { wallet: string; name: string | null; avatar: string | null; tier: string | null }[] };
};

export async function mintHub() {
  const drops = await mintingDrops();
  const now = Math.floor(Date.now() / 1000);
  const proven = provenWallets();
  const out: HubDrop[] = drops.map((d) => {
    const last = latestSupply.get(d.slug) as { minted: number; ts: number } | undefined;
    const fresh = last && now - last.ts < (d.minting ? 15 * 60 : 3 * 3600) ? last : undefined;
    const diff = (secs: number) => {
      if (!fresh) return null;
      // The snapshot from `secs` ago; while there's less history, the oldest one if it covers half the window.
      const then = (supplyAt.get(d.slug, now - secs) ?? oldestSupply.get(d.slug, now - secs)) as { minted: number; ts: number } | undefined;
      return then && fresh.ts - then.ts >= secs * 0.5 ? Math.max(0, fresh.minted - then.minted) : null;
    };
    const rawMax = maxCache.get(d.slug)?.max ?? null;
    const openEdition = rawMax != null && rawMax >= OPEN_EDITION;
    const max = rawMax != null && rawMax > 0 && !openEdition ? rawMax : null;
    const minted = fresh?.minted ?? null;
    const soldOut = minted != null && max != null && minted >= max;
    const ms = d.contract ? (mintersOf.all(d.chain, d.contract.toLowerCase()) as { minter: string; n: number }[]) : [];
    const pro = ms.filter((m) => proven.has(m.minter));
    const top = pro.sort((a, b) => (proven.get(b.minter) === "elite" ? 1 : 0) - (proven.get(a.minter) === "elite" ? 1 : 0)).slice(0, 3);
    const who = traders(top.map((m) => m.minter));
    const section: HubDrop["section"] = d.minting && !soldOut ? "live" : !d.minting && d.startsAt && d.startsAt > now ? "upcoming" : "done";
    return {
      ...d, section,
      chainName: (EVM_CHAINS as Record<string, { name: string }>)[d.chain]?.name ?? d.chain,
      supported: isTradableChain(d.chain),
      verified: verified.get(d.slug)?.v ?? null,
      minted, max, openEdition, mints10m: diff(600), mints1h: diff(3600),
      minters: ms.length,
      proven: {
        count: pro.length,
        wallets: top.map((m) => ({ wallet: m.minter, name: who.get(m.minter)?.name ?? null, avatar: who.get(m.minter)?.avatar ?? null, tier: who.get(m.minter)?.tier ?? null })),
      },
    };
  });
  // Live: hottest first (mint speed, then proven minters, then featured). Upcoming: soonest first.
  const heat = (x: HubDrop) => (x.mints1h ?? 0) + (x.mints10m ?? 0) * 3 + x.proven.count * 20 + (x.featured ? 5 : 0);
  out.sort((a, b) => {
    const order = { live: 0, upcoming: 1, done: 2 };
    if (a.section !== b.section) return order[a.section] - order[b.section];
    if (a.section === "live") return heat(b) - heat(a);
    if (a.section === "upcoming") return (a.startsAt ?? 0) - (b.startsAt ?? 0);
    return 0;
  });
  return { drops: out, at: now };
}

// Per-drop numbers for the drop page.
export async function dropActivity(slug: string) {
  const hub = await mintHub();
  const d = hub.drops.find((x) => x.slug === slug);
  return d ? { mints10m: d.mints10m, mints1h: d.mints1h, minters: d.minters, proven: d.proven, verified: d.verified } : null;
}

// --- reminders ---

export function reminders(userId: string) {
  return (db.prepare(`SELECT slug, starts_at AS startsAt FROM drop_reminders WHERE user_id = ? AND starts_at > ?`)
    .all(userId, Math.floor(Date.now() / 1000) - 3600) as { slug: string; startsAt: number }[]);
}

export async function setReminder(userId: string, slug: string, on: boolean) {
  if (!on) {
    db.prepare(`DELETE FROM drop_reminders WHERE user_id = ? AND slug = ? AND sent_at IS NULL`).run(userId, slug);
    return { ok: true, on: false };
  }
  // The start time comes from the drop list, not the client.
  const d = (await mintingDrops()).find((x) => x.slug === slug);
  const now = Math.floor(Date.now() / 1000);
  if (!d || !d.startsAt || d.startsAt <= now) throw new Error("This drop has no upcoming stage to remind you about.");
  db.prepare(`INSERT OR IGNORE INTO drop_reminders (user_id, slug, starts_at, name, image, stage) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, slug, d.startsAt, d.name, d.image, d.stage);
  return { ok: true, on: true, startsAt: d.startsAt };
}

const LEAD = 5 * 60; // remind this long before the stage opens
async function sendReminders() {
  const now = Math.floor(Date.now() / 1000);
  const due = db.prepare(`SELECT * FROM drop_reminders WHERE sent_at IS NULL AND starts_at <= ? AND starts_at > ?`)
    .all(now + LEAD, now - 1800) as { user_id: string; slug: string; starts_at: number; name: string; image: string | null; stage: string | null }[];
  for (const r of due) {
    db.prepare(`UPDATE drop_reminders SET sent_at = ? WHERE user_id = ? AND slug = ? AND starts_at = ?`).run(now, r.user_id, r.slug, r.starts_at);
    const mins = Math.round((r.starts_at - now) / 60);
    await pushTo(r.user_id, [{
      title: mins > 0 ? `${r.name} mints in ${mins} min` : `${r.name} is minting now`,
      body: `${r.stage ?? "Next stage"} opens${mins > 0 ? " soon" : ""}. Tap to mint on FloorFeed.`,
      url: `/drop/${encodeURIComponent(r.slug)}`, image: r.image, tag: `remind:${r.slug}:${r.starts_at}`,
    }]).catch((err) => console.warn("[mints] remind", (err as Error).message));
  }
}

export function startMints() {
  void tick();
  setInterval(() => void tick(), EVERY);
  setInterval(() => void sendReminders(), 60_000);
}
