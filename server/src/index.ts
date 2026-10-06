import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { cachedTake, getTake } from "./ai.ts";
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import { startIngest } from "./ingest.ts";
import { leaderboard, walletStats } from "./pnl.ts";

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
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  ok: true,
  trades: (db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n,
}));

app.get("/collections", async () =>
  db.prepare("SELECT * FROM collections ORDER BY volume_7d DESC").all()
    .map((c: any) => ({ ...c, name: collectionName(c.symbol) })),
);

// Feed of recent buys. `following=<userId>` limits it to wallets that user follows;
// `before=<unix>` paginates.
app.get("/feed", async (req) => {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().int().optional(),
    following: z.string().optional(),
  }).parse(req.query);
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
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
    .parse(req.query);
  return leaderboard(limit);
});

app.get("/wallets/:address", async (req) => {
  const { address } = req.params as { address: string };
  const trades = db.prepare(
    `${tradeSelect} WHERE t.buyer = ? OR t.seller = ? ORDER BY t.block_time DESC LIMIT 50`,
  ).all(address, address) as TradeRow[];
  return {
    stats: walletStats(address),
    trades: trades.map((t) => ({
      signature: t.signature,
      side: t.buyer === address ? "buy" : "sell",
      collection: collectionName(t.collection),
      image: t.image,
      price: t.price,
      blockTime: t.block_time,
    })),
  };
});

// --- Follows (userId is a device id until Privy auth lands) ---
const FollowBody = z.object({ userId: z.string().min(1), wallet: z.string().min(32).max(44) });

app.get("/follows/:userId", async (req) => {
  const { userId } = req.params as { userId: string };
  return (db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(userId) as { wallet: string }[])
    .map((r) => r.wallet);
});
app.post("/follows", async (req) => {
  const b = FollowBody.parse(req.body);
  db.prepare("INSERT OR IGNORE INTO follows (user_id, wallet) VALUES (?, ?)").run(b.userId, b.wallet);
  return { ok: true };
});
app.delete("/follows", async (req) => {
  const b = FollowBody.parse(req.body);
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

app.get("/paper/:userId", async (req) => {
  const { userId } = req.params as { userId: string };
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

startIngest();
await app.listen({ host: "0.0.0.0", port: config.port });
