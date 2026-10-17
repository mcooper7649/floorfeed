import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { verifyMessage } from "viem";
import { ADDRESS_RE, hasDas, holdings } from "./chain.ts";
import { collectionName, config, isEvm } from "./config.ts";
import { db } from "./db.ts";
import { feeRates } from "./fees.ts";
import { traders } from "./feed.ts";
import { champions } from "./practice.ts";
import { tg } from "./social.ts";
import { EVM_ADDRESS_RE, evmHoldings } from "./trade-evm.ts";

// Takes: short posts about a collection by signed-in users (FOMO's "Thesis").
// A take can carry a holder badge ("Holder · 3 NFTs · +12%"): the author signs
// the take with their wallet, we check the signature, then read that wallet's
// NFTs in the collection. Likes, reports (3 hide a take pending review), and
// the author can delete their own.

db.exec(`
CREATE TABLE IF NOT EXISTS user_takes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  collection  TEXT NOT NULL,
  text        TEXT NOT NULL,
  wallet      TEXT,                 -- verified by signature, or NULL
  items       INTEGER,              -- NFTs the wallet held when posting
  pnl_pct     REAL,                 -- their position vs floor (after fees), when we know the cost
  floor       REAL,                 -- collection floor when posting (for the chart marker)
  created_at  INTEGER NOT NULL,     -- unix ms
  likes       INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS user_takes_coll ON user_takes(collection, created_at DESC);
CREATE TABLE IF NOT EXISTS take_likes (take_id INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (take_id, user_id));
CREATE TABLE IF NOT EXISTS take_reports (take_id INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (take_id, user_id));
-- Display names users pick for themselves (shown on their theses).
CREATE TABLE IF NOT EXISTS profiles (
  user_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  updated_at INTEGER NOT NULL
);
`);

// --- profiles ---------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const RESERVED = /^(floorfeed|admin|moderator|mod|support|official|ai|system|null|undefined)$/i;
const profileOf = db.prepare(`SELECT name, updated_at FROM profiles WHERE user_id = ?`);

const profileStats = db.prepare(`
  SELECT (SELECT COUNT(*) FROM user_takes WHERE user_id = @u AND hidden = 0) AS theses,
         (SELECT COALESCE(SUM(likes), 0) FROM user_takes WHERE user_id = @u AND hidden = 0) AS likes,
         (SELECT COUNT(*) FROM follows WHERE user_id = @u) AS following,
         (SELECT COUNT(*) FROM paper_positions WHERE user_id = @u) AS practiceTrades`);

// The signed-in user's own profile page and settings (GET /profile).
export function getProfile(userId: string) {
  const p = profileOf.get(userId) as { name: string; updated_at: number } | undefined;
  const stats = profileStats.get({ u: userId }) as { theses: number; likes: number; following: number; practiceTrades: number };
  return { name: p?.name ?? null, fallback: memberName(userId), nameChangedAt: p?.updated_at ?? null, stats };
}

// Why a name can't be used by this user, or null if it can (also the live
// "is it free?" check while typing during onboarding).
export function nameProblem(userId: string, raw: string): { error: string; status: number } | null {
  const name = raw.trim();
  if (!NAME_RE.test(name)) return { error: "Use 3–20 letters, numbers, dots, dashes or underscores.", status: 400 };
  if (RESERVED.test(name) || /floorfeed/i.test(name)) return { error: "That name is reserved.", status: 400 };
  const taken = db.prepare(`SELECT user_id FROM profiles WHERE name_lower = ?`).get(name.toLowerCase()) as { user_id: string } | undefined;
  if (taken && taken.user_id !== userId) return { error: "That name is taken.", status: 409 };
  return null;
}

export function setProfileName(userId: string, raw: string) {
  const name = raw.trim();
  const problem = nameProblem(userId, name);
  if (problem) throw new TakeError(problem.error, problem.status);
  const taken = db.prepare(`SELECT user_id FROM profiles WHERE name_lower = ?`).get(name.toLowerCase()) as { user_id: string } | undefined;
  const prev = profileOf.get(userId) as { updated_at: number } | undefined;
  if (prev && !taken && Date.now() - prev.updated_at < 60_000) throw new TakeError("You just changed your name. Try again in a minute.", 429);
  db.prepare(`INSERT INTO profiles (user_id, name, name_lower, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower, updated_at = excluded.updated_at`)
    .run(userId, name, name.toLowerCase(), Date.now());
  return { name };
}

const MAX_LEN = 280;
const HIDE_AT = 3;

export class TakeError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// The exact text a wallet signs. Binding the collection, the text and a
// timestamp keeps a signature from being reused for another post.
export const signedMessage = (collection: string, text: string, ts: number) =>
  `FloorFeed take\nCollection: ${collection}\nText: ${createHash("sha256").update(text).digest("hex").slice(0, 16)}\nTime: ${ts}`;

// --- signature checks -----------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

async function walletSigned(wallet: string, message: string, signature: string) {
  if (EVM_ADDRESS_RE.test(wallet)) {
    return verifyMessage({ address: wallet as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false);
  }
  if (!ADDRESS_RE.test(wallet)) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: base58(wallet).toString("base64url") }, format: "jwk" });
    return edVerify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// What the verified wallet holds in this collection, and how that position
// stands against the floor after selling fees (when we saw what it paid).
async function position(collection: string, wallet: string) {
  const evm = isEvm(collection);
  if (!evm && !hasDas()) return { items: null, pnlPct: null };
  const h = evm ? await evmHoldings(wallet) : await holdings(wallet);
  const mine = h.nfts.filter((n) => n.collection.symbol === collection);
  if (!mine.length) return { items: 0, pnlPct: null };
  const floor = mine[0].collection.floor;
  const paid = mine.flatMap((n) => (n.boughtAt != null ? [n.boughtAt] : []));
  if (floor == null || !paid.length) return { items: mine.length, pnlPct: null };
  const fee = feeRates(collection);
  const cost = paid.reduce((a, p) => a + p * (1 + fee.buyTaker), 0) / paid.length;
  const mark = floor * (1 - (evm ? fee.sellMaker : 0));
  return { items: mine.length, pnlPct: ((mark - cost) / cost) * 100 };
}

// --- posting ---------------------------------------------------------------------

const recentByUser = db.prepare(`SELECT COUNT(*) n FROM user_takes WHERE user_id = ? AND created_at > ?`);
const recentHere = db.prepare(`SELECT COUNT(*) n FROM user_takes WHERE user_id = ? AND collection = ? AND created_at > ?`);
const floorOf = db.prepare(`SELECT floor FROM collections WHERE symbol = ?`);
const insert = db.prepare(`INSERT INTO user_takes (user_id, collection, text, wallet, items, pnl_pct, floor, created_at)
                           VALUES (@userId, @collection, @text, @wallet, @items, @pnlPct, @floor, @now)`);

export async function postTake(userId: string, b: {
  collection: string; text: string; wallet?: string; signature?: string; ts?: number;
}) {
  const text = b.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 3) throw new TakeError("Write a little more.");
  if (text.length > MAX_LEN) throw new TakeError(`Keep it under ${MAX_LEN} characters.`);
  if (/https?:\/\/|www\.|\.(com|io|xyz|gg|link)\b/i.test(text)) throw new TakeError("Links aren't allowed in takes.");
  const now = Date.now();
  if ((recentByUser.get(userId, now - 86_400_000) as { n: number }).n >= 10) throw new TakeError("That's 10 takes today. Try again tomorrow.", 429);
  if ((recentHere.get(userId, b.collection, now - 10 * 60_000) as { n: number }).n >= 1) {
    throw new TakeError("One take per collection every 10 minutes.", 429);
  }
  const floor = (floorOf.get(b.collection) as { floor: number | null } | undefined);
  if (!floor) throw new TakeError("Unknown collection.", 404);

  let wallet: string | null = null;
  let pos: { items: number | null; pnlPct: number | null } = { items: null, pnlPct: null };
  if (b.wallet && b.signature && b.ts) {
    if (Math.abs(now - b.ts * 1000) > 10 * 60_000) throw new TakeError("The wallet signature expired. Try again.");
    if (!(await walletSigned(b.wallet, signedMessage(b.collection, text, b.ts), b.signature))) {
      throw new TakeError("The wallet signature didn't check out.");
    }
    wallet = EVM_ADDRESS_RE.test(b.wallet) ? b.wallet.toLowerCase() : b.wallet;
    pos = await position(b.collection, wallet).catch(() => ({ items: null, pnlPct: null }));
  }
  const r = insert.run({ userId, collection: b.collection, text, wallet, items: pos.items, pnlPct: pos.pnlPct, floor: floor.floor, now });
  return { id: Number(r.lastInsertRowid) };
}

// --- reading ---------------------------------------------------------------------

type Row = {
  id: number; user_id: string; collection: string; text: string; wallet: string | null; items: number | null;
  pnl_pct: number | null; floor: number | null; created_at: number; likes: number;
};
const list = db.prepare(`SELECT * FROM user_takes WHERE collection = ? AND hidden = 0 ORDER BY created_at DESC LIMIT ?`);
const likedBy = db.prepare(`SELECT take_id FROM take_likes WHERE user_id = ? AND take_id IN (SELECT id FROM user_takes WHERE collection = ?)`);
// The AI takes FloorFeed writes for notable buys, shown alongside (labelled).
const aiTakes = db.prepare(`
  SELECT k.signature, k.text, k.created_at, t.buyer, t.price, t.mint, t.block_time
  FROM takes k JOIN trades t ON t.signature = k.signature
  WHERE t.collection = ? ORDER BY t.block_time DESC LIMIT 10`);

// A stable, non-identifying name for authors without a chosen name or a verified wallet.
export function memberName(userId: string) { return `Member ${createHash("sha256").update(userId).digest("hex").slice(0, 4)}`; }

// Who wrote a thesis: their chosen name, else the verified wallet's .sol/ENS
// name, else the short wallet address, else "Member ab12".
const nameOf = db.prepare(`SELECT name FROM profiles WHERE user_id = ?`);
type Who = { name: string | null; avatar: string | null; tier: string | null } | null | undefined;
export function authorOf(r: { user_id: string; wallet: string | null }, w: Who) {
  const chosen = (nameOf.get(r.user_id) as { name: string } | undefined)?.name ?? null;
  const short = r.wallet ? `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}` : null;
  return {
    name: chosen ?? w?.name ?? short ?? memberName(r.user_id),
    walletName: w?.name ?? short, // shown next to a chosen name
    avatar: w?.avatar ?? null, wallet: r.wallet, tier: (w?.tier ?? null) as "elite" | "pro" | "mm" | "new" | null,
    champ: champions().get(r.user_id) ?? null, // 1–3: top of last week's practice season
  };
}

export function collectionTakes(collection: string, viewer: string | null) {
  const rows = list.all(collection, 60) as Row[];
  const liked = new Set(viewer ? (likedBy.all(viewer, collection) as { take_id: number }[]).map((r) => r.take_id) : []);
  const ai = aiTakes.all(collection) as { signature: string; text: string; created_at: number; buyer: string; price: number; mint: string; block_time: number }[];
  const who = traders([...rows.flatMap((r) => (r.wallet ? [r.wallet] : [])), ...ai.map((a) => a.buyer)]);
  const user = rows.map((r) => {
    const w = r.wallet ? who.get(r.wallet) : null;
    return {
      kind: "user" as const, id: r.id, text: r.text, t: Math.floor(r.created_at / 1000),
      author: authorOf(r, w), 
      holder: r.wallet && r.items != null && r.items > 0 ? { items: r.items, pnlPct: r.pnl_pct } : null,
      verified: r.wallet != null,
      floor: r.floor, likes: r.likes, liked: liked.has(r.id), mine: viewer === r.user_id,
    };
  });
  const aiRows = ai.map((a) => ({
    kind: "ai" as const, id: a.signature, text: a.text, t: a.block_time,
    trade: { buyer: a.buyer, buyerName: who.get(a.buyer)?.name ?? null, price: a.price, mint: a.mint },
  }));
  return [...user, ...aiRows].sort((x, y) => y.t - x.t);
}

// --- likes, reports, deletes ------------------------------------------------------

export function toggleLike(id: number, userId: string) {
  const had = db.prepare(`DELETE FROM take_likes WHERE take_id = ? AND user_id = ?`).run(id, userId).changes > 0;
  if (!had) db.prepare(`INSERT OR IGNORE INTO take_likes (take_id, user_id) VALUES (?, ?)`).run(id, userId);
  db.prepare(`UPDATE user_takes SET likes = (SELECT COUNT(*) FROM take_likes WHERE take_id = ?) WHERE id = ?`).run(id, id);
  const likes = (db.prepare(`SELECT likes FROM user_takes WHERE id = ?`).get(id) as { likes: number } | undefined)?.likes;
  if (likes == null) throw new TakeError("Not found.", 404);
  return { liked: !had, likes };
}

export async function reportTake(id: number, userId: string) {
  const t = db.prepare(`SELECT * FROM user_takes WHERE id = ?`).get(id) as (Row & { reports: number; hidden: number }) | undefined;
  if (!t) throw new TakeError("Not found.", 404);
  if (!db.prepare(`INSERT OR IGNORE INTO take_reports (take_id, user_id) VALUES (?, ?)`).run(id, userId).changes) return { ok: true };
  const reports = t.reports + 1;
  db.prepare(`UPDATE user_takes SET reports = ?, hidden = CASE WHEN ? >= ${HIDE_AT} THEN 1 ELSE hidden END WHERE id = ?`).run(reports, reports, id);
  // Tell the admin chat; deleting is DELETE /admin/takes/:id.
  if (config.telegramBotToken && config.telegramChatId) {
    await tg("sendMessage", {
      chat_id: config.telegramChatId,
      text: `Take #${id} reported (${reports}/${HIDE_AT}${reports >= HIDE_AT ? ", now hidden" : ""}) on ${t.collection}:\n\n${t.text}`,
    }).catch(() => {});
  }
  return { ok: true };
}

export function deleteTake(id: number, userId: string | null) {
  const r = userId
    ? db.prepare(`DELETE FROM user_takes WHERE id = ? AND user_id = ?`).run(id, userId)
    : db.prepare(`DELETE FROM user_takes WHERE id = ?`).run(id); // admin
  if (!r.changes) throw new TakeError("Not found.", 404);
  db.prepare(`DELETE FROM take_likes WHERE take_id = ?`).run(id);
  db.prepare(`DELETE FROM take_reports WHERE take_id = ?`).run(id);
  return { ok: true };
}

// Takes as chart markers: posted when the floor was here.
export function takeMarkers(collection: string, sinceSec: number) {
  return (db.prepare(`SELECT * FROM user_takes WHERE collection = ? AND hidden = 0 AND created_at >= ? AND floor IS NOT NULL ORDER BY created_at DESC LIMIT 40`)
    .all(collection, sinceSec * 1000) as Row[]);
}

// --- the live thesis feed (all collections) ---------------------------------------------

const recentAll = db.prepare(`SELECT * FROM user_takes WHERE hidden = 0 ORDER BY created_at DESC LIMIT ?`);
const recentAi = db.prepare(`
  SELECT k.signature, k.text, t.collection, t.buyer, t.price, t.mint, t.block_time
  FROM takes k JOIN trades t ON t.signature = k.signature
  ORDER BY t.block_time DESC LIMIT ?`);
const collInfo = db.prepare(`SELECT image, COALESCE(sale_currency, currency) AS currency, chain FROM collections WHERE symbol = ?`);

export function recentTheses(limit: number, viewer: string | null, withAi: boolean) {
  const rows = recentAll.all(limit) as Row[];
  const ai = withAi ? (recentAi.all(limit) as { signature: string; text: string; collection: string; buyer: string; price: number; mint: string; block_time: number }[]) : [];
  const liked = new Set(viewer ? (db.prepare(`SELECT take_id FROM take_likes WHERE user_id = ?`).all(viewer) as { take_id: number }[]).map((r) => r.take_id) : []);
  const who = traders([...rows.flatMap((r) => (r.wallet ? [r.wallet] : [])), ...ai.map((a) => a.buyer)]);
  const coll = (symbol: string) => {
    const c = (collInfo.get(symbol) ?? {}) as { image?: string | null; currency?: string | null; chain?: string | null };
    return { symbol, name: collectionName(symbol), image: c.image ?? null, currency: c.currency ?? "SOL", chain: c.chain ?? "solana" };
  };
  const user = rows.map((r) => ({
    kind: "user" as const, id: r.id, text: r.text, t: Math.floor(r.created_at / 1000), collection: coll(r.collection),
    author: authorOf(r, r.wallet ? who.get(r.wallet) : null),
    holder: r.wallet && r.items != null && r.items > 0 ? { items: r.items, pnlPct: r.pnl_pct } : null,
    verified: r.wallet != null, likes: r.likes, liked: liked.has(r.id), mine: viewer === r.user_id,
  }));
  const aiRows = ai.map((a) => ({
    kind: "ai" as const, id: a.signature, text: a.text, t: a.block_time, collection: coll(a.collection),
    trade: { buyer: a.buyer, buyerName: who.get(a.buyer)?.name ?? null, price: a.price, mint: a.mint },
  }));
  return [...user, ...aiRows].sort((x, y) => y.t - x.t).slice(0, limit);
}
