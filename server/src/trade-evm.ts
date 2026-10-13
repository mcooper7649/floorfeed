import { createPublicClient, encodeFunctionData, formatEther, http, parseAbiItem, type Hex } from "viem";
import { base, mainnet } from "viem/chains";
import { EVM_SALES, config } from "./config.ts";
import { db } from "./db.ts";
import { getOsAccountNfts, getOsBestListing, getOsBestListings, getOsFulfillment } from "./opensea.ts";

// Real buys on Ethereum and Base. FloorFeed never holds keys or funds: it
// asks OpenSea for the Seaport fill data of a listing, encodes it into a
// transaction, simulates it against the chain (so a stale listing or a short
// balance fails here, not in the wallet), and hands it to the user's wallet,
// which shows it and asks them to confirm.

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com", { timeout: 15_000 }) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com", { timeout: 15_000 }) }),
};
type EvmChain = keyof typeof clients;
const isTradable = (c: string): c is EvmChain => c === "ethereum" || c === "base";
const chainIds: Record<EvmChain, number> = { ethereum: 1, base: 8453 };

// --- balances and holdings ---

const balanceCache = new Map<string, { at: number; v: { ethereum: number; base: number } }>();
export async function evmBalances(address: string) {
  const key = address.toLowerCase();
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.v;
  const [e, b] = await Promise.all([
    clients.ethereum.getBalance({ address: address as Hex }).catch(() => 0n),
    clients.base.getBalance({ address: address as Hex }).catch(() => 0n),
  ]);
  const v = { ethereum: Number(formatEther(e)), base: Number(formatEther(b)) };
  balanceCache.set(key, { at: Date.now(), v });
  return v;
}

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
      name: n.name,
      image: n.image,
      collection: { symbol: n.collection, name: tracked.get(n.collection)!.name, floor },
      estValue: floor != null ? floor * (1 - config.paperSellHaircut) : null,
      boughtAt: (lastBuy.get(address, mint) as { price: number } | undefined)?.price ?? null,
    };
  }).sort((x, y) => (y.estValue ?? 0) - (x.estValue ?? 0));
  const eth = balances.ethereum + balances.base;
  const nftValue = nfts.reduce((t, n) => t + (n.estValue ?? 0), 0);
  return { address, eth, balances, nftValue, totalValue: eth + nftValue, nfts, untracked: all.length - nfts.length };
}

// --- quote and buy ---

const imageOf = db.prepare(`SELECT image FROM trades WHERE mint = ? AND image IS NOT NULL ORDER BY block_time DESC LIMIT 1`);

// The listing a buy would fill: one NFT's best listing (`id` = contract:tokenId)
// or the collection's cheapest.
export async function evmQuote(symbol: string, buyer: string | undefined, id: string | undefined) {
  const meta = EVM_SALES.find((c) => c.slug === symbol);
  if (!meta) return null;
  let listing: { mint: string; price: number; orderHash: string | null; protocolAddress: string | null; chain: string } | null = null;
  if (id) {
    const l = await getOsBestListing(symbol, id.split(":")[1] ?? "");
    if (l) listing = { mint: id, ...l };
  } else {
    listing = (await getOsBestListings(symbol, 5).catch(() => []))[0] ?? null;
  }
  const chain = (listing?.chain ?? meta.chain) as string;
  const tradable = isTradable(chain) && !!listing?.orderHash && !!listing?.protocolAddress;
  const balances = buyer ? await evmBalances(buyer).catch(() => null) : null;
  const floor = (floorOf.get(symbol) as { floor: number | null } | undefined)?.floor ?? null;
  return {
    collection: { symbol, name: meta.name, floor },
    chain,
    listing: listing && {
      ...listing,
      name: `${meta.name} #${listing.mint.split(":")[1]}`,
      image: (imageOf.get(listing.mint) as { image: string } | undefined)?.image ?? null,
    },
    balanceEth: balances && isTradable(chain) ? balances[chain] : null,
    executable: tradable,
    reason: !listing ? "No ETH listing is live right now." : !tradable ? `Buying on ${chain} isn't supported yet.` : null,
    marketUrl: listing ? `https://opensea.io/assets/${chain}/${listing.mint.replace(":", "/")}` : `https://opensea.io/collection/${symbol}`,
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
  const client = clients[p.chain];
  // Dry run as the buyer: catches a listing that just sold, a short balance,
  // or a bad encoding before the wallet ever sees it.
  let gas: bigint;
  try {
    gas = await client.estimateGas({ account: p.buyer as Hex, to: tx.to as Hex, data, value });
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(/insufficient funds/i.test(msg)
      ? "Not enough ETH in this wallet for the price plus gas."
      : "This listing can't be filled right now (it may have just sold). Try again for the next cheapest.");
  }
  const fees = await client.estimateFeesPerGas().catch(() => null);
  const gasCostEth = fees?.maxFeePerGas ? Number(formatEther(gas * fees.maxFeePerGas)) : null;
  return {
    chainId: chainIds[p.chain],
    to: tx.to,
    data,
    value: value.toString(),
    valueEth: Number(formatEther(value)),
    gas: ((gas * 12n) / 10n).toString(), // +20% headroom
    gasCostEth,
  };
}

