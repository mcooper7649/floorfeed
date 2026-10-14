import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { tg } from "./social.ts";

// First-party, cookie-free analytics. The app sends page views and a short
// list of product events; nothing identifies a person. A visitor is a hash of
// IP + user agent with a salt that changes every day (the Plausible method),
// so the same person can't be followed across days and no consent banner is
// needed. Raw rows are kept 90 days.

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,        -- unix ms
  day       TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  visitor   TEXT NOT NULL,           -- daily-salted hash
  name      TEXT NOT NULL,           -- 'pageview' or a product event
  path      TEXT,
  referrer  TEXT,                    -- host only, external referrers
  source    TEXT,                    -- utm_source (or ref=)
  medium    TEXT,
  campaign  TEXT,
  country   TEXT,
  device    TEXT,                    -- mobile | tablet | desktop
  signed_in INTEGER NOT NULL DEFAULT 0,
  props     TEXT                     -- small JSON, event-specific
);
CREATE INDEX IF NOT EXISTS events_day ON events(day, name);
`);

// The product events the app may send (anything else is dropped).
export const EVENTS = [
  "pageview",
  "sign_in", "follow", "unfollow", "alerts_on", "alerts_off",
  "paper_buy", "paper_sell", "copy_tap",
  "buy_open", "buy_click", "buy_signed", "sell_open", "sell_approved", "sell_signed", "bridge_click", "deposit_open",
  "wallet_connect", "mode_real",
  "welcome_shown", "welcome_cta", "welcome_dismiss", "suggested_follow", "guide_open", "take_post",
] as const;

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|fetch|python|curl|wget|monitor/i;
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

const stateGet = db.prepare(`SELECT value FROM app_state WHERE key = ?`);
const stateSet = db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
function salt(d: string) {
  const row = stateGet.get("analytics_salt") as { value: string } | undefined;
  const cur = row ? (JSON.parse(row.value) as { day: string; salt: string }) : null;
  if (cur?.day === d) return cur.salt;
  const next = { day: d, salt: randomBytes(16).toString("hex") }; // yesterday's salt is gone for good
  stateSet.run("analytics_salt", JSON.stringify(next));
  return next.salt;
}

function device(ua: string) {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  return /mobi|iphone|android/i.test(ua) ? "mobile" : "desktop";
}
function host(url: string | undefined | null) {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : null; } catch { return null; }
}
const clip = (s: unknown, n: number) => (typeof s === "string" && s ? s.slice(0, n) : null);

const insert = db.prepare(`
  INSERT INTO events (ts, day, visitor, name, path, referrer, source, medium, campaign, country, device, signed_in, props)
  VALUES (@ts, @day, @visitor, @name, @path, @referrer, @source, @medium, @campaign, @country, @device, @signedIn, @props)`);
const perVisitor = db.prepare(`SELECT COUNT(*) n FROM events WHERE day = ? AND visitor = ?`);

export type Hit = { n: string; p?: string; r?: string; s?: string; m?: string; c?: string; a?: boolean; props?: Record<string, unknown> };

export function record(req: FastifyRequest, hit: Hit) {
  const ua = String(req.headers["user-agent"] ?? "");
  if (!ua || BOT.test(ua)) return false;
  if (!(EVENTS as readonly string[]).includes(hit.n)) return false;
  const ip = String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.ip).split(",")[0].trim();
  const now = Date.now();
  const d = day(now);
  const visitor = createHash("sha256").update(`${salt(d)}|${ip}|${ua}`).digest("hex").slice(0, 16);
  if ((perVisitor.get(d, visitor) as { n: number }).n > 500) return false; // runaway client
  const ref = host(hit.r);
  const self = ref && (ref === "floorfeed.io" || ref.endsWith(".floorfeed.io") || ref === "floorfeed.mycodedojo.com");
  const props = hit.props && Object.keys(hit.props).length ? JSON.stringify(hit.props).slice(0, 300) : null;
  insert.run({
    ts: now, day: d, visitor, name: hit.n,
    path: clip(hit.p, 200), referrer: self ? null : ref,
    source: clip(hit.s, 60), medium: clip(hit.m, 60), campaign: clip(hit.c, 80),
    country: clip(req.headers["cf-ipcountry"], 2), device: device(ua), signedIn: hit.a ? 1 : 0, props,
  });
  return true;
}

// --- Reading it back ---------------------------------------------------------

// Paths with ids are grouped (/wallet/abc → /wallet/:address) so pages rank by type.
const SHAPE_SQL = `CASE
  WHEN path LIKE '/wallet/%' THEN '/wallet/:address'
  WHEN path LIKE '/item/%' THEN '/item/:id'
  WHEN path LIKE '/collection/%' THEN '/collection/:symbol'
  ELSE path END`;

export function summary(days: number) {
  const since = day(Date.now() - (days - 1) * 86_400_000);
  const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(since, ...args) as T[];
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(since, ...args) as T;
  return {
    days, since,
    totals: one<{ visitors: number; pageviews: number }>(
      `SELECT COUNT(DISTINCT day || visitor) visitors, SUM(name = 'pageview') pageviews FROM events WHERE day >= ?`),
    daily: q<{ day: string; visitors: number; pageviews: number }>(
      `SELECT day, COUNT(DISTINCT visitor) visitors, SUM(name = 'pageview') pageviews FROM events WHERE day >= ? GROUP BY day ORDER BY day`),
    pages: q<{ path: string; views: number; visitors: number }>(
      `SELECT ${SHAPE_SQL} path, COUNT(*) views, COUNT(DISTINCT day || visitor) visitors FROM events
       WHERE day >= ? AND name = 'pageview' GROUP BY 1 ORDER BY views DESC LIMIT 12`),
    sources: q<{ source: string; visitors: number }>(
      `SELECT COALESCE(source, referrer, 'Direct') source, COUNT(DISTINCT day || visitor) visitors FROM events
       WHERE day >= ? GROUP BY 1 ORDER BY visitors DESC LIMIT 12`),
    countries: q<{ country: string; visitors: number }>(
      `SELECT COALESCE(country, '??') country, COUNT(DISTINCT day || visitor) visitors FROM events
       WHERE day >= ? GROUP BY 1 ORDER BY visitors DESC LIMIT 10`),
    devices: q<{ device: string; visitors: number }>(
      `SELECT device, COUNT(DISTINCT day || visitor) visitors FROM events WHERE day >= ? GROUP BY 1 ORDER BY visitors DESC`),
    events: q<{ name: string; count: number; visitors: number }>(
      `SELECT name, COUNT(*) count, COUNT(DISTINCT day || visitor) visitors FROM events
       WHERE day >= ? AND name != 'pageview' GROUP BY name ORDER BY count DESC`),
    // The activation funnel: of the people who came, how many did each step.
    funnel: ["pageview", "follow", "alerts_on", "paper_buy", "sign_in", "buy_click"].map((name) => ({
      step: name,
      visitors: (db.prepare(`SELECT COUNT(DISTINCT day || visitor) n FROM events WHERE day >= ? AND name = ?`)
        .get(since, name) as { n: number }).n,
    })),
    // Facts from the product tables, independent of tracking.
    product: {
      accounts: (db.prepare(`SELECT COUNT(DISTINCT u) n FROM (SELECT user_id u FROM follows UNION SELECT user_id FROM paper_positions
                             UNION SELECT user_id FROM push_subs) WHERE u LIKE 'did:privy:%'`).get() as { n: number }).n,
      followers: (db.prepare(`SELECT COUNT(DISTINCT user_id) n FROM follows`).get() as { n: number }).n,
      follows: (db.prepare(`SELECT COUNT(*) n FROM follows`).get() as { n: number }).n,
      pushSubscribers: (db.prepare(`SELECT COUNT(DISTINCT user_id) n FROM push_subs`).get() as { n: number }).n,
      paperTraders: (db.prepare(`SELECT COUNT(DISTINCT user_id) n FROM paper_positions`).get() as { n: number }).n,
    },
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// A plain admin page: numbers and small bars, no JS.
export function dashboard(days: number) {
  const s = summary(days);
  const max = Math.max(1, ...s.daily.map((d) => d.visitors));
  const table = (title: string, rows: Record<string, unknown>[], cols: string[]) => `
    <section><h2>${esc(title)}</h2>${rows.length ? `<table>${rows.map((r) =>
      `<tr>${cols.map((c, i) => `<td${i ? ' class="n"' : ""}>${esc(r[c])}</td>`).join("")}</tr>`).join("")}</table>` : `<p class="dim">Nothing yet.</p>`}</section>`;
  const top = s.funnel[0].visitors || 1;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>FloorFeed stats</title><style>
:root{color-scheme:dark;--bg:#0b0b10;--card:#14141c;--line:#262633;--text:#f2f2f5;--dim:#8b8b9a;--accent:#c6ff3d}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:var(--dim);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:18px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.kpis{display:flex;gap:28px;flex-wrap:wrap}.kpi b{display:block;font-size:28px;font-variant-numeric:tabular-nums}.kpi span{color:var(--dim);font-size:13px}
table{width:100%;border-collapse:collapse}td{padding:5px 0;border-bottom:1px solid var(--line)}td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.bars{display:flex;align-items:flex-end;gap:3px;height:90px}.bars div{flex:1;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}
.dim{color:var(--dim)}nav a{color:var(--accent);margin-right:12px}.f{display:grid;grid-template-columns:110px 1fr 70px;gap:8px;align-items:center;margin:6px 0}
.f i{display:block;height:10px;background:var(--accent);border-radius:5px}
</style></head><body><main>
<h1>FloorFeed stats</h1><p class="dim">Last ${s.days} days, since ${s.since}. Cookie-free; visitors are counted per day.</p>
<nav>${[1, 7, 30, 90].map((d) => `<a href="?days=${d}">${d}d</a>`).join("")}</nav>
<div class="grid">
<section style="grid-column:1/-1"><div class="kpis">
  <div class="kpi"><b>${s.totals.visitors ?? 0}</b><span>visitors</span></div>
  <div class="kpi"><b>${s.totals.pageviews ?? 0}</b><span>page views</span></div>
  <div class="kpi"><b>${s.product.accounts}</b><span>signed-in accounts (all time)</span></div>
  <div class="kpi"><b>${s.product.followers}</b><span>users following wallets</span></div>
  <div class="kpi"><b>${s.product.pushSubscribers}</b><span>with push alerts</span></div>
  <div class="kpi"><b>${s.product.paperTraders}</b><span>paper traders</span></div>
</div>
<div class="bars" title="visitors per day">${s.daily.map((d) => `<div style="height:${Math.round((d.visitors / max) * 100)}%" title="${d.day}: ${d.visitors}"></div>`).join("")}</div></section>
<section><h2>Activation funnel</h2>${s.funnel.map((f) => `<div class="f"><span>${esc(f.step)}</span><i style="width:${Math.max(1, Math.round((f.visitors / top) * 100))}%"></i><span class="dim">${f.visitors}</span></div>`).join("")}</section>
${table("Top pages", s.pages, ["path", "views"])}
${table("Sources", s.sources, ["source", "visitors"])}
${table("Events", s.events, ["name", "count"])}
${table("Countries", s.countries, ["country", "visitors"])}
${table("Devices", s.devices, ["device", "visitors"])}
</div></main></body></html>`;
}

// --- Daily digest to Telegram, and retention --------------------------------

async function digest() {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const s = summary(1);
  const y = summary(2); // today + yesterday, to show yesterday on its own
  const yesterday = y.daily.find((d) => d.day === day(Date.now() - 86_400_000));
  const ev = (n: string) => y.events.find((e) => e.name === n)?.count ?? 0;
  const lines = [
    `FloorFeed yesterday (${yesterday?.day ?? "n/a"}): ${yesterday?.visitors ?? 0} visitors, ${yesterday?.pageviews ?? 0} page views`,
    `Last 2 days: ${ev("follow")} follows, ${ev("alerts_on")} alerts on, ${ev("paper_buy")} paper buys, ${ev("sign_in")} sign-ins, ${ev("buy_click")} buy clicks`,
    `Top sources: ${y.sources.slice(0, 4).map((x) => `${x.source} ${x.visitors}`).join(", ") || "none"}`,
    `All time: ${s.product.accounts} accounts, ${s.product.pushSubscribers} with push alerts`,
  ];
  await tg("sendMessage", { chat_id: config.telegramChatId, text: lines.join("\n"), link_preview_options: { is_disabled: true } })
    .catch((err) => console.warn("[analytics]", (err as Error).message));
}

export function startAnalytics() {
  const tick = () => {
    db.prepare(`DELETE FROM events WHERE ts < ?`).run(Date.now() - 90 * 86_400_000);
    const now = new Date();
    const sent = (stateGet.get("analytics_digest") as { value: string } | undefined)?.value;
    if (now.getUTCHours() >= 13 && sent !== day()) { // ~9am ET
      stateSet.run("analytics_digest", day());
      void digest();
    }
  };
  setInterval(tick, 10 * 60_000).unref();
}
