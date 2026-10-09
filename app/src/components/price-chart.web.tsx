import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import {
  AreaSeries, HistogramSeries, LineStyle,
  customSeriesDefaultOptions,
  type AutoscaleInfo, type CustomData, type CustomSeriesOptions, type ICustomSeriesPaneRenderer, type ICustomSeriesPaneView,
  type IPriceLine, type ISeriesApi, type PaneRendererCustomData,
  type PriceToCoordinateConverter, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

import { C } from '@/constants/brand';
import type { DailyPoint } from '@/lib/api';
import { alpha, tickFormatter, TV_URL, useLwChart } from '@/lib/lw-chart';
import { DAY, fmtWhen, priceSeries, type Sale, type Slot } from '@/lib/price-series';
import { fmtSol } from '@/lib/scale';

// Web price chart on TradingView Lightweight Charts (native keeps the SVG
// chart in price-chart.tsx). Two panes on one time axis:
//  - price: the rolling median is the one accent series (area), individual
//    sales are gray dots at their real time inside each bucket, the current
//    floor is a dashed price line;
//  - volume: SOL traded per bucket.
// Drag to pan, wheel/pinch to zoom; the tooltip follows the crosshair.
const TIP_W = 220;
const NARROW = 560; // below this the headline shows the hovered bucket instead of a tooltip

type Props = {
  sales: Sale[];
  buckets: DailyPoint[];
  bucketSec: number;
  floor: number | null;
  rangeDays: number;
  asOf: number;
  dimmed?: boolean;
  tall?: boolean;
};

// --- sale dots: a custom series, one row per bucket holding its sales ---
type DotRow = CustomData<Time> & { dots: { p: number; f: number }[] }; // f = offset within the bucket, 0..1

class SaleDots implements ICustomSeriesPaneView<Time, DotRow, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, DotRow> | null = null;
  radius = 2.5;
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: CanvasRenderingTarget2D, toY: PriceToCoordinateConverter) => {
        const d = this.data;
        if (!d?.visibleRange) return;
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          ctx.fillStyle = alpha(C.muted, 0.55);
          for (let i = d.visibleRange!.from; i < d.visibleRange!.to; i++) {
            const bar = d.bars[i];
            for (const dot of bar.originalData.dots ?? []) {
              const y = toY(dot.p);
              if (y == null) continue;
              ctx.beginPath();
              ctx.arc((bar.x + (dot.f - 0.5) * d.barSpacing) * hr, y * vr, this.radius * hr, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        });
      },
    };
  }
  update(data: PaneRendererCustomData<Time, DotRow>) { this.data = data; }
  // Only used for autoscale, which the series overrides with a percentile range.
  priceValueBuilder(row: DotRow) { return row.dots.length ? [row.dots[0].p] : []; }
  isWhitespace(row: DotRow | CustomData<Time>): row is CustomData<Time> { return !(row as DotRow).dots?.length; }
  defaultOptions() { return customSeriesDefaultOptions; }
}

type Hover = { slot: Slot; x: number } | null;

export function PriceChart({ sales, buckets, bucketSec, floor, rangeDays, asOf, dimmed, tall }: Props) {
  const PLOT_H = tall ? 300 : 220;
  const VOL_H = tall ? 80 : 56;
  const H = PLOT_H + VOL_H + 26;
  const { host, chart } = useLwChart();
  const [hover, setHover] = useState<Hover>(null);
  const [width, setWidth] = useState(0);
  const refs = useRef<{
    median: ISeriesApi<'Area'>; dots: ISeriesApi<'Custom', Time, DotRow | CustomData<Time>>; dotsView: SaleDots;
    vol: ISeriesApi<'Histogram'>; floorLine: IPriceLine | null;
  } | null>(null);

  const series = useMemo(() => priceSeries(sales, buckets, bucketSec, floor, rangeDays, asOf),
    [sales, buckets, bucketSec, floor, rangeDays, asOf]);
  // Latest props for the chart's callbacks (autoscale, crosshair).
  const salesRef = useRef(sales);
  const slotsRef = useRef(series.slots);
  const floorRef = useRef(floor);
  useEffect(() => {
    salesRef.current = sales;
    slotsRef.current = series.slots;
    floorRef.current = floor;
  });

  // Build the series once the chart exists.
  useEffect(() => {
    if (!chart) return;
    const median = chart.addSeries(AreaSeries, {
      lineColor: C.accent, lineWidth: 2,
      topColor: alpha(C.accent, 0.22), bottomColor: alpha(C.accent, 0),
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerRadius: 4, crosshairMarkerBorderColor: C.card, crosshairMarkerBorderWidth: 2,
      // Keep the floor reference line in view.
      autoscaleInfoProvider: (orig: () => AutoscaleInfo | null) => {
        const r = orig();
        const f = floorRef.current;
        if (!r?.priceRange || f == null) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, f), maxValue: Math.max(r.priceRange.maxValue, f) } };
      },
    });
    const dotsView = new SaleDots();
    const dots = chart.addCustomSeries(dotsView, {
      priceLineVisible: false, lastValueVisible: false,
      // 2nd–92nd percentile of the sales in view: a rare-trait sale at 3× floor
      // doesn't flatten the median; it's simply above the pane.
      autoscaleInfoProvider: () => {
        const r = chart.timeScale().getVisibleRange();
        const from = r ? (r.from as number) : -Infinity;
        const to = r ? (r.to as number) + DAY : Infinity;
        const ps = salesRef.current.filter((s) => s.t >= from && s.t <= to).map((s) => s.price).sort((a, b) => a - b);
        if (!ps.length) return null;
        const q = (p: number) => ps[Math.min(ps.length - 1, Math.floor(p * (ps.length - 1)))];
        return { priceRange: { minValue: q(0.02), maxValue: q(0.92) } };
      },
    }, 0);
    const vol = chart.addSeries(HistogramSeries, {
      color: C.barFill, priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: fmtSol },
    }, 1);
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });
    refs.current = { median, dots, dotsView, vol, floorLine: null };

    chart.subscribeCrosshairMove((param) => {
      if (param.time == null || !param.point || param.point.x < 0) { setHover(null); return; }
      const slot = slotsRef.current.find((s) => s.day === param.time);
      setHover(slot ? { slot, x: param.point.x } : null);
    });
    return () => { refs.current = null; };
  }, [chart]);

  // Push data whenever the range or data changes.
  useEffect(() => {
    const r = refs.current;
    if (!chart || !r) return;
    const t = (d: number) => d as UTCTimestamp;
    const intraday = bucketSec < DAY;
    chart.applyOptions({
      timeScale: { timeVisible: intraday, secondsVisible: false,
        tickMarkFormatter: tickFormatter(intraday) },
      localization: { priceFormatter: fmtSol, timeFormatter: (time: Time) => fmtWhen(time as number, bucketSec) },
    });
    chart.panes()[1]?.setStretchFactor(VOL_H / PLOT_H);

    const slots = series.slots;
    r.median.setData(slots.map((s) => (s.roll == null ? { time: t(s.day) } : { time: t(s.day), value: s.roll })));
    r.vol.setData(slots.map((s) => ({ time: t(s.day), value: s.volume })));
    const byBucket = new Map<number, DotRow['dots']>();
    for (const s of sales) {
      const day = Math.floor(s.t / bucketSec) * bucketSec;
      if (!byBucket.has(day)) byBucket.set(day, []);
      byBucket.get(day)!.push({ p: s.price, f: (s.t - day) / bucketSec });
    }
    r.dotsView.radius = tall ? 3 : 2.5;
    r.dots.setData(slots.map((s) => ({ time: t(s.day), dots: byBucket.get(s.day) ?? [] })));

    if (r.floorLine) r.median.removePriceLine(r.floorLine);
    r.floorLine = floor == null ? null : r.median.createPriceLine({
      price: floor, color: C.dim, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'floor',
      axisLabelColor: C.cardHi, axisLabelTextColor: C.text,
    });
    chart.timeScale().fitContent();
  }, [chart, series, sales, bucketSec, floor, tall, PLOT_H, VOL_H]);

  const { last, change, hi } = series;
  const hidden = sales.filter((s) => s.price > hi).length;
  const rangeLabel = rangeDays === 1 ? '24h' : `${rangeDays}d`;
  const sel = hover?.slot;
  const narrow = width < NARROW;
  const vMax = Math.max(...series.slots.map((x) => x.volume), 0);
  const per = bucketSec === 3600 ? 'hour' : bucketSec < DAY ? '6h' : 'day';

  return (
    <View style={{ opacity: dimmed ? 0.45 : 1 }}>
      {/* Headline: latest median and its change over the range; on narrow
          screens it shows the hovered bucket instead of a covering tooltip. */}
      {narrow && sel ? (
        <View style={s.head}>
          <Text style={s.headVal}>{sel.roll != null ? `${fmtSol(sel.roll)} SOL` : '—'}</Text>
          <Text style={s.ctx}>
            {fmtWhen(sel.day, bucketSec)} · {sel.count} sale{sel.count === 1 ? '' : 's'} · {fmtSol(sel.volume)} SOL volume
            {sel.roll != null && floor != null ? ` · ${sel.roll >= floor ? '+' : ''}${(((sel.roll - floor) / floor) * 100).toFixed(1)}% vs floor` : ''}
          </Text>
        </View>
      ) : (
        <View style={s.head}>
          {last && (
            <Text style={s.headVal}>
              {fmtSol(last.roll!)} SOL{'  '}
              {change != null && (
                <Text style={[s.headChg, { color: change >= 0 ? C.up : C.down }]}>
                  {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% {rangeLabel}
                </Text>
              )}
            </Text>
          )}
          <Text style={s.ctx}>
            median sale price, rolling {rangeDays <= 1 ? '3 hours' : '24 hours'}
            {hidden ? ` · ${hidden} rare-trait sale${hidden === 1 ? '' : 's'} above ${fmtSol(hi)} SOL off-chart` : ''}
          </Text>
        </View>
      )}

      <View style={s.legend}>
        <Key color={C.accent} kind="line" label="Rolling median" />
        <Key color={C.muted} kind="dot" label="Sale" />
        {floor != null && <Key color={C.dim} kind="ref" label="Floor now" />}
        <Key color={C.barFill} kind="bar" label="Volume" />
      </View>

      <View style={{ height: H }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        accessibilityRole="image"
        accessibilityLabel={last ? `Rolling median sale price, latest ${fmtSol(last.roll!)} SOL` : 'Price chart'}>
        <View ref={host} style={StyleSheet.absoluteFill} />

        {/* tooltip follows the crosshair, flips sides near the right edge */}
        {sel && hover && !narrow && (
          <View pointerEvents="none" style={[s.tip, {
            left: hover.x + 16 + TIP_W > width - 60 ? Math.max(0, hover.x - 16 - TIP_W) : hover.x + 16,
          }]}>
            <Text style={s.tipWhen}>{fmtWhen(sel.day, bucketSec)}</Text>
            {sel.roll != null && <TipRow label={`Rolling median (${rangeDays <= 1 ? '3h' : '24h'})`} value={`${fmtSol(sel.roll)} SOL`} strong />}
            {sel.roll != null && floor != null && (
              <TipRow label="vs floor now" value={`${sel.roll >= floor ? '+' : ''}${(((sel.roll - floor) / floor) * 100).toFixed(1)}%`} />
            )}
            <View style={s.tipSep} />
            <TipRow label="Sales in period" value={String(sel.count)} />
            {sel.count > 0 && <TipRow label="Period median" value={`${fmtSol(sel.median)} SOL`} />}
            {sel.count > 0 && <TipRow label="Low – high" value={`${fmtSol(sel.low)} – ${fmtSol(sel.high)}`} />}
            <TipRow label="Volume" value={`${fmtSol(sel.volume)} SOL`} />
          </View>
        )}
      </View>
      <Text style={s.hint}>
        Volume per {per} · peak {fmtSol(vMax)} SOL · {narrow ? 'touch for detail, drag to pan' : 'hover for detail · drag to pan · scroll to zoom'} ·{' '}
        <Text style={s.tv} onPress={() => Linking.openURL(TV_URL)}>Chart by TradingView</Text>
      </Text>
    </View>
  );
}

const TipRow = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <View style={s.tipRow}>
    <Text style={s.tipLabel}>{label}</Text>
    <Text style={[s.tipVal, strong && { fontWeight: '800', fontSize: 14 }]}>{value}</Text>
  </View>
);

function Key({ kind, color, label }: { kind: 'line' | 'dot' | 'ref' | 'bar'; color: string; label: string }) {
  const mark = {
    line: { width: 14, height: 2, borderRadius: 1, backgroundColor: color },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color },
    ref: { width: 14, height: 0, borderTopWidth: 1, borderStyle: 'dashed' as const, borderColor: color },
    bar: { width: 6, height: 9, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: color },
  }[kind];
  return (
    <View style={s.key}>
      <View style={{ width: 16, alignItems: 'center' }}><View style={mark} /></View>
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
  hint: { color: C.dim, fontSize: 11.5, marginTop: 4 },
  tv: { color: C.dim, textDecorationLine: 'underline' },
  tip: {
    position: 'absolute', top: 8, width: TIP_W, backgroundColor: C.cardHi, borderRadius: 10, padding: 10, gap: 3, zIndex: 5,
    borderWidth: 1, borderColor: C.border, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12,
  },
  tipWhen: { color: C.text, fontWeight: '700', fontSize: 12.5, marginBottom: 2 },
  tipRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tipSep: { height: 1, backgroundColor: C.border, marginVertical: 3 },
  tipLabel: { color: C.dim, fontSize: 12 },
  tipVal: { color: C.text, fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
