import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';

// Shared building blocks so screens stay consistent: one card, one section
// header, one list row, one stat tile, one chip, two button weights and the
// follow button. Type comes from constants/type.ts; corners are 16 for cards,
// 12 for tiles and buttons, round for chips.

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
export function ListRow({ art, title, meta, value, valueColor, note, sub, subColor, action, onPress, onMenu }: {
  art?: ReactNode;
  title: string;
  meta?: string;
  value?: string;
  valueColor?: string;
  note?: string; // a second reading of `value`, e.g. its dollar value
  sub?: string;
  subColor?: string;
  action?: ReactNode;
  onPress?: () => void;
  onMenu?: (e: unknown) => void; // right-click (web) / long-press: a quick menu (quick-menu.tsx)
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
          {note ? <Text style={T.metaNum}>{note}</Text> : null}
          {sub ? <Text style={[T.metaNum, subColor ? { color: subColor } : null]}>{sub}</Text> : null}
        </View>
      ) : null}
    </>
  );
  return (
    <View style={s.row} {...(onMenu ? { onContextMenu: onMenu } as object : {})}>
      {onPress
        ? <Pressable accessibilityRole="link" onPress={onPress} onLongPress={onMenu} style={s.rowMain}>{body}</Pressable>
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

// A number with its label. `tile` sits on its own surface (grids of stats);
// `plain` sits inside a card or a header row.
export function Stat({ label, value, sub, color, tone = 'tile', style }: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  tone?: 'tile' | 'plain' | 'inset';
  style?: ViewStyle;
}) {
  return (
    <View style={[tone === 'tile' ? s.statTile : tone === 'inset' ? s.statInset : s.statPlain, style]}>
      <Text style={T.label} numberOfLines={1}>{label}</Text>
      <Text style={[tone === 'inset' ? T.num : T.value, color ? { color } : null]} numberOfLines={1}>{value}</Text>
      {sub ? <Text style={T.metaNum} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

// Filter chip: one look everywhere (leaderboard, markets, ranges, feed).
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={({ pressed }) => [s.chip, on && s.chipOn, pressed && !on && { opacity: 0.8 }]}>
      <Text style={[T.label, { color: on ? C.accentInk : C.text }]}>{label}</Text>
    </Pressable>
  );
}

// A row of chips groups that scrolls sideways on narrow screens. Groups are
// separated by a thin divider.
export function ChipRow({ groups, pad = 0 }: { groups: ReactNode[]; pad?: number }) {
  return (
    <View style={s.chipBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.chipRow, { paddingHorizontal: pad }]}>
        {groups.filter(Boolean).map((g, i) => (
          <View key={i} style={s.chipGroup}>
            {i > 0 && <View style={s.chipSep} />}
            {g}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export function FollowButton({ on, onPress, size = 'sm' }: { on: boolean; onPress: () => void; size?: 'sm' | 'lg' }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={({ pressed }) => [size === 'lg' ? s.followLg : s.follow, on && s.following, pressed && { opacity: 0.8 }]}>
      <Text style={[T.label, { color: on ? C.dim : C.bg }]}>{on ? 'Following' : 'Follow'}</Text>
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
  statTile: { flexGrow: 1, flexBasis: 140, backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, gap: 2 },
  statInset: { flex: 1, backgroundColor: C.cardHi, borderRadius: 10, padding: 10, gap: 1 },
  statPlain: { gap: 2 },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipBar: { height: 46 },
  chipRow: { alignItems: 'center' },
  chipGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipSep: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 6 },
  follow: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: C.text },
  followLg: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 11, backgroundColor: C.text, alignItems: 'center' },
  following: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
});
