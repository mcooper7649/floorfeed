import { createPublicClient, encodeFunctionData, formatEther, http, parseAbiItem, type Hex, type PublicClient } from "viem";
import { abstract, apeChain, arbitrum, base, hyperEvm, ink, mainnet, monad, ronin } from "viem/chains";
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
      boughtAt: (lastBuy.get(address, mint) as { price: number } | undefined)?.price ?? null,
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
    executable: tradable,
    reason: !listing ? `No ${unit} listing is live right now.`
      : !isTradable(chain) ? `Buying on ${chain} isn't supported yet.`
      : !nativePriced ? `This listing is priced in ${listing.currency}, which needs an extra approval. Finish it on OpenSea.`
      : null,
    marketUrl: listing ? `https://opensea.io/assets/${osAssetChain(chain)}/${listing.mint.replace(":", "/")}` : `https://opensea.io/collection/${symbol}`,
  };
}

// OpenSea gives the arguments as named objects in struct order; viem wants
// tuples as arrays in that same order.
const toArgs = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(toArgs) : v && typeof v === "object" ? Object.values(v).map(toArgs) : v;

export async function evmBuyTx(p: { orderHash: string; protocolAddress: string; chain: string; buyer: string }) {
  if (!isTradable(p.chain)) throw new Error(`Buying on ${p.chain} isn't supported yet.`);
  const tx = await getOsFulfillment(p.orderHash, p.chain, p.protocolAddress, p.buyer);
  const abi = parseAbiItem(`function ${tx.function}`) as ReturnType<typeof parseAbiItem> & { name: string };
  const data = encodeFunctionData({ abi: [abi], functionName: abi.name, args: toArgs(tx.input_data) as never });
  const value = BigInt(tx.value);
  // The chains' client types differ (Abstract is zkSync-based); the calls used here are common to all.
  const client = clients[p.chain] as unknown as PublicClient;
  // Dry run as the buyer: catches a listing that just sold, a short balance,
  // or a bad encoding before the wallet ever sees it.
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: p.buyer as Hex, to: tx.to as Hex, data, value });
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
