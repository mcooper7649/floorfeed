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
