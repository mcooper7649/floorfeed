import Svg, { Circle, Path } from 'react-native-svg';

import { C } from '@/constants/brand';
import { linear } from '@/lib/scale';

// Stat-tile trend: history in the de-emphasis hue, the latest point in the accent.
export function Sparkline({ values, width = 72, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <Svg width={width} height={height} />;
  const pad = 4;
  const x = linear(0, values.length - 1, pad, width - pad);
  const y = linear(Math.min(...values), Math.max(...values), height - pad, pad);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const lx = x(values.length - 1);
  const ly = y(values[values.length - 1]);
  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={C.muted} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={lx} cy={ly} r={4} fill={C.card} />
      <Circle cx={lx} cy={ly} r={2.5} fill={C.accent} />
    </Svg>
  );
}
