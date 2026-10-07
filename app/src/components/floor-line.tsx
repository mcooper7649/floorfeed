import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { C } from '@/constants/brand';
import { linear, niceTicks } from '@/lib/scale';

// Single-series floor history from our own snapshots (EVM collections).
const PAD = { top: 10, right: 12, left: 56, bottom: 22 };
const FONT = Platform.select({ web: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined });

const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(3) : v.toPrecision(2));
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

export function FloorLine({ points, currency, tall }: { points: { ts: number; floor: number }[]; currency: string; tall?: boolean }) {
  const H = tall ? 300 : 160;
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const vals = points.map((p) => p.floor);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), tall ? 5 : 3);
  const x = linear(points[0].ts, points[points.length - 1].ts, PAD.left, width - PAD.right);
  const y = linear(ticks[0], ticks[ticks.length - 1], H - PAD.bottom, PAD.top);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.floor).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const first = points[0];
  const change = ((last.floor - first.floor) / first.floor) * 100;
  const sel = active != null ? points[active] : null;

  const pick = (lx: number) => {
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(p.ts) - lx) < Math.abs(x(points[best].ts) - lx)) best = i; });
    setActive(best);
  };

  return (
    <View>
      <View style={s.head}>
        <Text style={s.val}>
          {fmt((sel ?? last).floor)} {currency}{'  '}
          {!sel && (
            <Text style={[s.chg, { color: change >= 0 ? C.up : C.down }]}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% since {fmtTime(first.ts)}
            </Text>
          )}
        </Text>
        <Text style={s.ctx}>{sel ? `floor at ${fmtTime(sel.ts)}` : 'current floor'}</Text>
      </View>
      <View style={{ height: H }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => pick(e.nativeEvent.locationX)}
        onResponderMove={(e) => pick(e.nativeEvent.locationX)}
        {...(Platform.OS === 'web'
          ? { onPointerMove: (e: any) => pick(e.nativeEvent.offsetX), onPointerLeave: () => setActive(null) }
          : {})}
        accessibilityRole="image" accessibilityLabel={`Floor history, latest ${fmt(last.floor)} ${currency}`}>
        {width > 0 && (
          <Svg width={width} height={H} pointerEvents="none">
            {ticks.map((t) => (
              <G key={t}>
                <Line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
                <SvgText fontFamily={FONT} x={PAD.left - 8} y={y(t) + 4} fill={C.dim} fontSize={11} textAnchor="end">{fmt(t)}</SvgText>
              </G>
            ))}
            <SvgText fontFamily={FONT} x={PAD.left} y={H - 5} fill={C.dim} fontSize={11}>{fmtTime(first.ts)}</SvgText>
            <SvgText fontFamily={FONT} x={width - PAD.right} y={H - 5} fill={C.dim} fontSize={11} textAnchor="end">{fmtTime(last.ts)}</SvgText>
            <Path d={d} stroke={C.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {sel ? (
              <G>
                <Line x1={x(sel.ts)} x2={x(sel.ts)} y1={PAD.top} y2={H - PAD.bottom} stroke={C.dim} strokeWidth={1} />
                <Circle cx={x(sel.ts)} cy={y(sel.floor)} r={6} fill={C.card} />
                <Circle cx={x(sel.ts)} cy={y(sel.floor)} r={4} fill={C.accent} />
              </G>
            ) : (
              <G>
                <Circle cx={x(last.ts)} cy={y(last.floor)} r={6} fill={C.card} />
                <Circle cx={x(last.ts)} cy={y(last.floor)} r={4} fill={C.accent} />
              </G>
            )}
          </Svg>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  head: { gap: 2, marginBottom: 8 },
  val: { color: C.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  chg: { fontSize: 13, fontWeight: '800' },
  ctx: { color: C.dim, fontSize: 12.5 },
});
