import { readFileSync } from "node:fs";
import http from "node:http";
import { Resvg } from "@resvg/resvg-js";
import { listCollections } from "./collections.ts";
import { COLLECTIONS, EVM_COLLECTIONS, chainName, config, isEvmWallet, walletUnit } from "./config.ts";
import { db } from "./db.ts";
import { traders } from "./feed.ts";
import { collectionFlippers } from "./pnl.ts";
import { ADDRESS_RE } from "./chain.ts";
import { traderLeaderboard, traderProfile } from "./traders.ts";

// The web app is a client-rendered single page, so every URL used to return
// the same empty shell titled "FloorFeed". Page requests now come here first
// (Caddy routes them): we take the built index.html and fill in a real title,
// description, canonical URL, share card and a plain-HTML summary of the page
// inside #root. The app replaces that summary when it boots, so people see
// the normal UI; crawlers and link unfurlers that don't run JS get the facts.

const SITE = config.siteUrl.replace(/\/$/, "");
// Solana (base58) or EVM (0x) wallet addresses.
const isWallet = (a: string) => ADDRESS_RE.test(a) || /^0x[0-9a-f]{40}$/.test(a);
const NAME = "FloorFeed";
const HANDLE = "@FloorFeed";
const DEFAULT_IMAGE = `${SITE}/og.jpg`;
const MIN = 60_000;

// --- small helpers ---------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const num = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const amt = (n: number | null | undefined, cur: string) =>
  n == null ? "n/a" : `${num(n, n < 1 ? 3 : n < 100 ? 2 : 0)} ${cur}`;
const signed = (n: number, cur: string) => `${n >= 0 ? "+" : "−"}${num(Math.abs(n), Math.abs(n) < 1 ? 3 : 2)} ${cur}`;
const pct = (n: number | null | undefined) => (n == null ? null : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`);
const usd = (n: number | null | undefined) =>
  n == null ? null : `$${n >= 1000 ? num(Math.round(n), 0) : num(n, 2)}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

function cached<T>(ttl: number, fn: () => T): () => T {
  let at = 0;
  let value: T;
  return () => {
    if (!at || Date.now() - at > ttl) { value = fn(); at = Date.now(); }
    return value;
  };
}

const markets = cached(5 * MIN, () => listCollections());
const leaders = cached(10 * MIN, () =>
  traderLeaderboard({ windowDays: 30, sort: "pnl", minFlips: 3, hideMarketMakers: true, limit: 100 }));
const evmLeaders = cached(10 * MIN, () =>
  traderLeaderboard({ windowDays: 30, sort: "pnl", minFlips: 3, hideMarketMakers: true, limit: 50, chain: "evm" }));


// --- the HTML shell --------------------------------------------------------

// The built index.html lives with the static site (nginx). Fetch it from
// there so the API never serves a stale copy for long after a web deploy.
// The shared nginx picks the site by Host, which fetch() can't set.
function getText(url: string, host?: string) {
  return new Promise<string>((resolve, reject) => {
    const req = http.get(url, { headers: host ? { host } : {}, timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`index.html ${res.statusCode}`)); return; }
      let body = "";
      res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("index.html timeout"))).on("error", reject);
  });
}

let shell: { html: string; at: number } | null = null;
async function template() {
  if (shell && Date.now() - shell.at < MIN) return shell.html;
  try {
    shell = { html: await getText(`${config.webOrigin}/index.html`, config.webHost || undefined), at: Date.now() };
  } catch (err) {
    if (!shell) throw err;
    shell.at = Date.now() - MIN / 2; // keep serving the last copy, retry soon
  }
  return shell.html;
}

type Page = {
  status?: number;
  title: string;
  description: string;
  path: string;
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
  jsonLd?: object[];
  body: string; // plain HTML summary placed inside #root
};

function render(html: string, p: Page) {
  const url = `${SITE}${p.path}`;
  const image = p.image ?? DEFAULT_IMAGE;
  const big = !p.image || p.image.endsWith(".png") || p.image === DEFAULT_IMAGE;
  const head = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    p.noindex ? `<meta name="robots" content="noindex, follow" />` : `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${NAME}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    ...(big ? [`<meta property="og:image:width" content="1200" />`, `<meta property="og:image:height" content="${image === DEFAULT_IMAGE ? 627 : 630}" />`] : []),
    `<meta property="og:image:alt" content="${esc(p.imageAlt ?? p.title)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:site" content="${HANDLE}" />`,
    `<meta name="twitter:title" content="${esc(p.title)}" />`,
    `<meta name="twitter:description" content="${esc(p.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    ...(p.jsonLd ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`),
  ].join("\n    ");

  return html
    // Drop the template's generic tags; ours replace them.
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(name|property)="(description|robots|og:[^"]+|twitter:[^"]+)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "")
    .replace(/<\/head>/i, `    ${head}\n  </head>`)
    .replace(/<div id="root"><\/div>/, `<div id="root"><div id="ssr">${p.body}</div></div>`);
}

const nav = `<nav><a href="/">Feed</a> · <a href="/markets">Markets</a> · <a href="/leaderboard">Leaders</a></nav>`;
const foot = `<footer><p>${NAME} tracks Solana NFT trades and the wallets behind them: who is buying, how good they are, and what they did last time. Follow <a href="https://x.com/FloorFeed" rel="me">${HANDLE}</a> on X.</p></footer>`;
const doc = (main: string) => `<header><a href="/"><strong>${NAME}</strong></a> ${nav}</header><main>${main}</main>${foot}`;

const org = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: NAME,
  url: SITE,
  logo: `${SITE}/icon-512.png`,
  sameAs: ["https://x.com/FloorFeed"],
};
const crumbs = (items: [string, string][]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE}${path}` })),
});

// --- pages -----------------------------------------------------------------

type Coll = ReturnType<typeof listCollections>[number];

const collRow = (c: Coll) => {
  const ch = pct(c.change24hPct);
  return `<tr><td><a href="/collection/${encodeURIComponent(c.symbol)}">${esc(c.name)}</a></td><td>${chainName(c.chain)}</td><td>${amt(c.floor, c.currency)}</td><td>${ch ?? "–"}</td><td>${amt(c.volume7d, c.currency)}</td></tr>`;
};
const collTable = (rows: Coll[]) =>
  `<table><thead><tr><th>Collection</th><th>Chain</th><th>Floor</th><th>24h</th><th>7d volume</th></tr></thead><tbody>${rows.map(collRow).join("")}</tbody></table>`;

type Leader = ReturnType<typeof leaders>["rows"][number];
const leaderList = (rows: Leader[]) => {
  const ids = traders(rows.map((r) => r.wallet));
  return `<ol>${rows.map((r) => {
    const name = ids.get(r.wallet)?.name ?? short(r.wallet);
    const wr = r.winRate == null ? "" : `, ${Math.round(r.winRate * 100)}% win rate`;
    return `<li><a href="/wallet/${r.wallet}">${esc(name)}</a>: ${signed(r.realizedSol, "SOL")} realized over ${r.flips} flips${wr}</li>`;
  }).join("")}</ol>`;
};

function home(): Page {
  const top = markets().slice(0, 12);
  const lb = leaders().rows.slice(0, 10);
  const description = "Live Solana NFT buys from wallets with a track record. See who is buying, their flip P&L and win rate, follow the best traders and copy them on paper first.";
  return {
    title: "FloorFeed: live Solana NFT trades from proven wallets",
    description,
    path: "/",
    jsonLd: [org, {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: NAME,
      url: SITE,
      description,
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE}/markets?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    }],
    body: doc(`
      <h1>Live Solana NFT trades from wallets with a track record</h1>
      <p>${esc(description)} Every buy in the feed shows the wallet's history: flips, realized P&amp;L, win rate and tier (Top Flipper, Proven, New, or Market Maker, which are filtered out).</p>
      <h2>Top NFT collections by volume</h2>
      ${collTable(top)}
      <p><a href="/markets">All ${markets().length} collections and floor prices</a></p>
      <h2>Top flippers, last 30 days</h2>
      ${leaderList(lb)}
      <p><a href="/leaderboard">Full leaderboard</a></p>`),
  };
}

// "Solana, Ethereum, Base and Abstract": the chains that currently have collections.
const chainList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "");

function marketsPage(): Page {
  const all = markets();
  const chains = [...new Set(all.map((c) => chainName(c.chain)))];
  const evmChains = chains.filter((c) => c !== "Solana");
  const sol = all.filter((c) => c.chain === "solana").length;
  return {
    title: `NFT floor prices today: ${all.length} Solana & Ethereum collections | FloorFeed`,
    description: `Live floor prices, 24h change and 7-day volume for ${all.length} NFT collections on ${chainList(chains)}, with price charts, listings and top flippers for each.`,
    path: "/markets",
    jsonLd: [crumbs([[NAME, "/"], ["Markets", "/markets"]]), {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "NFT collections by 7-day volume",
      itemListElement: all.slice(0, 50).map((c, i) => ({
        "@type": "ListItem", position: i + 1, name: c.name, url: `${SITE}/collection/${encodeURIComponent(c.symbol)}`,
      })),
    }],
    body: doc(`
      <h1>NFT floor prices</h1>
      <p>${all.length} collections (${sol} on Solana via Magic Eden, ${all.length - sol} on ${chainList(evmChains)} via OpenSea), sorted by 7-day volume. Floors refresh every few minutes.</p>
      ${collTable(all)}`),
  };
}

function leaderboardPage(): Page {
  const lb = leaders();
  return {
    title: "Top Solana NFT flippers: 30-day P&L leaderboard | FloorFeed",
    description: `The most profitable Solana NFT traders of the last 30 days, ranked by realized P&L from ${num(lb.summary.flips, 0)} tracked flips. Win rate, ROI, hold time and streaks, with market-making bots filtered out.`,
    path: "/leaderboard",
    jsonLd: [crumbs([[NAME, "/"], ["Leaderboard", "/leaderboard"]])],
    body: doc(`
      <h1>Top Solana NFT flippers</h1>
      <p>Realized profit from flips (a sale matched to the wallet's earlier buy of the same NFT) over the last 30 days, gross of fees. ${lb.summary.wallets} wallets with 3+ flips; ${lb.summary.profitableWallets} are in profit.</p>
      ${leaderList(lb.rows.slice(0, 50))}`),
  };
}

const descRow = db.prepare(`SELECT description FROM collections WHERE symbol = ?`);

function collectionPage(symbol: string): Page | null {
  const c = markets().find((x) => x.symbol === symbol);
  if (!c) return null;
  const evm = c.chain !== "solana";
  const meta = (descRow.get(symbol) as { description: string | null } | undefined)?.description?.trim();
  const ch = pct(c.change24hPct);
  const floorUsd = usd(c.floorUsd);
  const lead = c.floor != null
    ? `${c.name} floor price is ${amt(c.floor, c.currency)}${floorUsd ? ` (${floorUsd})` : ""}${ch ? `, ${ch} in 24h` : ""}.`
    : `${c.name} on ${chainName(c.chain)}.`;
  const vol = c.volume7d ? ` 7-day volume ${amt(c.volume7d, c.currency)}.` : "";
  const description = clip(evm
    ? `${lead}${vol} Live sales, price chart, owners and the wallets flipping ${c.name} on ${chainName(c.chain)}.`
    : `${lead}${vol} Live sales, price chart, cheapest listings and the wallets flipping ${c.name} for profit.`, 300);

  const flippers = collectionFlippers(symbol, 8).filter((f) => f.flips >= 2);
  const ids = traders(flippers.map((f) => f.wallet));
  const related = markets().filter((x) => x.symbol !== symbol && x.category === c.category).slice(0, 8);
  const stats: [string, string | null][] = [
    ["Floor", c.floor != null ? `${amt(c.floor, c.currency)}${floorUsd ? ` (${floorUsd})` : ""}` : null],
    ["24h change", ch],
    ["7d change", pct(c.change7dPct)],
    ["7d volume", c.volume7d != null ? amt(c.volume7d, c.currency) : null],
    ["24h sales", c.sales24h != null ? String(c.sales24h) : null],
    ["Listed", c.listed != null ? num(c.listed, 0) : null],
    ["Owners", c.owners != null ? num(c.owners, 0) : null],
    ["Chain", chainName(c.chain)],
    ["Category", c.category],
  ];

  return {
    title: `${c.name} floor price, chart & top flippers | FloorFeed`,
    description,
    path: `/collection/${encodeURIComponent(symbol)}`,
    image: `${SITE}/og/collection/${encodeURIComponent(symbol)}.png`,
    imageAlt: `${c.name} floor price card`,
    jsonLd: [crumbs([[NAME, "/"], ["Markets", "/markets"], [c.name, `/collection/${encodeURIComponent(symbol)}`]])],
    body: doc(`
      <h1>${esc(c.name)} floor price</h1>
      <p>${esc(lead)}${esc(vol)}</p>
      <dl>${stats.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v!)}</dd>`).join("")}</dl>
      ${meta ? `<h2>About ${esc(c.name)}</h2><p>${esc(clip(meta, 600))}</p>` : ""}
      ${flippers.length ? `<h2>Top ${esc(c.name)} flippers</h2><ol>${flippers.map((f) =>
        `<li><a href="/wallet/${f.wallet}">${esc(ids.get(f.wallet)?.name ?? short(f.wallet))}</a>: ${signed(f.realizedSol, c.currency)} over ${f.flips} flips, ${Math.round((f.wins / f.flips) * 100)}% wins</li>`).join("")}</ol>` : ""}
      ${related.length ? `<h2>Similar collections</h2><ul>${related.map((r) =>
        `<li><a href="/collection/${encodeURIComponent(r.symbol)}">${esc(r.name)}</a> · floor ${amt(r.floor, r.currency)}</li>`).join("")}</ul>` : ""}`),
  };
}

function walletPage(address: string): Page {
  const p = traderProfile(address);
  const unit = walletUnit(address);
  const eco = isEvmWallet(address) ? "Ethereum" : "Solana";
  const id = traders([address]).get(address)!;
  const name = id.name ?? short(address);
  const tier = { elite: "Top Flipper", pro: "Proven", mm: "Market Maker", new: "New" }[id.tier ?? "new"] ?? "New";
  const wr = p.winRate == null ? null : `${Math.round(p.winRate * 100)}%`;
  const has = p.flips > 0;
  const description = has
    ? `${name} has ${signed(p.realizedSol, unit)} realized from ${p.flips} ${eco} NFT flips${wr ? ` with a ${wr} win rate` : ""}. ${p.collections.length ? `Mostly trades ${p.collections.map((c) => c.name).join(", ")}. ` : ""}See every buy, sell and open position.`
    : `${eco} NFT trades by ${name}: buys, sells and open positions tracked by FloorFeed.`;
  return {
    title: has ? `${name}: ${eco} NFT trader, ${signed(p.realizedSol, unit)} P&L | FloorFeed` : `${name}: ${eco} NFT wallet | FloorFeed`,
    description: clip(description, 300),
    path: `/wallet/${address}`,
    image: has ? `${SITE}/og/wallet/${address}.png` : undefined,
    imageAlt: `${name} trading card`,
    // A wallet with no tracked flips is a thin page; keep it out of the index.
    noindex: p.flips < 3,
    jsonLd: [crumbs([[NAME, "/"], ["Leaderboard", "/leaderboard"], [name, `/wallet/${address}`]])],
    body: doc(`
      <h1>${esc(name)}</h1>
      <p>${esc(description)}</p>
      ${has ? `<dl>
        <dt>Tier</dt><dd>${tier}</dd>
        <dt>Realized P&amp;L</dt><dd>${signed(p.realizedSol, unit)}</dd>
        <dt>Flips</dt><dd>${p.flips} (${p.wins} wins)</dd>
        ${wr ? `<dt>Win rate</dt><dd>${wr}</dd>` : ""}
        ${p.roiPct != null ? `<dt>ROI</dt><dd>${pct(p.roiPct)}</dd>` : ""}
        ${p.avgHoldHours != null ? `<dt>Average hold</dt><dd>${p.avgHoldHours < 48 ? `${Math.round(p.avgHoldHours)} hours` : `${Math.round(p.avgHoldHours / 24)} days`}</dd>` : ""}
        ${p.bestFlip ? `<dt>Best flip</dt><dd>${signed(p.bestFlip.pnlSol, unit)} on ${esc(p.bestFlip.collection)}</dd>` : ""}
      </dl>` : ""}
      ${p.collections.length ? `<h2>Most traded</h2><ul>${p.collections.map((c) =>
        `<li><a href="/collection/${encodeURIComponent(c.symbol)}">${esc(c.name)}</a>: ${c.flips} flips, ${signed(c.pnlSol, unit)}</li>`).join("")}</ul>` : ""}
      <p>Wallet <code>${address}</code></p>`),
  };
}

function notFound(path: string): Page {
  return {
    status: 404,
    title: "Not found | FloorFeed",
    description: "This page doesn't exist on FloorFeed.",
    path,
    noindex: true,
    body: doc(`<h1>Not found</h1><p>Try the <a href="/markets">markets</a> or the <a href="/leaderboard">leaderboard</a>.</p>`),
  };
}

export function pageFor(path: string): Page {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return home();
  if (clean === "/markets") return marketsPage();
  if (clean === "/leaderboard") return leaderboardPage();
  if (clean === "/portfolio") {
    return { title: "Portfolio | FloorFeed", description: "Your paper and real NFT positions on FloorFeed.", path: "/portfolio", noindex: true, body: doc(`<h1>Portfolio</h1>`) };
  }
  let m = clean.match(/^\/collection\/([^/]+)$/);
  if (m) return collectionPage(decodeURIComponent(m[1])) ?? notFound(clean);
  m = clean.match(/^\/wallet\/([^/]+)$/);
  if (m && isWallet(m[1])) return walletPage(m[1]);
  return notFound(clean);
}

export async function renderPage(path: string) {
  const p = pageFor(path);
  return { status: p.status ?? 200, html: render(await template(), p) };
}

// --- sitemap / robots ------------------------------------------------------

export function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls: [string, string, number][] = [
    ["/", "hourly", 1.0],
    ["/markets", "hourly", 0.9],
    ["/leaderboard", "daily", 0.8],
    ...[...COLLECTIONS.map((c) => c.symbol), ...EVM_COLLECTIONS.map((c) => c.slug)]
      .map((s): [string, string, number] => [`/collection/${encodeURIComponent(s)}`, "hourly", 0.7]),
    ...[...leaders().rows, ...evmLeaders().rows].map((r): [string, string, number] => [`/wallet/${r.wallet}`, "daily", 0.5]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, f, pr]) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><changefreq>${f}</changefreq><priority>${pr.toFixed(1)}</priority></url>`).join("\n")}
</urlset>
`;
}

export const robots = () => `User-agent: *
Allow: /
Disallow: /portfolio
Disallow: /api/

Sitemap: ${SITE}/sitemap.xml
`;

// --- share cards (1200x630 PNG) --------------------------------------------

const FONT_DIR = new URL("../assets/fonts/", import.meta.url);
const FONTS = ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-ExtraBold.ttf"].map((f) => new URL(f, FONT_DIR).pathname);
// Fail at startup, not on the first share, if the fonts didn't ship.
for (const f of FONTS) readFileSync(f);

const BG = "#0B0B10", CARD = "#15151C", BORDER = "#262631", TEXT = "#F4F4F6", DIM = "#9797A6", ACCENT = "#B8FF3C", UP = "#3DDC97", DOWN = "#FF5C7A";

// Same resize proxies the app uses (lib/img.ts), asking for JPEG so resvg can decode it.
function thumbUrl(uri: string) {
  if (/\.seadn\.io\//.test(uri)) return `${uri.split("?")[0]}?w=512&fm=jpg`;
  return `https://img-cdn.magiceden.dev/rs:fill:512:512:0:0/plain/${uri}@jpg`;
}
async function dataUri(uri: string | null) {
  if (!uri || !/^https?:\/\//.test(uri)) return null;
  try {
    const r = await fetch(thumbUrl(uri), { headers: { accept: "image/jpeg,image/png" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (!/jpe?g|png/.test(type)) return null;
    return `data:${type.split(";")[0]};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  } catch {
    return null;
  }
}

const wordmark = `<g transform="translate(64 70)"><rect width="18" height="18" rx="4" fill="${ACCENT}"/><text x="30" y="16" font-size="26" font-weight="800" fill="${TEXT}">FloorFeed</text></g>`;
const footer = (right: string) =>
  `<text x="64" y="580" font-size="24" fill="${DIM}">${esc(SITE.replace(/^https?:\/\//, ""))}</text><text x="1136" y="580" font-size="24" fill="${DIM}" text-anchor="end">${esc(right)}</text>`;
const svgDoc = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter"><rect width="1200" height="630" fill="${BG}"/>${inner}</svg>`;

function stat(x: number, label: string, value: string, color = TEXT) {
  return `<text x="${x}" y="430" font-size="22" font-weight="600" fill="${DIM}" letter-spacing="1.5">${esc(label.toUpperCase())}</text><text x="${x}" y="482" font-size="44" font-weight="800" fill="${color}">${esc(value)}</text>`;
}

// Long names shrink to fit beside the art.
const titleSize = (s: string, max: number) => Math.max(44, Math.min(max, Math.floor(1300 / Math.max(8, s.length))));

function spark(points: { median: number }[], x: number, y: number, w: number, h: number, color: string) {
  if (points.length < 2) return "";
  const vs = points.map((p) => p.median);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const d = vs.map((v, i) => `${i ? "L" : "M"}${(x + (i / (vs.length - 1)) * w).toFixed(1)},${(y + h - ((v - lo) / span) * h).toFixed(1)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
}

async function collectionCard(symbol: string) {
  const c = markets().find((x) => x.symbol === symbol);
  if (!c) return null;
  const art = await dataUri(c.image);
  const ch = c.change24hPct;
  const chColor = ch == null ? DIM : ch >= 0 ? UP : DOWN;
  const size = titleSize(c.name, 68);
  const inner = `
    ${wordmark}
    <rect x="788" y="64" width="348" height="348" rx="28" fill="${CARD}" stroke="${BORDER}" stroke-width="2"/>
    ${art ? `<clipPath id="a"><rect x="790" y="66" width="344" height="344" rx="26"/></clipPath><image x="790" y="66" width="344" height="344" preserveAspectRatio="xMidYMid slice" clip-path="url(#a)" xlink:href="${art}"/>` : `<text x="962" y="270" font-size="140" font-weight="800" fill="${DIM}" text-anchor="middle">${esc(c.name.slice(0, 1))}</text>`}
    <text x="64" y="170" font-size="24" font-weight="600" fill="${ACCENT}" letter-spacing="2">${esc(`${chainName(c.chain)} · ${c.category}`.toUpperCase())}</text>
    <text x="64" y="${170 + size + 14}" font-size="${size}" font-weight="800" fill="${TEXT}">${esc(clip(c.name, 26))}</text>
    ${spark(c.spark, 64, 290, 640, 70, chColor)}
    ${stat(64, "Floor", amt(c.floor, c.currency))}
    ${stat(340, "24h", pct(ch) ?? "–", chColor)}
    ${stat(560, "7d volume", c.volume7d != null ? amt(c.volume7d, c.currency) : "–")}
    ${footer(usd(c.floorUsd) ? `Floor ${usd(c.floorUsd)}` : "Live floor & sales")}`;
  return svgDoc(inner);
}

async function walletCard(address: string) {
  const p = traderProfile(address);
  const unit = walletUnit(address);
  if (!p.flips) return null;
  const id = traders([address]).get(address)!;
  const name = id.name ?? short(address);
  const art = await dataUri(id.avatar);
  const tier = { elite: "TOP FLIPPER", pro: "PROVEN", mm: "MARKET MAKER", new: "NEW" }[id.tier ?? "new"] ?? "NEW";
  const pnlColor = p.realizedSol >= 0 ? UP : DOWN;
  const size = titleSize(name, 64);
  const series = p.series.map((v) => ({ median: v }));
  const inner = `
    ${wordmark}
    <rect x="884" y="64" width="252" height="252" rx="126" fill="${CARD}" stroke="${BORDER}" stroke-width="2"/>
    ${art ? `<clipPath id="a"><circle cx="1010" cy="190" r="124"/></clipPath><image x="886" y="66" width="248" height="248" preserveAspectRatio="xMidYMid slice" clip-path="url(#a)" xlink:href="${art}"/>` : ""}
    <text x="64" y="170" font-size="24" font-weight="600" fill="${ACCENT}" letter-spacing="2">${tier} · ${isEvmWallet(address) ? "ETHEREUM" : "SOLANA"} NFT TRADER</text>
    <text x="64" y="${170 + size + 14}" font-size="${size}" font-weight="800" fill="${TEXT}">${esc(clip(name, 24))}</text>
    ${spark(series, 64, 290, 760, 70, pnlColor)}
    ${stat(64, "Realized P&L", signed(p.realizedSol, unit), pnlColor)}
    ${stat(470, "Win rate", p.winRate == null ? "–" : `${Math.round(p.winRate * 100)}%`)}
    ${stat(720, "Flips", String(p.flips))}
    ${stat(920, "Streak", p.streak ? `${p.streak} wins` : "–")}
    ${footer(p.bestFlip ? `Best: ${signed(p.bestFlip.pnlSol, unit)} on ${clip(p.bestFlip.collection, 22)}` : "Every flip, tracked")}`;
  return svgDoc(inner);
}

// Cards are cheap to keep and slow-ish to draw (image fetch + raster).
const cards = new Map<string, { png: Buffer; at: number }>();
const CARD_TTL = 30 * MIN;

export async function card(kind: "collection" | "wallet", id: string) {
  const key = `${kind}:${id}`;
  const hit = cards.get(key);
  if (hit && Date.now() - hit.at < CARD_TTL) return hit.png;
  const svg = kind === "collection" ? await collectionCard(id) : isWallet(id) ? await walletCard(id) : null;
  if (!svg) return null;
  const png = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: 1200 },
  }).render().asPng();
  if (cards.size > 500) cards.clear();
  cards.set(key, { png, at: Date.now() });
  return png;
}

