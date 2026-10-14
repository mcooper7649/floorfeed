import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { cachedTake, getTake } from "./ai.ts";
import { followingHoldings, smartMoney } from "./discover.ts";
import { GUIDE } from "./guide.ts";
import { refreshPrices, tickerPrices } from "./prices.ts";
import { dashboard, record, startAnalytics, summary, type Hit } from "./analytics.ts";
import { checkAlerts, hasPush, inbox, markRead, pushKey, startAlerts, subscribe, syncWebhook, unreadCount, unsubscribe } from "./alerts.ts";
import { adoptDevice, authorize, privyUser } from "./auth.ts";
import { ADDRESS_RE, capabilities, collectionOfMint, hasDas, holdings, solBalance } from "./chain.ts";
import { cheapestListings, collectionDetail, listCollections } from "./collections.ts";
import { COLLECTIONS, UNITS, collectionName, config, isEvm } from "./config.ts";
import { db } from "./db.ts";
import { feedEvents, traders } from "./feed.ts";
import { loadDiscovered } from "./discovery.ts";
import { itemDetail, warmRarity } from "./items.ts";
import { EVM_ADDRESS_RE, evmBalances, evmBuyTx, evmHoldings, evmQuote, totalEth } from "./trade-evm.ts";
import { startIngest } from "./ingest.ts";
import { KINDS, generate, nextPost, postedSince, reportResult, startSocial, submitExternal, xLength } from "./social.ts";
import { amountsFrom, feeRates } from "./fees.ts";
import { walletStats } from "./pnl.ts";
import { card, renderPage, robots, sitemap } from "./seo.ts";
import { nameFor, startNames } from "./sns.ts";
import { traderLeaderboard, traderProfile, walletUnits } from "./traders.ts";
import { unitOf } from "./units.ts";

type TradeRow = {
  signature: string;
  collection: string;
  mint: string;
  buyer: string;
  seller: string;
  price: number;
  block_time: number;
  image: string | null;
  floor: number | null;
  avg_24h: number | null;
  volume_7d: number | null;
};

const tradeSelect = `
  SELECT t.*, c.floor, c.avg_24h, c.volume_7d
  FROM trades t LEFT JOIN collections c ON c.symbol = t.collection`;

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "DELETE"] });

app.get("/health", async () => ({
  ok: true,
  trades: (db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n,
}));

app.get("/collections", async () => listCollections());

// --- Wallet + trading ------------------------------------------------------

app.get("/capabilities", async () => capabilities());

app.get("/chain/balance/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not a Solana address" });
  try {
    return await solBalance(address);
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// Real portfolio: the wallet's NFTs in tracked collections (Helius DAS).
app.get("/chain/holdings/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not a Solana address" });
  if (!hasDas()) return reply.code(501).send({ error: "Holdings need a Helius RPC (SOLANA_RPC_URL)" });
  try {
    return await holdings(address);
  } catch (err) {
    return reply.code(502).send({ error: (err as Error).message });
  }
});

// What a real "buy floor" would cost: the cheapest listing right now, the
// buyer's balance, and whether FloorFeed can build the transaction yet.
app.get("/trade/quote/:symbol", async (req, reply) => {
  const { symbol } = req.params as { symbol: string };
  const { buyer } = z.object({ buyer: z.string().regex(ADDRESS_RE).optional() }).parse(req.query);
  if (isEvm(symbol)) return reply.code(422).send({ error: "Real buys are Solana-only" });
  const coll = db.prepare("SELECT floor FROM collections WHERE symbol = ?").get(symbol) as { floor: number | null } | undefined;
  if (!coll) return reply.code(404).send({ error: "unknown collection" });
  const [listings, balance] = await Promise.all([
    cheapestListings(symbol),
    buyer ? solBalance(buyer).catch(() => null) : null,
  ]);
  const listing = listings[0] ?? null;
  const caps = capabilities();
  return {
    collection: { symbol, name: collectionName(symbol), floor: coll.floor },
    listing,
    // Price is what the listing asks; marketplace fee and royalty are added
    // by the marketplace when it builds the transaction.
    networkFeeSol: 0.000005,
    balanceSol: balance?.sol ?? null,
    executable: caps.buy.enabled,
    reason: caps.buy.enabled ? null : "FloorFeed's marketplace API access is pending, so buys open on Magic Eden for now.",
    marketUrl: listing ? `https://magiceden.io/item-details/${listing.mint}` : `https://magiceden.io/marketplace/${symbol}`,
  };
});

// Builds an unsigned buy transaction for the user's wallet to sign. The
// marketplace API calls need keys we don't have yet, so this reports that
// plainly instead of pretending. See docs/WALLET_AND_TRADING.md.
app.post("/trade/buy-tx", async (_req, reply) => {
  const caps = capabilities();
  if (!caps.buy.enabled) {
    return reply.code(501).send({
      error: "Buying isn't enabled yet: FloorFeed needs a Magic Eden or Tensor API key to build buy transactions.",
    });
  }
  return reply.code(501).send({ error: "Buy transactions are not implemented yet." });
});

app.get("/collections/:symbol", async (req, reply) => {
  const { symbol } = req.params as { symbol: string };
  const { range } = z.object({ range: z.coerce.number().int().refine((d) => [1, 7, 30].includes(d)).default(7) })
    .parse(req.query);
  const detail = await collectionDetail(symbol, range);
  if (!detail) return reply.code(404).send({ error: "unknown collection" });
  // .sol names / avatars for the wallets on the page.
  const ids = traders([...detail.topFlippers.map((f) => f.wallet), ...detail.recentSales.map((r) => r.buyer)]);
  return {
    ...detail,
    topFlippers: detail.topFlippers.map((f) => ({ ...f, name: ids.get(f.wallet)?.name ?? null, avatar: ids.get(f.wallet)?.avatar ?? null })),
    recentSales: detail.recentSales.map((r) => ({ ...r, buyerName: ids.get(r.buyer)?.name ?? null })),
  };
});

// Feed of recent buys. `following=<userId>` limits it to wallets that user follows;
// `before=<unix>` paginates.
app.get("/feed", async (req, reply) => {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().int().optional(),
    following: z.string().optional(),
  }).parse(req.query);
  if (q.following && !(await authorize(req, reply, q.following))) return;
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.before) { where.push("t.block_time < ?"); args.push(q.before); }
  if (q.following) {
    where.push("t.buyer IN (SELECT wallet FROM follows WHERE user_id = ?)");
    args.push(q.following);
  }
  const rows = db.prepare(
    `${tradeSelect} ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY t.block_time DESC LIMIT ?`,
  ).all(...args, q.limit) as TradeRow[];

  const stats = new Map<string, ReturnType<typeof walletStats>>();
  return rows.map((t) => {
    if (!stats.has(t.buyer)) stats.set(t.buyer, walletStats(t.buyer));
    return {
      signature: t.signature,
      collection: { symbol: t.collection, name: collectionName(t.collection), floor: t.floor },
      mint: t.mint,
      image: t.image,
      price: t.price,
      vsFloorPct: t.floor ? ((t.price - t.floor) / t.floor) * 100 : null,
      blockTime: t.block_time,
      buyer: stats.get(t.buyer)!,
      seller: t.seller,
      take: cachedTake(t.signature) ?? null,
    };
  });
});

// Event feed: ranked ("top"), chronological ("latest") or profitable flips
// ("wins"); buys, flips, sweeps and multi-wallet clusters. `following=<userId>`
// keeps events involving wallets that user follows.
app.get("/events", async (req, reply) => {
  const q = z.object({
    view: z.enum(["top", "latest", "wins"]).default("top"),
    limit: z.coerce.number().int().min(1).max(60).default(30),
    before: z.coerce.number().int().optional(),
    following: z.string().optional(),
    chain: z.enum(["all", "solana", "evm"]).default("all"),
  }).parse(req.query);
  if (q.following && !(await authorize(req, reply, q.following))) return;
  const followed = q.following
    ? new Set((db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(q.following) as { wallet: string }[]).map((r) => r.wallet))
    : undefined;
  return feedEvents({ view: q.view, before: q.before, limit: q.limit, followed, chain: q.chain });
});

// AI take, generated lazily and cached per trade.
app.get("/takes/:signature", async (req, reply) => {
  const { signature } = req.params as { signature: string };
  const t = db.prepare(`${tradeSelect} WHERE t.signature = ?`).get(signature) as TradeRow | undefined;
  if (!t) return reply.code(404).send({ error: "unknown trade" });
  try {
    const take = await getTake({
      signature,
      collection: t.collection,
      price: t.price,
      floor: t.floor,
      avg24h: t.avg_24h,
      volume7d: t.volume_7d,
      buyer: walletStats(t.buyer, unitOf(t.collection)),
    });
    return take ?? reply.code(204).send();
  } catch (err) {
    req.log.warn({ err }, "take failed");
    return reply.code(503).send({ error: "AI unavailable" });
  }
});

app.get("/leaderboard", async (req) => {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    window: z.enum(["7", "30", "all"]).default("30"),
    sort: z.enum(["pnl", "winrate", "roi", "flips"]).default("pnl"),
    minFlips: z.coerce.number().int().min(1).max(50).default(3),
    hideMM: z.enum(["0", "1"]).default("1"),
    // `unit` ranks in one currency; `chain` is the older solana/evm form.
    unit: z.enum(UNITS).optional(),
    chain: z.enum(["solana", "evm"]).default("solana"),
  }).parse(req.query);
  const board = traderLeaderboard({
    windowDays: q.window === "all" ? null : Number(q.window),
    sort: q.sort,
    minFlips: q.minFlips,
    hideMarketMakers: q.hideMM === "1",
    limit: q.limit,
    unit: q.unit ?? (q.chain === "evm" ? "ETH" : "SOL"),
  });
  const ids = traders(board.rows.map((r) => r.wallet));
  return {
    ...board,
    rows: board.rows.map((r) => ({ ...r, name: ids.get(r.wallet)?.name ?? null, avatar: ids.get(r.wallet)?.avatar ?? null })),
  };
});

// One wallet's record in one currency (?unit=, default: the one it trades
// most in), plus every currency it trades in.
app.get("/wallets/:address", async (req) => {
  const { address } = req.params as { address: string };
  const { unit } = z.object({ unit: z.enum(UNITS).optional() }).parse(req.query);
  const units = walletUnits(address);
  const u = unit ?? units[0]?.unit;
  const trades = db.prepare(
    `${tradeSelect} WHERE t.buyer = ? OR t.seller = ? ORDER BY t.block_time DESC LIMIT 50`,
  ).all(address, address) as TradeRow[];
  await nameFor(address);
  return {
    identity: traders([address]).get(address)!,
    unit: u ?? (address.startsWith("0x") ? "ETH" : "SOL"),
    units,
    stats: walletStats(address, u),
    profile: traderProfile(address, u),
    trades: trades.map((t) => ({
      signature: t.signature,
      mint: t.mint,
      currency: unitOf(t.collection), // a wallet's trades can span currencies
      side: t.buyer === address ? "buy" : "sell",
      collection: collectionName(t.collection),
      symbol: t.collection,
      image: t.image,
      price: t.price,
      blockTime: t.block_time,
    })),
  };
});

// --- Sign-in: verify the Privy token and adopt this device's anonymous data ---
app.post("/auth/session", async (req, reply) => {
  const userId = await privyUser(req);
  if (!userId) return reply.code(401).send({ error: "invalid or expired token" });
  const b = z.object({ deviceId: z.string().optional() }).parse(req.body ?? {});
  if (b.deviceId) adoptDevice(userId, b.deviceId);
  return { userId };
});

// --- Follows (userId: anonymous device id, or a Privy user with its token) ---
const FollowBody = z.object({ userId: z.string().min(1), wallet: z.string().min(32).max(44) });

app.get("/follows/:userId", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  if (!(await authorize(req, reply, userId))) return;
  return (db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(userId) as { wallet: string }[])
    .map((r) => r.wallet);
});
app.post("/follows", async (req, reply) => {
  const b = FollowBody.parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  db.prepare("INSERT OR IGNORE INTO follows (user_id, wallet) VALUES (?, ?)").run(b.userId, b.wallet);
  void syncWebhook();
  return { ok: true };
});
app.delete("/follows", async (req, reply) => {
  const b = FollowBody.parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  db.prepare("DELETE FROM follows WHERE user_id = ? AND wallet = ?").run(b.userId, b.wallet);
  void syncWebhook();
  return { ok: true };
});

// --- Paper trading: "buy floor" fills at current floor, "sell" at floor minus a
// haircut that stands in for the top bid. No real SOL moves. P&L counts the
// fees and royalties a real trade would pay. ---
const floorOf = (symbol: string) =>
  (db.prepare("SELECT floor FROM collections WHERE symbol = ?").get(symbol) as { floor: number | null } | undefined)?.floor ?? null;

const paperUnit = (symbol: string) => unitOf(symbol);

app.post("/paper/buy", async (req, reply) => {
  const b = z.object({
    userId: z.string().min(1),
    collection: z.string(),
    copiedFrom: z.string().optional(),
  }).parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  // Paper positions are kept in the collection's own unit (SOL or ETH) and
  // totalled per unit; collections priced in anything else are browse-only.
  if (!(UNITS as readonly string[]).includes(paperUnit(b.collection))) {
    return reply.code(422).send({ error: "Paper trading isn't available for this collection's currency" });
  }
  const floor = floorOf(b.collection);
  if (!floor) return reply.code(409).send({ error: "no floor price yet" });
  const r = db.prepare(
    `INSERT INTO paper_positions (user_id, collection, entry_price, opened_at, copied_from)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(b.userId, b.collection, floor, Date.now(), b.copiedFrom ?? null);
  return { id: r.lastInsertRowid, entryPrice: floor };
});

app.post("/paper/sell", async (req, reply) => {
  const b = z.object({ userId: z.string(), positionId: z.number().int() }).parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  const pos = db.prepare(
    "SELECT * FROM paper_positions WHERE id = ? AND user_id = ? AND closed_at IS NULL",
  ).get(b.positionId, b.userId) as { collection: string } | undefined;
  if (!pos) return reply.code(404).send({ error: "no open position" });
  const floor = floorOf(pos.collection);
  if (!floor) return reply.code(409).send({ error: "no floor price yet" });
  const exit = floor * (1 - config.paperSellHaircut);
  db.prepare("UPDATE paper_positions SET exit_price = ?, closed_at = ? WHERE id = ?")
    .run(exit, Date.now(), b.positionId);
  return { exitPrice: exit };
});

// Wipes the user's paper positions (open and closed): a fresh start for stats.
app.post("/paper/reset", async (req, reply) => {
  const b = z.object({ userId: z.string().min(1) }).parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  const r = db.prepare("DELETE FROM paper_positions WHERE user_id = ?").run(b.userId);
  return { deleted: r.changes };
});

app.get("/paper/:userId", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  if (!(await authorize(req, reply, userId))) return;
  const rows = db.prepare(
    `SELECT p.*, c.floor, COALESCE(c.sale_currency, c.currency) AS currency,
            COALESCE(c.image, (SELECT image FROM trades WHERE collection = p.collection AND image IS NOT NULL
                               ORDER BY block_time DESC LIMIT 1)) AS image
     FROM paper_positions p
     LEFT JOIN collections c ON c.symbol = p.collection
     WHERE p.user_id = ? ORDER BY p.opened_at DESC`,
  ).all(userId) as any[];
  const positions = rows.map((p) => {
    const mark = p.exit_price ?? (p.floor ?? p.entry_price) * (1 - config.paperSellHaircut);
    // Like a real flip: the buy pays the taker fee and royalty on top, the
    // sale (into the top bid) pays the seller's share (fees.ts).
    const fee = feeRates(p.collection);
    const cost = p.entry_price * (1 + fee.buyTaker);
    const proceeds = mark * (1 - fee.sellTaker);
    return {
      id: p.id,
      collection: { symbol: p.collection, name: collectionName(p.collection), floor: p.floor, image: p.image ?? null },
      currency: (p.currency as string | null) ?? "SOL",
      entryPrice: p.entry_price,
      exitPrice: p.exit_price,
      open: p.closed_at == null,
      pnlSol: proceeds - cost,
      feesSol: cost - p.entry_price + mark - proceeds,
      openedAt: p.opened_at,
      copiedFrom: p.copied_from,
    };
  });
  const sum = (xs: typeof positions) => xs.reduce((a, p) => a + p.pnlSol, 0);
  // SOL and ETH can't be added together: one total per unit.
  const totals: Record<string, { realized: number; unrealized: number }> = {};
  for (const unit of new Set(positions.map((p) => p.currency))) {
    const mine = positions.filter((p) => p.currency === unit);
    totals[unit] = { realized: sum(mine.filter((p) => !p.open)), unrealized: sum(mine.filter((p) => p.open)) };
  }
  return {
    positions,
    totals,
    // SOL only, for older app builds.
    realizedSol: totals.SOL?.realized ?? 0,
    unrealizedSol: totals.SOL?.unrealized ?? 0,
  };
});

// --- Helius enhanced-transaction webhook: sales by followed Solana wallets
// (alerts.ts keeps the webhook's address list in sync with follows). Sales in
// collections we track are stored like polled ones, with their exact fees. ---
app.post("/webhooks/helius", async (req, reply) => {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(config.heliusWebhookSecret);
  if (!config.heliusWebhookSecret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return reply.code(401).send();
  }
  const txs = z.array(z.any()).parse(req.body);
  const insert = db.prepare(`INSERT OR IGNORE INTO trades
    (signature, collection, mint, buyer, seller, price, block_time, image, source, cost, proceeds, fees_checked)
    VALUES (@signature, @collection, @mint, @buyer, @seller, @price, @blockTime, NULL, @source, @cost, @proceeds, 1)`);
  let added = 0;
  for (const tx of txs) {
    const ev = tx?.events?.nft;
    if (ev?.type !== "NFT_SALE" || !ev.nfts?.[0]?.mint || !ev.buyer || !ev.seller || !(ev.amount > 0)) continue;
    const mint = ev.nfts[0].mint as string;
    const collection = await collectionOfMint(mint).catch(() => null);
    if (!collection) continue;
    const price = ev.amount / 1e9;
    added += insert.run({
      signature: ev.signature, collection, mint, buyer: ev.buyer, seller: ev.seller, price, blockTime: ev.timestamp,
      source: `helius:${String(ev.source ?? "unknown").toLowerCase()}`, ...amountsFrom(tx, ev.buyer, ev.seller, price),
    }).changes;
  }
  if (added) void checkAlerts();
  return { added };
});

// --- First-party analytics (analytics.ts). The app sends beacons as
// text/plain so browsers skip the CORS preflight. ---
app.post("/a", async (req, reply) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const hits = (Array.isArray(body) ? body : [body]).slice(0, 20) as Hit[];
    for (const h of hits) if (h && typeof h.n === "string") record(req, h);
  } catch { /* malformed beacon: ignore */ }
  return reply.code(204).send();
});

// Admin dashboard. ?key=<ADMIN_TOKEN> once; a cookie keeps it for 30 days.
app.get("/admin/stats", async (req, reply) => {
  const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(7), key: z.string().optional() }).parse(req.query);
  const cookie = /(?:^|;\s*)ff_admin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const given = Buffer.from(q.key ?? cookie ?? "");
  const want = Buffer.from(config.adminToken);
  if (!config.adminToken || given.length !== want.length || !timingSafeEqual(given, want)) return reply.code(404).send();
  if (q.key) reply.header("set-cookie", `ff_admin=${q.key}; Path=/api/admin; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`);
  return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(dashboard(q.days));
});
app.get("/admin/stats.json", async (req, reply) => {
  const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
  const cookie = /(?:^|;\s*)ff_admin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const given = Buffer.from(cookie ?? "");
  const want = Buffer.from(config.adminToken);
  if (!config.adminToken || given.length !== want.length || !timingSafeEqual(given, want)) return reply.code(404).send();
  return summary(q.days);
});

// The in-app guide (guide.ts); /how-it-works serves the same text as HTML.
app.get("/guide", async (_req, reply) => reply.header("cache-control", "public, max-age=600").send(GUIDE));

// --- Discovery panel (discover.ts): who holds what, and native coin prices ---
app.get("/discover/holders", async (req, reply) => {
  const { userId } = z.object({ userId: z.string().optional() }).parse(req.query);
  if (userId && !(await authorize(req, reply, userId))) return;
  const followed = userId
    ? new Set((db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(userId) as { wallet: string }[]).map((r) => r.wallet))
    : new Set<string>();
  return { smart: smartMoney(), following: followingHoldings(followed) };
});
app.get("/prices", async (_req, reply) => reply.header("cache-control", "public, max-age=60").send(tickerPrices()));

// --- Wallet alerts: inbox and web push (alerts.ts) ---
app.get("/alerts/:userId", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  if (!(await authorize(req, reply, userId))) return;
  return inbox(userId, limit);
});
app.get("/alerts/:userId/unread", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  if (!(await authorize(req, reply, userId))) return;
  return { unread: unreadCount(userId), push: hasPush(userId) };
});
app.post("/alerts/:userId/read", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  if (!(await authorize(req, reply, userId))) return;
  return { marked: markRead(userId) };
});
app.get("/push/key", async (_req, reply) => {
  const key = pushKey();
  return key ? { key } : reply.code(501).send({ error: "Push isn't configured" });
});
app.post("/push/subscribe", async (req, reply) => {
  const b = z.object({
    userId: z.string().min(1),
    subscription: z.object({
      endpoint: z.string().url().max(1000),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
    }),
  }).parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  subscribe(b.userId, b.subscription);
  return { ok: true };
});
app.post("/push/unsubscribe", async (req) => {
  const b = z.object({ endpoint: z.string().url().max(1000) }).parse(req.body);
  return { removed: unsubscribe(b.endpoint) };
});

// --- X posting: the browser poster pulls approved drafts (see src/social.ts) ---
function posterAuth(req: FastifyRequest, reply: FastifyReply) {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${config.socialToken}`);
  if (config.socialToken && got.length === want.length && timingSafeEqual(got, want)) return true;
  reply.code(401).send({ error: "unauthorized" });
  return false;
}

app.get("/social/next", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const p = nextPost();
  return p ? { id: p.id, kind: p.kind, text: p.text, image: p.image } : reply.code(204).send();
});

app.post("/social/:id/result", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
  const b = z.object({ ok: z.boolean(), url: z.string().url().nullish(), error: z.string().max(500).nullish() }).parse(req.body);
  return (await reportResult(id, b.ok, b.url ?? null, b.error ?? null)) ? { ok: true } : reply.code(409).send({ error: "not approved" });
});

// Drafts from other apps (CryptoThreads drops). One per kind per day.
app.post("/social/draft", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const b = z.object({
    kind: z.literal("merch"),
    key: z.string().min(1).max(80),
    text: z.string().min(1).max(600),
    image: z.string().url().nullish(),
  }).parse(req.body);
  if (xLength(b.text) > 280) return reply.code(400).send({ error: "too long for X" });
  const r = await submitExternal({ ...b, image: b.image ?? null });
  return "id" in r ? reply.code(201).send(r) : reply.code(409).send(r);
});

// Posted posts of a kind from the last N days, with their X URLs (for reading likes back).
app.get("/social/posted", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const q = z.object({ kind: z.literal("merch"), days: z.coerce.number().int().min(1).max(30).default(7) }).parse(req.query);
  return postedSince(q.kind, Date.now() - q.days * 86_400_000);
});

// Dry run: what each generator would post right now (nothing is saved).
app.get("/social/preview", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const out = [];
  for (const kind of KINDS) {
    const d = await generate(kind, `${kind}:preview:${Date.now()}`);
    out.push(d ? { kind, chars: xLength(d.text), text: d.text, image: d.image } : { kind, text: null });
  }
  return out;
});

// --- Ethereum / Base: balances, holdings, and buys through OpenSea listings ---
app.get("/chain/evm/balance/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
  const b = await evmBalances(address);
  return { ...b, eth: totalEth(b) };
});

app.get("/chain/evm/holdings/:address", async (req, reply) => {
  const { address } = req.params as { address: string };
  if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
  return evmHoldings(address);
});

app.get("/trade/evm/quote/:symbol", async (req, reply) => {
  const { symbol } = req.params as { symbol: string };
  const q = z.object({ buyer: z.string().regex(EVM_ADDRESS_RE).optional(), id: z.string().optional() }).parse(req.query);
  const quote = await evmQuote(symbol, q.buyer, q.id).catch((err) => { req.log.warn({ err }, "evm quote"); return null; });
  if (!quote) return reply.code(404).send({ error: "No quote for this collection" });
  return quote;
});

// An unsigned, already-simulated transaction for the buyer's wallet to confirm.
app.post("/trade/evm/buy-tx", async (req, reply) => {
  const b = z.object({
    orderHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    protocolAddress: z.string().regex(EVM_ADDRESS_RE),
    chain: z.string(),
    buyer: z.string().regex(EVM_ADDRESS_RE),
  }).parse(req.body);
  try {
    return await evmBuyTx(b);
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
});

// One NFT: traits with rarity, rank, owner, listing and its sale history.
// `id` is the mint (Solana) or contract:tokenId (EVM).
app.get("/items/:symbol/:id", async (req, reply) => {
  const { symbol, id } = req.params as { symbol: string; id: string };
  const d = await itemDetail(symbol, id).catch((err) => { req.log.warn({ err }, "item failed"); return null; });
  if (!d) return reply.code(404).send({ error: "unknown item" });
  return d;
});

// --- SEO: Caddy sends page requests here as /seo/<path> (see seo.ts) ---
app.get("/seo/robots.txt", async (_req, reply) => reply.type("text/plain").header("cache-control", "public, max-age=3600").send(robots()));
app.get("/seo/sitemap.xml", async (_req, reply) => reply.type("application/xml").header("cache-control", "public, max-age=3600").send(sitemap()));
app.get("/seo/og/:kind/:file", async (req, reply) => {
  const { kind, file } = req.params as { kind: string; file: string };
  const m = file.match(/^(.+)\.png$/);
  if (!m || (kind !== "collection" && kind !== "wallet")) return reply.code(404).send();
  const png = await card(kind, decodeURIComponent(m[1]));
  if (!png) return reply.code(404).send();
  return reply.type("image/png").header("cache-control", "public, max-age=1800").send(png);
});
app.get("/seo/*", async (req, reply) => {
  const path = "/" + ((req.params as { "*": string })["*"] ?? "");
  const { status, html } = await renderPage(path);
  return reply.code(status).type("text/html; charset=utf-8").header("cache-control", "public, max-age=60").send(html);
});

// INGEST=0 runs the API only. This machine and production share a public IP,
// and so Magic Eden's rate limit.
loadDiscovered(); // last run's discovered EVM collections, before anything reads the lists
if (process.env.INGEST !== "0") startIngest();
else { void refreshPrices(); setInterval(() => void refreshPrices(), 10 * 60_000).unref(); } // USD values for local dev
// Rank every Solana collection's items in the background (weekly refresh),
// starting after boot so it doesn't compete with the first polls.
if (process.env.INGEST !== "0") {
  const warm = () => void warmRarity(COLLECTIONS.map((c) => c.symbol));
  setTimeout(warm, 5 * 60_000).unref();
  setInterval(warm, 6 * 3_600_000).unref();
}
startSocial();
startNames();
startAlerts();
startAnalytics();
// Smart-money holdings take a few seconds to compute: keep them warm.
setTimeout(() => smartMoney(), 60_000).unref();
setInterval(() => smartMoney(), 4 * 60_000).unref();
await app.listen({ host: "0.0.0.0", port: config.port });
