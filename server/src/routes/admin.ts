// Analytics beacons, the admin dashboard, support reports and the Helius webhook.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { checkAlerts } from "../alerts.ts";
import { dashboard, record, summary, type Hit } from "../analytics.ts";
import { collectionOfMint } from "../chain.ts";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { amountsFrom } from "../fees.ts";
import { adminCookie, adminOk, secretMatches } from "../http.ts";
import { listReports, setReportStatus, submitReport, SupportError } from "../support.ts";

const supportReply = (reply: FastifyReply, err: unknown) => {
  if (err instanceof SupportError) return reply.code(err.status).send({ error: err.message });
  throw err;
};

const Days = z.coerce.number().int().min(1).max(90).default(7);

export function adminRoutes(app: FastifyInstance) {
  // First-party analytics (analytics.ts). The app sends beacons as
  // text/plain so browsers skip the CORS preflight.
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
    const q = z.object({ days: Days, key: z.string().optional() }).parse(req.query);
    if (!secretMatches(q.key ?? adminCookie(req) ?? "", config.adminToken)) return reply.code(404).send();
    if (q.key) reply.header("set-cookie", `ff_admin=${q.key}; Path=/api/admin; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`);
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(dashboard(q.days));
  });
  app.get("/admin/stats.json", async (req, reply) => {
    const q = z.object({ days: Days }).parse(req.query);
    if (!adminOk(req)) return reply.code(404).send();
    return summary(q.days);
  });

  // Support form (support.ts): anyone can report; the admin token lists / closes.
  app.post("/support", async (req, reply) => {
    try { return await submitReport(req, req.body); } catch (err) { return supportReply(reply, err); }
  });
  app.get("/admin/support", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send();
    const q = z.object({ status: z.enum(["open", "closed", "all"]).default("open"), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return reply.header("cache-control", "no-store").send({ reports: listReports(q.status, q.limit) });
  });
  app.post("/admin/support/:id/:action", async (req, reply) => {
    if (!adminOk(req)) return reply.code(404).send();
    const { id, action } = z.object({ id: z.coerce.number().int(), action: z.enum(["close", "reopen"]) }).parse(req.params);
    try { return setReportStatus(id, action === "close" ? "closed" : "open"); } catch (err) { return supportReply(reply, err); }
  });

  // Helius enhanced-transaction webhook: sales by followed Solana wallets
  // (alerts.ts keeps the webhook's address list in sync with follows). Sales in
  // collections we track are stored like polled ones, with their exact fees.
  app.post("/webhooks/helius", async (req, reply) => {
    if (!secretMatches(req.headers.authorization ?? "", config.heliusWebhookSecret)) return reply.code(401).send();
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
}
