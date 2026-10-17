// Moving money across chains and the wallet's record: bridging (Relay),
// sending coins, FloorFeed activity and full history.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACTIVITY_KINDS, recordActivity, walletActivity } from "../activity.ts";
import { bridgeQuote, bridgeStatus } from "../bridge.ts";
import { ADDRESS_RE } from "../chain.ts";
import { historyCsv, walletHistory } from "../history.ts";
import { orFail } from "../http.ts";
import { solSendTx } from "../send.ts";
import { EVM_ADDRESS_RE, evmSendTx } from "../trade-evm.ts";

// An EVM tx hash, or a Solana signature (base58, 64 bytes).
const TX_HASH_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{80,90})$/;
const isWallet = (a: string) => EVM_ADDRESS_RE.test(a) || ADDRESS_RE.test(a);

export function walletRoutes(app: FastifyInstance) {
  // Moving native tokens between chains in-app (Relay). The user's wallet signs the deposit.
  app.post("/bridge/quote", async (req, reply) => {
    const addr = z.string().refine(isWallet, "Not a wallet address");
    const b = z.object({
      user: addr, recipient: addr.optional(), from: z.string(), to: z.string(),
      amount: z.number().positive().optional(), side: z.enum(["send", "receive"]).optional(), fraction: z.number().positive().max(1).optional(),
    }).refine((x) => x.amount != null || x.fraction != null, "Enter an amount").parse(req.body);
    return orFail(reply, 409, () => bridgeQuote(b));
  });
  app.get("/bridge/status/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return reply.code(400).send({ error: "bad request id" });
    const q = z.object({ chain: z.string().optional(), tx: z.string().regex(TX_HASH_RE).optional() }).parse(req.query);
    return orFail(reply, 502, () => bridgeStatus(id, q.chain && q.tx ? { chain: q.chain, tx: q.tx } : undefined));
  });

  // Send coins from a network row to any address (another wallet, a deployer,
  // an exchange): an unsigned, simulated transaction for the user's wallet.
  app.post("/chain/send-tx", async (req, reply) => {
    const b = z.object({
      chain: z.string(), from: z.string(), to: z.string(), token: z.string().regex(EVM_ADDRESS_RE).optional(),
      amount: z.string().regex(/^\d{0,20}(\.\d{0,18})?$/).refine((a) => /\d/.test(a), "Enter an amount").optional(), max: z.boolean().optional(),
    }).refine((x) => x.amount != null || x.max, "Enter an amount").parse(req.body);
    const solana = b.chain === "solana";
    const re = solana ? ADDRESS_RE : EVM_ADDRESS_RE;
    if (!re.test(b.from)) return reply.code(400).send({ error: "Not a wallet address" });
    if (!re.test(b.to.trim())) return reply.code(409).send({ error: solana ? "That isn't a Solana address." : "That isn't an Ethereum-style address (0x…)." });
    const tx = { ...b, to: b.to.trim() };
    return orFail(reply, 409, () => (solana ? solSendTx(tx) : evmSendTx(tx)));
  });

  // A wallet's FloorFeed transactions with their on-chain outcome.
  app.post("/activity", async (req, reply) => {
    const b = z.object({
      hash: z.string().regex(TX_HASH_RE), wallet: z.string().refine(isWallet), chain: z.string(),
      kind: z.enum(ACTIVITY_KINDS), title: z.string().min(1).max(140),
      amount: z.number().finite().nullable().optional(), unit: z.string().max(12).nullable().optional(),
      symbol: z.string().max(80).nullable().optional(), mint: z.string().max(140).nullable().optional(),
      requestId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().optional(), toChain: z.string().nullable().optional(),
    }).parse(req.body);
    return orFail(reply, 400, () => { recordActivity(b); return { ok: true }; });
  });
  app.get("/activity/:wallet", async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    if (!isWallet(wallet)) return reply.code(400).send({ error: "Not a wallet address" });
    return walletActivity(wallet);
  });

  // Full history (FloorFeed txs + marketplace record, listings with outcomes) for
  // up to 3 wallets; ?format=csv downloads it, filtered like the History page.
  app.get("/history", async (req, reply) => {
    const q = z.object({
      w: z.string().max(400), format: z.enum(["json", "csv"]).default("json"),
      types: z.string().max(200).optional(), since: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);
    const wallets = [...new Set(q.w.split(",").map((a) => a.trim()).filter(Boolean))].slice(0, 3);
    if (!wallets.length || !wallets.every(isWallet)) return reply.code(400).send({ error: "Not a wallet address" });
    const h = await walletHistory(wallets);
    if (q.format === "json") return reply.header("cache-control", "no-store").send(h);
    const types = q.types ? new Set(q.types.split(",")) : null;
    const rows = h.entries.filter((e) => (!types || types.has(e.type)) && (!q.since || e.at >= q.since));
    const day = new Date().toISOString().slice(0, 10);
    return reply.header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="floorfeed-history-${day}.csv"`)
      .header("cache-control", "no-store").send(historyCsv(rows));
  });
}
