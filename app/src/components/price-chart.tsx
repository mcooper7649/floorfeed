import { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { C } from '@/constants/brand';
import type { DailyPoint } from '@/lib/api';
import { fmtDay, fmtSol, linear, niceTicks } from '@/lib/scale';

// Emphasis chart: individual sales are gray context, the daily median is the
// one accent series, and the current floor is a labeled reference line.
const PLOT_H = 200;
const AXIS_H = 22; // x-axis band is part of the container height
const PAD = { top: 12, right: 52, left: 40 };
const DAY = 86_400;
const FONT = Platform.select({ web: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined });

type Props = {
  sales: { signature: string; price: number; t: number }[];
  daily: DailyPoint[];
  floor: number | null;
  rangeDays: number;
  asOf: number;
  dimmed?: boolean;
};

export function PriceChart({ sales, daily, floor, rangeDays, asOf, dimmed }: Props) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (!width || !daily.length) return null;
    const t0 = Math.floor((asOf - rangeDays * DAY) / DAY) * DAY;
    const t1 = Math.ceil(asOf / DAY) * DAY;
    // Rare-trait sales can sit at 2–3× floor and flatten everything else. The
    // y-domain covers the 2nd–92nd percentile (plus every median and the floor);
    // sales outside it are left off the plot and counted in the caption,
    // never pinned to the edge where they'd read as real values.
    const sorted = sales.map((s) => s.price).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const lo = Math.min(q(0.02), floor ?? Infinity, ...daily.map((d) => d.median));
    const hi = Math.max(q(0.92), floor ?? -Infinity, ...daily.map((d) => d.median));
    const ticks = niceTicks(lo, hi, 4);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const x = linear(t0, t1, PAD.left, width - PAD.right);
    const y = linear(yMin, yMax, PAD.top + PLOT_H, PAD.top);
    const shown = sales.filter((s) => s.price >= yMin && s.price <= yMax);
    const pts = daily.map((d) => ({ ...d, cx: x(d.day + DAY / 2), cy: y(d.median) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('');
    const xTicks = [t0, t0 + (t1 - t0) / 2, t1 - DAY].map((t) => ({ t, x: x(t + DAY / 2) }));
    return { x, y, ticks, pts, path, xTicks, shown, hidden: sales.length - shown.length, yMax };
  }, [width, sales, daily, floor, rangeDays, asOf]);

  const pick = (e: GestureResponderEvent) => {
    if (!geo) return;
    const lx = e.nativeEvent.locationX;
    let best = 0;
    geo.pts.forEach((p, i) => { if (Math.abs(p.cx - lx) < Math.abs(geo.pts[best].cx - lx)) best = i; });
    setActive(best);
  };

  const sel = geo && active != null ? geo.pts[active] : null;
  const last = geo?.pts[geo.pts.length - 1];

  return (
    <View style={{ opacity: dimmed ? 0.45 : 1 }}>
      <View style={s.legend}>
        <Key kind="line" label="Daily median" />
        <Key kind="dot" label="Sale" />
        {floor != null && <Key kind="ref" label="Floor now" />}
      </View>

      {/* Readout row: value leads, context follows. Holds its height so nothing jumps. */}
      <View style={s.readout}>
        {sel ? (
          <>
            <Text style={s.readVal}>{fmtSol(sel.median)} ◎</Text>
            <Text style={s.readCtx}>
              median · {fmtDay(sel.day)} · {sel.count} sale{sel.count === 1 ? '' : 's'} · range {fmtSol(sel.low)}–{fmtSol(sel.high)}
            </Text>
          </>
        ) : (
          <Text style={s.readCtx}>
            {Platform.OS === 'web' ? 'Hover' : 'Touch'} the chart for daily detail
            {geo?.hidden ? ` · ${geo.hidden} sale${geo.hidden === 1 ? '' : 's'} above ${fmtSol(geo.yMax)} ◎ not plotted` : ''}
          </Text>
        )}
      </View>

      <View
        style={{ height: PAD.top + PLOT_H + AXIS_H }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        {...(Platform.OS === 'web'
          ? { onPointerMove: (e: any) => pick({ nativeEvent: { locationX: e.nativeEvent.offsetX } } as any), onPointerLeave: () => setActive(null) }
          : {})}
        accessibilityRole="image"
        accessibilityLabel={last ? `Daily median sale price, latest ${fmtSol(last.median)} SOL` : 'Price chart'}>
        {geo && (
          <Svg width={width} height={PAD.top + PLOT_H + AXIS_H} pointerEvents="none">
            {/* recessive solid hairline grid + y ticks */}
            {geo.ticks.map((t) => (
              <G key={t}>
                <Line x1={PAD.left} x2={width - PAD.right} y1={geo.y(t)} y2={geo.y(t)} stroke={C.grid} strokeWidth={1} />
                <SvgText fontFamily={FONT} x={PAD.left - 6} y={geo.y(t) + 4} fill={C.dim} fontSize={11} textAnchor="end">{fmtSol(t)}</SvgText>
              </G>
            ))}
            {geo.xTicks.map(({ t, x }, i) => (
              <SvgText fontFamily={FONT} key={t} x={x} y={PAD.top + PLOT_H + 16} fill={C.dim} fontSize={11}
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{fmtDay(t)}</SvgText>
            ))}

            {/* context: every sale */}
            {geo.shown.map((p) => (
              <Circle key={p.signature} cx={geo.x(p.t)} cy={geo.y(p.price)} r={3} fill={C.muted} opacity={0.55} />
            ))}

            {/* reference: current floor (dashed = threshold, not a gridline) */}
            {floor != null && (
              <G>
                <Line x1={PAD.left} x2={width - PAD.right} y1={geo.y(floor)} y2={geo.y(floor)}
                  stroke={C.dim} strokeWidth={1} strokeDasharray="4 4" />
                <SvgText fontFamily={FONT} x={width - PAD.right + 6} y={geo.y(floor) + 4} fill={C.dim} fontSize={11}>floor</SvgText>
              </G>
            )}

            {/* emphasis: daily median */}
            <Path d={geo.path} stroke={C.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {last && (
              <G>
                <Circle cx={last.cx} cy={last.cy} r={6} fill={C.card} />
                <Circle cx={last.cx} cy={last.cy} r={4} fill={C.accent} />
                <SvgText fontFamily={FONT} x={last.cx + 9} y={last.cy - 8} fill={C.text} fontSize={12} fontWeight="700">{fmtSol(last.median)}</SvgText>
              </G>
            )}

            {/* crosshair */}
            {sel && (
              <G>
                <Line x1={sel.cx} x2={sel.cx} y1={PAD.top} y2={PAD.top + PLOT_H} stroke={C.dim} strokeWidth={1} />
                <Circle cx={sel.cx} cy={sel.cy} r={6} fill={C.card} />
                <Circle cx={sel.cx} cy={sel.cy} r={4} fill={C.accent} />
              </G>
            )}
          </Svg>
        )}
      </View>
    </View>
  );
}

function Key({ kind, label }: { kind: 'line' | 'dot' | 'ref'; label: string }) {
  return (
    <View style={s.key}>
      <Svg width={16} height={10}>
        {kind === 'line' && <Line x1={1} x2={15} y1={5} y2={5} stroke={C.accent} strokeWidth={2} strokeLinecap="round" />}
        {kind === 'dot' && <Circle cx={8} cy={5} r={3} fill={C.muted} />}
        {kind === 'ref' && <Line x1={0} x2={16} y1={5} y2={5} stroke={C.dim} strokeWidth={1} strokeDasharray="3 3" />}
      </Svg>
      <Text style={s.keyTxt}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  legend: { flexDirection: 'row', gap: 14, marginBottom: 6 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  keyTxt: { color: C.dim, fontSize: 12 },
  readout: { minHeight: 40, justifyContent: 'center' },
  readVal: { color: C.text, fontSize: 20, fontWeight: '800' },
  readCtx: { color: C.dim, fontSize: 12.5 },
});
