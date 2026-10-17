// A user's own state: sign-in, follows, paper trading, alerts and web push.
// userId is an anonymous device id, or a Privy user with its token (auth.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasPush, inbox, markRead, pushKey, subscribe, syncWebhook, unreadCount, unsubscribe } from "../alerts.ts";
import { adoptDevice, authorize, privyUser } from "../auth.ts";
import { listingLadder } from "../collections.ts";
import { UNITS, collectionName, config } from "../config.ts";
import { db } from "../db.ts";
import { markPosition, practiceLeaderboard, type PositionRow } from "../practice.ts";
import { unitOf } from "../units.ts";
import { syncPrivyWallets } from "../user-wallets.ts";

export const followedWallets = (userId: string) =>
  (db.prepare("SELECT wallet FROM follows WHERE user_id = ?").all(userId) as { wallet: string }[]).map((r) => r.wallet);

const floorOf = (symbol: string) =>
  (db.prepare("SELECT floor FROM collections WHERE symbol = ?").get(symbol) as { floor: number | null } | undefined)?.floor ?? null;

const FollowBody = z.object({ userId: z.string().min(1), wallet: z.string().min(32).max(44) });

export function accountRoutes(app: FastifyInstance) {
  // Sign-in: verify the Privy token and adopt this device's anonymous data.
  app.post("/auth/session", async (req, reply) => {
    const userId = await privyUser(req);
    if (!userId) return reply.code(401).send({ error: "invalid or expired token" });
    const b = z.object({ deviceId: z.string().optional() }).parse(req.body ?? {});
    if (b.deviceId) adoptDevice(userId, b.deviceId);
    void syncPrivyWallets(userId); // their wallets show their account name (user-wallets.ts)
    return { userId };
  });

  // --- Follows ---
  app.get("/follows/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!(await authorize(req, reply, userId))) return;
    return followedWallets(userId);
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
  app.post("/paper/buy", async (req, reply) => {
    const b = z.object({
      userId: z.string().min(1),
      collection: z.string(),
      copiedFrom: z.string().optional(),
      count: z.number().int().min(1).max(10).default(1), // a sweep: the N cheapest listings
    }).parse(req.body);
    if (!(await authorize(req, reply, b.userId))) return;
    // Paper positions are kept in the collection's own unit (SOL or ETH) and
    // totalled per unit; collections priced in anything else are browse-only.
    if (!(UNITS as readonly string[]).includes(unitOf(b.collection))) {
      return reply.code(422).send({ error: "Paper trading isn't available for this collection's currency" });
    }
    const floor = floorOf(b.collection);
    if (!floor) return reply.code(409).send({ error: "no floor price yet" });
    // One item fills at the floor; a sweep walks up the live listings (the
    // floor again where we have fewer listings than asked for).
    const ladder = b.count > 1 ? (await listingLadder(b.collection).catch(() => [])).map((l) => l.price) : [];
    const prices = Array.from({ length: b.count }, (_, i) => Math.max(floor, ladder[i] ?? ladder.at(-1) ?? floor));
    const insert = db.prepare(
      `INSERT INTO paper_positions (user_id, collection, entry_price, opened_at, copied_from)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const ids = db.transaction(() => prices.map((p) => insert.run(b.userId, b.collection, p, Date.now(), b.copiedFrom ?? null).lastInsertRowid))();
    return { id: ids[0], ids, entryPrice: floor, entryPrices: prices, total: prices.reduce((a, p) => a + p, 0) };
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
    ).all(userId) as PositionRow[];
    const positions = rows.map((p) => {
      const { pnl, fees, breakEven } = markPosition(p);
      return {
        id: p.id,
        collection: { symbol: p.collection, name: collectionName(p.collection), floor: p.floor, image: p.image ?? null },
        currency: (p.currency as string | null) ?? "SOL",
        entryPrice: p.entry_price,
        exitPrice: p.exit_price,
        open: p.closed_at == null,
        pnlSol: pnl,
        feesSol: fees,
        breakEven: p.closed_at == null ? breakEven : null, // the floor this open position needs to be in profit
        openedAt: p.opened_at,
        closedAt: p.closed_at,
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

  // Top practice traders (practice.ts): ranked by return, in dollars across coins.
  // `userId` only marks the viewer's own row and standing.
  app.get("/practice/leaderboard", async (req, reply) => {
    const q = z.object({ window: z.enum(["season", "last", "7", "30", "all"]).default("season"), userId: z.string().max(200).optional() }).parse(req.query);
    return reply.header("cache-control", "no-store").send(practiceLeaderboard(q.window, q.userId ?? null));
  });

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
}
