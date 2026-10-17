import { EVM_CHAINS, EVM_COLLECTIONS, knownNames, normalizeUnit, syncEvmLists, type Category, type Chain, type EvmCollection } from "./config.ts";
import { db } from "./db.ts";
import { fromOsChain, getOsCollectionMeta, getOsDrops, getOsTopCollections, getOsWeek, hasOsKey } from "./opensea.ts";
import { refreshPrices, toUsd, usdPrice } from "./prices.ts";

// Keeps each EVM chain's busiest collections in FloorFeed automatically,
// instead of a hand-maintained list. Once a day, per chain: OpenSea's top 25
// by 7-day volume, minus disabled/NSFW/DeFi position "collections", minus
// anything not priced in one of the chain's currencies (EVM_CHAINS.units) or
// with fewer than 15 sales that week or a floor under $5; the first
// N survivors are kept. A collection that drops out stays for 7 days so its
// pages and history don't vanish overnight. The list is stored, so restarts
// come back with it immediately.

const DAY_MS = 86_400_000;
const KEEP_MS = 7 * DAY_MS;
const MIN_SALES_7D = 15;
// Floors under $5 are mostly game consumables and dust (Axie items at a
// fraction of a cent, tens of thousands of sales a week): they flood the feed.
const MIN_FLOOR_USD = 5;
const SKIP_CATEGORIES = new Set(["LIQUIDITY_POSITIONS"]);

const CATEGORY: Record<string, Category> = {
  PFPS: "PFP", ART: "Art", PHOTOGRAPHY: "Art", MUSIC: "Art", GAMING: "Gaming", VIRTUAL_WORLDS: "Gaming",
  MEMBERSHIPS: "Memberships", DOMAIN_NAMES: "Domains", PHYSICAL_COLLECTIBLES: "Assets",
  SPORTS_COLLECTIBLES: "Assets", TRADING_CARDS: "Assets",
};

const upsert = db.prepare(`
  INSERT INTO evm_discovered (slug, name, chain, category, rank, seen_at) VALUES (@slug, @name, @chain, @category, @rank, @seen)
  ON CONFLICT(slug) DO UPDATE SET name = excluded.name, chain = excluded.chain, category = excluded.category,
    rank = excluded.rank, seen_at = excluded.seen_at`);
// Dropped collections keep their row (for names) but stop being loaded.
const drop = db.prepare(`UPDATE evm_discovered SET seen_at = 0 WHERE slug = ?`);
const allNames = db.prepare(`SELECT slug, name FROM evm_discovered`);
const recent = db.prepare(`SELECT slug, name, chain, category FROM evm_discovered WHERE seen_at >= ? ORDER BY chain, rank`);

export function loadDiscovered() {
  for (const r of allNames.all() as { slug: string; name: string }[]) knownNames.set(r.slug, r.name);
  const rows = recent.all(Date.now() - KEEP_MS) as { slug: string; name: string; chain: Chain; category: Category }[];
  syncEvmLists(rows.map((r): EvmCollection => ({ ...r, auto: true })));
  return rows.length;
}

export async function discoverEvm() {
  if (!hasOsKey()) return;
  if (!usdPrice("ETH")) await refreshPrices(); // the $5 floor rule needs prices
  const now = Date.now();
  let found = 0;
  for (const [chain, cfg] of Object.entries(EVM_CHAINS)) {
    if (!cfg.discover) continue;
    try {
      const top = (await getOsTopCollections(chain, 25))
        .filter((c) => !c.is_disabled && !c.is_nsfw && !SKIP_CATEGORIES.has(c.category ?? ""));
      let rank = 0;
      for (const c of top) {
        if (rank >= cfg.discover) break;
        const week = await getOsWeek(c.collection).catch(() => null);
        const unit = normalizeUnit(week?.symbol);
        const floorUsd = week?.floor && unit ? toUsd(week.floor, unit) : null;
        if (!week || !unit || !cfg.units.includes(unit) || !week.floor || week.sales7d < MIN_SALES_7D
            || (floorUsd != null && floorUsd < MIN_FLOOR_USD)) {
          knownNames.set(c.collection, c.name || c.collection);
          drop.run(c.collection); // an explicit no: don't keep it for the 7-day grace either
          continue;
        }
        upsert.run({
          slug: c.collection, name: c.name || c.collection, chain,
          category: CATEGORY[c.category ?? ""] ?? "Utility", rank: ++rank, seen: now,
        });
      }
      found += rank;
    } catch (err) {
      console.warn(`[discover] ${chain}:`, (err as Error).message);
    }
  }
  const n = loadDiscovered();
  console.log(`[discover] ${found} top collections this run, ${n} kept across EVM chains`);
}

// New projects reach the 7-day top lists days after they start trading, if
// ever. Every few hours, OpenSea's recently minted drops that have finished
// minting and already trade (the same floor and currency rules, a lower
// sales bar) are added too, so "New" shows them within hours. They're kept
// like any discovered collection: 7 days after they stop qualifying.
const FRESH_MIN_SALES_7D = 15;
const FRESH_RANK = 100; // after each chain's top-volume picks
const rowOf = db.prepare(`SELECT rank, seen_at FROM evm_discovered WHERE slug = ?`);

export async function discoverFresh() {
  if (!hasOsKey()) return;
  if (!usdPrice("ETH")) await refreshPrices();
  const drops = await getOsDrops("recently_minted", 50).catch(() => []);
  const now = Date.now();
  let added = 0;
  for (const d of drops) {
    const chain = fromOsChain(d.chain) as Chain;
    const cfg = (EVM_CHAINS as Record<string, (typeof EVM_CHAINS)[keyof typeof EVM_CHAINS]>)[chain];
    if (d.is_minting || !cfg?.discover) continue;
    // Already tracked by hand or by the daily top-volume pass: that owns its row (category, rank).
    const row = rowOf.get(d.collection_slug) as { rank: number; seen_at: number } | undefined;
    if (EVM_COLLECTIONS.some((c) => c.slug === d.collection_slug && !c.auto)
        || (row && row.rank < FRESH_RANK && row.seen_at >= now - KEEP_MS)) continue;
    const week = await getOsWeek(d.collection_slug).catch(() => null);
    const unit = normalizeUnit(week?.symbol);
    const floorUsd = week?.floor && unit ? toUsd(week.floor, unit) : null;
    if (!week || !unit || !cfg.units.includes(unit) || !week.floor || week.sales7d < FRESH_MIN_SALES_7D
        || (floorUsd != null && floorUsd < MIN_FLOOR_USD)) continue;
    const meta = await getOsCollectionMeta(d.collection_slug).catch(() => null);
    if (!meta || meta.disabled || meta.nsfw || SKIP_CATEGORIES.has(meta.category ?? "")) continue;
    upsert.run({
      slug: d.collection_slug, name: d.collection_name || d.collection_slug, chain,
      category: CATEGORY[meta.category ?? ""] ?? "Utility", rank: FRESH_RANK + added, seen: now,
    });
    added++;
  }
  const n = loadDiscovered();
  console.log(`[discover] ${added} freshly minted collections this run, ${n} kept across EVM chains`);
}
