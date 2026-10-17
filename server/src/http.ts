// Small helpers shared by the route modules in routes/.
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";

// Constant-time compare; an unset secret never matches.
export const secretMatches = (given: string, want: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return !!want && a.length === b.length && timingSafeEqual(a, b);
};

export const bearer = (req: FastifyRequest) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
export const adminCookie = (req: FastifyRequest) => /(?:^|;\s*)ff_admin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];

// The admin token, from the dashboard cookie or a bearer header.
export const adminOk = (req: FastifyRequest) => secretMatches(adminCookie(req) ?? bearer(req) ?? "", config.adminToken);

// A sliding one-minute window per key (an IP): true when this hit is allowed, and counts it.
export function perMinute(limit: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) return false;
    hits.set(key, [...recent, now]);
    return true;
  };
}

// Runs `fn`; anything it throws goes back as `{ error: message }` with `status`.
export async function orFail(reply: FastifyReply, status: number, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    return reply.code(status).send({ error: (err as Error).message });
  }
}
