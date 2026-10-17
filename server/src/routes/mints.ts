// Mint hub (mints.ts): drops with progress, mint speed and proven minters;
// one drop (drops.ts) and an in-app mint transaction for it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorize } from "../auth.ts";
import { dropDetail, dropMintTx } from "../drops.ts";
import { orFail } from "../http.ts";
import { dropActivity, mintHub, reminders, setReminder } from "../mints.ts";
import { EVM_ADDRESS_RE } from "../trade-evm.ts";

export function mintRoutes(app: FastifyInstance) {
  app.get("/mints", async (_req, reply) => reply.header("cache-control", "public, max-age=20").send(await mintHub()));
  app.get("/mints/reminders/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!(await authorize(req, reply, userId))) return;
    return { reminders: reminders(userId) };
  });
  app.post("/mints/remind", async (req, reply) => {
    const b = z.object({ userId: z.string().min(1).max(100), slug: z.string().min(1).max(200), on: z.boolean() }).parse(req.body);
    if (!(await authorize(req, reply, b.userId))) return;
    return orFail(reply, 400, () => setReminder(b.userId, b.slug, b.on));
  });

  app.get("/drops/:slug/activity", async (req) => {
    const { slug } = req.params as { slug: string };
    return (await dropActivity(slug)) ?? { mints10m: null, mints1h: null, minters: 0, proven: { count: 0, wallets: [] }, verified: null };
  });
  app.get("/drops/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const q = z.object({ minter: z.string().regex(EVM_ADDRESS_RE).optional() }).parse(req.query);
    if (!/^[a-z0-9-_.]{1,120}$/i.test(slug)) return reply.code(400).send({ error: "bad slug" });
    try { return await dropDetail(slug, q.minter); } catch (err) { req.log.warn({ err }, "drop"); return reply.code(404).send({ error: "Drop not found" }); }
  });
  app.post("/drops/:slug/mint-tx", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const b = z.object({ minter: z.string().regex(EVM_ADDRESS_RE), quantity: z.number().int().min(1).max(100) }).parse(req.body);
    return orFail(reply, 409, () => dropMintTx({ slug, ...b }));
  });
}
