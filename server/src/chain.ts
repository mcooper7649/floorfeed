import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";

// Solana base58 address (32-byte public key).
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${body.error.message}`);
  return body.result as T;
}

// Balances are read often (every wallet render) and change rarely: 15s cache.
const balanceCache = new Map<string, { at: number; lamports: number }>();
export async function solBalance(address: string) {
  const hit = balanceCache.get(address);
  if (hit && Date.now() - hit.at < 15_000) return { lamports: hit.lamports, sol: hit.lamports / 1e9 };
  const { value } = await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
  balanceCache.set(address, { at: Date.now(), lamports: value });
  return { lamports: value, sol: value / 1e9 };
}

// What the client may offer. Buying needs at least one marketplace key.
export function capabilities() {
  const magiceden = Boolean(config.magicEdenApiKey);
  const tensor = Boolean(config.tensorApiKey);
  return {
    buy: { enabled: magiceden || tensor, magiceden, tensor },
    rpc: config.solanaRpcUrl.includes("mainnet-beta.solana.com") ? "public" : "custom",
  };
}

// --- Real holdings: the wallet's NFTs in tracked collections, via Helius DAS ---

export const hasDas = () => !config.solanaRpcUrl.includes("mainnet-beta.solana.com");

type DasAsset = {
  id: string;
  burnt?: boolean;
  grouping?: { group_key: string; group_value: string }[];
  content?: { metadata?: { name?: string }; links?: { image?: string } };
};

const collOf = (a: DasAsset) => a.grouping?.find((g) => g.group_key === "collection")?.group_value ?? null;

// On-chain collection address → our symbol, learned from a few recently
// traded mints per collection (one getAssetBatch call), refreshed daily.
let collMap: { at: number; map: Map<string, string> } | null = null;
async function collectionAddresses() {
  if (collMap && Date.now() - collMap.at < 86_400_000) return collMap.map;
  const rows = db.prepare(`
    SELECT collection, mint FROM (
      SELECT collection, mint, ROW_NUMBER() OVER (PARTITION BY collection ORDER BY block_time DESC) rn FROM trades
    ) WHERE rn <= 3`).all() as { collection: string; mint: string }[];
  const symbolOf = new Map(rows.map((r) => [r.mint, r.collection]));
  const assets = await rpc<(DasAsset | null)[]>("getAssetBatch", { ids: [...symbolOf.keys()] });
  const map = new Map<string, string>();
  for (const a of assets) {
    const addr = a && collOf(a);
    if (addr) map.set(addr, symbolOf.get(a.id)!);
  }
  collMap = { at: Date.now(), map };
  return map;
}

export type Holding = {
  mint: string;
  name: string | null;
  image: string | null;
  collection: { symbol: string; name: string; floor: number | null };
  estValue: number | null; // floor minus the sell haircut, like paper marks
  boughtAt: number | null; // last buy price we saw on-chain for this wallet
};

const holdingsCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof loadHoldings>> }>();
export async function holdings(owner: string) {
  const hit = holdingsCache.get(owner);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = await loadHoldings(owner);
  holdingsCache.set(owner, { at: Date.now(), data });
  return data;
}

async function loadHoldings(owner: string) {
  const assets: DasAsset[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await rpc<{ items: DasAsset[]; total: number }>("getAssetsByOwner", { ownerAddress: owner, page, limit: 1000 });
    assets.push(...r.items.filter((a) => !a.burnt));
    if (r.items.length < 1000) break;
  }
  const byAddress = await collectionAddresses();
  const mints = assets.map((a) => a.id);
  const placeholders = (n: number) => Array(n).fill("?").join(",");
  // Mints without a collection grouping are matched against sales we've seen.
  const seen = mints.length
    ? (db.prepare(`SELECT mint, collection FROM trades WHERE mint IN (${placeholders(mints.length)}) GROUP BY mint`)
        .all(...mints) as { mint: string; collection: string }[])
    : [];
  const seenColl = new Map(seen.map((r) => [r.mint, r.collection]));
  const buys = mints.length
    ? (db.prepare(`SELECT mint, price FROM trades WHERE buyer = ? AND mint IN (${placeholders(mints.length)}) ORDER BY block_time`)
        .all(owner, ...mints) as { mint: string; price: number }[])
    : [];
  const boughtAt = new Map(buys.map((b) => [b.mint, b.price])); // latest wins
  const floorOf = db.prepare("SELECT floor FROM collections WHERE symbol = ?");

  const nfts: Holding[] = [];
  for (const a of assets) {
    const addr = collOf(a);
    const symbol = (addr && byAddress.get(addr)) || seenColl.get(a.id);
    if (!symbol) continue;
    const floor = (floorOf.get(symbol) as { floor: number | null } | undefined)?.floor ?? null;
    nfts.push({
      mint: a.id,
      name: a.content?.metadata?.name ?? null,
      image: a.content?.links?.image ?? null,
      collection: { symbol, name: collectionName(symbol), floor },
      estValue: floor != null ? floor * (1 - config.paperSellHaircut) : null,
      boughtAt: boughtAt.get(a.id) ?? null,
    });
  }
  nfts.sort((x, y) => (y.estValue ?? 0) - (x.estValue ?? 0));
  const { sol } = await solBalance(owner);
  const nftValue = nfts.reduce((t, n) => t + (n.estValue ?? 0), 0);
  return { address: owner, sol, nftValue, totalValue: sol + nftValue, nfts, untracked: assets.length - nfts.length };
}
