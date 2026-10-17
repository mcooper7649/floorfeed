// Ethereum / Base and other EVM chains: balances, holdings, and trading on
// OpenSea (buy, sell into offers, list, cancel, make offers). Every transaction
// is built unsigned and simulated; the user's wallet signs it.
import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { z } from "zod";
import { orFail, perMinute } from "../http.ts";
import { evmCancelBuild, evmCancelSubmit, evmListBuild, evmListQuote, evmListSubmit, evmMyListings, evmWalletListings } from "../list-evm.ts";
import { evmOfferApproveTx, evmOfferBuild, evmOfferQuote, evmOfferSubmit, evmWalletOffers, evmWrapTx, forgetOffers } from "../offer-evm.ts";
import { background, interactive } from "../opensea.ts";
import {
  EVM_ADDRESS_RE, evmApproveTx, evmBalances, evmBroadcast, evmBuyTx, evmHoldings, evmNetworks, evmNftTransferTx,
  evmPrepare, evmQuote, evmSellQuote, evmSellTx, evmTransferFee, evmUnwrapTx, totalEth,
} from "../trade-evm.ts";

// Someone waiting on a trade sheet: their OpenSea calls take the interactive lane (opensea.ts).
const INTERACTIVE = /^\/trade\/evm\/(quote|buy-tx|sell-quote|sell-tx|approve-tx|list-quote|list-build|list-submit|cancel-build|cancel-submit|offer-quote|offer-build|offer-submit|offer-approve-tx|wrap-tx)(\/|\?|$)/;
export const interactiveLane: onRequestHookHandler = (req, _reply, done) => {
  if (INTERACTIVE.test(req.url)) interactive(done); else done();
};

const Address = z.string().regex(EVM_ADDRESS_RE);
const OrderHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Signature = z.string().regex(/^0x[0-9a-fA-F]{128,200}$/);
const MINT_RE = /^0x[0-9a-fA-F]{40}:\d{1,78}$/;
const sendLimit = perMinute(20);

export function evmRoutes(app: FastifyInstance) {
  app.get("/chain/evm/balance/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
    const b = await evmBalances(address);
    return { ...b, eth: totalEth(b) };
  });

  app.get("/chain/evm/holdings/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
    const h = await evmHoldings(address);
    // Which of them are listed on OpenSea (price, expiry), from the chains they're on.
    const listed = await evmMyListings([...new Set(h.nfts.map((n) => n.chain))], address).catch(() => new Map());
    return { ...h, nfts: h.nfts.map((n) => ({ ...n, listing: listed.get(n.mint.toLowerCase()) ?? null })) };
  });

  // Balances by network (native + wrapped token) and unwrapping WETH back to ETH.
  app.get("/chain/evm/networks/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
    return evmNetworks(address);
  });
  app.post("/chain/evm/unwrap-tx", async (req, reply) => {
    const b = z.object({ chain: z.string(), owner: Address, token: Address, amount: z.number().positive().optional() }).parse(req.body);
    return orFail(reply, 409, () => evmUnwrapTx(b));
  });

  // --- Buying ---
  app.get("/trade/evm/quote/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const q = z.object({ buyer: Address.optional(), id: z.string().optional() }).parse(req.query);
    const quote = await evmQuote(symbol, q.buyer, q.id).catch((err) => { req.log.warn({ err }, "evm quote"); return null; });
    if (!quote) return reply.code(404).send({ error: "No quote for this collection" });
    return quote;
  });

  // An unsigned, already-simulated transaction for the buyer's wallet to confirm.
  app.post("/trade/evm/buy-tx", async (req, reply) => {
    const b = z.object({ orderHash: OrderHash, protocolAddress: Address, chain: z.string(), buyer: Address }).parse(req.body);
    return orFail(reply, 409, () => evmBuyTx(b));
  });

  // --- Selling into the best OpenSea offer: quote (offer, ownership, approval),
  // the one-time conduit approval, then the fill. ---
  app.get("/trade/evm/sell-quote/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const q = z.object({ seller: Address, id: z.string().regex(MINT_RE) }).parse(req.query);
    const [quote, listed] = await Promise.all([
      evmSellQuote(symbol, q.id, q.seller).catch((err) => { req.log.warn({ err }, "evm sell quote"); return null; }),
      // An extra (is it also listed?): background lane, and the quote doesn't wait more than 3s for it.
      Promise.race([
        background(() => evmMyListings(null, q.seller)).catch(() => new Map() as Awaited<ReturnType<typeof evmMyListings>>),
        new Promise<Awaited<ReturnType<typeof evmMyListings>>>((r) => setTimeout(() => r(new Map()), 3_000)),
      ]),
    ]);
    if (!quote) return reply.code(404).send({ error: "No quote for this NFT" });
    // Listed too? Selling leaves that listing signed until it expires, so the sheet offers to cancel it.
    return { ...quote, listing: listed.get(q.id.toLowerCase()) ?? null };
  });
  app.post("/trade/evm/approve-tx", async (req, reply) => {
    const b = z.object({ chain: z.string(), contract: Address, owner: Address, operator: Address }).parse(req.body);
    return orFail(reply, 409, () => evmApproveTx(b));
  });
  app.post("/trade/evm/sell-tx", async (req, reply) => {
    const b = z.object({
      orderHash: OrderHash, protocolAddress: Address, chain: z.string(), seller: Address, mint: z.string().regex(MINT_RE),
    }).parse(req.body);
    return orFail(reply, 409, () => evmSellTx(b));
  });

  // --- Listing on OpenSea (list-evm.ts): quote, typed data to sign, submit; and cancel. ---
  app.get("/trade/evm/list-quote/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const q = z.object({ id: z.string().max(130), seller: Address }).parse(req.query);
    return orFail(reply, 409, () => evmListQuote(symbol, q.id, q.seller));
  });
  app.post("/trade/evm/list-build", async (req, reply) => {
    const b = z.object({ symbol: z.string().max(80), id: z.string().max(130), seller: Address,
      price: z.number().positive(), days: z.number().int() }).parse(req.body);
    return orFail(reply, 409, () => evmListBuild(b));
  });
  app.post("/trade/evm/list-submit", async (req, reply) => {
    const b = z.object({ chain: z.string(), parameters: z.any(), signature: Signature }).parse(req.body);
    return orFail(reply, 409, () => evmListSubmit(b));
  });
  // Everything this wallet has listed on OpenSea (EVM), for "Your listings".
  app.get("/trade/evm/listings/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
    try { return { listings: await evmWalletListings(address) }; } catch (err) {
      req.log.warn({ err }, "evm listings");
      return reply.code(502).send({ error: "Couldn't load your listings from OpenSea" });
    }
  });
  app.post("/trade/evm/cancel-build", async (req, reply) => {
    const b = z.object({ chain: z.string(), orderHash: OrderHash, seller: Address }).parse(req.body);
    return orFail(reply, 409, () => evmCancelBuild(b));
  });
  app.post("/trade/evm/cancel-submit", async (req, reply) => {
    const b = z.object({ chain: z.string(), protocolAddress: Address, orderHash: OrderHash, signature: Signature, seller: Address }).parse(req.body);
    forgetOffers(b.seller); // the same cancel serves offers
    return orFail(reply, 409, () => evmCancelSubmit(b));
  });

  // --- Making offers on OpenSea (offer-evm.ts): on one NFT (`id`) or the whole
  // collection. Quote, wrap and approve transactions, typed data to sign, submit. ---
  app.get("/trade/evm/offer-quote/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const q = z.object({ id: z.string().regex(MINT_RE).optional(), buyer: Address }).parse(req.query);
    return orFail(reply, 409, () => evmOfferQuote(symbol, q.id ?? null, q.buyer));
  });
  app.post("/trade/evm/wrap-tx", async (req, reply) => {
    const b = z.object({ symbol: z.string().max(80), owner: Address, amount: z.number().positive() }).parse(req.body);
    return orFail(reply, 409, () => evmWrapTx(b));
  });
  app.post("/trade/evm/offer-approve-tx", async (req, reply) => {
    const b = z.object({ symbol: z.string().max(80), owner: Address, operator: Address }).parse(req.body);
    return orFail(reply, 409, () => evmOfferApproveTx(b));
  });
  app.post("/trade/evm/offer-build", async (req, reply) => {
    const b = z.object({ symbol: z.string().max(80), id: z.string().regex(MINT_RE).nullish(), buyer: Address,
      price: z.number().positive(), days: z.number().int() }).parse(req.body);
    return orFail(reply, 409, () => evmOfferBuild(b));
  });
  app.post("/trade/evm/offer-submit", async (req, reply) => {
    const b = z.object({ chain: z.string(), kind: z.enum(["item", "collection"]), parameters: z.any(),
      signature: Signature, criteria: z.record(z.string(), z.any()).nullish() }).parse(req.body);
    return orFail(reply, 409, () => evmOfferSubmit(b));
  });
  app.get("/trade/evm/offers/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!EVM_ADDRESS_RE.test(address)) return reply.code(400).send({ error: "Not an EVM address" });
    try { return { offers: await evmWalletOffers(address) }; } catch (err) {
      req.log.warn({ err }, "evm offers");
      return reply.code(502).send({ error: "Couldn't load your offers from OpenSea" });
    }
  });

  // --- FloorFeed (Privy) wallet on EVM: fields to sign, then broadcast (trade-evm.ts) ---
  app.post("/chain/evm/prepare", async (req, reply) => {
    const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
    const b = z.object({ chainId: z.number().int(), from: Address, to: Address,
      data: hex, value: z.string().regex(/^\d+$/), gas: z.string().regex(/^\d+$/).optional() }).parse(req.body);
    return orFail(reply, 409, () => evmPrepare(b));
  });
  app.post("/chain/evm/send", async (req, reply) => {
    const b = z.object({ from: Address, tx: z.record(z.string(), z.union([z.string(), z.number()])),
      signed: z.string().regex(/^0x[0-9a-fA-F]{130,40000}$/) }).parse(req.body);
    if (!sendLimit(req.ip)) return reply.code(429).send({ error: "Too many transactions. Wait a minute and try again." });
    return orFail(reply, 409, async () => ({ hash: await evmBroadcast(b) }));
  });
  app.get("/chain/evm/transfer-fee", async (req, reply) => {
    const { chain } = z.object({ chain: z.string() }).parse(req.query);
    return orFail(reply, 400, () => evmTransferFee(chain));
  });
  app.post("/chain/evm/nft-transfer", async (req, reply) => {
    const b = z.object({
      chain: z.string(), contract: Address, tokenId: z.string().regex(/^\d{1,78}$/), from: Address, to: Address,
    }).parse(req.body);
    if (b.from.toLowerCase() === b.to.toLowerCase()) return reply.code(400).send({ error: "That's the same wallet." });
    return orFail(reply, 409, () => evmNftTransferTx(b));
  });
}
