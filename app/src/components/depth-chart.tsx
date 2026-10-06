import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';

import { C } from '@/constants/brand';
import { linear, niceTicks } from '@/lib/scale';

// Floor depth: how far above the floor each of the cheapest listings sits.
// Columns grow from a 0% baseline (= the floor), one series in one color.
const PLOT_H = 120;
const AXIS_H = 20;
const FONT = Platform.select({ web: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', default: undefined });
const PAD = { top: 8, left: 36, right: 4 };

export function DepthChart({ listings, floor }: { listings: { mint: string; price: number }[]; floor: number }) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const prem = listings.map((l) => ((l.price - floor) / floor) * 100);
  const ticks = niceTicks(0, Math.max(1, ...prem), 3);
  const yMax = ticks[ticks.length - 1];
  const y = linear(0, yMax, PAD.top + PLOT_H, PAD.top);
  const n = listings.length;
  const slot = width ? (width - PAD.left - PAD.right) / Math.max(n, 1) : 0;
  const bw = Math.min(24, slot - 2); // capped thickness, >= 2px surface gap
  const sel = active != null ? listings[active] : null;

  // Column with a 4px rounded data-end and a square baseline.
  const col = (x: number, top: number, w: number) => {
    const base = PAD.top + PLOT_H;
    const h = base - top;
    const r = Math.min(4, w / 2, h);
    return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
  };

  return (
    <View>
      <View style={s.readout}>
        {sel ? (
          <Text style={s.readCtx}>
            <Text style={s.readVal}>{sel.price.toFixed(3)} ◎</Text>  #{active! + 1} cheapest · +{prem[active!].toFixed(1)}% over floor
          </Text>
        ) : (
          <Text style={s.readCtx}>Tap a column for the listing price</Text>
        )}
      </View>
      <View
        style={{ height: PAD.top + PLOT_H + AXIS_H }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          const i = Math.floor((e.nativeEvent.locationX - PAD.left) / slot);
          setActive(i >= 0 && i < n ? i : null);
        }}
        accessibilityRole="image"
        accessibilityLabel={`Cheapest ${n} listings, up to ${prem[n - 1]?.toFixed(0)} percent above floor`}>
        {width > 0 && (
          <Svg width={width} height={PAD.top + PLOT_H + AXIS_H} pointerEvents="none">
            {ticks.map((t) => (
              <Line key={t} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
            ))}
            {ticks.map((t) => (
              <SvgText fontFamily={FONT} key={'l' + t} x={PAD.left - 6} y={y(t) + 4} fill={C.dim} fontSize={11} textAnchor="end">+{t}%</SvgText>
            ))}
            {listings.map((l, i) => {
              const x = PAD.left + i * slot + (slot - bw) / 2;
              const top = Math.min(y(prem[i]), PAD.top + PLOT_H - 2); // at-floor listings stay visible
              return <Path key={`${i}:${l.mint}`} d={col(x, top, bw)} fill={C.barFill} opacity={active == null || active === i ? 1 : 0.5} />;
            })}
            <SvgText fontFamily={FONT} x={PAD.left} y={PAD.top + PLOT_H + 15} fill={C.dim} fontSize={11}>cheapest</SvgText>
            <SvgText fontFamily={FONT} x={width - PAD.right} y={PAD.top + PLOT_H + 15} fill={C.dim} fontSize={11} textAnchor="end">#{n}</SvgText>
          </Svg>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  readout: { minHeight: 28, justifyContent: 'center' },
  readVal: { color: C.text, fontSize: 15, fontWeight: '800' },
  readCtx: { color: C.dim, fontSize: 12.5 },
});
