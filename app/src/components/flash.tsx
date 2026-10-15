import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { C } from '@/constants/brand';

// FOMO-style tick indicators for live lists. A row watches a number (a floor,
// a value) and a counter (sales); when the number moves, the row's background
// flashes green or red and fades, with an arrow by the value; when the counter
// grows, a small "+N sales" pulse shows activity at a glance. The first value
// a row sees never flashes, so lists don't light up on load.

export type Tick = 'up' | 'down' | null;
const HOLD = 4_000; // how long the arrow / sale pulse stays after a change

// 'up' / 'down' for a few seconds after `value` changes.
export function useTick(value: number | null | undefined): { tick: Tick; at: number } {
  const prev = useRef(value);
  const [state, setState] = useState<{ tick: Tick; at: number }>({ tick: null, at: 0 });
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    if (was == null || value == null || was === value) return;
    // Ignore float noise (USD conversions etc.).
    if (Math.abs(value - was) <= Math.abs(was) * 1e-9) return;
    const at = Date.now();
    setState({ tick: value > was ? 'up' : 'down', at });
    const t = setTimeout(() => setState((s) => (s.at === at ? { tick: null, at } : s)), HOLD);
    return () => clearTimeout(t);
  }, [value]);
  return state;
}

// How much `count` just grew by (shown for a few seconds), e.g. new sales.
export function useBump(count: number | null | undefined): { by: number; at: number } {
  const prev = useRef(count);
  const [state, setState] = useState({ by: 0, at: 0 });
  useEffect(() => {
    const was = prev.current;
    prev.current = count;
    if (was == null || count == null || count <= was) return;
    const at = Date.now();
    setState({ by: count - was, at });
    const t = setTimeout(() => setState((s) => (s.at === at ? { by: 0, at } : s)), HOLD);
    return () => clearTimeout(t);
  }, [count]);
  return state;
}

// Absolute-fill background that flashes the tick's color and fades out.
// `at` restarts the animation when the same direction ticks again.
export function FlashBg({ tick, at, style }: { tick: Tick; at: number; style?: ViewStyle }) {
  const [o] = useState(() => new Animated.Value(0));
  // The fade ends long before the tick clears, so the color can follow the tick.
  const color: string = tick === 'down' ? C.down : C.up;
  useEffect(() => {
    if (!tick) return;
    o.setValue(0.28);
    Animated.timing(o, { toValue: 0, duration: 1_800, useNativeDriver: true }).start();
  }, [tick, at, o]);
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: o, borderRadius: 8 }, style]} />;
}

export function TickArrow({ tick }: { tick: Tick }) {
  if (!tick) return null;
  return <Text style={{ color: tick === 'up' ? C.up : C.down, fontSize: 10, fontWeight: '700' }}>{tick === 'up' ? '▲' : '▼'} </Text>;
}

// "+2 sales" pill with a pulsing dot while a bump is fresh.
export function SalePulse({ by, at, label = 'sale' }: { by: number; at: number; label?: string }) {
  const [o] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!by) return;
    o.setValue(1);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.25, duration: 450, useNativeDriver: true }),
      Animated.timing(o, { toValue: 1, duration: 450, useNativeDriver: true }),
    ]), { iterations: 4 });
    loop.start();
    return () => loop.stop();
  }, [by, at, o]);
  if (!by) return null;
  return (
    <View style={s.pill}>
      <Animated.View style={[s.dot, { opacity: o }]} />
      <Text style={s.pillTxt}>+{by} {label}{by === 1 ? '' : 's'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: C.cardHi },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.accent },
  pillTxt: { color: C.accent, fontSize: 10, fontWeight: '700' },
});
