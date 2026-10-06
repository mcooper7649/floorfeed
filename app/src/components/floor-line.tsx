import { useState } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { C } from '@/constants/brand';
import { linear, niceTicks } from '@/lib/scale';

// Single-series floor history from our own snapshots (EVM collections).
const H = 140;
const PAD = { top: 10, right: 12, left: 52, bottom: 20 };
const FONT = Platform.select({ web: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined });

const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(3) : v.toPrecision(2));
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

export function FloorLine({ points, currency }: { points: { ts: number; floor: number }[]; currency: string }) {
  const [width, setWidth] = useState(0);
  const vals = points.map((p) => p.floor);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 3);
  const x = linear(points[0].ts, points[points.length - 1].ts, PAD.left, width - PAD.right);
  const y = linear(ticks[0], ticks[ticks.length - 1], H - PAD.bottom, PAD.top);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.floor).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  return (
    <View style={{ height: H }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityRole="image" accessibilityLabel={`Floor history, latest ${fmt(last.floor)} ${currency}`}>
      {width > 0 && (
        <Svg width={width} height={H}>
          {ticks.map((t) => (
            <G key={t}>
              <Line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
              <SvgText fontFamily={FONT} x={PAD.left - 6} y={y(t) + 4} fill={C.dim} fontSize={11} textAnchor="end">{fmt(t)}</SvgText>
            </G>
          ))}
          <SvgText fontFamily={FONT} x={PAD.left} y={H - 4} fill={C.dim} fontSize={11}>{fmtTime(points[0].ts)}</SvgText>
          <SvgText fontFamily={FONT} x={width - PAD.right} y={H - 4} fill={C.dim} fontSize={11} textAnchor="end">{fmtTime(last.ts)}</SvgText>
          <Path d={d} stroke={C.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={x(last.ts)} cy={y(last.floor)} r={6} fill={C.card} />
          <Circle cx={x(last.ts)} cy={y(last.floor)} r={4} fill={C.accent} />
        </Svg>
      )}
    </View>
  );
}
