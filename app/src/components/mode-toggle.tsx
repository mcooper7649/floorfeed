import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { useTradeMode, type TradeMode } from '@/lib/mode';
import { track } from '@/lib/analytics';

// Paper is tinted with the AI/practice purple, Real with the brand accent, so
// the current mode reads at a glance wherever it shows up.
export const MODE_COLOR: Record<TradeMode, string> = { paper: C.ai, real: C.accent };

const COPY: Record<TradeMode, string> = {
  paper: 'Practice with simulated trades. No real SOL moves.',
  real: 'Buys use your connected wallet. Your wallet asks before anything is signed.',
};

// Segmented Paper | Real switch. Real is disabled until a wallet is connected.
export function ModeToggle({ describe = true }: { describe?: boolean }) {
  const { mode, canReal, setMode } = useTradeMode();
  const seg = (m: TradeMode, label: string) => {
    const on = mode === m;
    const disabled = m === 'real' && !canReal;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: on, disabled }}
        accessibilityLabel={`${label} mode`}
        disabled={disabled}
        onPress={() => { setMode(m); if (m === 'real' && !on) track('mode_real'); }}
        style={[s.seg, on && { backgroundColor: MODE_COLOR[m] }, disabled && { opacity: 0.4 }]}>
        <Text style={[s.segTxt, on && { color: C.accentInk }]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={s.track}>
        {seg('paper', 'Paper')}
        {seg('real', 'Real')}
      </View>
      {describe && (
        <Text style={s.copy}>{canReal ? COPY[mode] : 'Connect a wallet or sign in to switch to real trading.'}</Text>
      )}
    </View>
  );
}

// Small label for buttons and headers: "PAPER" / "REAL".
export function ModeChip({ mode }: { mode: TradeMode }) {
  return (
    <View style={[s.chip, { borderColor: MODE_COLOR[mode] }]}>
      <Text style={[s.chipTxt, { color: MODE_COLOR[mode] }]}>{mode === 'real' ? 'REAL' : 'PAPER'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  track: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: C.border },
  seg: { flex: 1, borderRadius: 9, paddingVertical: 8, alignItems: 'center' },
  segTxt: { ...T.button, color: C.dim },
  copy: T.meta,
  chip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  chipTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
});
