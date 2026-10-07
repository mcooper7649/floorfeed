import { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { C } from '@/constants/brand';
import type { DailyPoint } from '@/lib/api';
import { fmtSol, linear, niceTicks } from '@/lib/scale';

// Two stacked panels on one time axis (never two y-scales on one plot):
//  - price: individual sales are gray context, a rolling median (trailing
//    24h, or 3h on the 24H range) is the one accent series, the current floor
//    is a dashed reference line. A plain per-bucket median jumps around when
//    a bucket holds one rare-trait sale; the rolling window doesn't;
//  - volume: SOL traded per bucket, single-series bars.
// One crosshair spans both; the tooltip follows it.
const DAY = 86_400;
const AXIS_H = 22;
const GAP = 24; // between the panels (holds the volume label)
const PAD = { top: 12, right: 52, left: 44 };
const FONT = Platform.select({ web: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined });
const TIP_W = 220;

const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const windowFor = (rangeDays: number) => (rangeDays <= 1 ? 3 * 3600 : DAY);

type Props = {
  sales: { signature: string; price: number; t: number }[];
  buckets: DailyPoint[];
  bucketSec: number;
  floor: number | null;
  rangeDays: number;
  asOf: number;
  dimmed?: boolean;
  tall?: boolean;
};

const fmtWhen = (t: number, bucketSec: number) => {
  const d = new Date(t * 1000);
  if (bucketSec >= DAY) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hr = (x: Date) => x.toLocaleTimeString(undefined, { hour: 'numeric' });
  return bucketSec === 3600 ? `${day}, ${hr(d)}` : `${day}, ${hr(d)}–${hr(new Date((t + bucketSec) * 1000))}`;
};

// Time ticks at round steps, at most `max` of them.
function timeTicks(t0: number, t1: number, max: number) {
  const steps = [3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 7 * DAY];
  const step = steps.find((st) => (t1 - t0) / st <= max) ?? 7 * DAY;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return { ticks: out, step };
}

const tickLabel = (t: number, step: number) =>
  step < DAY
    ? new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric' })
    : new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function PriceChart({ sales, buckets, bucketSec, floor, rangeDays, asOf, dimmed, tall }: Props) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const PLOT_H = tall ? 300 : 190;
  const VOL_H = tall ? 72 : 48;
  const H = PAD.top + PLOT_H + GAP + VOL_H + AXIS_H;

  const geo = useMemo(() => {
    if (!width || !buckets.length) return null;
    const t1 = Math.ceil(asOf / bucketSec) * bucketSec;
    const t0 = t1 - rangeDays * DAY;
    // Rare-trait sales can sit at 2–3× floor and flatten everything else. The
    // y-domain covers the 2nd–92nd percentile (plus every median and the floor);
    // sales outside it are left off the plot and counted in the caption,
    // never pinned to the edge where they'd read as real values.
    const sorted = sales.map((s) => s.price).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    // Rolling median at each bucket's end over the trailing window.
    const W = windowFor(rangeDays);
    const byT = [...sales].sort((a, b) => a.t - b.t);
    const rolled = buckets.map((d) => {
      const end = d.day + bucketSec;
      const inWin = byT.filter((x) => x.t > end - W && x.t <= end).map((x) => x.price);
      return { ...d, roll: inWin.length ? median(inWin) : d.median };
    });
    const lo = Math.min(q(0.02), floor ?? Infinity, ...rolled.map((d) => d.roll));
    const hi = Math.max(q(0.92), floor ?? -Infinity, ...rolled.map((d) => d.roll));
    const ticks = niceTicks(lo, hi, tall ? 5 : 4);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const x = linear(t0, t1, PAD.left, width - PAD.right);
    const y = linear(yMin, yMax, PAD.top + PLOT_H, PAD.top);
    const volTop = PAD.top + PLOT_H + GAP;
    const vMax = Math.max(...buckets.map((d) => d.volume), 1e-9);
    const vy = linear(0, vMax, volTop + VOL_H, volTop);
    const slot = x(t0 + bucketSec) - x(t0);
    const bw = Math.max(1, Math.min(18, slot - 2)); // >= 2px surface gap between bars
    const shown = sales.filter((s) => s.price >= yMin && s.price <= yMax && s.t >= t0);
    const pts = rolled.filter((d) => d.day >= t0 - bucketSec)
      .map((d) => ({ ...d, cx: x(d.day + bucketSec / 2), cy: y(d.roll) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('');
    const xt = timeTicks(t0, t1, Math.max(3, Math.floor((width - PAD.left - PAD.right) / 110)));
    const end = pts[pts.length - 1];
    let endLabelY = end ? end.cy - 8 : 0;
    if (end && floor != null && Math.abs(endLabelY - (y(floor) + 4)) < 14) {
      endLabelY = end.cy <= y(floor) ? end.cy - 18 : end.cy + 20;
    }
    return { x, y, vy, ticks, pts, path, xt, shown, hidden: sales.length - shown.length, yMax, endLabelY, volTop, bw, vMax };
  }, [width, sales, buckets, bucketSec, floor, rangeDays, asOf, PLOT_H, VOL_H, tall]);

  const pick = (lx: number) => {
    if (!geo || !geo.pts.length) return;
    let best = 0;
    geo.pts.forEach((p, i) => { if (Math.abs(p.cx - lx) < Math.abs(geo.pts[best].cx - lx)) best = i; });
    setActive(best);
  };
  const onTouch = (e: GestureResponderEvent) => pick(e.nativeEvent.locationX);

  const sel = geo && active != null ? geo.pts[active] : null;
  const first = geo?.pts[0];
  const last = geo?.pts[geo.pts.length - 1];
  const change = first && last && first !== last ? ((last.roll - first.roll) / first.roll) * 100 : null;
  const rangeLabel = rangeDays === 1 ? '24h' : `${rangeDays}d`;

  return (
    <View style={{ opacity: dimmed ? 0.45 : 1 }}>
      {/* Headline: latest median and its change over the range */}
      <View style={s.head}>
        {last && (
          <Text style={s.headVal}>
            {fmtSol(last.roll)} SOL{'  '}
            {change != null && (
              <Text style={[s.headChg, { color: change >= 0 ? C.up : C.down }]}>
                {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% {rangeLabel}
              </Text>
            )}
          </Text>
        )}
        <Text style={s.ctx}>
          median sale price, rolling {rangeDays <= 1 ? '3 hours' : '24 hours'}
          {geo?.hidden ? ` · ${geo.hidden} sale${geo.hidden === 1 ? '' : 's'} above ${fmtSol(geo.yMax)} SOL not plotted` : ''}
        </Text>
      </View>

      <View style={s.legend}>
        <Key kind="line" label="Rolling median" />
        <Key kind="dot" label="Sale" />
        {floor != null && <Key kind="ref" label="Floor now" />}
        <Key kind="bar" label="Volume" />
      </View>

      <View
        style={{ height: H }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
        onResponderRelease={() => Platform.OS !== 'web' && setActive(null)}
        {...(Platform.OS === 'web'
          ? { onPointerMove: (e: any) => pick(e.nativeEvent.offsetX), onPointerLeave: () => setActive(null) }
          : {})}
        accessibilityRole="image"
        accessibilityLabel={last ? `Rolling median sale price, latest ${fmtSol(last.roll)} SOL` : 'Price chart'}>
        {geo && (
          <Svg width={width} height={H} pointerEvents="none">
            {/* recessive hairline grid + y ticks */}
            {geo.ticks.map((t) => (
              <G key={t}>
                <Line x1={PAD.left} x2={width - PAD.right} y1={geo.y(t)} y2={geo.y(t)} stroke={C.grid} strokeWidth={1} />
                <SvgText fontFamily={FONT} x={PAD.left - 8} y={geo.y(t) + 4} fill={C.dim} fontSize={11} textAnchor="end">{fmtSol(t)}</SvgText>
              </G>
            ))}
            {/* volume panel baseline + its own label (separate scale, separate panel) */}
            <Line x1={PAD.left} x2={width - PAD.right} y1={geo.volTop + VOL_H} y2={geo.volTop + VOL_H} stroke={C.grid} strokeWidth={1} />
            <SvgText fontFamily={FONT} x={PAD.left} y={geo.volTop - 3} fill={C.dim} fontSize={11}>
              Volume per {bucketSec === 3600 ? 'hour' : bucketSec < DAY ? '6h' : 'day'} · peak {fmtSol(geo.vMax)} SOL
            </SvgText>
            {geo.xt.ticks.map((t) => (
              <SvgText fontFamily={FONT} key={t} x={geo.x(t)} y={H - 6} fill={C.dim} fontSize={11} textAnchor="middle">
                {tickLabel(t, geo.xt.step)}
              </SvgText>
            ))}

            {/* volume bars, 2px rounded data-ends on a square baseline */}
            {geo.pts.map((p, i) => {
              const top = Math.min(geo.vy(p.volume), geo.volTop + VOL_H - 1);
              const base = geo.volTop + VOL_H;
              const w = geo.bw;
              const x0 = p.cx - w / 2;
              const r = Math.min(2, w / 2, base - top);
              const d = `M${x0},${base} L${x0},${top + r} Q${x0},${top} ${x0 + r},${top} L${x0 + w - r},${top} Q${x0 + w},${top} ${x0 + w},${top + r} L${x0 + w},${base} Z`;
              return <Path key={p.day} d={d} fill={C.barFill} opacity={active == null || active === i ? 1 : 0.45} />;
            })}

            {/* context: every sale */}
            {geo.shown.map((p) => (
              <Circle key={p.signature} cx={geo.x(p.t)} cy={geo.y(p.price)} r={tall ? 3 : 2.5} fill={C.muted} opacity={0.5} />
            ))}

            {/* reference: current floor (dashed = threshold, not a gridline) */}
            {floor != null && (
              <G>
                <Line x1={PAD.left} x2={width - PAD.right} y1={geo.y(floor)} y2={geo.y(floor)}
                  stroke={C.dim} strokeWidth={1} strokeDasharray="4 4" />
                <SvgText fontFamily={FONT} x={width - PAD.right + 6} y={geo.y(floor) + 4} fill={C.dim} fontSize={11}>floor</SvgText>
              </G>
            )}

            {/* emphasis: rolling median */}
            <Path d={geo.path} stroke={C.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {last && !sel && (
              <G>
                <Circle cx={last.cx} cy={last.cy} r={6} fill={C.card} />
                <Circle cx={last.cx} cy={last.cy} r={4} fill={C.accent} />
                <SvgText fontFamily={FONT} x={last.cx + 9} y={geo.endLabelY}
                  fill={C.text} fontSize={12} fontWeight="700">{fmtSol(last.roll)}</SvgText>
              </G>
            )}

            {/* crosshair across both panels */}
            {sel && (
              <G>
                <Line x1={sel.cx} x2={sel.cx} y1={PAD.top} y2={geo.volTop + VOL_H} stroke={C.dim} strokeWidth={1} />
                <Circle cx={sel.cx} cy={sel.cy} r={6} fill={C.card} />
                <Circle cx={sel.cx} cy={sel.cy} r={4} fill={C.accent} />
              </G>
            )}
          </Svg>
        )}

        {/* tooltip follows the crosshair, flips sides near the right edge */}
        {sel && geo && (
          <View pointerEvents="none" style={[s.tip, {
            top: PAD.top,
            left: sel.cx + 14 + TIP_W > width ? sel.cx - 14 - TIP_W : sel.cx + 14,
          }]}>
            <Text style={s.tipWhen}>{fmtWhen(sel.day, bucketSec)}</Text>
            <TipRow label={`Rolling median (${rangeDays <= 1 ? '3h' : '24h'})`} value={`${fmtSol(sel.roll)} SOL`} strong />
            {floor != null && <TipRow label="vs floor now" value={`${sel.roll >= floor ? '+' : ''}${(((sel.roll - floor) / floor) * 100).toFixed(1)}%`} />}
            <View style={s.tipSep} />
            <TipRow label="Sales in period" value={String(sel.count)} />
            <TipRow label="Period median" value={`${fmtSol(sel.median)} SOL`} />
            <TipRow label="Low – high" value={`${fmtSol(sel.low)} – ${fmtSol(sel.high)}`} />
            <TipRow label="Volume" value={`${fmtSol(sel.volume)} SOL`} />
          </View>
        )}
      </View>
      <Text style={s.hint}>{Platform.OS === 'web' ? 'Hover' : 'Touch and drag'} for detail</Text>
    </View>
  );
}

const TipRow = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <View style={s.tipRow}>
    <Text style={s.tipLabel}>{label}</Text>
    <Text style={[s.tipVal, strong && { fontWeight: '800', fontSize: 14 }]}>{value}</Text>
  </View>
);

function Key({ kind, label }: { kind: 'line' | 'dot' | 'ref' | 'bar'; label: string }) {
  return (
    <View style={s.key}>
      <Svg width={16} height={10}>
        {kind === 'line' && <Line x1={1} x2={15} y1={5} y2={5} stroke={C.accent} strokeWidth={2} strokeLinecap="round" />}
        {kind === 'dot' && <Circle cx={8} cy={5} r={3} fill={C.muted} />}
        {kind === 'ref' && <Line x1={0} x2={16} y1={5} y2={5} stroke={C.dim} strokeWidth={1} strokeDasharray="3 3" />}
        {kind === 'bar' && <Path d="M5,10 L5,3 Q5,1 7,1 L9,1 Q11,1 11,3 L11,10 Z" fill={C.barFill} />}
      </Svg>
      <Text style={s.keyTxt}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  head: { gap: 2, marginBottom: 8 },
  headVal: { color: C.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  headChg: { fontSize: 14, fontWeight: '800' },
  ctx: { color: C.dim, fontSize: 12.5 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginBottom: 6 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  keyTxt: { color: C.dim, fontSize: 12 },
  hint: { color: C.dim, fontSize: 11.5, marginTop: 2 },
  tip: {
    position: 'absolute', width: TIP_W, backgroundColor: C.cardHi, borderRadius: 10, padding: 10, gap: 3,
    borderWidth: 1, borderColor: C.border, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12,
  },
  tipWhen: { color: C.text, fontWeight: '700', fontSize: 12.5, marginBottom: 2 },
  tipRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tipSep: { height: 1, backgroundColor: C.border, marginVertical: 3 },
  tipLabel: { color: C.dim, fontSize: 12 },
  tipVal: { color: C.text, fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
