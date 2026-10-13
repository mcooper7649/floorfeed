import { EVM_CHAINS, syncEvmLists, type Category, type Chain, type EvmCollection } from "./config.ts";
import { db } from "./db.ts";
import { getOsTopCollections, getOsWeek, hasOsKey } from "./opensea.ts";

// Keeps each EVM chain's busiest collections in FloorFeed automatically,
// instead of a hand-maintained list. Once a day, per chain: OpenSea's top 25
// by 7-day volume, minus disabled/NSFW/DeFi position "collections", minus
// anything not priced in ETH or with fewer than 15 sales that week; the first
// N survivors are kept. A collection that drops out stays for 7 days so its
// pages and history don't vanish overnight. The list is stored, so restarts
// come back with it immediately.

const DAY_MS = 86_400_000;
const KEEP_MS = 7 * DAY_MS;
const MIN_SALES_7D = 15;
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
const recent = db.prepare(`SELECT slug, name, chain, category FROM evm_discovered WHERE seen_at >= ? ORDER BY chain, rank`);

export function loadDiscovered() {
  const rows = recent.all(Date.now() - KEEP_MS) as { slug: string; name: string; chain: Chain; category: Category }[];
  syncEvmLists(rows.map((r): EvmCollection => ({ ...r, auto: true })));
  return rows.length;
}

export async function discoverEvm() {
  if (!hasOsKey()) return;
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
        if (!week || !["ETH", "WETH"].includes(week.symbol) || !week.floor || week.sales7d < MIN_SALES_7D) continue;
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
