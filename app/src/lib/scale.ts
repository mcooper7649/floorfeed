// Small chart helpers shared by the SVG charts.
export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) =>
  d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);

// "Nice" round ticks (1/2/5 × 10^n) covering [min, max].
export function niceTicks(min: number, max: number, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export const fmtSol = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

export const fmtDay = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
