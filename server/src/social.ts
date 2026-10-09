import { createHash } from "node:crypto";
import { cachedTake, getTake } from "./ai.ts";
import { listCollections } from "./collections.ts";
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import { walletStats } from "./pnl.ts";
import { traderLeaderboard, traderProfile } from "./traders.ts";

// Drafts X posts from FloorFeed's own data. Each draft is sent to Telegram
// with Post / Skip buttons (or approved automatically for kinds listed in
// SOCIAL_AUTO_APPROVE); approved posts are published by the browser poster
// (tools/x-poster), which pulls them from GET /social/next.

export type Kind = "movers" | "bigsale" | "smartbuy" | "flipper";
export const KINDS: Kind[] = ["movers", "bigsale", "smartbuy", "flipper"];

type Draft = { kind: Kind; key: string; text: string; image: string | null; ttlMs: number };

export type SocialPost = {
  id: number; kind: Kind; key: string; text: string; image: string | null; status: string;
  created_at: number; expires_at: number; posted_at: number | null; post_url: string | null;
  attempts: number; tg_chat: string | null; tg_message: number | null;
};

const HOUR = 3_600_000;
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const sol = (n: number) => `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} SOL`;
const pct = (n: number) => `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const link = (path: string) => `${config.siteUrl}${path}`;

// Stable per-key choice so a regenerated draft reads the same, while
// different days rotate through the phrasings.
function pick<T>(key: string, options: T[]): T {
  const h = createHash("sha256").update(key).digest().readUInt32BE(0);
  return options[h % options.length];
}

// X counts every URL as 23 characters.
export const xLength = (text: string) => text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;

// Join lines, dropping optional ones (null) and then trailing extras until it fits.
function compose(required: string[], optional: (string | null)[], tail: string) {
  const extra = optional.filter((l): l is string => !!l);
  for (let n = extra.length; n >= 0; n--) {
    const text = [...required, ...extra.slice(0, n), tail].join("\n");
    if (xLength(text) <= 280) return text;
  }
  return null;
}

// --- Generators ---------------------------------------------------------

function movers(key: string): Draft | null {
  const rows = listCollections().filter(
    (c) => c.chain === "solana" && c.floor != null && c.floor >= 0.05 && c.change24hPct != null,
  );
  const up = rows.filter((c) => c.change24hPct! >= 3).sort((a, b) => b.change24hPct! - a.change24hPct!).slice(0, 3);
  const down = rows.filter((c) => c.change24hPct! <= -3).sort((a, b) => a.change24hPct! - b.change24hPct!).slice(0, 3);
  if (up.length + down.length < 2) return null;
  const line = (c: (typeof rows)[number]) =>
    `${c.change24hPct! > 0 ? "▲" : "▼"} ${c.name} ${sol(c.floor!)} (${pct(c.change24hPct!)})`;
  const head = pick(key, [
    "Solana NFT floors, last 24h:",
    "24h floor movers on Solana:",
    "Who moved overnight? Solana NFT floors, 24h:",
    "Floor check, last 24 hours:",
  ]);
  const text = compose([head, ""], [...up.map(line), ...down.map(line)], `\nAll floors live: ${link("/markets")}`);
  const top = [...up, ...down].sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))[0];
  return text ? { kind: "movers", key, text, image: top.image, ttlMs: 6 * HOUR } : null;
}

type SaleRow = {
  signature: string; collection: string; buyer: string; price: number; image: string | null;
  floor: number | null; avg_24h: number | null; volume_7d: number | null;
};

function bigSale(key: string): Draft | null {
  const s = db.prepare(`
    SELECT t.signature, t.collection, t.buyer, t.price, t.image, c.floor, c.avg_24h, c.volume_7d
    FROM trades t JOIN collections c ON c.symbol = t.collection
    WHERE t.block_time >= ? ORDER BY t.price DESC LIMIT 1`).get(Math.floor(Date.now() / 1000) - 86_400) as SaleRow | undefined;
  if (!s) return null;
  const name = collectionName(s.collection);
  const vsFloor = s.floor ? ((s.price - s.floor) / s.floor) * 100 : null;
  const head = pick(key, [
    `Biggest Solana NFT sale of the last 24h: a ${name} for ${sol(s.price)}.`,
    `Top sale today: ${sol(s.price)} for a ${name}.`,
    `Someone just paid ${sol(s.price)} for a ${name}. Biggest sale we tracked in 24h.`,
  ]);
  const floorLine = vsFloor != null && Math.abs(vsFloor) >= 5
    ? `That's ${pct(vsFloor)} vs the ${sol(s.floor!)} floor.`
    : s.floor ? `Floor is ${sol(s.floor)}.` : null;
  const b = walletStats(s.buyer);
  const buyerLine = b.flips >= 3 ? `Buyer's tracked record: ${b.wins}/${b.flips} profitable flips.` : null;
  const text = compose([head], [floorLine, buyerLine], `\n${link(`/collection/${s.collection}`)}`);
  return text ? { kind: "bigsale", key, text, image: s.image, ttlMs: 8 * HOUR } : null;
}

// A recent buy by a wallet with a real track record, with its AI take.
async function smartBuy(key: string): Promise<Draft | null> {
  const recent = db.prepare(`
    SELECT t.signature, t.collection, t.buyer, t.price, t.image, c.floor, c.avg_24h, c.volume_7d
    FROM trades t JOIN collections c ON c.symbol = t.collection
    WHERE t.block_time >= ? AND t.price >= 0.5 ORDER BY t.block_time DESC LIMIT 200`)
    .all(Math.floor(Date.now() / 1000) - 3 * 3600) as SaleRow[];
  let best: { s: SaleRow; p: ReturnType<typeof traderProfile> } | null = null;
  const seen = new Set<string>();
  for (const s of recent) {
    if (seen.has(s.buyer)) continue;
    seen.add(s.buyer);
    const p = traderProfile(s.buyer);
    if (p.likelyMarketMaker || p.flips < 5 || (p.winRate ?? 0) < 0.6 || p.realizedSol < 3) continue;
    if (!best || p.realizedSol > best.p.realizedSol) best = { s, p };
  }
  if (!best) return null;
  const { s, p } = best;
  const k = `${key}:${s.signature}`;
  if (db.prepare("SELECT 1 FROM social_posts WHERE key = ?").get(k)) return null;
  const name = collectionName(s.collection);
  const head = pick(k, [
    `Smart money just bought a ${name} for ${sol(s.price)}.`,
    `Wallet ${short(s.buyer)} just bought a ${name} at ${sol(s.price)}.`,
    `Fresh buy from a proven flipper: ${name}, ${sol(s.price)}.`,
  ]);
  const record = `Record: ${p.wins}/${p.flips} profitable flips, ${p.realizedSol >= 0 ? "+" : ""}${sol(p.realizedSol)} realized.`;
  let take: string | null = cachedTake(s.signature)?.text ?? null;
  if (!take) {
    take = await Promise.race([
      getTake({ signature: s.signature, collection: s.collection, price: s.price, floor: s.floor,
        avg24h: s.avg_24h, volume7d: s.volume_7d, buyer: walletStats(s.buyer) }).then((t) => t?.text ?? null).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 45_000)),
    ]);
  }
  // The take goes before the record line, so if both don't fit the record
  // (which the take usually cites anyway) is what gets dropped.
  const text = take
    ? compose([head], [`AI take: ${take}`, record], `\nCopy it on FloorFeed: ${link(`/wallet/${s.buyer}`)}`)
    : compose([head, record], [], `\nCopy it on FloorFeed: ${link(`/wallet/${s.buyer}`)}`);
  return text ? { kind: "smartbuy", key: k, text, image: s.image, ttlMs: 2 * HOUR } : null;
}

function flipper(key: string): Draft | null {
  const top = traderLeaderboard({ windowDays: 7, sort: "pnl", minFlips: 3, hideMarketMakers: true, limit: 1 }).rows[0];
  if (!top || top.realizedSol <= 0) return null;
  const head = pick(key, [
    "Top flipper of the week on FloorFeed:",
    "This week's best Solana NFT flipper:",
    "Weekly leaderboard, #1:",
  ]);
  const stats = `${short(top.wallet)}: +${sol(top.realizedSol)} realized on ${top.flips} flips, ${Math.round((top.winRate ?? 0) * 100)}% win rate.`;
  const bestLine = top.bestFlip && top.bestFlip.pnlSol > 0 ? `Best flip: ${top.bestFlip.collection}, +${sol(top.bestFlip.pnlSol)}.` : null;
  const text = compose([head, stats], [bestLine], `\nFollow their trades: ${link(`/wallet/${top.wallet}`)}`);
  const img = top.bestFlip
    ? (db.prepare("SELECT image FROM collections WHERE symbol = ?").get(top.bestFlip.symbol) as { image: string | null } | undefined)?.image ?? null
    : null;
  return text ? { kind: "flipper", key, text, image: img, ttlMs: 12 * HOUR } : null;
}

// When each kind is due (UTC). Keys make each slot fire once.
function slotKey(kind: Kind, now = new Date()): string | null {
  const h = now.getUTCHours();
  switch (kind) {
    case "movers": return h >= 14 ? `movers:${day()}` : null;    // ~10am ET
    case "bigsale": return h >= 22 ? `bigsale:${day()}` : null;  // ~6pm ET
    case "smartbuy": {                                            // at most one a day, US daytime
      if (h < 15 && h > 2) return null;
      const today = db.prepare("SELECT 1 FROM social_posts WHERE kind = 'smartbuy' AND created_at >= ?")
        .get(Date.parse(day()));
      return today ? null : `smartbuy:${day()}`;
    }
    case "flipper": return now.getUTCDay() === 5 && h >= 17 ? `flipper:${day()}` : null; // Fridays
  }
}

export async function generate(kind: Kind, key: string): Promise<Draft | null> {
  switch (kind) {
    case "movers": return movers(key);
    case "bigsale": return bigSale(key);
    case "smartbuy": return smartBuy(key);
    case "flipper": return flipper(key);
  }
}

// --- Storage ------------------------------------------------------------

const insert = db.prepare(`INSERT OR IGNORE INTO social_posts (kind, key, text, image, status, created_at, expires_at)
  VALUES (@kind, @key, @text, @image, @status, @created_at, @expires_at)`);
const byId = db.prepare("SELECT * FROM social_posts WHERE id = ?");
const setStatus = db.prepare("UPDATE social_posts SET status = ?, decided_at = ? WHERE id = ? AND status = 'draft'");

async function save(d: Draft) {
  const now = Date.now();
  const auto = config.socialAutoApprove.includes(d.kind);
  const r = insert.run({
    kind: d.kind, key: d.key, text: d.text, image: d.image,
    status: auto ? "approved" : "draft", created_at: now, expires_at: now + d.ttlMs,
  });
  if (!r.changes) return null;
  const post = byId.get(r.lastInsertRowid) as SocialPost;
  await sendForApproval(post, auto).catch((e) => console.warn("[social] telegram send failed:", (e as Error).message));
  return post;
}

export async function tick() {
  db.prepare("UPDATE social_posts SET status = 'expired' WHERE status IN ('draft','approved') AND expires_at < ?").run(Date.now());
  for (const kind of KINDS) {
    const key = slotKey(kind);
    if (!key || db.prepare("SELECT 1 FROM social_posts WHERE key = ?").get(key)) continue;
    try {
      const d = await generate(kind, key);
      // Remember empty slots too, so a quiet day isn't retried every tick.
      if (!d) { if (kind !== "smartbuy") insert.run({ kind, key, text: "", image: null, status: "skipped", created_at: Date.now(), expires_at: Date.now() }); continue; }
      await save(d);
    } catch (e) {
      console.warn(`[social] ${kind} failed:`, (e as Error).message);
    }
  }
}

// --- Poster API helpers -------------------------------------------------

// The next approved post, if the spacing rule allows posting now.
export function nextPost(): SocialPost | null {
  const last = db.prepare("SELECT MAX(posted_at) AS t FROM social_posts").get() as { t: number | null };
  if (last.t && Date.now() - last.t < config.socialMinGapMs) return null;
  return (db.prepare(`SELECT * FROM social_posts WHERE status = 'approved' AND expires_at > ?
    ORDER BY created_at LIMIT 1`).get(Date.now()) as SocialPost | undefined) ?? null;
}

export async function reportResult(id: number, ok: boolean, url: string | null, error: string | null) {
  const post = byId.get(id) as SocialPost | undefined;
  if (!post || post.status !== "approved") return false;
  if (ok) {
    db.prepare("UPDATE social_posts SET status = 'posted', posted_at = ?, post_url = ?, error = NULL WHERE id = ?").run(Date.now(), url, id);
    await updateCard(post, `✅ Posted${url ? `: ${url}` : ""}`);
  } else {
    const attempts = post.attempts + 1;
    const failed = attempts >= 3;
    db.prepare("UPDATE social_posts SET attempts = ?, error = ?, status = ? WHERE id = ?")
      .run(attempts, error, failed ? "failed" : "approved", id);
    if (failed) await updateCard(post, `⚠️ Posting failed 3 times: ${error ?? "unknown error"}`);
  }
  return true;
}

// --- Telegram -----------------------------------------------------------

const tgOn = () => !!(config.telegramBotToken && config.telegramChatId);

async function tg<T = unknown>(method: string, body: object, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const LABEL: Record<Kind, string> = { movers: "Floor movers", bigsale: "Biggest sale", smartbuy: "Smart-money buy", flipper: "Top flipper" };
const buttons = (id: number) => ({
  inline_keyboard: [[
    { text: "✅ Post", callback_data: `ok:${id}` },
    { text: "⏭ Skip", callback_data: `skip:${id}` },
  ]],
});
const statusOnly = (label: string) => ({ inline_keyboard: [[{ text: label, callback_data: "noop" }]] });

async function sendForApproval(post: SocialPost, auto: boolean) {
  if (!tgOn()) return;
  const caption = `📝 ${LABEL[post.kind]} draft #${post.id}${auto ? " (auto-approved)" : ""}\n\n${post.text}`;
  const markup = auto ? statusOnly("🕒 Queued") : buttons(post.id);
  let msg: { message_id: number };
  try {
    if (!post.image) throw new Error("no image");
    msg = await tg("sendPhoto", { chat_id: config.telegramChatId, photo: post.image, caption, reply_markup: markup });
  } catch {
    msg = await tg("sendMessage", { chat_id: config.telegramChatId, text: caption, reply_markup: markup, link_preview_options: { is_disabled: true } });
  }
  db.prepare("UPDATE social_posts SET tg_chat = ?, tg_message = ? WHERE id = ?").run(config.telegramChatId, msg.message_id, post.id);
}

async function updateCard(post: SocialPost, label: string) {
  if (!tgOn() || !post.tg_message) return;
  await tg("editMessageReplyMarkup", { chat_id: post.tg_chat, message_id: post.tg_message, reply_markup: statusOnly(label) })
    .catch(() => {});
}

type Update = {
  update_id: number;
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
  message?: { chat: { id: number }; text?: string };
};

async function handle(u: Update) {
  const cb = u.callback_query;
  if (cb) {
    if (String(cb.message?.chat.id) !== config.telegramChatId) return;
    const [action, idStr] = (cb.data ?? "").split(":");
    const post = byId.get(Number(idStr)) as SocialPost | undefined;
    if (!post || (action !== "ok" && action !== "skip")) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      return;
    }
    const changed = setStatus.run(action === "ok" ? "approved" : "skipped", Date.now(), post.id).changes;
    const note = !changed ? `Already ${post.status}` : action === "ok" ? "Queued for posting" : "Skipped";
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: note }).catch(() => {});
    if (changed) await updateCard(post, action === "ok" ? "🕒 Queued" : "⏭ Skipped");
    return;
  }
  // "/draft <kind>" makes a fresh draft now, ignoring the schedule.
  const m = u.message;
  if (!m || String(m.chat.id) !== config.telegramChatId || !m.text) return;
  const [cmd, arg] = m.text.trim().split(/\s+/);
  if (cmd !== "/draft") return;
  const kinds = arg && KINDS.includes(arg as Kind) ? [arg as Kind] : KINDS;
  for (const kind of kinds) {
    const d = await generate(kind, `${kind}:manual:${Date.now()}`);
    if (d) await save(d);
    else await tg("sendMessage", { chat_id: config.telegramChatId, text: `No ${LABEL[kind]} post right now (not enough data).` });
  }
}

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<Update[]>("getUpdates",
        { offset, timeout: 50, allowed_updates: ["callback_query", "message"] }, 60_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        await handle(u).catch((e) => console.warn("[social] update failed:", (e as Error).message));
      }
    } catch (e) {
      console.warn("[social] telegram poll:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

export function startSocial() {
  if (!tgOn() && !config.socialAutoApprove.length) {
    console.log("[social] off (no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or SOCIAL_AUTO_APPROVE)");
    return;
  }
  if (tgOn()) void pollTelegram();
  const run = () => tick().catch((e) => console.warn("[social] tick:", (e as Error).message));
  setTimeout(run, 60_000);
  setInterval(run, 10 * 60_000);
}
