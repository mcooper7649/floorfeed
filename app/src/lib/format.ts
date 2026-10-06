export const sol = (n: number, digits = 2) => `${n.toFixed(digits)} SOL`;

export const signedSol = (n: number, digits = 2) =>
  `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)} SOL`;

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
