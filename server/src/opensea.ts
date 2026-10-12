// OpenSea API v2: collection stats + info (work keyless) and sale events
// (need OPENSEA_API_KEY, sent when present). The limit is 120 req/min; a
// 700ms gap stays under it.
const BASE = "https://api.opensea.io/api/v2";
const MIN_GAP_MS = 700;
let last = 0;
let chain: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

// Keyless access is intermittent: the same request can get 200 or a 401
// "missing API key", so 401/429 are retried a couple of times. Setting
// OPENSEA_API_KEY (free) makes this reliable.
async function get<T>(path: string, attempt = 0): Promise<T> {
  const res = await throttled(() =>
    fetch(BASE + path, {
      headers: {
        accept: "application/json",
        "user-agent": "FloorFeed/0.1 (+https://floorfeed.io)",
        ...(process.env.OPENSEA_API_KEY ? { "x-api-key": process.env.OPENSEA_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if ((res.status === 401 || res.status === 429) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenSea ${res.status} ${path}`);
  return (await res.json()) as T;
}

type Interval = { interval: string; volume: number; sales: number };

export async function getOsStats(slug: string) {
  const s = await get<{
    total: { floor_price?: number; floor_price_symbol?: string; num_owners?: number };
    intervals: Interval[];
  }>(`/collections/${slug}/stats`);
  const iv = (name: string) => s.intervals.find((i) => i.interval === name);
  return {
    floor: s.total.floor_price ?? null,
    currency: s.total.floor_price_symbol || "ETH",
    owners: s.total.num_owners ?? null,
    volume24h: iv("one_day")?.volume ?? null,
    sales24h: iv("one_day")?.sales ?? null,
    volume7d: iv("seven_day")?.volume ?? null,
    volume30d: iv("thirty_day")?.volume ?? null,
  };
}

export async function getOsInfo(slug: string) {
  const c = await get<{ image_url?: string; description?: string; total_supply?: number; opensea_url?: string }>(
    `/collections/${slug}`,
  );
  return {
    image: c.image_url || null,
    description: c.description || null,
    supply: c.total_supply ?? null,
    url: c.opensea_url ?? `https://opensea.io/collection/${slug}`,
  };
}

// Sales are kept only when paid in ETH or an ETH wrapper (WETH, Blur's BETH),
// so every EVM price and P&L is in ETH. Bundles/ERC-1155 lots are priced per unit.
const ETH_LIKE = new Set(["ETH", "WETH", "BETH"]);

export type OsSale = {
  signature: string; // tx:contract:tokenId (one tx can sell several NFTs)
  mint: string;      // contract:tokenId
  buyer: string;
  seller: string;
  price: number;
  blockTime: number;
  image: string | null;
  source: string;    // os:<payment symbol>; WETH sales are usually accepted bids
};

type OsEvent = {
  event_type: string;
  event_timestamp: number;
  transaction: string;
  buyer: string;
  seller: string;
  quantity: number;
  payment: { quantity: string; decimals: number; symbol: string } | null;
  nft: { identifier: string; contract: string; display_image_url?: string | null; image_url?: string | null } | null;
};

export const hasOsKey = () => !!process.env.OPENSEA_API_KEY;

// One page of sales, newest first. `after` (unix seconds) limits to newer ones.
export async function getOsSales(slug: string, opts: { after?: number; next?: string } = {}) {
  const q = new URLSearchParams({ event_type: "sale", limit: "50" });
  if (opts.after) q.set("after", String(opts.after));
  if (opts.next) q.set("next", opts.next);
  const r = await get<{ asset_events: OsEvent[]; next?: string | null }>(`/events/collection/${slug}?${q}`);
  const sales: OsSale[] = [];
  for (const e of r.asset_events) {
    if (e.event_type !== "sale" || !e.nft || !e.payment || !ETH_LIKE.has(e.payment.symbol)) continue;
    const qty = Math.max(1, e.quantity || 1);
    const price = Number(e.payment.quantity) / 10 ** e.payment.decimals / qty;
    if (!(price > 0)) continue;
    const mint = `${e.nft.contract}:${e.nft.identifier}`;
    sales.push({
      signature: `${e.transaction}:${mint}`,
      mint,
      buyer: e.buyer.toLowerCase(),
      seller: e.seller.toLowerCase(),
      price,
      blockTime: e.event_timestamp,
      image: e.nft.display_image_url || e.nft.image_url || null,
      source: `os:${e.payment.symbol}`,
    });
  }
  return { sales, next: r.next || null, oldest: r.asset_events.at(-1)?.event_timestamp ?? null };
}

// OpenSea's chain names; Polygon is "matic" in the API.
export const osChain = (chain: string) => (chain === "polygon" ? "matic" : chain);

type OsNft = {
  identifier: string; name: string | null; image_url?: string | null; display_image_url?: string | null;
  traits?: { trait_type: string; value: string | number }[] | null;
  owners?: { address: string; quantity: number }[] | null;
  rarity?: { rank?: number | null } | null;
  opensea_url?: string;
};
export async function getOsNft(chain: string, contract: string, id: string) {
  const r = await get<{ nft: OsNft }>(`/chain/${osChain(chain)}/contract/${contract}/nfts/${id}`);
  const n = r.nft;
  return {
    name: n.name || null,
    image: n.display_image_url || n.image_url || null,
    traits: (n.traits ?? []).map((t) => ({ type: t.trait_type, value: String(t.value) })),
    owner: n.owners?.[0]?.address?.toLowerCase() ?? null,
    rank: n.rarity?.rank ?? null,
    url: n.opensea_url ?? null,
  };
}

// Trait value counts across the collection: {type: {value: count}}.
export async function getOsTraits(slug: string) {
  const r = await get<{ counts: Record<string, Record<string, number>> }>(`/traits/${slug}`);
  return r.counts ?? {};
}

// Cheapest active listing for one NFT, in ETH (null when not listed).
export async function getOsBestListing(slug: string, id: string) {
  try {
    const r = await get<{ price?: { current?: { value: string; decimals: number; currency: string } }; order_hash?: string }>(
      `/listings/collection/${slug}/nfts/${id}/best`);
    const p = r.price?.current;
    if (!p || !["ETH", "WETH"].includes(p.currency)) return null;
    return { price: Number(p.value) / 10 ** p.decimals, orderHash: r.order_hash ?? null };
  } catch {
    return null; // 404 = not listed
  }
}
