import { encodeFunctionData, formatEther, formatUnits, maxUint256, parseAbiItem, parseUnits, type Hex } from "viem";
import { EVM_CHAINS, EVM_SALES } from "./config.ts";
import { db } from "./db.ts";
import { decimalString } from "./units.ts";
import { CONDUIT_KEYS, PREFERS_SECOND, SEAPORT, SEAPORT_TYPES, SIGNED_ZONE, domain, requiredFees } from "./list-evm.ts";
import {
  buildOsCollectionOffer, fromOsChain, getOsBestCollectionOffer, getOsBestOffer, getOsMyOffers, getOsNft, getOsOrder,
  postOsCollectionOffer, postOsItemOffer, type OsOrderParams,
} from "./opensea.ts";
import { noteListed } from "./history.ts";
import { evmPublicClient, isTradableChain, osConduit } from "./trade-evm.ts";

// Making an offer on OpenSea from FloorFeed: on one NFT (item offer) or on any
// NFT in a collection (collection offer). Like a listing, an offer is a signed
// Seaport order, not a transaction: the buyer offers wrapped coin (WETH on
// Ethereum and its L2s) and asks for the NFT. Fees come out of the offer when
// a holder accepts it, so the buyer pays exactly the offer. The wallet needs
// that much wrapped coin and a one-time allowance for OpenSea's conduit, and
// FloorFeed builds both transactions (wrap, approve) when they're missing.

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const DAYS = [1, 3, 7, 30] as const;

const GET_COUNTER = parseAbiItem("function getCounter(address offerer) view returns (uint256)");
const SUPPORTS = parseAbiItem("function supportsInterface(bytes4 id) view returns (bool)");
const BALANCE = parseAbiItem("function balanceOf(address) view returns (uint256)");
const ALLOWANCE = parseAbiItem("function allowance(address owner, address spender) view returns (uint256)");
const APPROVE = parseAbiItem("function approve(address spender, uint256 amount) returns (bool)");
const DEPOSIT = parseAbiItem("function deposit() payable");

const floorOf = db.prepare("SELECT floor, image FROM collections WHERE symbol = ?");
// An untracked collection's OpenSea slug as a readable name: "inkverse-920024436" -> "Inkverse".
const prettySlug = (slug: string) => slug.replace(/-\d{5,}$/, "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const imageOf = db.prepare("SELECT image FROM trades WHERE mint = ? AND image IS NOT NULL ORDER BY block_time DESC LIMIT 1");

type Target = { meta: (typeof EVM_SALES)[number]; chain: string; contract: Hex | null; tokenId: string | null };
function parseTarget(symbol: string, id?: string | null): Target {
  const meta = EVM_SALES.find((c) => c.slug === symbol);
  if (!meta) throw new Error("Unknown collection");
  if (!id) return { meta, chain: meta.chain as string, contract: null, tokenId: null };
  const [contract, tokenId] = id.split(":");
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract ?? "") || !/^\d{1,78}$/.test(tokenId ?? "")) throw new Error("Unknown NFT");
  return { meta, chain: meta.chain as string, contract: contract.toLowerCase() as Hex, tokenId };
}

// Which conduit to offer through: one already allowed to spend `need` of the
// token, else the one OpenSea prefers on this chain.
async function pickConduit(chain: string, token: Hex, owner: string, need: bigint) {
  const c = evmPublicClient(chain);
  const options = await Promise.all(CONDUIT_KEYS.map(async (key) => {
    const conduit = await osConduit(chain as never, SEAPORT, key).catch(() => null);
    const allowance = conduit
      ? await c.readContract({ address: token, abi: [ALLOWANCE], functionName: "allowance", args: [owner as Hex, conduit] }).catch(() => 0n)
      : 0n;
    return { key, conduit, allowance };
  }));
  const usable = options.filter((o) => o.conduit);
  if (!usable.length) throw new Error("OpenSea's marketplace contracts aren't set up on this network.");
  const preferred = PREFERS_SECOND.has(chain) ? [...usable].reverse() : usable;
  return preferred.find((o) => need > 0n && o.allowance >= need) ?? preferred.find((o) => o.allowance > 0n) ?? preferred[0];
}

async function offerToken(slug: string) {
  const f = await requiredFees(slug);
  if (!f.offerCurrency) throw new Error("OpenSea doesn't take offers on this collection.");
  return f;
}

export async function evmOfferQuote(symbol: string, id: string | null, buyer: string) {
  const t = parseTarget(symbol, id);
  const chainCfg = EVM_CHAINS[t.chain as keyof typeof EVM_CHAINS];
  const native = chainCfg?.native ?? "ETH";
  const row = floorOf.get(symbol) as { floor: number | null; image: string | null } | undefined;
  const mint = t.contract ? `${t.contract}:${t.tokenId}` : null;
  const base = {
    kind: mint ? "item" as const : "collection" as const,
    chain: t.chain, native, mint,
    name: mint ? `${t.meta.name} #${t.tokenId}` : t.meta.name,
    image: (mint ? (imageOf.get(mint) as { image: string } | undefined)?.image : row?.image) ?? row?.image ?? null,
    collection: { symbol, name: t.meta.name, floor: row?.floor ?? null },
    days: DAYS,
  };
  if (!isTradableChain(t.chain)) return { ...base, executable: false, reason: `Offers on ${chainCfg?.name ?? t.chain} aren't available in FloorFeed yet.` };
  const fees = await offerToken(symbol);
  const token = fees.offerCurrency!;
  const c = evmPublicClient(t.chain);
  const [wrapped, nativeBal, conduit, best, mine] = await Promise.all([
    c.readContract({ address: token.address as Hex, abi: [BALANCE], functionName: "balanceOf", args: [buyer as Hex] }).catch(() => 0n),
    c.getBalance({ address: buyer as Hex }).catch(() => 0n),
    pickConduit(t.chain, token.address as Hex, buyer, 0n),
    (mint ? getOsBestOffer(symbol, t.tokenId!) : getOsBestCollectionOffer(symbol)).catch(() => null),
    myOffersOn(buyer, symbol, mint).catch(() => []),
  ]);
  const scale = (n: bigint) => Number(formatUnits(n, token.decimals));
  const totalBps = fees.fees.reduce((a, f) => a + f.bps, 0);
  return {
    ...base,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    // Wrapping only works for the chain's own coin wrapped (WETH on an ETH chain, WAPE on ApeChain...).
    wrappable: token.symbol.toUpperCase() === `W${native.toUpperCase()}`,
    wrapped: scale(wrapped),
    nativeBalance: Number(formatEther(nativeBal)),
    allowance: conduit.allowance >= maxUint256 / 2n ? null : scale(conduit.allowance), // null = unlimited
    operator: conduit.conduit,
    feePct: totalBps / 100, // what the seller gives up when they accept
    bestOffer: best ? { price: best.price, currency: best.currency } : null,
    mine,
    executable: true,
    reason: null,
    marketUrl: mint ? `https://opensea.io/assets/${t.chain === "apechain" ? "ape_chain" : t.chain}/${t.contract}/${t.tokenId}`
      : `https://opensea.io/collection/${symbol}`,
  };
}

// This wallet's live offers on one NFT, or its collection offers on `symbol`.
// One account call, then only the matching orders (for expiry and cancel type).
async function myOffersOn(wallet: string, symbol: string, mint: string | null) {
  const raw = (await getOsMyOffers(wallet)).filter((o) => o.criteria?.collection?.slug === symbol && (mint
    ? o.asset?.identifier != null && `${o.asset.contract.toLowerCase()}:${o.asset.identifier}` === mint
    : o.asset?.identifier == null && !o.criteria?.traits?.length));
  const out = await Promise.all(raw.slice(0, 5).map(async (o) => {
    const order = await getOsOrder(fromOsChain(o.chain), o.order_hash);
    const p = o.price_per_item ?? o.price;
    return order && p ? {
      orderHash: o.order_hash, price: Number(p.value) / 10 ** p.decimals,
      expiresAt: Number(order.protocol_data.parameters.endTime),
      cancelFree: order.protocol_data.parameters.zone.toLowerCase() === SIGNED_ZONE,
    } : null;
  }));
  return out.filter((x) => x !== null);
}

// Wrap the chain's coin into the offer token (WETH.deposit).
export async function evmWrapTx(b: { symbol: string; owner: string; amount: number }) {
  const t = parseTarget(b.symbol);
  if (!isTradableChain(t.chain)) throw new Error("Unsupported chain");
  const { offerCurrency: token } = await offerToken(b.symbol);
  const cfg = EVM_CHAINS[t.chain as keyof typeof EVM_CHAINS];
  if (token!.symbol.toUpperCase() !== `W${cfg.native.toUpperCase()}`) throw new Error(`Offers here are in ${token!.symbol}, which can't be wrapped from ${cfg.native}.`);
  if (!(b.amount > 0) || b.amount > 1e6) throw new Error("Enter an amount.");
  const value = parseUnits(decimalString(b.amount, token!.decimals), token!.decimals);
  const c = evmPublicClient(t.chain);
  const data = encodeFunctionData({ abi: [DEPOSIT], functionName: "deposit" });
  const gas = await c.estimateGas({ account: b.owner as Hex, to: token!.address as Hex, data, value }).catch((err: Error) => {
    throw new Error(/insufficient funds/i.test(err.message)
      ? `Not enough ${cfg.native} on ${cfg.name}: wrapping ${b.amount} also needs a little for the network fee.`
      : `The wrap would fail: ${err.message.split("\n")[0]}`);
  });
  return {
    chainId: cfg.id, explorerTx: `${cfg.explorer}/tx/`,
    to: token!.address, data, value: value.toString(), gas: ((gas * 12n) / 10n).toString(),
    amount: b.amount, symbol: token!.symbol,
  };
}

// Let OpenSea's conduit spend the offer token when an offer is accepted. An
// unlimited allowance like OpenSea's own, so later offers don't need it again;
// nothing is spent until a holder accepts one of your offers.
export async function evmOfferApproveTx(b: { symbol: string; owner: string; operator: string }) {
  const t = parseTarget(b.symbol);
  if (!isTradableChain(t.chain)) throw new Error("Unsupported chain");
  const { offerCurrency: token } = await offerToken(b.symbol);
  const okOperator = await Promise.all(CONDUIT_KEYS.map((k) => osConduit(t.chain as never, SEAPORT, k).catch(() => null)));
  if (!okOperator.some((o) => o?.toLowerCase() === b.operator.toLowerCase())) throw new Error("That isn't OpenSea's conduit.");
  const cfg = EVM_CHAINS[t.chain as keyof typeof EVM_CHAINS];
  const c = evmPublicClient(t.chain);
  const data = encodeFunctionData({ abi: [APPROVE], functionName: "approve", args: [b.operator as Hex, maxUint256] });
  const gas = await c.estimateGas({ account: b.owner as Hex, to: token!.address as Hex, data }).catch((err: Error) => {
    throw new Error(/insufficient funds/i.test(err.message)
      ? `Not enough ${cfg.native} on ${cfg.name} for the network fee.`
      : `The approval would fail: ${err.message.split("\n")[0]}`);
  });
  return {
    chainId: cfg.id, explorerTx: `${cfg.explorer}/tx/`,
    to: token!.address, data, value: "0", gas: ((gas * 12n) / 10n).toString(), symbol: token!.symbol,
  };
}

// The offer to sign: EIP-712 typed data plus what to post afterwards.
export async function evmOfferBuild(p: { symbol: string; id?: string | null; buyer: string; price: number; days: number }) {
  const t = parseTarget(p.symbol, p.id);
  if (!isTradableChain(t.chain)) throw new Error("Offers aren't available on this network yet.");
  if (!(p.price > 0) || p.price > 1e6) throw new Error("Enter an offer.");
  // OpenSea only takes bids in steps of 0.0001.
  if (Math.abs(Math.round(p.price * 1e4) - p.price * 1e4) > 1e-6) throw new Error("OpenSea takes offers in steps of 0.0001. Round your offer to 4 decimals.");
  if (!DAYS.includes(p.days as never)) throw new Error("Pick how long the offer lasts.");
  const fees = await offerToken(p.symbol);
  const token = fees.offerCurrency!;
  const amount = parseUnits(decimalString(p.price, token.decimals), token.decimals);
  const c = evmPublicClient(t.chain);
  const buyer = p.buyer.toLowerCase();
  const [balance, conduit, counter] = await Promise.all([
    c.readContract({ address: token.address as Hex, abi: [BALANCE], functionName: "balanceOf", args: [buyer as Hex] }),
    pickConduit(t.chain, token.address as Hex, buyer, amount),
    c.readContract({ address: SEAPORT, abi: [GET_COUNTER], functionName: "getCounter", args: [buyer as Hex] }),
  ]);
  if (balance < amount) throw new Error(`You have ${formatUnits(balance, token.decimals)} ${token.symbol}; the offer needs ${p.price}. Wrap more first.`);
  if (conduit.allowance < amount) throw new Error(`Allow OpenSea to use your ${token.symbol} first.`);

  // What the offer asks for: this NFT, or any NFT in the collection (OpenSea's criteria).
  let nftItem: { itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string };
  let zone: string, zoneHash: string = ZERO32, criteria: Record<string, unknown> | null = null;
  if (t.contract) {
    const is1155 = await c.readContract({ address: t.contract, abi: [SUPPORTS], functionName: "supportsInterface", args: ["0xd9b67a26"] }).catch(() => false);
    nftItem = { itemType: is1155 ? 3 : 2, token: t.contract, identifierOrCriteria: t.tokenId!, startAmount: "1", endAmount: "1", recipient: buyer };
    const zoneCode = await c.getCode({ address: SIGNED_ZONE }).catch(() => undefined);
    zone = (fees.requiredZone && /^0x[0-9a-fA-F]{40}$/.test(fees.requiredZone)) ? fees.requiredZone.toLowerCase()
      : zoneCode && zoneCode !== "0x" ? SIGNED_ZONE : ZERO;
  } else {
    const b = await buildOsCollectionOffer(buyer, p.symbol, 1, SEAPORT).catch((err: Error) => {
      throw new Error(`OpenSea couldn't set up a collection offer: ${err.message.slice(0, 160)}`);
    });
    const it = b.partialParameters.consideration[0];
    if (!it) throw new Error("OpenSea returned no collection criteria.");
    nftItem = { ...it, recipient: buyer };
    zone = b.partialParameters.zone.toLowerCase();
    zoneHash = b.partialParameters.zoneHash;
    criteria = b.criteria;
  }
  // Fees in the offer token, paid out of the offer when it's accepted (same rounding as opensea-js).
  const feeItems = fees.fees.map((f) => ({ amount: (amount * BigInt(f.bps)) / 10_000n, recipient: f.recipient })).filter((f) => f.amount > 0n);
  const now = Math.floor(Date.now() / 1000);
  const salt = BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  const parameters = {
    offerer: buyer,
    zone,
    offer: [{ itemType: 1, token: token.address, identifierOrCriteria: "0", startAmount: amount.toString(), endAmount: amount.toString() }],
    consideration: [nftItem, ...feeItems.map((f) => ({
      itemType: 1, token: token.address, identifierOrCriteria: "0", startAmount: f.amount.toString(), endAmount: f.amount.toString(), recipient: f.recipient,
    }))],
    orderType: zone === ZERO ? 0 : 2, // FULL_OPEN, or FULL_RESTRICTED on a zone
    startTime: String(now - 60),
    endTime: String(now + p.days * 86_400),
    zoneHash,
    salt: salt.toString(),
    conduitKey: conduit.key,
    counter: counter.toString(),
  };
  const chainId = EVM_CHAINS[t.chain as keyof typeof EVM_CHAINS].id;
  return {
    chain: t.chain, chainId, kind: t.contract ? "item" as const : "collection" as const, parameters, criteria,
    typedData: { domain: domain(chainId), types: SEAPORT_TYPES, primaryType: "OrderComponents" as const, message: parameters },
  };
}

export async function evmOfferSubmit(p: { chain: string; kind: "item" | "collection"; parameters: OsOrderParams; signature: string; criteria?: Record<string, unknown> | null }) {
  if (!isTradableChain(p.chain)) throw new Error("Unsupported chain");
  const parameters = { ...p.parameters, totalOriginalConsiderationItems: p.parameters.consideration.length };
  const explain = (err: Error): never => {
    throw new Error(/balance/i.test(err.message) ? "Your wallet doesn't hold enough wrapped coin for this offer anymore."
      : /approv|allowance/i.test(err.message) ? "OpenSea can't use your wrapped coin yet. Approve it first."
      : `OpenSea didn't accept the offer: ${err.message.slice(0, 200)}`);
  };
  let hash: string | null;
  if (p.kind === "item") {
    const r = await postOsItemOffer(p.chain, { parameters, signature: p.signature, protocol_address: SEAPORT }).catch(explain);
    hash = r.order?.order_hash ?? null;
  } else {
    if (!p.criteria) throw new Error("Missing the collection criteria.");
    const r = await postOsCollectionOffer({ protocol_data: { parameters, signature: p.signature }, criteria: p.criteria, protocol_address: SEAPORT }).catch(explain);
    hash = r.order_hash ?? null;
  }
  forgetOffers(p.parameters.offerer);
  if (hash) noteListed(hash, p.chain); // History badges it "via FloorFeed"
  return { orderHash: hash };
}

// A wallet's live OpenSea offers, for "Your offers": what it's for, the price
// per NFT, expiry, and whether cancelling is free. Cached a minute per wallet.
export type MyOffer = {
  chain: string; orderHash: string; kind: "item" | "collection" | "trait";
  symbol: string | null; collection: string | null; mint: string | null; name: string; image: string | null;
  price: number; unit: string; quantity: number; expiresAt: number; createdAt: number; cancelFree: boolean;
  floor: number | null; url: string;
};
const cache = new Map<string, { at: number; v: MyOffer[] }>();
const dirtyUntil = new Map<string, number>();
const nftArt = new Map<string, { name: string | null; image: string | null }>();
export const forgetOffers = (wallet: string) => {
  cache.delete(wallet.toLowerCase());
  dirtyUntil.set(wallet.toLowerCase(), Date.now() + 60_000);
};
export async function evmWalletOffers(wallet: string): Promise<MyOffer[]> {
  const key = wallet.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000 && (dirtyUntil.get(key) ?? 0) < Date.now()) return hit.v;
  const raw = await getOsMyOffers(wallet);
  const v = (await Promise.all(raw.slice(0, 40).map(async (o): Promise<MyOffer | null> => {
    const chain = fromOsChain(o.chain);
    if (!isTradableChain(chain)) return null;
    const order = await getOsOrder(chain, o.order_hash);
    if (!order) return null;
    const slug = o.criteria?.collection?.slug ?? null;
    const meta = slug ? EVM_SALES.find((c) => c.slug === slug) : undefined;
    const collName = meta?.name ?? (slug ? prettySlug(slug) : null);
    const id = o.asset?.identifier ?? null;
    const contract = o.asset?.contract?.toLowerCase() ?? null;
    const mint = id && contract ? `${contract}:${id}` : null;
    let art: { name: string | null; image: string | null } | undefined;
    if (mint) {
      art = nftArt.get(`${chain}:${mint}`);
      if (!art) {
        const n = await getOsNft(chain, contract!, id!).catch(() => null);
        art = { name: n?.name ?? null, image: n?.image ?? null };
        if (n) nftArt.set(`${chain}:${mint}`, art);
      }
    }
    const row = meta ? floorOf.get(meta.slug) as { floor: number | null; image: string | null } | undefined : undefined;
    const p = o.price_per_item ?? o.price;
    const assetChain = chain === "apechain" ? "ape_chain" : chain;
    return {
      chain, orderHash: o.order_hash,
      kind: mint ? "item" : o.criteria?.traits?.length ? "trait" : "collection",
      symbol: meta?.slug ?? null, collection: collName, mint,
      name: art?.name ?? (mint ? `${collName ?? "NFT"} #${id}` : `Any ${collName ?? "NFT"}`),
      image: art?.image ?? row?.image ?? null,
      price: p ? Number(p.value) / 10 ** p.decimals : 0, unit: p?.currency ?? "WETH",
      quantity: o.remaining_quantity ?? 1,
      expiresAt: Number(order.protocol_data.parameters.endTime), createdAt: o.order_created_at ?? Number(order.protocol_data.parameters.startTime),
      cancelFree: order.protocol_data.parameters.zone.toLowerCase() === SIGNED_ZONE,
      floor: row?.floor ?? null,
      url: mint ? `https://opensea.io/assets/${assetChain}/${contract}/${id}` : `https://opensea.io/collection/${slug ?? ""}`,
    };
  }))).filter((x): x is MyOffer => x !== null);
  cache.set(key, { at: Date.now(), v });
  return v;
}
