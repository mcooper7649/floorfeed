import { rpc } from "./chain.ts";
import { COLLECTIONS, EVM_CHAINS, EVM_COLLECTIONS, chainOf, collectionName, currencyOf, isEvm } from "./config.ts";
import { db } from "./db.ts";
import { traders } from "./feed.ts";
import { getTokenListing } from "./magiceden.ts";
import { getOsBestListing, getOsNft, getOsTraits, hasOsKey } from "./opensea.ts";

// NFT detail pages: one item's traits with how rare each is, a rarity rank,
// the current owner, an active listing and every sale of it we've tracked.
//
// Rarity. EVM ranks come from OpenSea (OpenRarity). Solana marketplaces only
// rank listed items, so FloorFeed ranks every item itself: Helius DAS lists a
// whole collection with its traits (1,000 per call), and each item scores the
// information content of its traits, sum(-log2(share of the collection with
// that value)), with a missing trait counted as the value "None". Higher
// score = rarer = better rank. The same idea as OpenRarity, without its
// trait-count normalisation.

const DAY_MS = 86_400_000;
const RARITY_TTL = 7 * DAY_MS;
const MAX_PAGES = 30; // 30k items; every tracked collection is well under

type Attr = { type: string; value: string };
type Counts = Record<string, Record<string, number>>;

type DasItem = {
  id: string;
  burnt?: boolean;
  grouping?: { group_key: string; group_value: string }[];
  creators?: { address: string; verified: boolean }[];
  content?: { metadata?: { name?: string; attributes?: { trait_type?: string; value?: unknown }[] }; links?: { image?: string } };
  ownership?: { owner?: string };
};

const attrsOf = (a: DasItem): Attr[] =>
  (a.content?.metadata?.attributes ?? [])
    .filter((t) => t && t.trait_type != null && t.value != null && String(t.value) !== "")
    .map((t) => ({ type: String(t.trait_type), value: String(t.value) }));

const traitsRow = db.prepare(`SELECT total, counts, computed_at AS at FROM collection_traits WHERE symbol = ?`);
const saveTraits = db.prepare(`
  INSERT INTO collection_traits (symbol, total, counts, computed_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET total = excluded.total, counts = excluded.counts, computed_at = excluded.computed_at`);

function storedTraits(symbol: string) {
  const r = traitsRow.get(symbol) as { total: number; counts: string; at: number } | undefined;
  return r ? { total: r.total, counts: JSON.parse(r.counts) as Counts, at: r.at } : null;
}

// --- Solana: fetch the whole collection once a week and rank it ---

async function groupFor(symbol: string): Promise<{ key: "collection" | "creator"; value: string } | null> {
  const mint = (db.prepare(`SELECT mint FROM trades WHERE collection = ? ORDER BY block_time DESC LIMIT 1`).get(symbol) as
    { mint: string } | undefined)?.mint;
  if (!mint) return null;
  const a = await rpc<DasItem>("getAsset", { id: mint });
  const coll = a.grouping?.find((g) => g.group_key === "collection")?.group_value;
  if (coll) return { key: "collection", value: coll };
  // Older collections without an on-chain collection: their first verified creator.
  const creator = a.creators?.find((c) => c.verified)?.address;
  return creator ? { key: "creator", value: creator } : null;
}

async function fetchCollection(group: { key: "collection" | "creator"; value: string }) {
  const items: DasItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = group.key === "collection"
      ? await rpc<{ items: DasItem[] }>("getAssetsByGroup", { groupKey: "collection", groupValue: group.value, page, limit: 1000 })
      : await rpc<{ items: DasItem[] }>("getAssetsByCreator", { creatorAddress: group.value, onlyVerified: true, page, limit: 1000 });
    items.push(...r.items.filter((a) => !a.burnt));
    if (r.items.length < 1000) break;
  }
  return items;
}

const clearItems = db.prepare(`DELETE FROM nft_items WHERE collection = ?`);
const insertItem = db.prepare(
  `INSERT OR REPLACE INTO nft_items (mint, collection, name, image, attrs, score, rank) VALUES (?, ?, ?, ?, ?, ?, ?)`);

async function computeSolanaRarity(symbol: string) {
  const group = await groupFor(symbol);
  if (!group) return false;
  const items = (await fetchCollection(group)).map((a) => ({ a, attrs: attrsOf(a) }));
  const withTraits = items.filter((x) => x.attrs.length);
  if (withTraits.length < 10) return false; // no usable trait metadata
  const n = withTraits.length;
  const types = [...new Set(withTraits.flatMap((x) => x.attrs.map((t) => t.type)))];
  const counts: Counts = {};
  for (const t of types) counts[t] = {};
  for (const { attrs } of withTraits) {
    for (const t of types) {
      const v = attrs.find((x) => x.type === t)?.value ?? "None";
      counts[t][v] = (counts[t][v] ?? 0) + 1;
    }
  }
  const scored = withTraits.map((x) => ({
    ...x,
    score: types.reduce((s, t) => s - Math.log2(counts[t][x.attrs.find((y) => y.type === t)?.value ?? "None"] / n), 0),
  })).sort((p, q) => q.score - p.score);
  db.transaction(() => {
    clearItems.run(symbol);
    scored.forEach((x, i) => insertItem.run(
      x.a.id, symbol, x.a.content?.metadata?.name ?? null, x.a.content?.links?.image ?? null,
      JSON.stringify(x.attrs), x.score, i + 1));
    saveTraits.run(symbol, n, JSON.stringify(counts), Date.now());
  })();
  console.log(`[rarity] ${symbol}: ranked ${n} items`);
  return true;
}

const inflight = new Map<string, Promise<boolean>>();
function ensureSolanaRarity(symbol: string) {
  const t = storedTraits(symbol);
  if (t && Date.now() - t.at < RARITY_TTL) return Promise.resolve(true);
  let p = inflight.get(symbol);
  if (!p) {
    p = computeSolanaRarity(symbol)
      .catch((err) => { console.warn(`[rarity] ${symbol}:`, (err as Error).message); return false; })
      .finally(() => inflight.delete(symbol));
    inflight.set(symbol, p);
  }
  return p;
}

// Warm every Solana collection in the background, one at a time.
export async function warmRarity(symbols: string[]) {
  for (const s of symbols) await ensureSolanaRarity(s);
}

// --- EVM: OpenSea trait counts, cached a day ---

async function evmTraits(slug: string) {
  const t = storedTraits(slug);
  if (t && Date.now() - t.at < DAY_MS) return t;
  try {
    const counts = await getOsTraits(slug);
    const supply = (db.prepare(`SELECT supply FROM collections WHERE symbol = ?`).get(slug) as { supply: number | null } | undefined)?.supply;
    // Without a supply, the biggest trait category's total is the best estimate.
    const total = supply || Math.max(0, ...Object.values(counts).map((vs) => Object.values(vs).reduce((a, b) => a + b, 0)));
    saveTraits.run(slug, total, JSON.stringify(counts), Date.now());
    return { total, counts, at: Date.now() };
  } catch {
    return t;
  }
}

// --- the item endpoint ---

const itemRow = db.prepare(`SELECT name, image, attrs, rank FROM nft_items WHERE mint = ?`);
const salesOf = db.prepare(
  `SELECT signature, buyer, seller, price, block_time AS t, image FROM trades WHERE mint = ? ORDER BY block_time DESC LIMIT 50`);
const collRow = db.prepare(`SELECT floor, image FROM collections WHERE symbol = ?`);

// Owners and listings change; short caches keep repeat views off the APIs.
const live = new Map<string, { at: number; data: unknown }>();
async function cachedLive<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = live.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await fn();
  if (live.size > 2000) live.clear();
  live.set(key, { at: Date.now(), data });
  return data;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export async function itemDetail(symbol: string, id: string) {
  const evm = isEvm(symbol);
  if (!evm && !COLLECTIONS.some((c) => c.symbol === symbol)) return null;
  const chain = chainOf(symbol);
  const currency = currencyOf(symbol);
  const coll = (collRow.get(symbol) as { floor: number | null; image: string | null } | undefined) ?? { floor: null, image: null };

  let name: string | null = null;
  let image: string | null = null;
  let attrs: Attr[] = [];
  let owner: string | null = null;
  let rank: number | null = null;
  let total: number | null = null;
  let counts: Counts = {};
  let rarityPending = false;
  let listing: { price: number; url: string } | null = null;
  let marketUrl: string;

  if (evm) {
    if (!hasOsKey()) return null;
    const [contract, tokenId] = id.split(":");
    if (!contract || !tokenId) return null;
    const [nft, traits, best] = await Promise.all([
      cachedLive(`os:${id}`, 5 * 60_000, () => getOsNft(chain, contract, tokenId)),
      evmTraits(symbol),
      withTimeout(cachedLive(`osl:${id}`, 2 * 60_000, () => getOsBestListing(symbol, tokenId)), 6000, null),
    ]);
    ({ name, image, owner, rank } = nft);
    attrs = nft.traits;
    if (traits) ({ total, counts } = traits);
    marketUrl = nft.url ?? `https://opensea.io/assets/${chain}/${contract}/${tokenId}`;
    if (best) listing = { price: best.price, url: marketUrl };
  } else {
    // Rank from our table; kick off (and briefly wait for) the weekly compute.
    const ready = await withTimeout(ensureSolanaRarity(symbol), 8000, false);
    const row = itemRow.get(id) as { name: string | null; image: string | null; attrs: string; rank: number } | undefined;
    const t = storedTraits(symbol);
    if (t) ({ total, counts } = t);
    rarityPending = !ready && !t;
    const asset = await cachedLive(`das:${id}`, 60_000, () => rpc<DasItem>("getAsset", { id }));
    name = row?.name ?? asset.content?.metadata?.name ?? null;
    image = row?.image ?? asset.content?.links?.image ?? null;
    attrs = row ? JSON.parse(row.attrs) : attrsOf(asset);
    rank = row?.rank ?? null;
    owner = asset.ownership?.owner ?? null;
    marketUrl = `https://magiceden.io/item-details/${id}`;
    const l = await withTimeout(cachedLive(`mel:${id}`, 2 * 60_000, () => getTokenListing(id)), 5000, null);
    if (l) listing = { price: l.price, url: marketUrl };
  }

  // Each trait with its share of the collection, rarest first.
  const traits = attrs.map((t) => {
    const count = counts[t.type]?.[t.value] ?? null;
    return { type: t.type, value: t.value, count, pct: count != null && total ? (count / total) * 100 : null };
  }).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));

  const sales = salesOf.all(id) as { signature: string; buyer: string; seller: string; price: number; t: number; image: string | null }[];
  const ids = traders([...sales.flatMap((s) => [s.buyer, s.seller]), ...(owner ? [owner] : [])]);
  // A sale whose seller bought this NFT earlier in our history is a flip.
  const asc = [...sales].reverse();
  const history = sales.map((s) => {
    const prev = asc.filter((p) => p.t < s.t && p.buyer === s.seller).pop();
    return {
      signature: s.signature, price: s.price, t: s.t,
      buyer: s.buyer, buyerName: ids.get(s.buyer)?.name ?? null,
      seller: s.seller, sellerName: ids.get(s.seller)?.name ?? null,
      flipPnl: prev ? s.price - prev.price : null,
    };
  });
  if (!image) image = sales.find((s) => s.image)?.image ?? null;

  const evmMeta = EVM_COLLECTIONS.find((c) => c.slug === symbol);
  return {
    symbol, id, chain, currency,
    collection: { symbol, name: evmMeta?.name ?? collectionName(symbol), floor: coll.floor, image: coll.image },
    name, image,
    owner: owner ? { wallet: owner, name: ids.get(owner)?.name ?? null, tier: ids.get(owner)?.tier ?? null } : null,
    rarity: rank != null ? { rank, total, source: evm ? "OpenSea (OpenRarity)" : "FloorFeed" } : null,
    rarityPending,
    traits,
    listing,
    lastSale: history[0] ? { price: history[0].price, t: history[0].t } : null,
    history,
    marketUrl,
    explorerUrl: evm
      ? `${EVM_CHAINS[chain as keyof typeof EVM_CHAINS]?.explorer ?? "https://etherscan.io"}/nft/${id.replace(":", "/")}`
      : `https://solscan.io/token/${id}`,
  };
}
