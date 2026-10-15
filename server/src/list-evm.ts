import { formatEther, parseAbiItem, parseEther, type Hex } from "viem";
import { EVM_CHAINS, EVM_SALES } from "./config.ts";
import { db } from "./db.ts";
import { cancelOsOrder, getOsBestOffer, getOsFees, getOsMyListings, getOsNft, getOsOrder, postOsListing, type OsOrderParams } from "./opensea.ts";
import { evmHolds, evmPublicClient, isTradableChain, osConduit } from "./trade-evm.ts";

// Listing an NFT on OpenSea from FloorFeed. Nothing moves on chain to list:
// FloorFeed builds a Seaport order (the price, OpenSea's fee and required
// creator fees as payments, an expiry), the wallet signs it as typed data (no
// gas), and FloorFeed posts it to OpenSea. The sale happens on chain later,
// when a buyer fills it. The first listing from a collection needs the same
// one-time approval as selling into an offer. Orders go on OpenSea's signed
// zone, so they can be cancelled off chain for free.

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395"; // Seaport 1.6, same address on every chain
const SIGNED_ZONE = "0x000056f7000000ece9003ca63978907a00ffd100";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
// OpenSea's two conduits. Chains differ in which one OpenSea uses; we prefer
// whichever this collection is already approved for.
const CONDUIT_KEYS = [
  "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  "0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e",
] as const;
const PREFERS_SECOND = new Set(["abstract", "hyperevm", "ink"]);
// Chains where OpenSea listings are priced in the native coin (Ronin lists in WETH).
const NATIVE_LISTING = new Set(["ethereum", "base", "abstract", "ink", "arbitrum", "hyperevm", "apechain", "monad", "robinhood"]);
const DAYS = [1, 7, 30] as const;

const GET_COUNTER = parseAbiItem("function getCounter(address offerer) view returns (uint256)");
const IS_APPROVED = parseAbiItem("function isApprovedForAll(address owner, address operator) view returns (bool)");
const SUPPORTS = parseAbiItem("function supportsInterface(bytes4 id) view returns (bool)");
const CANCEL = parseAbiItem("function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)[] orders) returns (bool)");

const floorOf = db.prepare("SELECT floor FROM collections WHERE symbol = ?");
const lastSaleOf = db.prepare("SELECT price FROM trades WHERE mint = ? ORDER BY block_time DESC LIMIT 1");
const lastBuyOf = db.prepare("SELECT price FROM trades WHERE buyer = ? AND mint = ? ORDER BY block_time DESC LIMIT 1");
const recentSalesOf = db.prepare("SELECT mint, price, block_time, source FROM trades WHERE collection = ? ORDER BY block_time DESC LIMIT 40");

// What the collection is actually selling for, to price a listing against.
// Sales into offers (paid in WETH and similar) run below asking prices, so the
// "typical" price is the median of recent sales that filled a listing.
function collectionMarket(symbol: string) {
  const rows = recentSalesOf.all(symbol) as { mint: string; price: number; block_time: number; source: string | null }[];
  const sales = rows.map((r) => ({
    price: r.price, at: r.block_time, id: r.mint.split(":")[1] ?? r.mint,
    kind: /WETH|BETH|WRON|offer/i.test(r.source ?? "") ? "offer" as const : "listing" as const,
  }));
  const fills = sales.filter((x) => x.kind === "listing");
  const last10 = fills.slice(0, 10).map((x) => x.price).sort((a, b) => a - b);
  const median = last10.length >= 3 ? last10[Math.floor(last10.length / 2)] : null;
  const dayAgo = Date.now() / 1000 - 86_400;
  const day = fills.filter((x) => x.at >= dayAgo);
  return {
    lastSale: fills[0] ? { price: fills[0].price, at: fills[0].at } : null,
    median,
    high24h: day.length ? Math.max(...day.map((x) => x.price)) : null,
    sales24h: sales.filter((x) => x.at >= dayAgo).length,
    recent: sales.slice(0, 6),
  };
}

export const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" }, { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" }, { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" }, { name: "startTime", type: "uint256" }, { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" }, { name: "salt", type: "uint256" }, { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" }, { name: "token", type: "address" }, { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" }, { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" }, { name: "token", type: "address" }, { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" }, { name: "endAmount", type: "uint256" }, { name: "recipient", type: "address" },
  ],
} as const;
const domain = (chainId: number) => ({ name: "Seaport", version: "1.6", chainId, verifyingContract: SEAPORT });

function parseMint(symbol: string, id: string) {
  const meta = EVM_SALES.find((c) => c.slug === symbol);
  const [contract, tokenId] = id.split(":");
  if (!meta || !/^0x[0-9a-fA-F]{40}$/.test(contract ?? "") || !/^\d{1,78}$/.test(tokenId ?? "")) throw new Error("Unknown NFT");
  return { meta, chain: meta.chain as string, contract: contract.toLowerCase() as Hex, tokenId };
}

// Which conduit to list through and whether this collection is approved for it.
async function pickConduit(chain: string, contract: Hex, owner: string) {
  const c = evmPublicClient(chain);
  const options = await Promise.all(CONDUIT_KEYS.map(async (key) => {
    const conduit = await osConduit(chain as never, SEAPORT, key).catch(() => null);
    const approved = conduit
      ? await c.readContract({ address: contract, abi: [IS_APPROVED], functionName: "isApprovedForAll", args: [owner as Hex, conduit] }).catch(() => null)
      : null;
    return { key, conduit, approved };
  }));
  const usable = options.filter((o) => o.conduit);
  if (!usable.length) throw new Error("OpenSea's marketplace contracts aren't set up on this network.");
  const preferred = PREFERS_SECOND.has(chain) ? [...usable].reverse() : usable;
  return preferred.find((o) => o.approved) ?? preferred[0];
}

// Payments in a listing for `price` (wei): OpenSea's fee and required creator
// fees, the rest to the seller. Same rounding as opensea-js.
function payments(price: bigint, seller: string, fees: { bps: number; recipient: string }[]) {
  const feeItems = fees.map((f) => ({ amount: (price * BigInt(f.bps)) / 10_000n, recipient: f.recipient }));
  const sellerAmount = price - feeItems.reduce((a, f) => a + f.amount, 0n);
  return [{ amount: sellerAmount, recipient: seller }, ...feeItems.filter((f) => f.amount > 0n)];
}

async function requiredFees(slug: string) {
  const { fees, requiredZone } = await getOsFees(slug);
  return {
    fees: fees.filter((f) => f.required && f.fee > 0 && /^0x[0-9a-fA-F]{40}$/.test(f.recipient))
      .map((f) => ({ bps: Math.round(f.fee * 100), recipient: f.recipient.toLowerCase() })),
    requiredZone,
  };
}

export async function evmListQuote(symbol: string, id: string, seller: string) {
  const { meta, chain, contract, tokenId } = parseMint(symbol, id);
  const unit = isTradableChain(chain) ? EVM_CHAINS[chain as keyof typeof EVM_CHAINS].native : "ETH";
  const base = { chain, unit, mint: `${contract}:${tokenId}`, name: `${meta.name} #${tokenId}`, collection: { symbol, name: meta.name } };
  if (!isTradableChain(chain) || !NATIVE_LISTING.has(chain)) {
    return { ...base, executable: false, reason: `Listing on ${EVM_CHAINS[chain as keyof typeof EVM_CHAINS]?.name ?? chain} isn't available in FloorFeed yet. List it on OpenSea.` };
  }
  const [owned, fees, offer, conduit, mine] = await Promise.all([
    evmHolds(chain as never, contract, BigInt(tokenId), seller),
    requiredFees(symbol),
    getOsBestOffer(symbol, tokenId).catch(() => null),
    pickConduit(chain, contract, seller),
    getOsMyListings(chain, seller).catch(() => []),
  ]);
  const listing = mine.find((l) => l.mint === base.mint) ?? null;
  const floor = (floorOf.get(symbol) as { floor: number | null } | undefined)?.floor ?? null;
  const totalBps = fees.fees.reduce((a, f) => a + f.bps, 0);
  return {
    ...base,
    owned,
    floor,
    lastSale: (lastSaleOf.get(base.mint) as { price: number } | undefined)?.price ?? null, // this NFT's
    market: collectionMarket(symbol),
    boughtAt: (lastBuyOf.get(seller.toLowerCase(), base.mint) as { price: number } | undefined)?.price ?? null,
    bestOffer: offer ? { price: offer.price, net: offer.net, currency: offer.currency } : null,
    fees: fees.fees.map((f) => ({ pct: f.bps / 100, recipient: f.recipient })),
    feePct: totalBps / 100,
    approved: conduit.approved === true,
    operator: conduit.conduit,
    days: DAYS,
    listing: listing && {
      orderHash: listing.orderHash, price: Number(formatEther(BigInt(listing.priceWei))), expiresAt: listing.expiresAt,
      cancelFree: listing.parameters.zone.toLowerCase() === SIGNED_ZONE,
    },
    executable: owned,
    reason: owned ? null : "This wallet doesn't hold this NFT.",
    marketUrl: `https://opensea.io/assets/${chain === "apechain" ? "ape_chain" : chain}/${contract}/${tokenId}`,
  };
}

// The order to sign: EIP-712 typed data for the wallet plus the parameters to post.
export async function evmListBuild(p: { symbol: string; id: string; seller: string; price: number; days: number }) {
  const { chain, contract, tokenId } = parseMint(p.symbol, p.id);
  if (!isTradableChain(chain) || !NATIVE_LISTING.has(chain)) throw new Error("Listing isn't available on this network yet.");
  if (!(p.price > 0) || p.price > 1e7) throw new Error("Enter a price.");
  if (!DAYS.includes(p.days as never)) throw new Error("Pick how long the listing lasts.");
  const c = evmPublicClient(chain);
  const [owned, fees, conduit, counter, is1155] = await Promise.all([
    evmHolds(chain as never, contract, BigInt(tokenId), p.seller),
    requiredFees(p.symbol),
    pickConduit(chain, contract, p.seller),
    c.readContract({ address: SEAPORT, abi: [GET_COUNTER], functionName: "getCounter", args: [p.seller as Hex] }),
    c.readContract({ address: contract, abi: [SUPPORTS], functionName: "supportsInterface", args: ["0xd9b67a26"] }).catch(() => false),
  ]);
  if (!owned) throw new Error("This wallet doesn't hold this NFT.");
  if (!conduit.approved) throw new Error("Approve OpenSea for this collection first.");
  // OpenSea's signed zone when it's on this chain (free off-chain cancels), unless the collection requires another.
  const zoneCode = await c.getCode({ address: SIGNED_ZONE }).catch(() => undefined);
  const zone = (fees.requiredZone && /^0x[0-9a-fA-F]{40}$/.test(fees.requiredZone)) ? fees.requiredZone.toLowerCase()
    : zoneCode && zoneCode !== "0x" ? SIGNED_ZONE : ZERO;
  const price = parseEther(p.price.toFixed(18));
  const now = Math.floor(Date.now() / 1000);
  const salt = BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  const parameters = {
    offerer: p.seller.toLowerCase(),
    zone,
    offer: [{ itemType: is1155 ? 3 : 2, token: contract, identifierOrCriteria: tokenId, startAmount: "1", endAmount: "1" }],
    consideration: payments(price, p.seller.toLowerCase(), fees.fees).map((x) => ({
      itemType: 0, token: ZERO, identifierOrCriteria: "0", startAmount: x.amount.toString(), endAmount: x.amount.toString(), recipient: x.recipient,
    })),
    orderType: zone === ZERO ? 1 : 2, // PARTIAL_OPEN like opensea-js; FULL_RESTRICTED on a zone
    startTime: String(now - 60),
    endTime: String(now + p.days * 86_400),
    zoneHash: ZERO32,
    salt: salt.toString(),
    conduitKey: conduit.key,
    counter: counter.toString(),
  };
  const chainId = EVM_CHAINS[chain as keyof typeof EVM_CHAINS].id;
  return {
    chain, chainId, parameters,
    net: Number(formatEther(BigInt(parameters.consideration[0].startAmount))),
    typedData: { domain: domain(chainId), types: SEAPORT_TYPES, primaryType: "OrderComponents" as const, message: parameters },
  };
}

export async function evmListSubmit(p: { chain: string; parameters: OsOrderParams; signature: string }) {
  if (!isTradableChain(p.chain)) throw new Error("Unsupported chain");
  const r = await postOsListing(p.chain, {
    parameters: { ...p.parameters, totalOriginalConsiderationItems: p.parameters.consideration.length },
    signature: p.signature, protocol_address: SEAPORT,
  }).catch((err: Error) => {
    throw new Error(/enough balance of order asset/i.test(err.message) ? "This wallet doesn't hold this NFT anymore."
      : /approv/i.test(err.message) ? "OpenSea isn't approved for this collection yet. Approve it first."
      : `OpenSea didn't accept the listing: ${err.message.slice(0, 200)}`);
  });
  forgetListings(p.parameters.offerer);
  return { orderHash: r.order?.order_hash ?? null };
}

// Cancel: off-chain (sign the order hash; free) on OpenSea's signed zone, else an on-chain Seaport.cancel.
export async function evmCancelBuild(p: { chain: string; orderHash: string; seller: string }) {
  if (!isTradableChain(p.chain)) throw new Error("Unsupported chain");
  const o = await getOsOrder(p.chain, p.orderHash, true);
  if (!o || o.protocol_data.parameters.offerer.toLowerCase() !== p.seller.toLowerCase()) throw new Error("That listing isn't yours.");
  if ((o.status && o.status !== "ACTIVE") || o.remaining_quantity === 0) throw new Error("That listing isn't live anymore.");
  const l = { orderHash: o.order_hash, protocolAddress: o.protocol_address, parameters: o.protocol_data.parameters };
  const chainId = EVM_CHAINS[p.chain as keyof typeof EVM_CHAINS].id;
  if (l.parameters.zone.toLowerCase() === SIGNED_ZONE) {
    return {
      kind: "offchain" as const, chain: p.chain, protocolAddress: l.protocolAddress,
      typedData: { domain: domain(chainId), types: { OrderHash: [{ name: "orderHash", type: "bytes32" }] }, primaryType: "OrderHash" as const, message: { orderHash: l.orderHash } },
    };
  }
  const { encodeFunctionData } = await import("viem");
  const params = l.parameters;
  const data = encodeFunctionData({ abi: [CANCEL], functionName: "cancel", args: [[{
    offerer: params.offerer as Hex, zone: params.zone as Hex,
    offer: params.offer.map((i) => ({ itemType: i.itemType, token: i.token as Hex, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) })),
    consideration: params.consideration.map((i) => ({ itemType: i.itemType, token: i.token as Hex, identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount), recipient: i.recipient as Hex })),
    orderType: params.orderType, startTime: BigInt(params.startTime), endTime: BigInt(params.endTime), zoneHash: params.zoneHash as Hex,
    salt: BigInt(params.salt), conduitKey: params.conduitKey as Hex, counter: BigInt(params.counter),
  }]] });
  return {
    kind: "onchain" as const, chain: p.chain,
    tx: { chainId, to: l.protocolAddress, data, value: "0", explorerTx: `${EVM_CHAINS[p.chain as keyof typeof EVM_CHAINS].explorer}/tx/` },
  };
}

export async function evmCancelSubmit(p: { chain: string; protocolAddress: string; orderHash: string; signature: string; seller: string }) {
  forgetListings(p.seller);
  if (!isTradableChain(p.chain)) throw new Error("Unsupported chain");
  await cancelOsOrder(p.chain, p.protocolAddress, p.orderHash, p.signature).catch((err: Error) => {
    throw new Error(/recent/i.test(err.message) ? "OpenSea can't cancel a listing this new for free yet. Try again in a few minutes." : `OpenSea didn't cancel it: ${err.message}`);
  });
  return { ok: true };
}

// A wallet's live OpenSea listings, for "Your listings" and the Listed tags on
// holdings: the NFT (name, art, collection), price, expiry, and floor / cost to
// compare. Cached a minute per wallet; listing or cancelling clears it.
export type MyListing = {
  chain: string; mint: string; symbol: string | null; collection: string | null; name: string; image: string | null;
  price: number; unit: string; expiresAt: number; listedAt: number; orderHash: string; cancelFree: boolean;
  floor: number | null; boughtAt: number | null; url: string;
};
const mineCache = new Map<string, { at: number; v: MyListing[] }>();
const nftMeta = new Map<string, { name: string | null; image: string | null; slug: string | null }>();
// After a list / cancel, skip the cache for a minute: OpenSea can take a few
// seconds to index the change, and a stale read mustn't stick for 60s.
const dirtyUntil = new Map<string, number>();
export const forgetListings = (seller: string) => {
  mineCache.delete(seller.toLowerCase());
  dirtyUntil.set(seller.toLowerCase(), Date.now() + 60_000);
};
export async function evmWalletListings(seller: string): Promise<MyListing[]> {
  const ck = seller.toLowerCase();
  const hit = mineCache.get(ck);
  if (hit && Date.now() - hit.at < 60_000 && (dirtyUntil.get(ck) ?? 0) < Date.now()) return hit.v;
  const raw = await getOsMyListings(null, seller);
  const v = await Promise.all(raw.filter((l) => isTradableChain(l.chain)).map(async (l): Promise<MyListing> => {
    const [contract, tokenId] = l.mint.split(":");
    let art = nftMeta.get(`${l.chain}:${l.mint}`);
    if (!art) {
      const n = await getOsNft(l.chain, contract, tokenId).catch(() => null);
      art = { name: n?.name ?? null, image: n?.image ?? null, slug: n?.collection ?? null };
      if (n) nftMeta.set(`${l.chain}:${l.mint}`, art);
    }
    const meta = art.slug ? EVM_SALES.find((c) => c.slug === art.slug) : undefined;
    const chainCfg = EVM_CHAINS[l.chain as keyof typeof EVM_CHAINS];
    return {
      chain: l.chain, mint: l.mint, symbol: meta?.slug ?? null, collection: meta?.name ?? art.slug,
      name: art.name ?? `${meta?.name ?? "NFT"} #${tokenId}`, image: art.image,
      price: Number(formatEther(BigInt(l.priceWei))), unit: l.currency || chainCfg?.native || "ETH",
      expiresAt: l.expiresAt, listedAt: l.listedAt, orderHash: l.orderHash,
      cancelFree: l.parameters.zone.toLowerCase() === SIGNED_ZONE,
      floor: meta ? ((floorOf.get(meta.slug) as { floor: number | null } | undefined)?.floor ?? null) : null,
      boughtAt: (lastBuyOf.get(ck, l.mint) as { price: number } | undefined)?.price ?? null,
      url: `https://opensea.io/assets/${l.chain === "apechain" ? "ape_chain" : l.chain}/${contract}/${tokenId}`,
    };
  }));
  mineCache.set(ck, { at: Date.now(), v });
  return v;
}
// The same, keyed by mint, limited to the given chains (for holdings).
export async function evmMyListings(chains: string[], seller: string) {
  const out = new Map<string, { price: number; expiresAt: number; orderHash: string }>();
  for (const l of await evmWalletListings(seller)) {
    if (chains.includes(l.chain) && !out.has(l.mint)) out.set(l.mint, { price: l.price, expiresAt: l.expiresAt, orderHash: l.orderHash });
  }
  return out;
}
