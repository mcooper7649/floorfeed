// Takes (takes.ts): theses people post on collections. Posting needs a signed-in account.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authorize, privyUser } from "../auth.ts";
import { config } from "../config.ts";
import { bearer, secretMatches } from "../http.ts";
import { TakeError, collectionTakes, deleteTake, getProfile, postTake, recentTheses, reportTake, setProfileName, signedMessage, toggleLike } from "../takes.ts";

const takeReply = (reply: FastifyReply, err: unknown) => {
  if (err instanceof TakeError) return reply.code(err.status).send({ error: err.message });
  throw err;
};

const TakeId = z.object({ id: z.coerce.number().int() });

export function takeRoutes(app: FastifyInstance) {
  app.get("/collections/:symbol/takes", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const { userId } = z.object({ userId: z.string().optional() }).parse(req.query);
    return collectionTakes(symbol, userId ?? null);
  });
  // The live thesis feed across collections (discovery panel, phone Feed).
  app.get("/theses", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(40), userId: z.string().optional(), ai: z.enum(["0", "1"]).default("1") }).parse(req.query);
    return recentTheses(q.limit, q.userId ?? null, q.ai === "1");
  });
  // Your display name (signed-in accounts), shown on your theses.
  app.get("/profile", async (req, reply) => {
    const userId = await privyUser(req);
    if (!userId) return reply.code(401).send({ error: "Sign in again." });
    return getProfile(userId);
  });
  app.put("/profile", async (req, reply) => {
    const userId = await privyUser(req);
    if (!userId) return reply.code(401).send({ error: "Sign in again." });
    const { name } = z.object({ name: z.string().max(40) }).parse(req.body);
    try { return setProfileName(userId, name); } catch (err) { return takeReply(reply, err); }
  });
  app.get("/takes/message", async (req) => {
    const q = z.object({ collection: z.string(), text: z.string().max(2000), ts: z.coerce.number().int() }).parse(req.query);
    return { message: signedMessage(q.collection, q.text.trim(), q.ts) };
  });
  app.post("/takes", async (req, reply) => {
    const userId = await privyUser(req);
    if (!userId) return reply.code(401).send({ error: "Sign in to post a take." });
    const b = z.object({
      collection: z.string().min(1).max(120), text: z.string().max(2000),
      wallet: z.string().max(64).optional(), signature: z.string().max(400).optional(), ts: z.number().int().optional(),
    }).parse(req.body);
    try { return await postTake(userId, b); } catch (err) { return takeReply(reply, err); }
  });
  app.post("/takes/:id/like", async (req, reply) => {
    const { id } = TakeId.parse(req.params);
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    if (!(await authorize(req, reply, userId))) return;
    try { return toggleLike(id, userId); } catch (err) { return takeReply(reply, err); }
  });
  app.post("/takes/:id/report", async (req, reply) => {
    const { id } = TakeId.parse(req.params);
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    if (!(await authorize(req, reply, userId))) return;
    try { return await reportTake(id, userId); } catch (err) { return takeReply(reply, err); }
  });
  app.delete("/takes/:id", async (req, reply) => {
    const { id } = TakeId.parse(req.params);
    const userId = await privyUser(req);
    if (!userId) return reply.code(401).send({ error: "Sign in again." });
    try { return deleteTake(id, userId); } catch (err) { return takeReply(reply, err); }
  });
  // Moderation: bearer token only (not the dashboard cookie).
  app.delete("/admin/takes/:id", async (req, reply) => {
    const { id } = TakeId.parse(req.params);
    if (!secretMatches(bearer(req) ?? "", config.adminToken)) return reply.code(404).send();
    try { return deleteTake(id, null); } catch (err) { return takeReply(reply, err); }
  });
}
