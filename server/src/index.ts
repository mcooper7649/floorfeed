import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { cachedTake, getTake } from "./ai.ts";
import { adoptDevice, authorize, privyUser } from "./auth.ts";
import { ADDRESS_RE, capabilities, hasDas, holdings, solBalance } from "./chain.ts";
import { cheapestListings, collectionDetail, listCollections } from "./collections.ts";
import { collectionName, config, isEvm } from "./config.ts";
import { db } from "./db.ts";
import { feedEvents } from "./feed.ts";
import { startIngest } from "./ingest.ts";
import { KINDS, generate, nextPost, reportResult, startSocial, xLength, type Kind } from "./social.ts";
import { walletStats } from "./pnl.ts";
import { startNames } from "./sns.ts";
import { traderLeaderboard, traderProfile } from "./traders.ts";

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
  return detail ?? reply.code(404).send({ error: "unknown collection" });
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
  }).parse(req.query);
  if (q.following && !(await authorize(req, reply, q.following))) return;
  const followed = q.following
    ? new Set((db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(q.following) as { wallet: string }[]).map((r) => r.wallet))
    : undefined;
  return feedEvents({ view: q.view, before: q.before, limit: q.limit, followed });
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
      buyer: walletStats(t.buyer),
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
  }).parse(req.query);
  return traderLeaderboard({
    windowDays: q.window === "all" ? null : Number(q.window),
    sort: q.sort,
    minFlips: q.minFlips,
    hideMarketMakers: q.hideMM === "1",
    limit: q.limit,
  });
});

app.get("/wallets/:address", async (req) => {
  const { address } = req.params as { address: string };
  const trades = db.prepare(
    `${tradeSelect} WHERE t.buyer = ? OR t.seller = ? ORDER BY t.block_time DESC LIMIT 50`,
  ).all(address, address) as TradeRow[];
  return {
    stats: walletStats(address),
    profile: traderProfile(address),
    trades: trades.map((t) => ({
      signature: t.signature,
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
  return { ok: true };
});
app.delete("/follows", async (req, reply) => {
  const b = FollowBody.parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  db.prepare("DELETE FROM follows WHERE user_id = ? AND wallet = ?").run(b.userId, b.wallet);
  return { ok: true };
});

// --- Paper trading: "buy floor" fills at current floor, "sell" at floor minus a
// haircut that stands in for the top bid. No real SOL moves. ---
const floorOf = (symbol: string) =>
  (db.prepare("SELECT floor FROM collections WHERE symbol = ?").get(symbol) as { floor: number | null } | undefined)?.floor ?? null;

app.post("/paper/buy", async (req, reply) => {
  const b = z.object({
    userId: z.string().min(1),
    collection: z.string(),
    copiedFrom: z.string().optional(),
  }).parse(req.body);
  if (!(await authorize(req, reply, b.userId))) return;
  // The paper portfolio is denominated in SOL; EVM collections are browse-only for now.
  if (isEvm(b.collection)) return reply.code(422).send({ error: "Paper trading is Solana-only for now" });
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

app.get("/paper/:userId", async (req, reply) => {
  const { userId } = req.params as { userId: string };
  if (!(await authorize(req, reply, userId))) return;
  const rows = db.prepare(
    `SELECT p.*, c.floor FROM paper_positions p
     LEFT JOIN collections c ON c.symbol = p.collection
     WHERE p.user_id = ? ORDER BY p.opened_at DESC`,
  ).all(userId) as any[];
  const positions = rows.map((p) => {
    const mark = p.exit_price ?? (p.floor ?? p.entry_price) * (1 - config.paperSellHaircut);
    return {
      id: p.id,
      collection: { symbol: p.collection, name: collectionName(p.collection), floor: p.floor },
      entryPrice: p.entry_price,
      exitPrice: p.exit_price,
      open: p.closed_at == null,
      pnlSol: mark - p.entry_price,
      openedAt: p.opened_at,
      copiedFrom: p.copied_from,
    };
  });
  const sum = (xs: typeof positions) => xs.reduce((a, p) => a + p.pnlSol, 0);
  return {
    positions,
    realizedSol: sum(positions.filter((p) => !p.open)),
    unrealizedSol: sum(positions.filter((p) => p.open)),
  };
});

// --- Phase 2: Helius enhanced-transaction webhook for wallet-level tracking.
// Ingests NFT_SALE events for mints we can map to a tracked collection. ---
app.post("/webhooks/helius", async (req, reply) => {
  if (config.heliusWebhookSecret && req.headers.authorization !== config.heliusWebhookSecret) {
    return reply.code(401).send();
  }
  const txs = z.array(z.any()).parse(req.body);
  const known = db.prepare("SELECT collection FROM trades WHERE mint = ? LIMIT 1");
  const insert = db.prepare(`INSERT OR IGNORE INTO trades
    (signature, collection, mint, buyer, seller, price, block_time, image, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  let added = 0;
  for (const tx of txs) {
    const ev = tx?.events?.nft;
    if (ev?.type !== "NFT_SALE" || !ev.nfts?.[0]?.mint) continue;
    const mint = ev.nfts[0].mint as string;
    const col = (known.get(mint) as { collection: string } | undefined)?.collection;
    if (!col) continue;
    added += insert.run(ev.signature, col, mint, ev.buyer, ev.seller, ev.amount / 1e9, ev.timestamp, ev.source ?? "helius").changes;
  }
  return { added };
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

// Dry run: what each generator would post right now (nothing is saved).
app.get("/social/preview", async (req, reply) => {
  if (!posterAuth(req, reply)) return;
  const out = [];
  for (const kind of KINDS as Kind[]) {
    const d = await generate(kind, `${kind}:preview:${Date.now()}`);
    out.push(d ? { kind, chars: xLength(d.text), text: d.text, image: d.image } : { kind, text: null });
  }
  return out;
});

// INGEST=0 runs the API only. This machine and production share a public IP,
// and so Magic Eden's rate limit.
if (process.env.INGEST !== "0") startIngest();
startSocial();
startNames();
await app.listen({ host: "0.0.0.0", port: config.port });
