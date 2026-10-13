import { config } from "./config.ts";
import { db } from "./db.ts";

// P&L after marketplace fees and creator royalties.
//
// Each trade has two amounts besides its price:
//   cost     = what the buyer actually paid (price + fees/royalties they bore)
//   proceeds = what the seller actually received (price − fees/royalties they bore)
//
// Solana trades get exact amounts from the transaction itself (Helius
// enhanced transactions: where the SOL went). When a transaction can't be
// read cleanly, the model below fills in:
//   - Solana listing buys (Magic Eden, Tensor listings): the buyer pays the
//     2% taker fee and any enforced royalty on top; the seller gets the price.
//   - Solana sells into pools/bids (Magic Eden MMM, Tensor swap/bids): the
//     seller pays the fee and royalty out of the price.
//     The royalty rate is measured per collection from parsed listing buys.
//   - EVM (OpenSea): the seller pays the collection's required fees
//     (OpenSea's fee plus enforced creator fees, from OpenSea's API); the buyer
//     pays the price. Gas isn't counted.

export const SOL_TAKER_FEE = 0.02;
export const OS_DEFAULT_FEE_BPS = 100; // OpenSea's own fee when a collection's fees are unknown

// Sources where the seller is the taker (sold into a pool or a bid).
const SELLER_TAKER = `('mmm','tensorswap','tcomp','tensortrade')`;
const isSol = (c: string) => `COALESCE(${c}.chain,'solana') = 'solana'`;
const royalty = (c: string) => `COALESCE(${c}.royalty_bps, 0) / 10000.0`;
const evmFee = (c: string) => `COALESCE(${c}.seller_fee_bps, ${OS_DEFAULT_FEE_BPS}) / 10000.0`;

// SQL for a trade's buyer cost / seller proceeds, given the trades alias and
// the alias of the trade's collection row.
export const COST_SQL = (t: string, c: string) =>
  `COALESCE(${t}.cost, ${t}.price * (1 + CASE WHEN ${isSol(c)} AND COALESCE(${t}.source,'') NOT IN ${SELLER_TAKER}
     THEN ${SOL_TAKER_FEE} + ${royalty(c)} ELSE 0 END))`;
export const PROCEEDS_SQL = (t: string, c: string) =>
  `COALESCE(${t}.proceeds, ${t}.price * (1 - CASE WHEN ${isSol(c)}
     THEN CASE WHEN COALESCE(${t}.source,'') IN ${SELLER_TAKER} THEN ${SOL_TAKER_FEE} + ${royalty(c)} ELSE 0 END
     ELSE ${evmFee(c)} END))`;
// What an open position would fetch listed at the floor: Solana sellers keep
// the full price (the buyer pays fees); EVM sellers pay the collection's fees.
export const MARK_SQL = (c: string) =>
  `${c}.floor * (1 - CASE WHEN ${isSol(c)} THEN 0 ELSE ${evmFee(c)} END)`;

// The same rates in code, for paper trades (buy at floor = listing buy; sell
// = into the top bid, so the seller is the taker).
const rateRow = db.prepare(`SELECT COALESCE(chain,'solana') AS chain, royalty_bps, seller_fee_bps FROM collections WHERE symbol = ?`);
export function feeRates(symbol: string) {
  const r = rateRow.get(symbol) as { chain: string; royalty_bps: number | null; seller_fee_bps: number | null } | undefined;
  if (!r || r.chain === "solana") {
    const roy = (r?.royalty_bps ?? 0) / 10_000;
    return { buyTaker: SOL_TAKER_FEE + roy, sellTaker: SOL_TAKER_FEE + roy, sellMaker: 0 };
  }
  const f = (r.seller_fee_bps ?? OS_DEFAULT_FEE_BPS) / 10_000;
  return { buyTaker: 0, sellTaker: f, sellMaker: f };
}

// --- Exact amounts for Solana trades, from Helius enhanced transactions ---

type Transfer = { fromUserAccount: string; toUserAccount: string; amount: number };
type HeliusTx = { signature: string; nativeTransfers?: Transfer[] };

// Rent deposits/refunds for token accounts are ~0.001–0.0024 SOL and move
// with the NFT, not the payment; anything at or under this is ignored.
const RENT_MAX = 2_500_000; // lamports
const LAMPORTS = 1e9;

export function amountsFrom(tx: HeliusTx, buyer: string, seller: string, price: number) {
  const big = (tx.nativeTransfers ?? []).filter((x) => x.amount > RENT_MAX);
  const sum = (xs: Transfer[]) => xs.reduce((a, x) => a + x.amount, 0) / LAMPORTS;
  const buyerOut = sum(big.filter((x) => x.fromUserAccount === buyer));
  const buyerIn = sum(big.filter((x) => x.toUserAccount === buyer));
  const sellerIn = sum(big.filter((x) => x.toUserAccount === seller));
  const sellerOut = sum(big.filter((x) => x.fromUserAccount === seller));
  // Only trust amounts that look like this sale: the buyer paid something
  // near the price, the seller received something near it.
  let cost: number | null = buyerOut > 0 ? buyerOut - buyerIn : null;
  if (cost != null && !(cost >= price * 0.95 && cost <= price * 1.3)) cost = null;
  let proceeds: number | null = sellerIn > 0 ? sellerIn - sellerOut : null;
  if (proceeds != null && !(proceeds >= price * 0.6 && proceeds <= price * 1.005)) proceeds = null;
  return { cost, proceeds };
}

const pending = db.prepare(`
  SELECT t.signature, t.buyer, t.seller, t.price FROM trades t
  JOIN collections c ON c.symbol = t.collection
  WHERE t.fees_checked = 0 AND COALESCE(c.chain,'solana') = 'solana' AND instr(t.mint, ':') = 0
  ORDER BY t.block_time DESC LIMIT ?`);
const saveAmounts = db.prepare(`UPDATE trades SET cost = @cost, proceeds = @proceeds, fees_checked = @checked WHERE signature = @signature`);

async function parseBatch(signatures: string[]): Promise<HeliusTx[]> {
  const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${config.heliusApiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "FloorFeed/0.1 (+https://floorfeed.io)" },
    body: JSON.stringify({ transactions: signatures }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Helius ${res.status}`);
  return (await res.json()) as HeliusTx[];
}

// Reads up to `batches` × 100 unchecked Solana trades (newest first), then
// re-measures royalty rates. Trades Helius doesn't return are marked
// checked (2) so they fall back to the model and aren't retried forever.
export async function enrichFees(batches = 10) {
  if (!config.heliusApiKey) return;
  let read = 0;
  for (let i = 0; i < batches; i++) {
    const rows = pending.all(100) as { signature: string; buyer: string; seller: string; price: number }[];
    if (!rows.length) break;
    let parsed: HeliusTx[];
    try {
      parsed = await parseBatch(rows.map((r) => r.signature));
    } catch (err) {
      console.warn("[fees]", (err as Error).message);
      break;
    }
    const txs = new Map(parsed.map((t) => [t.signature, t]));
    db.transaction(() => {
      for (const r of rows) {
        const tx = txs.get(r.signature);
        const a = tx ? amountsFrom(tx, r.buyer, r.seller, r.price) : { cost: null, proceeds: null };
        saveAmounts.run({ signature: r.signature, ...a, checked: tx ? 1 : 2 });
      }
    })();
    read += rows.length;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (read) {
    measureRoyalties();
    console.log(`[fees] read ${read} Solana trades`);
  }
}

// Royalty a collection's listing buyers pay on top of price + 2% taker fee,
// as the median over parsed Magic Eden listing buys (0 when unenforced).
const listingBuys = db.prepare(`
  SELECT collection, cost / price - 1 - ${SOL_TAKER_FEE} AS r FROM trades
  WHERE cost IS NOT NULL AND source = 'magiceden_v2' ORDER BY collection`);
const setRoyalty = db.prepare(`UPDATE collections SET royalty_bps = ? WHERE symbol = ?`);
export function measureRoyalties() {
  const by = new Map<string, number[]>();
  for (const r of listingBuys.all() as { collection: string; r: number }[]) {
    (by.get(r.collection) ?? by.set(r.collection, []).get(r.collection)!).push(r.r);
  }
  db.transaction(() => {
    for (const [symbol, rs] of by) {
      if (rs.length < 3) continue;
      rs.sort((a, b) => a - b);
      const median = rs[Math.floor(rs.length / 2)];
      setRoyalty.run(Math.round(Math.min(0.2, Math.max(0, median)) * 10_000), symbol);
    }
  })();
}
