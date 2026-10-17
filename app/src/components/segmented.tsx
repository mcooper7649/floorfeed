import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';

// A compact segmented control: one choice out of a few, as a pill with a
// raised selection. Used for feed filters and anywhere a small set of
// mutually exclusive options sits in a row.
export function Segmented<K extends string>({ items, value, onChange, label }: {
  items: { key: K; label: string; count?: number | null }[];
  value: K;
  onChange: (k: K) => void;
  label?: string; // for screen readers
}) {
  return (
    <View style={s.seg} accessibilityRole="tablist" accessibilityLabel={label}>
      {items.map((t) => {
        const on = value === t.key;
        return (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: on }}
            onPress={() => !on && onChange(t.key)}
            style={({ hovered }: { hovered?: boolean }) => [s.btn, on && s.on, !on && hovered && { backgroundColor: C.card }]}>
            <Text style={[s.txt, on && { color: C.text }]} numberOfLines={1}>{t.label}</Text>
            {t.count != null && t.count > 0 && <Text style={[s.count, on && { color: C.accent }]}>{t.count}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  seg: { flexDirection: 'row', padding: 3, gap: 2, borderRadius: 10, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, alignSelf: 'flex-start' },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7 },
  on: { backgroundColor: C.cardHi },
  txt: { color: C.dim, fontSize: 13, fontWeight: '600' },
  count: { color: C.muted, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

// An on/off pill that sits with the segmented controls ("Hide bots").
export function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={() => onChange(!on)}
      style={({ hovered }: { hovered?: boolean }) => [t.pill, hovered && { backgroundColor: C.card }]}>
      <View style={[t.track, on && t.trackOn]}><View style={[t.knob, on && t.knobOn]} /></View>
      <Text style={[t.txt, on && { color: C.text }]}>{label}</Text>
    </Pressable>
  );
}

const t = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignSelf: 'flex-start' },
  track: { width: 26, height: 16, borderRadius: 8, backgroundColor: C.border, padding: 2 },
  trackOn: { backgroundColor: C.accent },
  knob: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.dim },
  knobOn: { backgroundColor: C.accentInk, transform: [{ translateX: 10 }] },
  txt: { color: C.dim, fontSize: 13, fontWeight: '600' },
});
