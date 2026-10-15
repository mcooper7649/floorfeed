import { normalizeUnit, type Unit } from "./config.ts";
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await throttled(() =>
    fetch(BASE + path, {
      method: "POST",
      headers: {
        accept: "application/json", "content-type": "application/json",
        "user-agent": "FloorFeed/0.1 (+https://floorfeed.io)",
        ...(process.env.OPENSEA_API_KEY ? { "x-api-key": process.env.OPENSEA_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  const json = (await res.json().catch(() => ({}))) as T & { errors?: string[] };
  if (!res.ok) throw new Error(json.errors?.join("; ") || `OpenSea ${res.status} ${path}`);
  return json;
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
  const c = await get<{
    image_url?: string; description?: string; total_supply?: number; opensea_url?: string;
    fees?: { fee: number; required: boolean }[];
    project_url?: string; twitter_username?: string; discord_url?: string;
    contracts?: { address: string; chain: string }[];
    created_date?: string;
    banner_image_url?: string; safelist_status?: string;
  }>(`/collections/${slug}`);
  return {
    // Fees a seller can't avoid (OpenSea's own plus enforced creator fees), in basis points.
    website: c.project_url || null,
    twitter: c.twitter_username || null,
    discord: c.discord_url || null,
    contract: c.contracts?.[0]?.address?.toLowerCase() ?? null,
    created: c.created_date || null, // YYYY-MM-DD
    feeBps: c.fees ? Math.round(c.fees.filter((f) => f.required).reduce((a, f) => a + f.fee, 0) * 100) : null,
    image: c.image_url || null,
    description: c.description || null,
    supply: c.total_supply ?? null,
    url: c.opensea_url ?? `https://opensea.io/collection/${slug}`,
    banner: c.banner_image_url || null,
    verified: c.safelist_status === "verified" || c.safelist_status === "approved",
  };
}

// Sales are kept when paid in a currency FloorFeed tracks (ETH and its
// wrappers, HYPE, RON, APE, MON); ingest then keeps each collection to one of
// them. Bundles/ERC-1155 lots are priced per unit.

export type OsSale = {
  signature: string; // tx:contract:tokenId (one tx can sell several NFTs)
  mint: string;      // contract:tokenId
  buyer: string;
  seller: string;
  price: number;
  blockTime: number;
  image: string | null;
  source: string;    // os:<payment symbol>; WETH sales are usually accepted bids
  unit: Unit;        // payment currency, wrappers folded in (WETH → ETH)
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
    const unit = normalizeUnit(e.payment?.symbol);
    if (e.event_type !== "sale" || !e.nft || !e.payment || !unit) continue;
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
      unit,
    });
  }
  return { sales, next: r.next || null, oldest: r.asset_events.at(-1)?.event_timestamp ?? null };
}

// OpenSea's chain names; Polygon is "matic" in the API.
export const osChain = (chain: string) => (chain === "polygon" ? "matic" : chain === "apechain" ? "ape_chain" : chain);
// And back: OpenSea's names in responses to ours.
export const fromOsChain = (chain: string) => (chain === "matic" ? "polygon" : chain === "ape_chain" ? "apechain" : chain);

type OsNft = {
  identifier: string; collection?: string; name: string | null; image_url?: string | null; display_image_url?: string | null;
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
    collection: n.collection ?? null,
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
    const r = await get<{
      price?: { current?: { value: string; decimals: number; currency: string } };
      order_hash?: string; protocol_address?: string; chain?: string;
    }>(`/listings/collection/${slug}/nfts/${id}/best`);
    const p = r.price?.current;
    if (!p || !normalizeUnit(p.currency)) return null;
    return {
      price: Number(p.value) / 10 ** p.decimals, currency: p.currency, orderHash: r.order_hash ?? null,
      protocolAddress: r.protocol_address ?? null, chain: fromOsChain(r.chain ?? "ethereum"),
    };
  } catch {
    return null; // 404 = not listed
  }
}

// Cheapest active listings for a collection, in ETH, ascending.
export async function getOsBestListings(slug: string, limit = 20) {
  const r = await get<{ listings: {
    order_hash: string;
    chain?: string;
    protocol_address?: string;
    price?: { current?: { value: string; decimals: number; currency: string } };
    protocol_data?: { parameters?: { offer?: { token: string; identifierOrCriteria: string }[] } };
  }[] }>(`/listings/collection/${slug}/best?limit=${limit}`);
  return r.listings.flatMap((l) => {
    const p = l.price?.current;
    const o = l.protocol_data?.parameters?.offer?.[0];
    if (!p || !o || !normalizeUnit(p.currency)) return [];
    return [{
      mint: `${o.token.toLowerCase()}:${o.identifierOrCriteria}`, price: Number(p.value) / 10 ** p.decimals,
      currency: p.currency, // as listed: ETH vs WETH matters for buying (wrapped tokens need an approval)
      orderHash: l.order_hash, protocolAddress: l.protocol_address ?? null, chain: fromOsChain(l.chain ?? "ethereum"),
    }];
  }).sort((a, b) => a.price - b.price);
}

// A wallet's NFTs on one chain (up to `pages` x 200).
// 100 per page: OpenSea answers limit=200 with an empty list on some chains
// (Ink, 2026-10-14) while 100-199 work, so stay well under it.
export async function getOsAccountNfts(chain: string, address: string, pages = 6) {
  const out: { collection: string; contract: string; identifier: string; name: string | null; image: string | null }[] = [];
  let next: string | undefined;
  for (let i = 0; i < pages; i++) {
    // OpenSea's CDN caches this by exact URL for minutes, so a wallet that just
    // bought showed its old (empty) list. A 30s bucket keeps every read fresh
    // enough while still letting repeat reads share one fetch.
    const q = new URLSearchParams({ limit: "100", cb: String(Math.floor(Date.now() / 5_000)) }); // past OpenSea's URL cache
    if (next) q.set("next", next);
    const r = await get<{ nfts: { collection: string; contract: string; identifier: string; name?: string | null;
      display_image_url?: string | null; image_url?: string | null }[]; next?: string | null }>(
      `/chain/${osChain(chain)}/account/${address}/nfts?${q}`);
    for (const n of r.nfts) {
      out.push({ collection: n.collection, contract: n.contract.toLowerCase(), identifier: n.identifier,
        name: n.name ?? null, image: n.display_image_url || n.image_url || null });
    }
    if (!r.next) break;
    next = r.next;
  }
  return out;
}

// Seaport fill data for a listing, for `fulfiller` to send. OpenSea returns the
// function signature and its arguments decoded; trade-evm.ts encodes them.
export async function getOsFulfillment(orderHash: string, chain: string, protocolAddress: string, fulfiller: string) {
  const r = await post<{ fulfillment_data?: { transaction?: {
    function: string; chain: number; to: string; value: string | number; input_data: Record<string, unknown>;
  } } }>("/listings/fulfillment_data", {
    listing: { hash: orderHash, chain: osChain(chain), protocol_address: protocolAddress },
    fulfiller: { address: fulfiller },
  });
  const tx = r.fulfillment_data?.transaction;
  if (!tx) throw new Error("OpenSea returned no transaction for this listing");
  return tx;
}

// Top collections on a chain by 7-day volume (metadata only; no prices).
// The best offer a holder could accept for one NFT right now: an item,
// trait or collection offer, whichever pays most. `net` is what the seller
// receives: the offer minus the fee and royalty items the offer's own
// consideration pays out of it.
export async function getOsBestOffer(slug: string, id: string) {
  try {
    const r = await get<{
      order_hash?: string; chain?: string; protocol_address?: string; status?: string;
      price?: { value: string; decimals: number; currency: string };
      criteria?: { traits?: { type: string; value: string }[] | null } | null;
      protocol_data?: { parameters?: {
        offer?: { token: string; startAmount: string }[];
        consideration?: { itemType: number; token: string; startAmount: string }[];
        endTime?: string;
        conduitKey?: string;
      } };
    }>(`/offers/collection/${slug}/nfts/${id}/best`);
    const p = r.price;
    const params = r.protocol_data?.parameters;
    if (!p || !r.order_hash || !r.protocol_address || !params?.offer?.length) return null;
    const token = params.offer[0].token.toLowerCase();
    const gross = BigInt(params.offer[0].startAmount);
    // ERC-20 items (itemType 1) in the offer's token go to fees and royalties.
    const fees = (params.consideration ?? [])
      .filter((c) => c.itemType === 1 && c.token.toLowerCase() === token)
      .reduce((a, c) => a + BigInt(c.startAmount), 0n);
    const scale = 10 ** p.decimals;
    return {
      price: Number(p.value) / scale,
      net: Number(gross - fees) / scale,
      currency: p.currency,
      orderHash: r.order_hash,
      protocolAddress: r.protocol_address,
      chain: fromOsChain(r.chain ?? "ethereum"),
      kind: r.criteria?.traits?.length ? "trait" as const : r.criteria ? "collection" as const : "item" as const,
      expiresAt: params.endTime ? Number(params.endTime) : null,
      // Which conduit moves the NFT. OpenSea's key differs by chain (Ink has its own).
      conduitKey: params.conduitKey ?? null,
    };
  } catch {
    return null; // 404 = no offers
  }
}

// Seaport fill data for accepting an offer with one specific NFT. Trait and
// collection offers need the token named so OpenSea can add the criteria proof.
export async function getOsOfferFulfillment(p: {
  orderHash: string; chain: string; protocolAddress: string; fulfiller: string; contract: string; tokenId: string;
}) {
  const r = await post<{ fulfillment_data?: { transaction?: {
    function: string; chain: number; to: string; value: string | number; input_data: Record<string, unknown>;
    calldata_suffix?: string;
  } } }>("/offers/fulfillment_data", {
    offer: { hash: p.orderHash, chain: osChain(p.chain), protocol_address: p.protocolAddress },
    fulfiller: { address: p.fulfiller },
    consideration: { asset_contract_address: p.contract, token_id: p.tokenId },
  });
  const tx = r.fulfillment_data?.transaction;
  if (!tx) throw new Error("OpenSea returned no transaction for this offer");
  return tx;
}

export async function getOsTopCollections(chain: string, limit = 25) {
  const r = await get<{ collections: {
    collection: string; name: string; category?: string | null; is_disabled?: boolean; is_nsfw?: boolean;
  }[] }>(`/collections?chain=${osChain(chain)}&order_by=seven_day_volume&limit=${limit}`);
  return r.collections;
}

export async function getOsWeek(slug: string) {
  const s = await get<{ total: { floor_price?: number; floor_price_symbol?: string }; intervals: Interval[] }>(`/collections/${slug}/stats`);
  const week = s.intervals.find((i) => i.interval === "seven_day");
  return { floor: s.total.floor_price ?? null, symbol: s.total.floor_price_symbol || "", sales7d: week?.sales ?? 0, volume7d: week?.volume ?? 0 };
}

// --- Drops (mints): featured, upcoming and recently minted, across chains ---

type OsDrop = {
  collection_slug: string; collection_name: string; chain: string; contract_address: string; is_minting: boolean;
  image_url: string | null; opensea_url: string;
  active_stage: { label?: string; stage_type?: string; price?: string; start_time?: string; end_time?: string } | null;
  next_stage: { label?: string; stage_type?: string; price?: string; start_time?: string } | null;
};
export type OsStage = {
  uuid?: string; stage_type?: string; label?: string; price?: string; price_currency_address?: string;
  start_time?: string; end_time?: string; max_per_wallet?: string; allowlist_wallet_count?: number | null;
};
export async function getOsDrop(slug: string) {
  return get<OsDrop & { drop_type?: string; stages?: OsStage[]; total_supply?: string; max_supply?: string; fee_bps?: number }>(
    `/drops/${encodeURIComponent(slug)}`);
}
// A ready-to-sign mint for `minter` (OpenSea checks stage eligibility and balance).
export async function getOsMintTx(slug: string, minter: string, quantity: number) {
  return post<{ to: string; data: string; value: string; chain: string }>(
    `/drops/${encodeURIComponent(slug)}/mint`, { minter, quantity });
}
export async function getOsDrops(type: "featured" | "upcoming" | "recently_minted", limit = 30) {
  const r = await get<{ drops: OsDrop[] }>(`/drops?type=${type}&limit=${limit}`);
  return r.drops ?? [];
}

// --- listing (list-evm.ts) ---

// A collection's fees as OpenSea charges them on a listing: its own fee plus
// creator fees, each with whether it's required. Percent, e.g. 1 = 1%.
export async function getOsFees(slug: string) {
  const c = await get<{ fees?: { fee: number; recipient: string; required: boolean }[]; required_zone?: string | null }>(`/collections/${slug}`);
  return { fees: c.fees ?? [], requiredZone: c.required_zone ?? null };
}

export async function postOsListing(chain: string, body: unknown) {
  return post<{ order?: { order_hash?: string } }>(`/orders/${osChain(chain)}/seaport/listings`, body);
}

type OsOrderItem = { itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient?: string };
export type OsOrderParams = {
  offerer: string; zone: string; offer: OsOrderItem[]; consideration: OsOrderItem[]; orderType: number;
  startTime: string; endTime: string; zoneHash: string; salt: string; conduitKey: string; counter: string | number;
  totalOriginalConsiderationItems?: number;
};
// This wallet's live OpenSea listings (all chains, or one), newest first, with
// their Seaport parameters. The account endpoint gives hash/price/NFT only, so
// each order is then fetched for its parameters (zone, expiry, for cancels).
const SEAPORTS = ["0x0000000000000068F116a894984e2DB1123eB395", "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"]; // 1.6, 1.5
type OsFullOrder = { order_hash: string; protocol_address: string; status?: string; remaining_quantity?: number; protocol_data: { parameters: OsOrderParams } };
// An order's parameters never change, so they're kept once fetched (status comes from
// the account list; `fresh` re-reads it, e.g. before a cancel).
const orderCache = new Map<string, OsFullOrder>();
export async function getOsOrder(chain: string, hash: string, fresh = false) {
  const hit = fresh ? null : orderCache.get(hash);
  if (hit) return hit;
  for (const p of SEAPORTS) {
    const r = await get<{ order?: OsFullOrder }>(`/orders/chain/${osChain(chain)}/protocol/${p}/${hash}`).catch(() => null);
    if (r?.order?.protocol_data?.parameters) {
      if (orderCache.size > 2_000) orderCache.clear();
      orderCache.set(hash, r.order);
      return r.order;
    }
  }
  return null;
}
export async function getOsMyListings(chain: string | null, maker: string) {
  const q = new URLSearchParams({ limit: "100", cb: String(Math.floor(Date.now() / 5_000)) }); // past OpenSea's URL cache
  const r = await get<{ listings?: {
    order_hash: string; chain: string; asset?: { identifier: string; contract: string }; status?: string; order_created_at?: number;
    price?: { current?: { currency: string; decimals: number; value: string } };
  }[] }>(`/account/${maker}/listings?${q}`);
  const live = (r.listings ?? []).filter((l) => (l.status ?? "ACTIVE") === "ACTIVE" && l.asset && (!chain || fromOsChain(l.chain) === chain));
  const out = await Promise.all(live.slice(0, 40).map(async (l) => {
    const o = await getOsOrder(l.chain, l.order_hash);
    if (!o) return null;
    return {
      chain: fromOsChain(l.chain),
      mint: `${l.asset!.contract.toLowerCase()}:${l.asset!.identifier}`,
      orderHash: l.order_hash, protocolAddress: o.protocol_address,
      priceWei: l.price?.current?.value ?? "0", currency: l.price?.current?.currency ?? "ETH",
      expiresAt: Number(o.protocol_data.parameters.endTime), listedAt: l.order_created_at ?? Number(o.protocol_data.parameters.startTime),
      parameters: o.protocol_data.parameters,
    };
  }));
  return out.filter((x) => x !== null).sort((a, b) => b.listedAt - a.listedAt);
}

export async function cancelOsOrder(chain: string, protocolAddress: string, orderHash: string, offererSignature: string) {
  return post<{ last_signature_issued_valid_until?: string | null }>(
    `/orders/chain/${osChain(chain)}/protocol/${protocolAddress}/${orderHash}/cancel`, { offererSignature });
}
