import {
  createPublicClient, encodeFunctionData, formatEther, http, parseAbiItem, parseEther, parseSignature, parseTransaction, recoverTransactionAddress,
  serializeTransaction, type Hex, type PublicClient, type TransactionSerializable,
} from "viem";
import { abstract, apeChain, arbitrum, base, hyperEvm, ink, mainnet, monad, robinhood, ronin } from "viem/chains";
import { EVM_CHAINS, EVM_SALES, config, normalizeUnit } from "./config.ts";
import { unitOf } from "./units.ts";
import { db } from "./db.ts";
import { getOsAccountNfts, getOsBestListing, getOsBestListings, getOsBestOffer, getOsFulfillment, getOsOfferFulfillment } from "./opensea.ts";

// Real buys on Ethereum and Base. FloorFeed never holds keys or funds: it
// asks OpenSea for the Seaport fill data of a listing, encodes it into a
// transaction, simulates it against the chain (so a stale listing or a short
// balance fails here, not in the wallet), and hands it to the user's wallet,
// which shows it and asks them to confirm.

// OpenSea's asset URLs use the API chain names (Polygon is "matic", ApeChain "ape_chain").
const osAssetChain = (c: string) => (c === "polygon" ? "matic" : c === "apechain" ? "ape_chain" : c);

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Chains where FloorFeed reads balances and builds buys. Gas and buys are in
// each chain's native token (EVM_CHAINS.native). RPCs default to public
// endpoints; override per chain in .env.
const rpc = (url: string) => http(url, { timeout: 15_000 });
const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: rpc(process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com") }),
  base: createPublicClient({ chain: base, transport: rpc(process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com") }),
  abstract: createPublicClient({ chain: abstract, transport: rpc(process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz") }),
  ink: createPublicClient({ chain: ink, transport: rpc(process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com") }),
  arbitrum: createPublicClient({ chain: arbitrum, transport: rpc(process.env.ARBITRUM_RPC_URL || "https://arbitrum-one-rpc.publicnode.com") }),
  hyperevm: createPublicClient({ chain: hyperEvm, transport: rpc(process.env.HYPEREVM_RPC_URL || "https://rpc.hyperliquid.xyz/evm") }),
  ronin: createPublicClient({ chain: ronin, transport: rpc(process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc") }),
  apechain: createPublicClient({ chain: apeChain, transport: rpc(process.env.APECHAIN_RPC_URL || "https://rpc.apechain.com/http") }),
  monad: createPublicClient({ chain: monad, transport: rpc(process.env.MONAD_RPC_URL || "https://rpc.monad.xyz") }),
  robinhood: createPublicClient({ chain: robinhood, transport: rpc(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com") }),
};
type EvmChain = keyof typeof clients;
const TRADABLE = Object.keys(clients) as EvmChain[];
const isTradable = (c: string): c is EvmChain => (TRADABLE as string[]).includes(c);

// --- balances and holdings ---

const balanceCache = new Map<string, { at: number; v: Record<EvmChain, number>; failed: Set<EvmChain> }>();
async function loadBalances(address: string) {
  const key = address.toLowerCase();
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  const failed = new Set<EvmChain>();
  const wei = await Promise.all(TRADABLE.map((c) => (clients[c] as unknown as PublicClient).getBalance({ address: address as Hex })
    .catch(() => { failed.add(c); return 0n; })));
  const v = Object.fromEntries(TRADABLE.map((c, i) => [c, Number(formatEther(wei[i]))])) as Record<EvmChain, number>;
  // Don't cache a read where an RPC failed: a 0 there isn't a real balance.
  const entry = { at: failed.size ? 0 : Date.now(), v, failed };
  balanceCache.set(key, entry);
  return entry;
}
export async function evmBalances(address: string) {
  return (await loadBalances(address)).v;
}
// Balances summed per native token: { ETH: across ETH chains, HYPE: ..., ... }.
export function nativeTotals(b: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [chain, v] of Object.entries(b)) {
    const unit = EVM_CHAINS[chain as EvmChain].native;
    out[unit] = (out[unit] ?? 0) + v;
  }
  return out;
}
export const totalEth = (b: Record<string, number>) => nativeTotals(b).ETH ?? 0;

const holdingsCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof loadEvmHoldings>> }>();
export async function evmHoldings(address: string) {
  const key = address.toLowerCase();
  const hit = holdingsCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = await loadEvmHoldings(key);
  holdingsCache.set(key, { at: Date.now(), data });
  return data;
}

const floorOf = db.prepare("SELECT floor FROM collections WHERE symbol = ?");
const lastBuy = db.prepare("SELECT price FROM trades WHERE buyer = ? AND mint = ? ORDER BY block_time DESC LIMIT 1");
// Fallback cost basis: a buy made in FloorFeed (activity log), for sales our ingest didn't see.
const appBuy = db.prepare("SELECT amount FROM wallet_activity WHERE wallet = ? AND mint = ? AND kind = 'buy' AND status = 'confirmed' ORDER BY created_at DESC LIMIT 1");

async function loadEvmHoldings(address: string) {
  const tracked = new Map(EVM_SALES.map((c) => [c.slug, c]));
  const chains = [...new Set(EVM_SALES.map((c) => c.chain))].filter(isTradable);
  const [nftLists, balances] = await Promise.all([
    Promise.all(chains.map((ch) => getOsAccountNfts(ch, address).catch(() => []))),
    evmBalances(address),
  ]);
  const all = nftLists.flat();
  const nfts = all.filter((n) => tracked.has(n.collection)).map((n) => {
    const floor = (floorOf.get(n.collection) as { floor: number | null } | undefined)?.floor ?? null;
    const mint = `${n.contract}:${n.identifier}`;
    return {
      mint,
      chain: tracked.get(n.collection)!.chain,
      unit: unitOf(n.collection),
      name: n.name,
      image: n.image,
      collection: { symbol: n.collection, name: tracked.get(n.collection)!.name, floor },
      estValue: floor != null ? floor * (1 - config.paperSellHaircut) : null,
      boughtAt: (lastBuy.get(address, mint) as { price: number } | undefined)?.price
        ?? (appBuy.get(address, mint) as { amount: number | null } | undefined)?.amount ?? null,
    };
  }).sort((x, y) => (y.estValue ?? 0) - (x.estValue ?? 0));
  // One value per currency: native balances plus NFTs marked in their collection's unit.
  const cash = nativeTotals(balances);
  const values: Record<string, { cash: number; nfts: number; nftValue: number; total: number }> = {};
  for (const [u, v] of Object.entries(cash)) if (v > 0 || u === "ETH") values[u] = { cash: v, nfts: 0, nftValue: 0, total: v };
  for (const n of nfts) {
    const v = (values[n.unit] ??= { cash: 0, nfts: 0, nftValue: 0, total: 0 });
    v.nfts++;
    v.nftValue += n.estValue ?? 0;
    v.total += n.estValue ?? 0;
  }
  const eth = cash.ETH ?? 0;
  const ethNfts = values.ETH?.nftValue ?? 0;
  return { address, eth, balances, values, nftValue: ethNfts, totalValue: eth + ethNfts, nfts, untracked: all.length - nfts.length };
}

// --- quote and buy ---

const imageOf = db.prepare(`SELECT image FROM trades WHERE mint = ? AND image IS NOT NULL ORDER BY block_time DESC LIMIT 1`);

// The listing a buy would fill: one NFT's best listing (`id` = contract:tokenId)
// or the collection's cheapest.
export async function evmQuote(symbol: string, buyer: string | undefined, id: string | undefined) {
  const meta = EVM_SALES.find((c) => c.slug === symbol);
  if (!meta) return null;
  const unit = unitOf(symbol);
  type L = { mint: string; price: number; currency: string; orderHash: string | null; protocolAddress: string | null; chain: string };
  let listing: L | null = null;
  if (id) {
    const l = await getOsBestListing(symbol, id.split(":")[1] ?? "");
    if (l) listing = { mint: id, ...l };
  } else {
    listing = (await getOsBestListings(symbol, 10).catch(() => [])).find((l) => normalizeUnit(l.currency) === unit) ?? null;
  }
  const chain = (listing?.chain ?? meta.chain) as string;
  const native = isTradable(chain) ? EVM_CHAINS[chain].native : null;
  // Only listings priced in the chain's native token are bought here: wrapped
  // tokens (WETH, WRON...) need a separate approval transaction first.
  const nativePriced = !!listing && listing.currency === native;
  const tradable = isTradable(chain) && nativePriced && !!listing?.orderHash && !!listing?.protocolAddress;
  const read = buyer ? await loadBalances(buyer).catch(() => null) : null;
  const balances = read?.v ?? null;
  const floor = (floorOf.get(symbol) as { floor: number | null } | undefined)?.floor ?? null;
  // null = unknown (RPC down), so the app doesn't claim an empty wallet.
  const balance = balances && isTradable(chain) && !read!.failed.has(chain) ? balances[chain] : null;
  // The same gas token on other chains (ETH on Ethereum while buying on Ink...):
  // the usual reason a "funded" wallet can't pay.
  // What a Seaport fill costs in gas right now (~300k gas, plus headroom and a
  // small allowance for the L1 data fee on rollups), so "can I afford it" counts gas too.
  const gasReserve = isTradable(chain)
    ? await (clients[chain] as unknown as PublicClient).getGasPrice()
        .then((gp) => Number(formatEther(gp * 400_000n)) + (chain === "ethereum" ? 0 : 0.00002))
        .catch(() => null)
    : null;
  const elsewhere = balances && native
    ? TRADABLE.filter((c) => c !== chain && EVM_CHAINS[c].native === native && balances[c] > 0)
        .map((c) => ({ chain: c, balance: balances[c] })).sort((a, b) => b.balance - a.balance)
    : [];
  return {
    collection: { symbol, name: meta.name, floor },
    chain,
    currency: unit,
    native,
    listing: listing && {
      ...listing,
      name: `${meta.name} #${listing.mint.split(":")[1]}`,
      image: (imageOf.get(listing.mint) as { image: string } | undefined)?.image ?? null,
    },
    balance,
    balanceEth: balance, // older app builds
    elsewhere,
    gasReserve,
    // FloorFeed's fee on top of the price (expected; the buy may go ahead without it).
    fee: tradable && listing && BUY_FEE_BPS > 0 ? { pct: BUY_FEE_BPS / 100, amount: listing.price * BUY_FEE_BPS / 10_000 } : null,
    executable: tradable,
    reason: !listing ? `No ${unit} listing is live right now.`
      : !isTradable(chain) ? `Buying on ${chain} isn't supported yet.`
      : !nativePriced ? `This listing is priced in ${listing.currency}, which needs an extra approval. Finish it on OpenSea.`
      : null,
    marketUrl: listing ? `https://opensea.io/assets/${osAssetChain(chain)}/${listing.mint.replace(":", "/")}` : `https://opensea.io/collection/${symbol}`,
  };
}

// FloorFeed's fee on buys: a Seaport "tip", an extra payment to our wallet
// appended to the order at fill time (the seller's signed terms don't change),
// paid by the buyer in the same transaction and shown in the buy sheet. Off
// unless BUY_FEE_BPS is set (max 1%). Only for listings paid in the native coin.
const FEE_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BUY_FEE_RECIPIENT = process.env.BUY_FEE_RECIPIENT || process.env.RELAY_FEE_RECIPIENT || "";
const BUY_FEE_BPS = FEE_ADDR_RE.test(BUY_FEE_RECIPIENT) ? Math.min(100, Math.max(0, Math.round(Number(process.env.BUY_FEE_BPS ?? 0)))) : 0;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const buyFee = (value: bigint) => (value * BigInt(BUY_FEE_BPS)) / 10_000n;
export const buyFeePct = () => (BUY_FEE_BPS > 0 ? BUY_FEE_BPS / 100 : null);

// The fulfillment with our tip added, or null when this order shape can't take
// one. Seaport accepts payments beyond the signed ones: extra
// additionalRecipients on basic orders, extra consideration items on others.
type Input = Record<string, unknown>;
function withTip(fn: string, input: Input, tip: bigint): Input | null {
  const copy = structuredClone(input) as Input;
  if (fn.startsWith("fulfillBasicOrder")) {
    const p = copy.parameters as { considerationToken: string; additionalRecipients: { amount: string; recipient: string }[] };
    if (!p || p.considerationToken.toLowerCase() !== ZERO_ADDR) return null;
    p.additionalRecipients.push({ amount: tip.toString(), recipient: BUY_FEE_RECIPIENT });
    return copy;
  }
  if (fn.startsWith("fulfillAdvancedOrder") || fn.startsWith("fulfillOrder")) {
    const order = (copy.advancedOrder ?? copy.order) as { parameters: { consideration: Record<string, string | number>[] } } | undefined;
    const cons = order?.parameters?.consideration;
    if (!cons?.length || cons.some((c) => Number(c.itemType) !== 0)) return null; // native-coin payments only
    cons.push({ itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0", startAmount: tip.toString(), endAmount: tip.toString(), recipient: BUY_FEE_RECIPIENT });
    return copy;
  }
  return null;
}

// OpenSea gives the arguments as named objects in struct order; viem wants
// tuples as arrays in that same order.
const toArgs = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(toArgs) : v && typeof v === "object" ? Object.values(v).map(toArgs) : v;

export async function evmBuyTx(p: { orderHash: string; protocolAddress: string; chain: string; buyer: string }) {
  if (!isTradable(p.chain)) throw new Error(`Buying on ${p.chain} isn't supported yet.`);
  const tx = await getOsFulfillment(p.orderHash, p.chain, p.protocolAddress, p.buyer);
  const abi = parseAbiItem(`function ${tx.function}`) as ReturnType<typeof parseAbiItem> & { name: string };
  const encode = (input: Input) => encodeFunctionData({ abi: [abi], functionName: abi.name, args: toArgs(input) as never });
  const price = BigInt(tx.value);
  let data = encode(tx.input_data);
  let value = price;
  // The chains' client types differ (Abstract is zkSync-based); the calls used here are common to all.
  const client = clients[p.chain] as unknown as PublicClient;
  // Dry run as the buyer: catches a listing that just sold, a short balance,
  // or a bad encoding before the wallet ever sees it.
  let gas: bigint | null = null;
  let fee = 0n;
  // With our fee first. If the order won't take the tip (some zones check the
  // payments) the buy still goes ahead without it.
  const native = EVM_CHAINS[p.chain].native;
  const tip = BUY_FEE_BPS > 0 && price > 0n ? buyFee(price) : 0n;
  const tipped = tip > 0n ? withTip(tx.function, tx.input_data, tip) : null;
  if (tipped) {
    const tData = encode(tipped);
    const ok = await client.estimateGas({ account: p.buyer as Hex, to: tx.to as Hex, data: tData, value: price + tip }).catch((err: Error) => {
      if (/insufficient funds/i.test(err.message)) throw new Error(`Not enough ${native} in this wallet for the price, FloorFeed's fee and gas.`);
      return null;
    });
    if (ok) { gas = ok; data = tData; value = price + tip; fee = tip; }
  }
  try {
    gas ??= await client.estimateGas({ account: p.buyer as Hex, to: tx.to as Hex, data, value });
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(/insufficient funds/i.test(msg)
      ? `Not enough ${EVM_CHAINS[p.chain].native} in this wallet for the price plus gas.`
      : "This listing can't be filled right now (it may have just sold). Try again for the next cheapest.");
  }
  const fees = await client.estimateFeesPerGas().catch(() => null);
  const gasCostEth = fees?.maxFeePerGas ? Number(formatEther(gas * fees.maxFeePerGas)) : null;
  return {
    chainId: EVM_CHAINS[p.chain].id,
    explorerTx: `${EVM_CHAINS[p.chain].explorer}/tx/`,
    to: tx.to,
    data,
    value: value.toString(),
    valueEth: Number(formatEther(value)),
    priceEth: Number(formatEther(price)),
    feeEth: Number(formatEther(fee)), // FloorFeed's fee included in value (0 when off or not applicable)
    gas: ((gas * 12n) / 10n).toString(), // +20% headroom
    gasCostEth,
  };
}


// --- sell: accept the best OpenSea offer ---
// The holder sells into the top bid (item, trait or collection offer). Seaport
// moves the NFT through OpenSea's conduit, so the first sale from a collection
// needs a one-time setApprovalForAll for that conduit. Offers pay in the wrapped
// token (WETH on Ethereum and its L2s), minus OpenSea's fee and any royalty.

const SEAPORT_INFO = parseAbiItem("function information() view returns (string version, bytes32 domainSeparator, address conduitController)");
const GET_CONDUIT = parseAbiItem("function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)");
const IS_APPROVED = parseAbiItem("function isApprovedForAll(address owner, address operator) view returns (bool)");
const SET_APPROVAL = parseAbiItem("function setApprovalForAll(address operator, bool approved)");
// OpenSea's conduit key on Ethereum and most chains. It is NOT universal (Ink
// uses another), so the offer's own conduitKey wins when OpenSea sends one.
const OS_CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000" as Hex;
const ZERO_KEY = `0x${"0".repeat(64)}`;

// Seaport -> its conduit controller -> the conduit for that key. Read from
// chain because addresses differ by chain (and on zkSync-based Abstract).
// A zero key means no conduit: Seaport itself moves the NFT.
const conduitCache = new Map<string, Hex>();
async function osConduit(chain: EvmChain, seaport: string, conduitKey?: string | null) {
  const want = (conduitKey && /^0x[0-9a-fA-F]{64}$/.test(conduitKey) ? conduitKey : OS_CONDUIT_KEY).toLowerCase() as Hex;
  if (want === ZERO_KEY) return seaport as Hex;
  const key = `${chain}:${seaport.toLowerCase()}:${want}`;
  const hit = conduitCache.get(key);
  if (hit) return hit;
  const c = clients[chain] as unknown as PublicClient;
  const [, , controller] = await c.readContract({ address: seaport as Hex, abi: [SEAPORT_INFO], functionName: "information" });
  const [conduit, exists] = await c.readContract({ address: controller, abi: [GET_CONDUIT], functionName: "getConduit", args: [want] });
  if (!exists) throw new Error(`OpenSea's conduit isn't set up on ${chain}.`);
  conduitCache.set(key, conduit);
  return conduit;
}

// Does `owner` hold contract:tokenId? Works for ERC-721 and ERC-1155.
async function holds(chain: EvmChain, contract: Hex, tokenId: bigint, owner: string) {
  const c = clients[chain] as unknown as PublicClient;
  const is1155 = await c.readContract({ address: contract, abi: [SUPPORTS], functionName: "supportsInterface", args: ["0xd9b67a26"] }).catch(() => false);
  if (is1155) {
    const bal = await c.readContract({ address: contract, abi: [BALANCE_1155], functionName: "balanceOf", args: [owner as Hex, tokenId] }).catch(() => 0n);
    return bal > 0n;
  }
  const o = await c.readContract({ address: contract, abi: [OWNER_OF], functionName: "ownerOf", args: [tokenId] }).catch(() => null);
  return !!o && o.toLowerCase() === owner.toLowerCase();
}

export async function evmSellQuote(symbol: string, id: string, seller: string) {
  const meta = EVM_SALES.find((c) => c.slug === symbol);
  const [contract, tokenId] = id.split(":");
  if (!meta || !EVM_ADDRESS_RE.test(contract ?? "") || !/^\d{1,78}$/.test(tokenId ?? "")) return null;
  const chain = meta.chain as string;
  const floor = (floorOf.get(symbol) as { floor: number | null } | undefined)?.floor ?? null;
  const boughtAt = (lastBuy.get(seller.toLowerCase(), id.toLowerCase()) as { price: number } | undefined)?.price ?? null;
  const base = {
    collection: { symbol, name: meta.name, floor },
    chain, mint: id, name: `${meta.name} #${tokenId}`,
    image: (imageOf.get(id.toLowerCase()) as { image: string } | undefined)?.image ?? null,
    boughtAt,
    marketUrl: `https://opensea.io/assets/${osAssetChain(chain)}/${contract}/${tokenId}`,
  };
  if (!isTradable(chain)) {
    return { ...base, offer: null, owned: null, approved: null, operator: null, executable: false, reason: `Selling on ${chain} isn't supported yet.` };
  }
  const [offer, owned] = await Promise.all([
    getOsBestOffer(symbol, tokenId),
    holds(chain, contract as Hex, BigInt(tokenId), seller),
  ]);
  let operator: Hex | null = null;
  let approved: boolean | null = null;
  if (offer && owned) {
    operator = await osConduit(chain, offer.protocolAddress, offer.conduitKey).catch(() => null);
    if (operator) {
      const c = clients[chain] as unknown as PublicClient;
      approved = await c.readContract({ address: contract as Hex, abi: [IS_APPROVED], functionName: "isApprovedForAll", args: [seller as Hex, operator] }).catch(() => null);
    }
  }
  // An offer far under the floor is usually a lowball bid; say so before they accept it.
  const belowFloor = offer && floor ? 1 - offer.price / floor : null;
  return {
    ...base,
    offer: offer && { ...offer, unit: normalizeUnit(offer.currency) ?? offer.currency, belowFloor },
    owned, approved, operator,
    executable: !!offer && owned && !!operator && approved !== null,
    reason: !owned ? "This wallet doesn't hold this NFT."
      : !offer ? "Nobody has an offer on this NFT right now. You can list it on OpenSea instead."
      : !operator || approved === null ? "Couldn't check the marketplace approval right now. Try again in a moment."
      : null,
  };
}

// The one-time approval that lets OpenSea's conduit move NFTs from this
// collection when the seller accepts an offer.
export async function evmApproveTx(b: { chain: string; contract: string; owner: string; operator: string }) {
  if (!isTradable(b.chain)) throw new Error("Unsupported chain");
  const c = clients[b.chain] as unknown as PublicClient;
  const data = encodeFunctionData({ abi: [SET_APPROVAL], functionName: "setApprovalForAll", args: [b.operator as Hex, true] });
  const gas = await c.estimateGas({ account: b.owner as Hex, to: b.contract as Hex, data }).catch((err: Error) => {
    throw new Error(/insufficient funds/i.test(err.message)
      ? `Not enough ${EVM_CHAINS[b.chain as EvmChain].native} for the network fee.`
      : `The approval would fail: ${err.message.split("\n")[0]}`);
  });
  return {
    chainId: EVM_CHAINS[b.chain].id, explorerTx: `${EVM_CHAINS[b.chain].explorer}/tx/`,
    to: b.contract, data, value: "0", gas: ((gas * 12n) / 10n).toString(),
  };
}

export async function evmSellTx(p: { orderHash: string; protocolAddress: string; chain: string; seller: string; mint: string }) {
  if (!isTradable(p.chain)) throw new Error(`Selling on ${p.chain} isn't supported yet.`);
  const [contract, tokenId] = p.mint.split(":");
  const tx = await getOsOfferFulfillment({
    orderHash: p.orderHash, chain: p.chain, protocolAddress: p.protocolAddress, fulfiller: p.seller, contract, tokenId,
  });
  const abi = parseAbiItem(`function ${tx.function}`) as ReturnType<typeof parseAbiItem> & { name: string };
  let data = encodeFunctionData({ abi: [abi], functionName: abi.name, args: toArgs(tx.input_data) as never });
  // OpenSea's attribution tag; trailing bytes are ignored by the ABI decoder.
  if (tx.calldata_suffix && /^0x[0-9a-fA-F]*$/.test(tx.calldata_suffix)) data = (data + tx.calldata_suffix.slice(2)) as Hex;
  const value = BigInt(tx.value);
  const client = clients[p.chain] as unknown as PublicClient;
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: p.seller as Hex, to: tx.to as Hex, data, value });
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(/insufficient funds/i.test(msg)
      ? `Not enough ${EVM_CHAINS[p.chain].native} in this wallet for the network fee.`
      : "This offer can't be accepted right now (it may have been filled or cancelled). Refresh for the next best one.");
  }
  return {
    chainId: EVM_CHAINS[p.chain].id, explorerTx: `${EVM_CHAINS[p.chain].explorer}/tx/`,
    to: tx.to, data, value: value.toString(), gas: ((gas * 12n) / 10n).toString(),
  };
}

// --- withdrawals: plain transfers out of the user's Privy wallet ---

const ERC721_TRANSFER = parseAbiItem("function safeTransferFrom(address from, address to, uint256 tokenId)");
const ERC1155_TRANSFER = parseAbiItem("function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)");
const OWNER_OF = parseAbiItem("function ownerOf(uint256 tokenId) view returns (address)");
const BALANCE_1155 = parseAbiItem("function balanceOf(address account, uint256 id) view returns (uint256)");
const SUPPORTS = parseAbiItem("function supportsInterface(bytes4 interfaceId) view returns (bool)");

// What a plain native-token transfer costs right now (21k gas, with headroom),
// so "Max" leaves enough for the fee.
export async function evmTransferFee(chain: string) {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  const c = clients[chain] as unknown as PublicClient;
  const gasPrice = await c.getGasPrice();
  const fee = (gasPrice * 21_000n * 13n) / 10n;
  return { chain, chainId: c.chain!.id, native: EVM_CHAINS[chain].native, fee: Number(formatEther(fee)) };
}

// An NFT transfer from the user's wallet to another address: checks the
// wallet owns it, picks ERC-721 or ERC-1155, and simulates it as the sender.
export async function evmNftTransferTx(b: { chain: string; contract: string; tokenId: string; from: string; to: string }) {
  if (!isTradable(b.chain)) throw new Error("Unsupported chain");
  const c = clients[b.chain] as unknown as PublicClient;
  const contract = b.contract as Hex, from = b.from as Hex, to = b.to as Hex;
  const id = BigInt(b.tokenId);
  const is1155 = await c.readContract({ address: contract, abi: [SUPPORTS], functionName: "supportsInterface", args: ["0xd9b67a26"] }).catch(() => false);
  let data: Hex;
  if (is1155) {
    const bal = await c.readContract({ address: contract, abi: [BALANCE_1155], functionName: "balanceOf", args: [from, id] });
    if (bal < 1n) throw new Error("This wallet doesn't hold that NFT.");
    data = encodeFunctionData({ abi: [ERC1155_TRANSFER], functionName: "safeTransferFrom", args: [from, to, id, 1n, "0x"] });
  } else {
    const owner = await c.readContract({ address: contract, abi: [OWNER_OF], functionName: "ownerOf", args: [id] }).catch(() => null);
    if (!owner || owner.toLowerCase() !== from.toLowerCase()) throw new Error("This wallet doesn't hold that NFT.");
    data = encodeFunctionData({ abi: [ERC721_TRANSFER], functionName: "safeTransferFrom", args: [from, to, id] });
  }
  const gas = await c.estimateGas({ account: from, to: contract, data }).catch((err: Error) => {
    throw new Error(`The transfer would fail: ${err.message.split("\n")[0]}`);
  });
  return { chainId: c.chain!.id, to: contract, data, value: "0", gas: ((gas * 12n) / 10n).toString(), standard: is1155 ? "erc1155" : "erc721" };
}

// --- shared helpers for other modules (bridge) ---
export const evmChainOf = (id: number) => TRADABLE.find((c) => EVM_CHAINS[c].id === id) ?? null;
export async function simulateEvm(chain: string, tx: { from: string; to: string; data: string; value: bigint }) {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  const c = clients[chain] as unknown as PublicClient;
  return c.estimateGas({ account: tx.from as Hex, to: tx.to as Hex, data: tx.data as Hex, value: tx.value });
}

// Did a transaction the wallet reported actually reach the chain?
// mined | failed | pending (in the mempool) | missing (never broadcast or dropped)
export async function evmTxState(chain: string, hash: string) {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  const c = clients[chain] as unknown as PublicClient;
  const receipt = await c.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  if (receipt) return receipt.status === "success" ? "mined" : "failed";
  const tx = await c.getTransaction({ hash: hash as Hex }).catch(() => null);
  return tx ? "pending" : "missing";
}

// --- balances by network, including the wrapped token ---
// Offer sales pay out in the chain's wrapped token (WETH on Ink...), which a
// plain balance read never shows, so the money looks gone. These are read
// alongside the native balance and can be unwrapped back 1:1.
// Addresses verified on chain with symbol() (2026-10-14; Robinhood 2026-10-15).
const WRAPPED: Partial<Record<EvmChain, { address: Hex; symbol: string; unit: string; unwrappable: boolean }[]>> = {
  ethereum: [{ address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", unit: "ETH", unwrappable: true }],
  base: [{ address: "0x4200000000000000000000000000000000000006", symbol: "WETH", unit: "ETH", unwrappable: true }],
  ink: [{ address: "0x4200000000000000000000000000000000000006", symbol: "WETH", unit: "ETH", unwrappable: true }],
  arbitrum: [{ address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", unit: "ETH", unwrappable: true }],
  abstract: [{ address: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809", symbol: "WETH", unit: "ETH", unwrappable: true }],
  hyperevm: [{ address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE", unit: "HYPE", unwrappable: true }],
  // Ronin: WRON unwraps to RON; its WETH is bridged ETH (no native ETH there to unwrap to).
  ronin: [
    { address: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4", symbol: "WRON", unit: "RON", unwrappable: true },
    { address: "0xc99a6A985eD2Cac1ef41640596C5A5f9F4E19Ef5", symbol: "WETH", unit: "ETH", unwrappable: false },
  ],
  apechain: [{ address: "0x48b62137EdfA95a428D35C09E44256a739F6B557", symbol: "WAPE", unit: "APE", unwrappable: true }],
  monad: [{ address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON", unit: "MON", unwrappable: true }],
  robinhood: [{ address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH", unit: "ETH", unwrappable: true }],
};
const ERC20_BALANCE = parseAbiItem("function balanceOf(address) view returns (uint256)");
const WETH_WITHDRAW = parseAbiItem("function withdraw(uint256 wad)");

const networksCache = new Map<string, { at: number; v: unknown }>();
export async function evmNetworks(address: string) {
  const key = address.toLowerCase();
  const hit = networksCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.v as Awaited<ReturnType<typeof loadNetworks>>;
  const v = await loadNetworks(key);
  networksCache.set(key, { at: Date.now(), v });
  return v;
}
async function loadNetworks(address: string) {
  const { v: native, failed } = await loadBalances(address);
  return Promise.all(TRADABLE.map(async (chain) => {
    const c = clients[chain] as unknown as PublicClient;
    const tokens = await Promise.all((WRAPPED[chain] ?? []).map(async (t) => {
      const raw = await c.readContract({ address: t.address, abi: [ERC20_BALANCE], functionName: "balanceOf", args: [address as Hex] }).catch(() => null);
      return { ...t, balance: raw == null ? null : Number(formatEther(raw)) };
    }));
    return {
      chain, name: EVM_CHAINS[chain].name, chainId: EVM_CHAINS[chain].id, native: EVM_CHAINS[chain].native,
      balance: failed.has(chain) ? null : native[chain],
      tokens: tokens.filter((t) => t.balance == null || t.balance > 0),
    };
  }));
}
// Drop the cached reads after a transaction so the next look is fresh.
export function forgetBalances(address: string) {
  balanceCache.delete(address.toLowerCase());
  networksCache.delete(address.toLowerCase());
  holdingsCache.delete(address.toLowerCase());
}

// Wrapped -> native, 1:1, on the same chain (WETH.withdraw). `amount` omitted = all of it.
export async function evmUnwrapTx(b: { chain: string; owner: string; token: string; amount?: number }) {
  if (!isTradable(b.chain)) throw new Error("Unsupported chain");
  const t = (WRAPPED[b.chain] ?? []).find((x) => x.address.toLowerCase() === b.token.toLowerCase());
  if (!t || !t.unwrappable) throw new Error("That token can't be unwrapped here.");
  const c = clients[b.chain] as unknown as PublicClient;
  const bal = await c.readContract({ address: t.address, abi: [ERC20_BALANCE], functionName: "balanceOf", args: [b.owner as Hex] });
  const wad = b.amount != null ? parseEther(b.amount.toFixed(18)) : bal;
  if (wad <= 0n || wad > bal) throw new Error(`You have ${formatEther(bal)} ${t.symbol} on ${EVM_CHAINS[b.chain].name}.`);
  const data = encodeFunctionData({ abi: [WETH_WITHDRAW], functionName: "withdraw", args: [wad] });
  const gas = await c.estimateGas({ account: b.owner as Hex, to: t.address, data }).catch((err: Error) => {
    throw new Error(/insufficient funds/i.test(err.message)
      ? `Not enough ${EVM_CHAINS[b.chain as EvmChain].native} on ${EVM_CHAINS[b.chain as EvmChain].name} for the network fee.`
      : `The unwrap would fail: ${err.message.split("\n")[0]}`);
  });
  return {
    chainId: EVM_CHAINS[b.chain].id, explorerTx: `${EVM_CHAINS[b.chain].explorer}/tx/`,
    to: t.address, data, value: "0", gas: ((gas * 12n) / 10n).toString(),
    amount: Number(formatEther(wad)), symbol: t.symbol, unit: t.unit,
  };
}

// State of a transaction plus who sent it (to check an activity entry belongs to its wallet).
export async function evmTxInfo(chain: string, hash: string) {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  const c = clients[chain] as unknown as PublicClient;
  const receipt = await c.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  if (receipt) return { state: receipt.status === "success" ? "mined" as const : "failed" as const, from: receipt.from.toLowerCase(), block: Number(receipt.blockNumber) };
  const tx = await c.getTransaction({ hash: hash as Hex }).catch(() => null);
  return tx ? { state: "pending" as const, from: tx.from.toLowerCase(), block: null } : { state: "missing" as const, from: null, block: null };
}

export const isTradableChain = (c: string) => isTradable(c);


// --- the FloorFeed (Privy) wallet: we prepare and broadcast, Privy only signs ---
// Privy's own send fetched nonce/fees and broadcast through RPCs we can't see
// or control (hangs, and a hash that never landed). Now the app asks here for
// the nonce, gas and fees, Privy shows and signs that exact transaction, and
// this broadcasts it through our RPC.

// Minimum priority fee: 0.05 gwei on Ethereum (a few cents at most), 0.001 gwei on L2s.
const MIN_TIP = (chain: EvmChain) => (chain === "ethereum" ? 50_000_000n : 1_000_000n);

export async function evmPrepare(p: { chainId: number; from: string; to: string; data: string; value: string; gas?: string }) {
  const chain = evmChainOf(p.chainId);
  if (!chain) throw new Error("Unsupported network");
  const c = clients[chain] as unknown as PublicClient;
  const [nonce, gas, fees] = await Promise.all([
    c.getTransactionCount({ address: p.from as Hex, blockTag: "pending" }),
    p.gas ? Promise.resolve(BigInt(p.gas))
      : c.estimateGas({ account: p.from as Hex, to: p.to as Hex, data: p.data as Hex, value: BigInt(p.value) }).then((g) => (g * 12n) / 10n),
    c.estimateFeesPerGas().catch(() => null),
  ]);
  const base = { nonce, gas: gas.toString(), chainId: p.chainId };
  if (fees?.maxFeePerGas != null) {
    // RPCs often estimate a 0 tip, and a 0-tip transaction can wait many
    // minutes for a block (Privy's did, and timed out). Floor the tip, and
    // allow the base fee to double; only what's used is charged.
    const tip = (fees.maxPriorityFeePerGas ?? 0n) > MIN_TIP(chain) ? fees.maxPriorityFeePerGas! : MIN_TIP(chain);
    const baseFee = await c.getBlock().then((b) => b.baseFeePerGas ?? 0n).catch(() => fees.maxFeePerGas!);
    return { ...base, type: 2, maxFeePerGas: (baseFee * 2n + tip).toString(), maxPriorityFeePerGas: tip.toString() };
  }
  return { ...base, type: 0, gasPrice: (((await c.getGasPrice()) * 12n) / 10n).toString() };
}

// `signed` is what the wallet returned: the signed transaction, or (some
// wallets) only the 65-byte signature over `tx`. Checks the signer is `from`.
export async function evmBroadcast(p: { from: string; tx: Record<string, string | number>; signed: string }) {
  const chainId = Number(p.tx.chainId);
  const chain = evmChainOf(chainId);
  if (!chain) throw new Error("Unsupported network");
  let raw = p.signed as Hex;
  if (raw.length === 132) { // r,s,v only: put it on the transaction we prepared
    const t = p.tx;
    const unsigned: TransactionSerializable = {
      chainId, to: t.to as Hex, data: t.data as Hex, value: BigInt(t.value), nonce: Number(t.nonce), gas: BigInt(t.gas),
      ...(Number(t.type) === 2
        ? { type: "eip1559" as const, maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) }
        : { type: "legacy" as const, gasPrice: BigInt(t.gasPrice) }),
    };
    raw = serializeTransaction(unsigned, parseSignature(raw));
  }
  const parsed = parseTransaction(raw);
  if (parsed.chainId !== chainId) throw new Error("The signed transaction is for a different network.");
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
  if (signer.toLowerCase() !== p.from.toLowerCase()) throw new Error("The transaction wasn't signed by this wallet.");
  const c = clients[chain] as unknown as PublicClient;
  try {
    return await c.sendRawTransaction({ serializedTransaction: raw });
  } catch (err) {
    const m = (err as Error).message;
    throw new Error(/insufficient funds/i.test(m) ? `Not enough ${EVM_CHAINS[chain].native} for this plus gas.`
      : /nonce too low|already known/i.test(m) ? "That transaction was already sent. Check Activity before trying again."
      : `The network rejected it: ${m.split("\n")[0].slice(0, 160)}`);
  }
}

// What to keep back for the network fee when moving "Max" off a chain: a
// bridge deposit's gas (~120k, with headroom) at today's price, plus a small
// allowance for the L1 data fee on rollups. In the chain's native token.
export async function evmGasReserve(chain: string) {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  const gp = await (clients[chain] as unknown as PublicClient).getGasPrice();
  return Number(formatEther((gp * 120_000n * 15n) / 10n)) + (chain === "ethereum" ? 0 : 0.00002);
}

// For list-evm.ts.
export const evmPublicClient = (chain: string) => {
  if (!isTradable(chain)) throw new Error("Unsupported chain");
  return clients[chain] as unknown as PublicClient;
};
export { holds as evmHolds, osConduit };
