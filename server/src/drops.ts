import { EVM_CHAINS } from "./config.ts";
import { fromOsChain, getOsDrop, getOsInfo, getOsMintTx, type OsStage } from "./opensea.ts";
import { evmBalances, isTradableChain, simulateEvm } from "./trade-evm.ts";
import { decodeFunctionData, formatEther, parseAbi } from "viem";

// One drop, for FloorFeed's own drop page, and minting it in-app. OpenSea
// (SeaDrop) has the stages and builds the mint transaction; FloorFeed
// simulates it as the minter and the wallet signs. Drops on chains FloorFeed
// can't send on yet still get the page, with the mint finishing on OpenSea.

const ZERO = "0x0000000000000000000000000000000000000000";
// Mints FloorFeed will pass to a wallet: SeaDrop's mintPublic for this drop's
// contract, minting to the payer. Anything else (an approval, a transfer, a
// different contract) is refused, whatever OpenSea returned.
const SEADROP = new Set(["0x00005ea00ac477b1030ce78506496e8c2de24bf5"]);
const SEADROP_ABI = parseAbi(["function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable"]);
function checkMint(tx: { to: string; data: string }, contract: string, minter: string, quantity: number) {
  const to = tx.to.toLowerCase();
  if (!SEADROP.has(to)) throw new Error("FloorFeed can't verify this mint. Finish it on OpenSea.");
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: SEADROP_ABI, data: tx.data as `0x${string}` }).args;
  } catch {
    throw new Error("FloorFeed can't verify this mint. Finish it on OpenSea.");
  }
  const [nft, , mintTo, qty] = args as [string, string, string, bigint];
  if (nft.toLowerCase() !== contract.toLowerCase()) throw new Error("OpenSea returned a mint for a different collection.");
  if (mintTo !== ZERO && mintTo.toLowerCase() !== minter.toLowerCase()) throw new Error("That mint would send the NFT to another wallet.");
  if (qty !== BigInt(quantity)) throw new Error("OpenSea returned a different quantity.");
}
// Chains OpenSea drops use that FloorFeed doesn't trade on (names for display).
const OTHER_CHAINS: Record<string, { name: string; native: string }> = {
  polygon: { name: "Polygon", native: "POL" },
  shape: { name: "Shape", native: "ETH" },
  zora: { name: "Zora", native: "ETH" },
  b3: { name: "B3", native: "ETH" },
};
const chainInfo = (c: string) => {
  const e = (EVM_CHAINS as Record<string, { name: string; native: string; explorer: string; id: number }>)[c];
  return e ? { name: e.name, native: e.native } : OTHER_CHAINS[c] ?? { name: c, native: "ETH" };
};

const cache = new Map<string, { at: number; v: Awaited<ReturnType<typeof load>> }>();
export async function dropDetail(slug: string, minter?: string) {
  const hit = cache.get(slug);
  const d = hit && Date.now() - hit.at < 60_000 ? hit.v : await load(slug);
  if (!hit || hit.v !== d) cache.set(slug, { at: Date.now(), v: d });
  const balance = minter && d.supported
    ? await evmBalances(minter).then((b) => (b as Record<string, number>)[d.chain] ?? null).catch(() => null)
    : null;
  return { ...d, balance };
}

async function load(slug: string) {
  const [raw, info] = await Promise.all([getOsDrop(slug), getOsInfo(slug).catch(() => null)]);
  const d = { ...raw, chain: fromOsChain(raw.chain) }; // OpenSea says ape_chain / matic
  const { name: chainName, native } = chainInfo(d.chain);
  const stage = (s: OsStage) => ({
    id: s.uuid ?? null,
    label: s.label ?? s.stage_type ?? "Stage",
    kind: s.stage_type ?? null, // public_sale | signed_presale | allowlist...
    // Native-token prices only; other currencies show but mint on OpenSea.
    price: s.price != null && (!s.price_currency_address || s.price_currency_address === ZERO) ? Number(formatEther(BigInt(s.price))) : null,
    nativePriced: !s.price_currency_address || s.price_currency_address === ZERO,
    startsAt: s.start_time ? Date.parse(s.start_time) / 1000 : null,
    endsAt: s.end_time ? Date.parse(s.end_time) / 1000 : null,
    maxPerWallet: s.max_per_wallet != null ? Number(s.max_per_wallet) : null,
    allowlist: s.stage_type !== "public_sale",
  });
  const stages = (d.stages ?? []).map(stage).sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  const active = d.active_stage ? stage(d.active_stage as OsStage) : null;
  const minted = d.total_supply != null ? Number(d.total_supply) : null;
  const max = d.max_supply != null ? Number(d.max_supply) : null;
  return {
    slug, name: d.collection_name, chain: d.chain, chainName, native,
    contract: d.contract_address, dropType: d.drop_type ?? null,
    image: d.image_url ?? info?.image ?? null, banner: info?.banner ?? null,
    description: info?.description ?? null, verified: info?.verified ?? false,
    website: info?.website ?? null, twitter: info?.twitter ?? null, discord: info?.discord ?? null,
    minting: d.is_minting, active, next: d.next_stage ? stage(d.next_stage as OsStage) : null, stages,
    minted, max, soldOut: minted != null && max != null && max > 0 && minted >= max,
    creatorFeeBps: d.fee_bps ?? null,
    supported: isTradableChain(d.chain),
    url: d.opensea_url,
  };
}

export async function dropMintTx(p: { slug: string; minter: string; quantity: number }) {
  const d = await load(p.slug);
  if (!d.supported) throw new Error(`Minting on ${d.chainName} isn't available in FloorFeed yet. Finish it on OpenSea.`);
  if (!d.minting) throw new Error("This drop isn't minting right now.");
  const tx = await getOsMintTx(p.slug, p.minter, p.quantity).catch((err: Error) => {
    const m = err.message;
    throw new Error(/insufficient balance/i.test(m) ? `Not enough ${d.native} on ${d.chainName} to mint ${p.quantity}.`
      : /not eligible|allowlist|not allowed/i.test(m) ? "This wallet isn't on the list for the current stage."
      : /max|limit/i.test(m) ? `That's more than this wallet can mint in the current stage.` : m);
  });
  if (fromOsChain(tx.chain) !== d.chain) throw new Error("OpenSea returned a mint for a different network.");
  checkMint(tx, d.contract, p.minter, p.quantity);
  const value = BigInt(tx.value);
  let gas: bigint;
  try {
    gas = await simulateEvm(d.chain, { from: p.minter, to: tx.to, data: tx.data, value });
  } catch (err) {
    throw new Error(/insufficient funds/i.test((err as Error).message)
      ? `Not enough ${d.native} on ${d.chainName} for the mint plus gas.`
      : "The mint would fail right now (the stage may have ended or sold out).");
  }
  const info = EVM_CHAINS[d.chain as keyof typeof EVM_CHAINS];
  return {
    chainId: info.id, explorerTx: `${info.explorer}/tx/`,
    to: tx.to, data: tx.data, value: tx.value, gas: ((gas * 12n) / 10n).toString(),
    total: Number(formatEther(value)), unit: d.native,
  };
}
