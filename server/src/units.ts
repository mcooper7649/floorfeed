import { COLLECTIONS, isEvm, type Unit } from "./config.ts";
import { db } from "./db.ts";

// Which currency each collection's prices and P&L are in. Solana is SOL.
// EVM collections use the currency their sales are actually paid in, chosen
// on first ingest and stored as collections.sale_currency (ingest.ts); before
// that, the currency of their floor quote. Cached, refreshed every 30s.
let cache: { at: number; map: Map<string, Unit> } | null = null;
const rows = db.prepare(`SELECT symbol, COALESCE(sale_currency, currency) AS unit FROM collections`);

function units() {
  if (cache && Date.now() - cache.at < 30_000) return cache.map;
  const map = new Map<string, Unit>();
  for (const r of rows.all() as { symbol: string; unit: string | null }[]) {
    if (r.unit) map.set(r.symbol, r.unit as Unit);
  }
  cache = { at: Date.now(), map };
  return map;
}

export const unitOf = (symbol: string): Unit =>
  COLLECTIONS.some((c) => c.symbol === symbol) ? "SOL" : units().get(symbol) ?? (isEvm(symbol) ? "ETH" : "SOL");
export const invalidateUnits = () => { cache = null; };

// SQL for a trade's unit given the trades alias and a collections alias.
export const UNIT_SQL = (c: string) => `COALESCE(${c}.sale_currency, ${c}.currency, 'SOL')`;

// A number as an exact decimal string for parseUnits/parseEther. toFixed(18)
// exposes float noise (0.0421 -> "0.042099999999999999"), which changes the
// amount; String() gives the shortest form that reads back as the same number.
export function decimalString(n: number, decimals = 18) {
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(Math.min(decimals, 20));
  const [whole, frac = ""] = s.split(".");
  return frac ? `${whole}.${frac.slice(0, decimals)}` : whole;
}
