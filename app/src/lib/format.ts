// Amounts in a chain's native unit: SOL by default, ETH for EVM collections
// and wallets. ETH amounts are ~10x smaller, so they get one more digit.
export const sol = (n: number, digits = 2, unit = 'SOL') =>
  `${n.toFixed(unit === 'ETH' ? digits + 1 : digits)} ${unit}`;

export const signedSol = (n: number, digits = 2, unit = 'SOL') =>
  `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(unit === 'ETH' ? digits + 1 : digits)} ${unit}`;

// A wallet's P&L unit: 0x addresses are EVM (ETH), everything else Solana.
export const isEvmWallet = (w: string) => w.startsWith('0x');
export const unitFor = (w: string) => (isEvmWallet(w) ? 'ETH' : 'SOL');

export const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function timeAgo(unixSeconds: number) {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function holdTime(hours: number) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// Native-currency amount: "8.35 SOL", "32.9 ETH". Small ETH floors need more digits.
export function amt(n: number, currency: string, digits?: number) {
  if (digits == null && n > 0 && n < 0.001) return `${n.toPrecision(2)} ${currency}`; // e.g. ENS floors
  const d = digits ?? (n >= 100 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
  return `${n.toFixed(d)} ${currency}`;
}

export function usdCompact(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return `$${n.toFixed(0)}`;
}
