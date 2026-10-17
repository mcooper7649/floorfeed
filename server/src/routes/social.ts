// X posting: the browser poster pulls approved drafts (see social.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { secretMatches } from "../http.ts";
import { KINDS, generate, nextPost, postedSince, reportResult, submitExternal, xLength } from "../social.ts";

function posterAuth(req: FastifyRequest, reply: FastifyReply) {
  if (config.socialToken && secretMatches(req.headers.authorization ?? "", `Bearer ${config.socialToken}`)) return true;
  reply.code(401).send({ error: "unauthorized" });
  return false;
}

export function socialRoutes(app: FastifyInstance) {
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
}
