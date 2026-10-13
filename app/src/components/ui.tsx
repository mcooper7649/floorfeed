import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';

// Shared building blocks so screens stay consistent: one card, one section
// header, one list row, two button weights. Type comes from constants/type.ts.

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionHeader({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={T.title}>
        {title}
        {count != null ? <Text style={[T.title, { color: C.muted }]}>  {count}</Text> : null}
      </Text>
      {action}
    </View>
  );
}

// [art] title / meta ............ value / sub [action]
export function ListRow({ art, title, meta, value, valueColor, sub, subColor, action, onPress }: {
  art?: ReactNode;
  title: string;
  meta?: string;
  value?: string;
  valueColor?: string;
  sub?: string;
  subColor?: string;
  action?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      {art}
      <View style={s.rowText}>
        <Text style={T.bodyStrong} numberOfLines={1}>{title}</Text>
        {meta ? <Text style={T.metaNum} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {value != null || sub ? (
        <View style={s.rowValue}>
          {value != null ? <Text style={[T.num, valueColor ? { color: valueColor } : null]}>{value}</Text> : null}
          {sub ? <Text style={[T.metaNum, subColor ? { color: subColor } : null]}>{sub}</Text> : null}
        </View>
      ) : null}
    </>
  );
  return (
    <View style={s.row}>
      {onPress
        ? <Pressable accessibilityRole="link" onPress={onPress} style={s.rowMain}>{body}</Pressable>
        : <View style={s.rowMain}>{body}</View>}
      {action}
    </View>
  );
}

export function Button({ label, onPress, tone = 'primary', color, disabled }: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'secondary';
  color?: string; // primary fill (defaults to the brand accent)
  disabled?: boolean;
}) {
  const primary = tone === 'primary';
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={({ pressed }) => [primary ? [s.btn, { backgroundColor: color ?? C.accent }] : s.btnAlt, (pressed || disabled) && { opacity: 0.75 }]}>
      <Text style={[T.button, { color: primary ? C.accentInk : C.text }]}>{label}</Text>
    </Pressable>
  );
}

// Compact trailing action inside list rows.
export function RowAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={({ pressed }) => [s.rowAction, pressed && { opacity: 0.7 }]}>
      <Text style={[T.label, { color: C.text }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 16, gap: 12 },
  section: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowValue: { alignItems: 'flex-end', gap: 2 },
  btn: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  btnAlt: {
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi,
  },
  rowAction: { borderRadius: 999, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, paddingHorizontal: 12, paddingVertical: 6 },
});
