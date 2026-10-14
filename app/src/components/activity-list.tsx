import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type ActivityItem } from '@/lib/api';
import { amt, timeAgo, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// The wallet's FloorFeed transactions with their real outcome, newest first.
// Polls while anything is still in flight, and refreshes when a sheet records
// a new transaction (the 'floorfeed:activity' event).

const STATUS: Record<ActivityItem['status'], { label: string; color: string }> = {
  pending: { label: 'Pending', color: C.dim },
  delivering: { label: 'Delivering', color: C.dim },
  confirmed: { label: 'Confirmed', color: C.up },
  failed: { label: 'Failed', color: C.down },
  dropped: { label: 'Not sent', color: C.down },
  refunded: { label: 'Refunded', color: C.dim },
};
const ICON: Record<ActivityItem['kind'], string> = { buy: '↓', sell: '↑', approve: '✓', bridge: '⇄', send: '→', unwrap: '◎', mint: '✦' };

export function ActivityList({ wallet, onSettled, limit = 8 }: {
  wallet: string;
  onSettled?: () => void; // something just confirmed: balances/holdings changed
  limit?: number;
}) {
  const { toUsd } = usePrices();
  const [items, setItems] = useState<{ wallet: string; list: ActivityItem[] } | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    api.activity(wallet).then((list) => setItems((prev) => {
      // A pending entry that just settled means balances moved.
      const before = prev?.wallet === wallet ? prev.list : [];
      if (before.some((b) => (b.status === 'pending' || b.status === 'delivering')
        && list.find((x) => x.hash === b.hash && x.status !== 'pending' && x.status !== 'delivering'))) onSettled?.();
      return { wallet, list };
    })).catch(() => {});
  }, [wallet, onSettled]);

  useEffect(() => {
    load();
    const soon = () => setTimeout(load, 1_500);
    window.addEventListener?.('floorfeed:activity', soon);
    return () => window.removeEventListener?.('floorfeed:activity', soon);
  }, [load]);

  const list = items?.wallet === wallet ? items.list : null;
  const inFlight = !!list?.some((i) => i.status === 'pending' || i.status === 'delivering');
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 6_000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  if (list == null) return <Card><ActivityIndicator color={C.accent} /></Card>;
  if (!list.length) {
    return (
      <Card>
        <Text style={T.meta}>Buys, sales, moves and sends you make in FloorFeed show up here with their status, so you can see each one went through.</Text>
      </Card>
    );
  }
  const shown = all ? list : list.slice(0, limit);
  return (
    <Card style={{ gap: 0, paddingVertical: 4 }}>
      {shown.map((i, n) => {
        const st = STATUS[i.status] ?? STATUS.pending;
        const dollars = i.amount != null && i.unit ? toUsd(i.amount, i.unit) : null;
        return (
          <Pressable key={i.hash} accessibilityRole="link" onPress={() => Linking.openURL(i.outUrl ?? i.explorerUrl)}
            style={[s.row, n > 0 && s.divider]}>
            <View style={s.icon}><Text style={s.iconTxt}>{ICON[i.kind] ?? '•'}</Text></View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={T.bodyStrong} numberOfLines={1}>{i.title}</Text>
              <View style={s.metaRow}>
                <ChainBadge chain={i.chain as never} />
                {i.toChain && <Text style={T.metaNum}>→ {chainName(i.toChain)}</Text>}
                <Text style={T.metaNum}>{timeAgo(i.createdAt)} ago · View ↗</Text>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              {i.amount != null && i.unit && <Text style={[T.num, { color: C.text }]}>{amt(i.amount, i.unit)}</Text>}
              {dollars != null && <Text style={T.metaNum}>≈ {usd(dollars)}</Text>}
              <View style={s.status}>
                {(i.status === 'pending' || i.status === 'delivering') && <ActivityIndicator size="small" color={C.dim} />}
                <Text style={[T.label, { color: st.color }]}>{st.label}</Text>
              </View>
            </View>
          </Pressable>
        );
      })}
      {list.length > limit && (
        <Pressable accessibilityRole="button" onPress={() => setAll((v) => !v)} style={s.more}>
          <Text style={T.label}>{all ? 'Show less' : `Show all ${list.length}`}</Text>
        </Pressable>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  iconTxt: { ...T.bodyStrong, color: C.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  more: { paddingVertical: 10, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
