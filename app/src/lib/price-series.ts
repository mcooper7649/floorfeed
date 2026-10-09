import type { DailyPoint } from '@/lib/api';

// Data prep shared by the price charts (SVG on native, Lightweight Charts on web).
export const DAY = 86_400;

export type Sale = { signature: string; price: number; t: number };
// One slot per bucket on a regular grid; `roll` is null while the trailing
// window isn't fully inside the loaded range or holds no sales.
export type Slot = DailyPoint & { roll: number | null };

const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Rolling median window: 3h on the 24H range, 24h otherwise.
export const windowFor = (rangeDays: number) => (rangeDays <= 1 ? 3 * 3600 : DAY);

export function priceSeries(sales: Sale[], buckets: DailyPoint[], bucketSec: number, floor: number | null, rangeDays: number, asOf: number) {
  const t1 = Math.ceil(asOf / bucketSec) * bucketSec;
  const t0 = t1 - rangeDays * DAY;
  const W = windowFor(rangeDays);
  const byDay = new Map(buckets.map((b) => [b.day, b]));
  const byT = [...sales].sort((a, b) => a.t - b.t);

  // Fill the grid so empty buckets keep their place on the time axis. A
  // window that starts before the loaded sales would median just a handful
  // of trades (the old chart opened with a fake spike), so those slots wait.
  const slots: Slot[] = [];
  for (let day = t0; day < t1; day += bucketSec) {
    const b = byDay.get(day) ?? { day, low: 0, median: 0, high: 0, count: 0, volume: 0 };
    const end = day + bucketSec;
    const inWin = end - W >= t0 ? byT.filter((x) => x.t > end - W && x.t <= end).map((x) => x.price) : [];
    slots.push({ ...b, roll: inWin.length ? median(inWin) : null });
  }

  // Rare-trait sales can sit at 2–3× floor and flatten everything else: the
  // y-domain covers the 2nd–92nd percentile of sales plus every median and
  // the floor; sales above it are counted in the caption, never pinned.
  const sorted = sales.map((s) => s.price).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const rolls = slots.flatMap((s) => (s.roll == null ? [] : [s.roll]));
  const lo = Math.min(sorted.length ? q(0.02) : Infinity, floor ?? Infinity, ...rolls);
  const hi = Math.max(sorted.length ? q(0.92) : -Infinity, floor ?? -Infinity, ...rolls);

  const valid = slots.filter((s) => s.roll != null);
  const first = valid[0];
  const last = valid[valid.length - 1];
  const change = first && last && first !== last ? ((last.roll! - first.roll!) / first.roll!) * 100 : null;
  return { t0, t1, slots, lo, hi, first, last, change };
}

export const fmtWhen = (t: number, bucketSec: number) => {
  const d = new Date(t * 1000);
  if (bucketSec >= DAY) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hr = (x: Date) => x.toLocaleTimeString(undefined, { hour: 'numeric' });
  return bucketSec === 3600 ? `${day}, ${hr(d)}` : `${day}, ${hr(d)}–${hr(new Date((t + bucketSec) * 1000))}`;
};
