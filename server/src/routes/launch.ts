// Launchpad (launch.ts): creators' drafts (keyed by userId), uploads, deploy
// and manage txs, and the public mint page of a launched collection.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize } from "../auth.ts";
import * as launch from "../launch.ts";

const launchErr = (reply: FastifyReply, err: unknown) => {
  if (err instanceof launch.LaunchError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Check the form." });
  throw err;
};
const Uid = z.object({ userId: z.string().min(1).max(100) });
// A creator-only route: userId (from the body or query) must be the signed-in user.
const launchRoute = (fn: (req: FastifyRequest, userId: string) => unknown, from: "body" | "query" = "body") =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { userId } = Uid.parse(from === "body" ? req.body : req.query);
      if (!(await authorize(req, reply, userId))) return;
      return await fn(req, userId);
    } catch (err) { return launchErr(reply, err); }
  };
const lid = (req: FastifyRequest) => (req.params as { id: string }).id;

export function launchRoutes(app: FastifyInstance) {
  app.get("/launch/config", async () => launch.launchConfig());
  app.get("/launch/mine", launchRoute((_req, u) => ({ launches: launch.myLaunches(u) }), "query"));
  app.post("/launch/drafts", launchRoute((req, u) => launch.createDraft(u, (req.body as { draft: unknown }).draft)));
  app.get("/launch/drafts/:id", launchRoute((req, u) => launch.getDraft(lid(req), u), "query"));
  app.put("/launch/drafts/:id", launchRoute((req, u) => launch.updateDraft(lid(req), u, (req.body as { draft: unknown }).draft)));
  app.delete("/launch/drafts/:id", launchRoute((req, u) => launch.deleteDraft(lid(req), u)));
  app.post("/launch/drafts/:id/sign", launchRoute((req, u) => {
    const b = z.object({ count: z.number().int().min(1).max(50), kind: z.enum(["art", "image"]) }).parse(req.body);
    return launch.signUploads(lid(req), u, b.count, b.kind);
  }));
  app.post("/launch/drafts/:id/items", launchRoute((req, u) => launch.putItems(lid(req), u, (req.body as { items: unknown }).items)));
  app.post("/launch/drafts/:id/trim", launchRoute((req, u) => launch.trimItems(lid(req), u, z.object({ n: z.number().int().min(0) }).parse(req.body).n)));
  app.get("/launch/drafts/:id/items", launchRoute((req, u) => {
    const q = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { items: launch.listItems(lid(req), u, q.offset, q.limit) };
  }, "query"));
  app.post("/launch/drafts/:id/allowlist", { bodyLimit: 2_000_000 }, launchRoute((req, u) => {
    const b = z.object({ phase: z.number().int().min(0).max(7), wallets: z.array(z.string().max(64)).max(25_000) }).parse(req.body);
    return launch.setAllowlist(lid(req), u, b.phase, b.wallets);
  }));
  app.post("/launch/drafts/:id/metadata", launchRoute((req, u) => launch.buildMetadata(lid(req), u)));
  app.post("/launch/drafts/:id/deploy-tx", launchRoute((req, u) => launch.deployTx(lid(req), u, z.object({ creator: z.string() }).parse(req.body).creator)));
  app.post("/launch/drafts/:id/deployed", launchRoute((req, u) => launch.confirmDeploy(lid(req), u, z.object({ hash: z.string() }).parse(req.body).hash)));
  app.post("/launch/drafts/:id/manage-tx", launchRoute((req, u) => {
    const b = z.object({ action: z.enum(["reveal", "withdraw", "freeze"]), to: z.string().optional() }).parse(req.body);
    return launch.manageTx(lid(req), u, b);
  }));

  app.get("/launch/c/:chain/:address", async (req, reply) => {
    const { chain, address } = req.params as { chain: string; address: string };
    const { wallet } = req.query as { wallet?: string };
    try { return await launch.launchedCollection(chain, address, wallet); } catch (err) { return launchErr(reply, err); }
  });
  app.post("/launch/c/:chain/:address/mint-tx", async (req, reply) => {
    const { chain, address } = req.params as { chain: string; address: string };
    try {
      const b = z.object({ minter: z.string(), phase: z.number().int().min(0).max(7), quantity: z.number().int().min(1).max(50) }).parse(req.body);
      return await launch.launchMintTx(chain, address, b);
    } catch (err) { return launchErr(reply, err); }
  });
}
