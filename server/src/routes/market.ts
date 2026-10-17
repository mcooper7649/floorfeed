// Read-only market data: collections, items, feeds, leaderboard, wallets,
// discovery, prices and the in-app guide.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cachedTake, getTake } from "../ai.ts";
import { authorize } from "../auth.ts";
import { collectionDetail, listCollections } from "../collections.ts";
import { collectionAbout, collectionHolders, collectionMarkers, collectionSales } from "../collection-tabs.ts";
import { UNITS, collectionName } from "../config.ts";
import { db } from "../db.ts";
import { followingHoldings, mintingDrops, smartMoney } from "../discover.ts";
import { feedEvents, traders } from "../feed.ts";
import { GUIDE, GUIDE_PARTS, GUIDE_V1 } from "../guide.ts";
import { itemDetail } from "../items.ts";
import { marks } from "../marks.ts";
import { walletStats } from "../pnl.ts";
import { tickerPrices } from "../prices.ts";
import { nameFor } from "../sns.ts";
import { authorOf, takeMarkers } from "../takes.ts";
import { traderLeaderboard, traderProfile, walletUnits } from "../traders.ts";
import { unitOf } from "../units.ts";
import { followedWallets } from "./account.ts";

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

const Range = z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d)).default(7);

export function marketRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    trades: (db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n,
  }));

  app.get("/collections", async () => listCollections());

  app.get("/collections/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { range } = z.object({ range: Range }).parse(req.query);
    const detail = await collectionDetail(symbol, range);
    if (!detail) return reply.code(404).send({ error: "unknown collection" });
    const about = await collectionAbout(symbol);
    // .sol names / avatars for the wallets on the page.
    const ids = traders([...detail.topFlippers.map((f) => f.wallet), ...detail.recentSales.map((r) => r.buyer)]);
    return {
      ...detail,
      about,
      topFlippers: detail.topFlippers.map((f) => ({ ...f, name: ids.get(f.wallet)?.name ?? null, avatar: ids.get(f.wallet)?.avatar ?? null })),
      recentSales: detail.recentSales.map((r) => ({ ...r, buyerName: ids.get(r.buyer)?.name ?? null })),
    };
  });

  // Collection page tabs (collection-tabs.ts).
  app.get("/collections/:symbol/holders", async (req) => {
    const { symbol } = req.params as { symbol: string };
    return collectionHolders(symbol);
  });
  // Trader avatars on the price chart: trades by proven wallets and/or the given wallets.
  app.get("/collections/:symbol/markers", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const q = z.object({
      range: Range,
      proven: z.enum(["0", "1"]).default("1"),
      wallets: z.string().max(4000).optional(), // comma-separated
      takes: z.enum(["0", "1"]).default("0"),
    }).parse(req.query);
    const wallets = (q.wallets ?? "").split(",").map((w) => w.trim()).filter(Boolean).slice(0, 100);
    const trades = q.proven === "1" || wallets.length ? collectionMarkers(symbol, q.range, { proven: q.proven === "1", wallets }) : [];
    if (q.takes !== "1") return trades;
    // Takes sit on the chart at the floor when they were posted.
    const rows = takeMarkers(symbol, Math.floor(Date.now() / 1000) - q.range * 86_400);
    const who = traders(rows.flatMap((r) => (r.wallet ? [r.wallet] : [])));
    return [...trades, ...rows.map((r) => ({
      t: Math.floor(r.created_at / 1000), price: r.floor!, side: "take" as const, wallet: r.wallet ?? "", mint: "",
      name: authorOf(r, r.wallet ? who.get(r.wallet) : null).name, avatar: r.wallet ? who.get(r.wallet)?.avatar ?? null : null,
      tier: r.wallet ? who.get(r.wallet)?.tier ?? null : null, text: r.text, takeId: r.id,
    }))];
  });
  app.get("/collections/:symbol/sales", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return collectionSales(symbol, limit);
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
      kinds: z.enum(["all", "buys", "flips"]).default("all"),
      bots: z.enum(["show", "hide"]).default("show"),
    }).parse(req.query);
    if (q.following && !(await authorize(req, reply, q.following))) return;
    const followed = q.following ? new Set(followedWallets(q.following)) : undefined;
    return feedEvents({ view: q.view, before: q.before, limit: q.limit, followed, chain: q.chain, kinds: q.kinds, hideBots: q.bots === "hide" });
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

  // One NFT: traits with rarity, rank, owner, listing and its sale history.
  // `id` is the mint (Solana) or contract:tokenId (EVM).
  app.get("/items/:symbol/:id", async (req, reply) => {
    const { symbol, id } = req.params as { symbol: string; id: string };
    const d = await itemDetail(symbol, id).catch((err) => { req.log.warn({ err }, "item failed"); return null; });
    if (!d) return reply.code(404).send({ error: "unknown item" });
    return d;
  });

  // Discovery panel (discover.ts): who holds what, and native coin prices.
  app.get("/discover/holders", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().optional() }).parse(req.query);
    if (userId && !(await authorize(req, reply, userId))) return;
    const followed = new Set(userId ? followedWallets(userId) : []);
    return { smart: smartMoney(), following: followingHoldings(followed) };
  });
  app.get("/drops", async () => mintingDrops());
  app.get("/prices", async (_req, reply) => reply.header("cache-control", "public, max-age=60").send(tickerPrices()));

  // Portfolio panel: current values for the collections a wallet holds (DB only).
  app.get("/portfolio/marks", async (req, reply) => {
    const { c } = z.object({ c: z.string().max(4000) }).parse(req.query);
    const symbols = c.split(",").map((x) => x.trim()).filter((x) => /^[\w.-]{1,80}$/.test(x));
    return reply.header("cache-control", "no-store").send(marks(symbols));
  });

  // The in-app guide (guide.ts); /how-it-works serves the same text as HTML.
  // v=2 adds parts (basics/paper/real), screenshots, steps and tips; older app
  // builds get paragraphs and lists only.
  app.get("/guide", async (req, reply) => {
    const v2 = (req.query as { v?: string }).v === "2";
    return reply.header("cache-control", "public, max-age=600").send(v2 ? { parts: GUIDE_PARTS, sections: GUIDE } : GUIDE_V1);
  });
}
