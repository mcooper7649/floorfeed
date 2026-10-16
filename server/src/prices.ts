// USD prices for cross-chain sorting and totals (CoinGecko public endpoint, no key).
// Values stay at their last good reading if a refresh fails.
const usd: Record<string, number> = { USDC: 1, USDT: 1 };
const change: Record<string, number> = {}; // 24h % change, for the price ticker

export async function refreshPrices() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,hyperliquid,ronin,apecoin,monad,polygon-ecosystem-token&vs_currencies=usd&include_24hr_change=true",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const d = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number } | undefined>;
    const ids: Record<string, string[]> = {
      solana: ["SOL"], ethereum: ["ETH", "WETH"], hyperliquid: ["HYPE", "WHYPE"],
      ronin: ["RON", "WRON"], apecoin: ["APE", "WAPE"], monad: ["MON", "WMON"],
      "polygon-ecosystem-token": ["POL", "WPOL"],
    };
    for (const [id, syms] of Object.entries(ids)) {
      const p = d[id]?.usd;
      if (p) for (const sym of syms) usd[sym] = p;
      const ch = d[id]?.usd_24h_change;
      if (ch != null) change[syms[0]] = ch;
    }
  } catch (err) {
    console.warn("[prices]", (err as Error).message);
  }
}

export const usdPrice = (currency: string) => usd[currency.toUpperCase()] ?? null;
export const toUsd = (amount: number | null, currency: string) => {
  const p = usdPrice(currency);
  return amount == null || p == null ? null : amount * p;
};

// Native coins for the ticker: USD price and 24h change.
export const tickerPrices = () =>
  ["SOL", "ETH", "HYPE", "APE", "RON", "MON", "POL"].flatMap((sym) =>
    usd[sym] ? [{ symbol: sym, usd: usd[sym], change24hPct: change[sym] ?? null }] : []);
