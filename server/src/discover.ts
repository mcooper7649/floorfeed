import { db } from "./db.ts";
import { EVM_CHAINS } from "./config.ts";
import { fromOsChain, getOsDrops, hasOsKey } from "./opensea.ts";
import { usdPrice } from "./prices.ts";
import { provenWallets, traders } from "./feed.ts";

// Collection holdings behind the discovery panel's Smart money and Following
// lists: which collections proven wallets (or the wallets a user follows)
// hold right now. "Holds" = bought in the window and not sold since; buys
// before the window aren't counted, since our trade history is partial.

const HOLD_DAYS = 30;

const openPositions = db.prepare(`
  SELECT b.collection, b.buyer AS wallet, COUNT(*) AS n
  FROM trades b
  WHERE b.block_time >= ?
    AND NOT EXISTS (SELECT 1 FROM trades s WHERE s.mint = b.mint AND s.seller = b.buyer AND s.block_time > b.block_time)
  GROUP BY b.collection, b.buyer`);

type Holding = { collection: string; wallet: string; n: number };

function byCollection(rows: Holding[], rank: (w: string) => number) {
  const out = new Map<string, { wallets: string[]; items: number }>();
  for (const r of rows) {
    const c = out.get(r.collection) ?? out.set(r.collection, { wallets: [], items: 0 }).get(r.collection)!;
    c.wallets.push(r.wallet);
    c.items += r.n;
  }
  const list = [...out.entries()].map(([symbol, c]) => ({ symbol, holders: c.wallets.length, items: c.items, wallets: c.wallets.sort((a, b) => rank(b) - rank(a)).slice(0, 3) }));
  list.sort((a, b) => b.holders - a.holders || b.items - a.items);
  const who = traders(list.flatMap((l) => l.wallets));
  return list.map((l) => ({
    ...l,
    wallets: l.wallets.map((w) => ({ wallet: w, name: who.get(w)?.name ?? null, avatar: who.get(w)?.avatar ?? null, tier: who.get(w)?.tier ?? null })),
  }));
}

let smartCache: { at: number; data: ReturnType<typeof byCollection> } | null = null;
let openCache: { at: number; rows: Holding[] } | null = null;

function holdings() {
  if (openCache && Date.now() - openCache.at < 5 * 60_000) return openCache.rows;
  const rows = openPositions.all(Math.floor(Date.now() / 1000) - HOLD_DAYS * 86_400) as Holding[];
  openCache = { at: Date.now(), rows };
  return rows;
}

export function smartMoney(limit = 40) {
  if (!smartCache || Date.now() - smartCache.at > 5 * 60_000) {
    const proven = provenWallets();
    smartCache = { at: Date.now(), data: byCollection(holdings().filter((r) => proven.has(r.wallet)), (w) => (proven.get(w) === "elite" ? 2 : 1)) };
  }
  return smartCache.data.slice(0, limit);
}

export function followingHoldings(wallets: Set<string>, limit = 40) {
  if (!wallets.size) return [];
  return byCollection(holdings().filter((r) => wallets.has(r.wallet)), () => 0).slice(0, limit);
}

// --- Minting: OpenSea drops, live and upcoming, across chains -------------------


export type Drop = {
  slug: string; name: string; chain: string; contract: string | null; image: string | null; url: string; minting: boolean; featured: boolean;
  stage: string | null; price: number | null; currency: string; priceUsd: number | null; startsAt: number | null; endsAt: number | null;
};
let dropCache: { at: number; data: Drop[] } | null = null;
async function loadDrops(): Promise<Drop[]> {
  const [featured, upcoming, recent] = await Promise.all(
    (["featured", "upcoming", "recently_minted"] as const).map((t) => getOsDrops(t, 30).catch(() => [])));
  const seen = new Set<string>();
  const out: Drop[] = [];
  for (const [list, src] of [[featured, "featured"], [upcoming, "upcoming"], [recent, "recent"]] as const) {
    for (const d of list) {
      if (seen.has(d.collection_slug)) continue;
      seen.add(d.collection_slug);
      const stage = d.active_stage ?? d.next_stage;
      const native = (EVM_CHAINS as Record<string, { native: string }>)[fromOsChain(d.chain)]?.native ?? "ETH";
      const price = stage?.price != null ? Number(BigInt(stage.price)) / 1e18 : null;
      const start = stage?.start_time ? Date.parse(stage.start_time) / 1000 : null;
      const end = d.active_stage?.end_time ? Date.parse(d.active_stage.end_time) / 1000 : null;
      out.push({
        slug: d.collection_slug, name: d.collection_name, chain: fromOsChain(d.chain), contract: d.contract_address?.toLowerCase() ?? null, image: d.image_url, url: d.opensea_url,
        minting: d.is_minting, featured: src === "featured",
        stage: stage?.label ?? stage?.stage_type ?? null, price, currency: native, priceUsd: price != null ? (usdPrice(native) ?? 0) * price || null : null,
        startsAt: start, endsAt: end,
      });
    }
  }
  // Live mints first (featured first), then upcoming by start time, then the rest.
  const now = Date.now() / 1000;
  const rank = (x: Drop) => (x.minting ? 0 : x.startsAt && x.startsAt > now ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || Number(b.featured) - Number(a.featured) || (a.startsAt ?? 0) - (b.startsAt ?? 0));
  return out;
}

export async function mintingDrops() {
  if (!hasOsKey()) return [];
  if (dropCache && Date.now() - dropCache.at < 10 * 60_000) return dropCache.data;
  const data = await loadDrops();
  dropCache = { at: Date.now(), data };
  return data;
}
