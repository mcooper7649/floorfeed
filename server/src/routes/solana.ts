// Solana: balances, holdings, buy quotes, and the RPC proxy + broadcast the
// Privy wallet uses (the user's wallet signs every transaction).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ADDRESS_RE, capabilities, hasDas, holdings, rpc, solBalance } from "../chain.ts";
import { cheapestListings } from "../collections.ts";
import { collectionName, config, isEvm } from "../config.ts";
import { db } from "../db.ts";
import { perMinute } from "../http.ts";

// Solana JSON-RPC for Privy's Solana confirm screen (balance, fee, simulation),
// forwarded to our RPC so its key stays here. Read and simulate methods only;
// sends go through /chain/sol/send.
const RPC_ALLOW = new Set(["getBalance", "getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "getFeeForMessage",
  "simulateTransaction", "getSignatureStatuses", "getMinimumBalanceForRentExemption", "getRecentPrioritizationFees",
  "getTokenAccountsByOwner", "getTokenAccountBalance", "getGenesisHash", "getSlot", "getBlockHeight", "getEpochInfo",
  "isBlockhashValid", "getTransaction", "getHealth", "getVersion"]);
const rpcLimit = perMinute(240);
// Broadcasts spend our RPC credits: a lighter limit.
const sendLimit = perMinute(20);

// Keep re-sending a transaction every 2s until it shows up on chain or its
// blockhash runs out (~90s). Leaders drop transactions under load, and one
// send is often not enough.
async function rebroadcast(transaction: string, signature: string) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    const st = await rpc<{ value: (unknown | null)[] }>("getSignatureStatuses", [[signature]]).catch(() => null);
    if (st?.value[0]) return;
    await rpc("sendTransaction", [transaction, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]).catch(() => {});
  }
}

export function solanaRoutes(app: FastifyInstance) {
  app.get("/capabilities", async () => capabilities());

  app.get("/chain/balance/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not a Solana address" });
    try {
      return await solBalance(address);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Real portfolio: the wallet's NFTs in tracked collections (Helius DAS).
  app.get("/chain/holdings/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not a Solana address" });
    if (!hasDas()) return reply.code(501).send({ error: "Holdings need a Helius RPC (SOLANA_RPC_URL)" });
    try {
      return await holdings(address);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // What a real "buy floor" would cost: the cheapest listing right now, the
  // buyer's balance, and whether FloorFeed can build the transaction yet.
  app.get("/trade/quote/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { buyer } = z.object({ buyer: z.string().regex(ADDRESS_RE).optional() }).parse(req.query);
    if (isEvm(symbol)) return reply.code(422).send({ error: "Real buys are Solana-only" });
    const coll = db.prepare("SELECT floor FROM collections WHERE symbol = ?").get(symbol) as { floor: number | null } | undefined;
    if (!coll) return reply.code(404).send({ error: "unknown collection" });
    const [listings, balance] = await Promise.all([
      cheapestListings(symbol),
      buyer ? solBalance(buyer).catch(() => null) : null,
    ]);
    const listing = listings[0] ?? null;
    const caps = capabilities();
    return {
      collection: { symbol, name: collectionName(symbol), floor: coll.floor },
      listing,
      // Price is what the listing asks; marketplace fee and royalty are added
      // by the marketplace when it builds the transaction.
      networkFeeSol: 0.000005,
      balanceSol: balance?.sol ?? null,
      executable: caps.buy.enabled,
      reason: caps.buy.enabled ? null : "FloorFeed's marketplace API access is pending, so buys open on Magic Eden for now.",
      marketUrl: listing ? `https://magiceden.io/item-details/${listing.mint}` : `https://magiceden.io/marketplace/${symbol}`,
    };
  });

  // Builds an unsigned buy transaction for the user's wallet to sign. The
  // marketplace API calls need keys we don't have yet, so this reports that
  // plainly instead of pretending. See docs/WALLET_AND_TRADING.md.
  app.post("/trade/buy-tx", async (_req, reply) => {
    const caps = capabilities();
    if (!caps.buy.enabled) {
      return reply.code(501).send({
        error: "Buying isn't enabled yet: FloorFeed needs a Magic Eden or Tensor API key to build buy transactions.",
      });
    }
    return reply.code(501).send({ error: "Buy transactions are not implemented yet." });
  });

  app.post("/solana-rpc", async (req, reply) => {
    if (!rpcLimit(req.ip)) return reply.code(429).send({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } });
    const body = req.body as { method?: string } | { method?: string }[];
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > 20 || calls.some((c) => !c || typeof c.method !== "string" || !RPC_ALLOW.has(c.method))) {
      return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not available here" } });
    }
    const res = await fetch(config.solanaRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      .catch(() => null);
    if (!res) return reply.code(502).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "RPC unavailable" } });
    return reply.code(res.status).header("content-type", "application/json").send(await res.text());
  });

  // Broadcast a Solana transaction the user's wallet signed (the Privy wallet
  // signs only). Signed bytes only, ≤1232 bytes.
  app.post("/chain/sol/send", async (req, reply) => {
    const { transaction } = z.object({ transaction: z.string().regex(/^[A-Za-z0-9+/=]{100,1700}$/) }).parse(req.body);
    if (!sendLimit(req.ip)) return reply.code(429).send({ error: "Too many transactions. Wait a minute and try again." });
    const bytes = Buffer.from(transaction, "base64");
    if (bytes.length > 1232 || bytes[0] < 1 || bytes.subarray(1, 65).every((b) => b === 0)) {
      return reply.code(400).send({ error: "That transaction isn't signed." });
    }
    try {
      const signature = await rpc<string>("sendTransaction", [transaction, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
      void rebroadcast(transaction, signature);
      return { signature };
    } catch (err) {
      const m = (err as Error).message;
      return reply.code(409).send({ error: /blockhash not found|expired/i.test(m) ? "The transaction expired before it was sent. Try again."
        : /insufficient (funds|lamports)|no record of a prior credit/i.test(m) ? "Not enough SOL for this plus the network fee." : `Solana rejected it: ${m.replace(/^RPC /, "").slice(0, 160)}` });
    }
  });

  app.get("/chain/blockhash", async (_req, reply) => {
    try {
      const r = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: String(r.value.lastValidBlockHeight) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
