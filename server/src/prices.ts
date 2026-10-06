// USD prices for cross-chain sorting (CoinGecko public endpoint, no key).
// Values stay at their last good reading if a refresh fails.
const usd: Record<string, number> = { USDC: 1, USDT: 1 };

export async function refreshPrices() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const d = (await res.json()) as { solana?: { usd: number }; ethereum?: { usd: number } };
    if (d.solana?.usd) usd.SOL = d.solana.usd;
    if (d.ethereum?.usd) usd.ETH = usd.WETH = d.ethereum.usd;
  } catch (err) {
    console.warn("[prices]", (err as Error).message);
  }
}

export const usdPrice = (currency: string) => usd[currency.toUpperCase()] ?? null;
export const toUsd = (amount: number | null, currency: string) => {
  const p = usdPrice(currency);
  return amount == null || p == null ? null : amount * p;
};
