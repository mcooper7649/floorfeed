import { collectionAddressOf } from "./chain.ts";
import { chainOf, isEvm } from "./config.ts";
import { db } from "./db.ts";
import { COST_SQL, MARK_SQL, OS_DEFAULT_FEE_BPS, SOL_TAKER_FEE, feeRates } from "./fees.ts";
import { provenWallets, traders } from "./feed.ts";

// The collection page's Holders and Sales tabs and its About panel.
// "Holders" are wallets we've seen buy and that still hold (no later sale of
// the same NFT), so the list covers the trading history FloorFeed has, not
// every owner on chain.

const HOUR = 3600;

const holderRows = db.prepare(`
  SELECT b.buyer AS wallet, COUNT(*) AS items,
         SUM(${COST_SQL("b", "c")}) AS cost, AVG(b.price) AS avgEntry,
         AVG(b.block_time) AS avgBought, MAX(${MARK_SQL("c")}) AS mark
  FROM trades b
  LEFT JOIN collections c ON c.symbol = b.collection
  WHERE b.collection = ?
    AND NOT EXISTS (SELECT 1 FROM trades s WHERE s.mint = b.mint AND s.block_time > b.block_time)
  GROUP BY b.buyer
  ORDER BY items DESC, cost DESC
  LIMIT 200`);

export function collectionHolders(symbol: string) {
  const now = Math.floor(Date.now() / 1000);
  const rows = holderRows.all(symbol) as { wallet: string; items: number; cost: number; avgEntry: number; avgBought: number; mark: number | null }[];
  const who = traders(rows.map((r) => r.wallet));
  return rows.map((r) => {
    const t = who.get(r.wallet)!;
    // Marked at what the floor would pay this seller (fees.ts MARK_SQL).
    const value = r.mark != null ? r.mark * r.items : null;
    const pnl = value != null ? value - r.cost : null;
    return {
      wallet: r.wallet, name: t.name, avatar: t.avatar, tier: t.tier,
      items: r.items, value, cost: r.cost, pnl, pnlPct: pnl != null && r.cost ? (pnl / r.cost) * 100 : null,
      avgEntry: r.avgEntry, avgHoldHours: (now - r.avgBought) / HOUR,
    };
  });
}

const saleRows = db.prepare(`
  SELECT signature, mint, buyer, seller, price, block_time AS t, image, source
  FROM trades WHERE collection = ? ORDER BY block_time DESC LIMIT ?`);
const floorAt = db.prepare(
  `SELECT floor FROM collection_snapshots WHERE symbol = ? AND ts <= ? AND floor IS NOT NULL ORDER BY ts DESC LIMIT 1`);

export function collectionSales(symbol: string, limit = 100) {
  const rows = saleRows.all(symbol, limit) as { signature: string; mint: string; buyer: string; seller: string; price: number; t: number; image: string | null; source: string | null }[];
  const who = traders(rows.flatMap((r) => [r.buyer, r.seller]));
  const id = (w: string) => { const t = who.get(w)!; return { wallet: w, name: t.name, avatar: t.avatar, tier: t.tier }; };
  return rows.map((r) => {
    const floor = (floorAt.get(symbol, r.t * 1000) as { floor: number } | undefined)?.floor ?? null;
    return {
      signature: r.signature, mint: r.mint, image: r.image, price: r.price, t: r.t,
      vsFloorPct: floor ? ((r.price - floor) / floor) * 100 : null,
      // Accepted bids: Ethereum sales paid in WETH/BETH; Solana sells into pools.
      kind: r.source && /^(os:WETH|os:BETH|mmm|tensorswap|tcomp|tensortrade)$/.test(r.source) ? "bid" : "listing",
      buyer: id(r.buyer), seller: id(r.seller),
    };
  });
}

// --- About -----------------------------------------------------------------------

const changeFrom = db.prepare(
  `SELECT floor FROM collection_snapshots WHERE symbol = ? AND ts <= ? AND floor IS NOT NULL ORDER BY ts DESC LIMIT 1`);
const info = db.prepare(`SELECT floor, supply, owners, listed, royalty_bps, seller_fee_bps, website, twitter, discord, contract
                         FROM collections WHERE symbol = ?`);
const window24 = db.prepare(`SELECT buyer, seller, price FROM trades WHERE collection = ? AND block_time >= ?`);
const tracked = db.prepare(`SELECT COUNT(DISTINCT buyer) AS n FROM trades b WHERE collection = ?
  AND NOT EXISTS (SELECT 1 FROM trades s WHERE s.mint = b.mint AND s.block_time > b.block_time)`);
const since = db.prepare(`SELECT MIN(block_time) AS t FROM trades WHERE collection = ?`);

export async function collectionAbout(symbol: string) {
  const c = (info.get(symbol) ?? {}) as {
    floor?: number | null; supply?: number | null; owners?: number | null; listed?: number | null;
    royalty_bps?: number | null; seller_fee_bps?: number | null;
    website?: string | null; twitter?: string | null; discord?: string | null; contract?: string | null;
  };
  const change = (hours: number) => {
    if (c.floor == null) return null;
    const then = (changeFrom.get(symbol, Date.now() - hours * 3_600_000) as { floor: number } | undefined)?.floor;
    return then ? ((c.floor - then) / then) * 100 : null;
  };
  // Last 24h of trading, and how much of it was proven wallets buying or selling.
  const proven = provenWallets();
  const day = window24.all(symbol, Math.floor(Date.now() / 1000) - 24 * HOUR) as { buyer: string; seller: string; price: number }[];
  const evm = isEvm(symbol);
  const fees = feeRates(symbol);
  return {
    changes: [
      { label: "1H", pct: change(1) }, { label: "6H", pct: change(6) },
      { label: "24H", pct: change(24) }, { label: "7D", pct: change(24 * 7) },
    ],
    activity24h: {
      sales: day.length,
      volume: day.reduce((a, r) => a + r.price, 0),
      buyers: new Set(day.map((r) => r.buyer)).size,
      sellers: new Set(day.map((r) => r.seller)).size,
      provenBuys: day.filter((r) => proven.has(r.buyer)).length,
      provenSells: day.filter((r) => proven.has(r.seller)).length,
    },
    fees: {
      // Marketplace fee and royalty as percentages, plus who pays on a floor buy/sell.
      marketplacePct: evm ? null : SOL_TAKER_FEE * 100,
      royaltyPct: evm ? null : (c.royalty_bps ?? 0) / 100,
      sellerFeesPct: evm ? (c.seller_fee_bps ?? OS_DEFAULT_FEE_BPS) / 100 : null,
      buyTaker: fees.buyTaker, sellTaker: fees.sellTaker,
    },
    info: {
      chain: chainOf(symbol),
      supply: c.supply ?? null, owners: c.owners ?? null, listed: c.listed ?? null,
      holdersTracked: (tracked.get(symbol) as { n: number }).n,
      trackedSince: (since.get(symbol) as { t: number | null }).t,
      address: evm ? c.contract ?? null : await collectionAddressOf(symbol).catch(() => null),
      website: c.website ?? null,
      twitter: c.twitter ?? null,
      discord: c.discord ?? null,
    },
  };
}
