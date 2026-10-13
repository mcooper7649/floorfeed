// USD prices for cross-chain sorting and totals (CoinGecko public endpoint, no key).
// Values stay at their last good reading if a refresh fails.
const usd: Record<string, number> = { USDC: 1, USDT: 1 };

export async function refreshPrices() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,hyperliquid,ronin,apecoin,monad&vs_currencies=usd",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const d = (await res.json()) as Record<string, { usd?: number } | undefined>;
    const ids: Record<string, string[]> = {
      solana: ["SOL"], ethereum: ["ETH", "WETH"], hyperliquid: ["HYPE", "WHYPE"],
      ronin: ["RON", "WRON"], apecoin: ["APE", "WAPE"], monad: ["MON", "WMON"],
    };
    for (const [id, syms] of Object.entries(ids)) {
      const p = d[id]?.usd;
      if (p) for (const sym of syms) usd[sym] = p;
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
