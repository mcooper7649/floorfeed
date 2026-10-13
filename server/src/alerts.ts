import { createHash } from "node:crypto";
import webpush from "web-push";
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import { COST_SQL, PROCEEDS_SQL } from "./fees.ts";
import { traders } from "./feed.ts";
import { unitOf } from "./units.ts";

// Wallet alerts: every trade by a followed wallet becomes an alert for each
// follower (an in-app inbox), and a web push to browsers that opted in.
// Trades arrive from ingest (Magic Eden / OpenSea polling) and, for followed
// Solana wallets, within seconds from a Helius webhook that alerts.ts keeps
// pointed at exactly the followed wallets.

const state = {
  get: db.prepare(`SELECT value FROM app_state WHERE key = ?`),
  set: db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};
const getState = (k: string) => (state.get.get(k) as { value: string } | undefined)?.value ?? null;
const setState = (k: string, v: string) => state.set.run(k, v);

const pushReady = !!(config.vapidPublicKey && config.vapidPrivateKey);
if (pushReady) webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
export const pushKey = () => (pushReady ? config.vapidPublicKey : null);

// --- New trades → alerts ---------------------------------------------------

// Older trades (backfills) never alert: only what happened in the last 6h.
const FRESH_SECS = 6 * 3600;
const maxRowid = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM trades`);
const newTrades = db.prepare(`
  SELECT f.user_id, f.wallet, t.signature, t.collection, t.mint, t.price, t.image, t.block_time,
         CASE WHEN t.buyer = f.wallet THEN 'buy' ELSE 'sell' END AS side,
         CASE WHEN t.seller = f.wallet THEN ${PROCEEDS_SQL("t", "c")} - (
           SELECT ${COST_SQL("b", "c")} FROM trades b
           WHERE b.mint = t.mint AND b.buyer = t.seller AND b.block_time < t.block_time
           ORDER BY b.block_time DESC LIMIT 1) END AS pnl
  FROM follows f
  JOIN trades t ON (t.buyer = f.wallet OR t.seller = f.wallet)
  LEFT JOIN collections c ON c.symbol = t.collection
  WHERE t.rowid > @from AND t.rowid <= @to AND t.block_time >= @fresh
  ORDER BY t.block_time`);
const insertAlert = db.prepare(`
  INSERT OR IGNORE INTO alerts (user_id, wallet, signature, side, collection, mint, price, pnl, image, block_time, created_at)
  VALUES (@user_id, @wallet, @signature, @side, @collection, @mint, @price, @pnl, @image, @block_time, @now)`);

type NewAlert = {
  user_id: string; wallet: string; signature: string; side: "buy" | "sell"; collection: string; mint: string;
  price: number; pnl: number | null; image: string | null; block_time: number;
};

let checking = false;
export async function checkAlerts() {
  if (checking) return;
  checking = true;
  try {
    const to = (maxRowid.get() as { m: number }).m;
    const from = Number(getState("alerts_rowid") ?? to); // first run starts from now
    if (to <= from) return void setState("alerts_rowid", String(to));
    const rows = newTrades.all({ from, to, fresh: Math.floor(Date.now() / 1000) - FRESH_SECS }) as NewAlert[];
    const now = Date.now();
    const fresh: NewAlert[] = [];
    db.transaction(() => {
      for (const r of rows) if (insertAlert.run({ ...r, now }).changes) fresh.push(r);
      setState("alerts_rowid", String(to));
    })();
    if (fresh.length) {
      console.log(`[alerts] ${fresh.length} new`);
      await notify(fresh);
    }
  } catch (err) {
    console.warn("[alerts]", (err as Error).message);
  } finally {
    checking = false;
  }
}

// --- Web push ----------------------------------------------------------------

const subsOf = db.prepare(`SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?`);
const dropSub = db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`);

const fmt = (n: number, unit: string) => `${n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3)} ${unit}`;
const signed = (n: number, unit: string) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n), unit)}`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

export function alertText(a: Pick<NewAlert, "wallet" | "side" | "collection" | "price" | "pnl">, name: string | null) {
  const who = name ?? short(a.wallet);
  const coll = collectionName(a.collection);
  const unit = unitOf(a.collection);
  if (a.side === "buy") return { title: `${who} bought ${coll}`, body: `Paid ${fmt(a.price, unit)}` };
  return {
    title: a.pnl == null ? `${who} sold ${coll}` : `${who} ${a.pnl >= 0 ? "flipped" : "sold at a loss"} ${coll}`,
    body: a.pnl == null ? `Sold for ${fmt(a.price, unit)}` : `${signed(a.pnl, unit)} after fees · sold for ${fmt(a.price, unit)}`,
  };
}

async function notify(alerts: NewAlert[]) {
  if (!pushReady) return;
  const names = traders([...new Set(alerts.map((a) => a.wallet))]);
  const byUser = new Map<string, NewAlert[]>();
  for (const a of alerts) (byUser.get(a.user_id) ?? byUser.set(a.user_id, []).get(a.user_id)!).push(a);
  for (const [userId, list] of byUser) {
    const subs = subsOf.all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    if (!subs.length) continue;
    // A burst (a sweep, a catch-up) becomes one summary instead of a stack.
    const one = list.length <= 2;
    const payloads = one
      ? list.map((a) => ({
          ...alertText(a, names.get(a.wallet)?.name ?? null),
          url: `/item/${encodeURIComponent(a.collection)}/${encodeURIComponent(a.mint)}`,
          image: a.image, tag: a.signature,
        }))
      : [{
          title: `${list.length} new trades from wallets you follow`,
          body: [...new Set(list.map((a) => collectionName(a.collection)))].slice(0, 3).join(", "),
          url: "/alerts", image: null, tag: `batch:${list[0].signature}`,
        }];
    for (const sub of subs) {
      for (const p of payloads) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(p), { TTL: 3600 });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) { dropSub.run(sub.endpoint); break; } // unsubscribed / expired
          console.warn("[push]", code ?? (err as Error).message);
        }
      }
    }
  }
}

export function subscribe(userId: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(s.endpoint, userId, s.keys.p256dh, s.keys.auth, Date.now());
}
export const unsubscribe = (endpoint: string) => dropSub.run(endpoint).changes > 0;
export const hasPush = (userId: string) => (subsOf.all(userId) as unknown[]).length > 0;

// --- Inbox -------------------------------------------------------------------

export function inbox(userId: string, limit: number) {
  const rows = db.prepare(`SELECT * FROM alerts WHERE user_id = ? ORDER BY block_time DESC, id DESC LIMIT ?`)
    .all(userId, limit) as (NewAlert & { id: number; read_at: number | null })[];
  const names = traders([...new Set(rows.map((r) => r.wallet))]);
  return {
    unread: unreadCount(userId),
    push: hasPush(userId),
    alerts: rows.map((r) => ({
      id: r.id, wallet: r.wallet, name: names.get(r.wallet)?.name ?? null, avatar: names.get(r.wallet)?.avatar ?? null,
      side: r.side, collection: { symbol: r.collection, name: collectionName(r.collection) }, currency: unitOf(r.collection),
      mint: r.mint, price: r.price, pnl: r.pnl, image: r.image, t: r.block_time, read: r.read_at != null,
    })),
  };
}
export const unreadCount = (userId: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM alerts WHERE user_id = ? AND read_at IS NULL`).get(userId) as { n: number }).n;
export const markRead = (userId: string) =>
  db.prepare(`UPDATE alerts SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).run(Date.now(), userId).changes;

// --- Helius webhook: kept on exactly the followed Solana wallets -------------

const HELIUS = "https://api.helius.xyz/v0/webhooks";
const followedSolana = db.prepare(`SELECT DISTINCT wallet FROM follows WHERE wallet NOT LIKE '0x%' ORDER BY wallet`);

async function helius<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HELIUS}${path}?api-key=${config.heliusApiKey}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "FloorFeed/0.1 (+https://floorfeed.io)" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Helius webhooks ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 || method === "DELETE" ? null : await res.json()) as T;
}

export async function syncWebhook() {
  if (!config.heliusApiKey || !config.heliusWebhookUrl || !config.heliusWebhookSecret) return;
  const wallets = (followedSolana.all() as { wallet: string }[]).map((r) => r.wallet);
  const hash = createHash("sha256").update(config.heliusWebhookUrl + "|" + wallets.join(",")).digest("hex");
  if (getState("helius_webhook_hash") === hash) return;
  try {
    const hooks = await helius<{ webhookID: string; webhookURL: string }[]>("GET", "");
    const mine = hooks.find((h) => h.webhookURL === config.heliusWebhookUrl);
    const body = {
      webhookURL: config.heliusWebhookUrl, webhookType: "enhanced", transactionTypes: ["NFT_SALE"],
      accountAddresses: wallets, authHeader: config.heliusWebhookSecret,
    };
    if (!wallets.length) {
      if (mine) await helius("DELETE", `/${mine.webhookID}`);
    } else if (mine) {
      await helius("PUT", `/${mine.webhookID}`, body);
    } else {
      await helius("POST", "", body);
    }
    setState("helius_webhook_hash", hash);
    console.log(`[alerts] Helius webhook now watches ${wallets.length} wallets`);
  } catch (err) {
    console.warn("[alerts]", (err as Error).message);
  }
}

export function startAlerts() {
  setInterval(() => void checkAlerts(), 15_000).unref();
  void syncWebhook();
  setInterval(() => void syncWebhook(), 60_000).unref();
}
