import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { AreaSeries, LineType, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';

import { C } from '@/constants/brand';
import { alpha, tickFormatter, TV_URL, useLwChart } from '@/lib/lw-chart';

// Web floor history (EVM collections) on Lightweight Charts; native keeps
// the SVG chart in floor-line.tsx. Snapshots are every ~10 minutes.
const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(3) : v.toPrecision(2));
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

export function FloorLine({ points, currency, tall }: { points: { ts: number; floor: number }[]; currency: string; tall?: boolean }) {
  const H = tall ? 300 : 180;
  const { host, chart } = useLwChart({
    localization: { priceFormatter: fmt, timeFormatter: (t: Time) => fmtTime((t as number) * 1000) },
    timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: tickFormatter(true) },
  });
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [sel, setSel] = useState<{ ts: number; floor: number } | null>(null);
  const pointsRef = useRef(points);
  useEffect(() => { pointsRef.current = points; });

  useEffect(() => {
    if (!chart) return;
    seriesRef.current = chart.addSeries(AreaSeries, {
      lineColor: C.accent, lineWidth: 2, lineType: LineType.WithSteps, topColor: alpha(C.accent, 0.22), bottomColor: alpha(C.accent, 0),
      priceLineVisible: false, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: C.card, crosshairMarkerBorderWidth: 2,
    });
    chart.subscribeCrosshairMove((p) => {
      if (p.time == null) return setSel(null);
      setSel(pointsRef.current.find((x) => Math.floor(x.ts / 1000) === p.time) ?? null);
    });
    return () => { seriesRef.current = null; };
  }, [chart]);

  useEffect(() => {
    if (!chart || !seriesRef.current) return;
    // One point per second at most (the time axis needs strictly increasing times).
    const rows = new Map<number, number>();
    for (const p of [...points].sort((a, b) => a.ts - b.ts)) rows.set(Math.floor(p.ts / 1000), p.floor);
    seriesRef.current.setData([...rows].map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    chart.timeScale().fitContent();
  }, [chart, points]);

  const first = points[0];
  const last = points[points.length - 1];
  const change = ((last.floor - first.floor) / first.floor) * 100;

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
      <View style={{ height: H }} accessibilityRole="image" accessibilityLabel={`Floor history, latest ${fmt(last.floor)} ${currency}`}>
        <View ref={host} style={StyleSheet.absoluteFill} />
      </View>
      <Text style={s.tv} onPress={() => Linking.openURL(TV_URL)}>Chart by TradingView</Text>
    </View>
  );
}

const s = StyleSheet.create({
  head: { gap: 2, marginBottom: 8 },
  val: { color: C.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  chg: { fontSize: 13, fontWeight: '800' },
  ctx: { color: C.dim, fontSize: 12.5 },
  tv: { color: C.dim, fontSize: 11.5, marginTop: 4, textDecorationLine: 'underline' },
});
