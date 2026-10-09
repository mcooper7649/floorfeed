import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.ts";
import { db } from "./db.ts";

// Two kinds of user id:
//  - "dev-…": anonymous per-device id, unauthenticated (the demo works
//    without signing in).
//  - "did:privy:…": a Privy user. Every request for one must carry that
//    user's Privy access token (an ES256 JWT, verified against Privy's JWKS).
const jwks = config.privyAppId
  ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${config.privyAppId}/jwks.json`))
  : null;

export const isPrivyId = (userId: string) => userId.startsWith("did:privy:");

// The Privy user id (token subject) for this request, or null.
export async function privyUser(req: FastifyRequest): Promise<string | null> {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m || !jwks) {
    req.log.warn({ auth: m ? "privy not configured" : "no bearer token" }, "auth rejected");
    return null;
  }
  try {
    const { payload } = await jwtVerify(m[1], jwks, { issuer: "privy.io", audience: config.privyAppId });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch (e) {
    // Reason only (expired, bad audience, …), never the token itself.
    req.log.warn({ auth: (e as { code?: string }).code ?? String(e) }, "auth rejected");
    return null;
  }
}

// Gate for routes keyed on a user id. Returns false (and replies 401) when a
// Privy id is used without a matching token.
export async function authorize(req: FastifyRequest, reply: FastifyReply, userId: string) {
  if (!isPrivyId(userId)) return true;
  if ((await privyUser(req)) === userId) return true;
  reply.code(401).send({ error: "sign in again" });
  return false;
}

// First sign-in on a device: move that device's follows and paper positions
// to the Privy user so nothing is lost.
export function adoptDevice(userId: string, deviceId: string) {
  if (!deviceId.startsWith("dev-")) return;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO follows (user_id, wallet) SELECT ?, wallet FROM follows WHERE user_id = ?")
      .run(userId, deviceId);
    db.prepare("DELETE FROM follows WHERE user_id = ?").run(deviceId);
    db.prepare("UPDATE paper_positions SET user_id = ? WHERE user_id = ?").run(userId, deviceId);
  })();
}
