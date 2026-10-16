import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { NftImage } from '@/components/nft-image';
import { Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type HistoryEntry } from '@/lib/api';
import { timeAgo, usd } from '@/lib/format';
import { TYPE, inFlight, lifecycle, signedPrice, statusOf } from '@/lib/history';
import { usePrices } from '@/lib/prices';

// The latest of the wallets' history (FloorFeed transactions plus marketplace
// buys, sales and listings with their outcome), newest first, linking to the
// full History page. Polls while a FloorFeed transaction is still in flight,
// and refreshes when a sheet records one ('floorfeed:activity') or a listing
// changes ('floorfeed:listing').

export function ActivityList({ wallets, onSettled, limit = 8 }: {
  wallets: string[];
  onSettled?: () => void; // something just confirmed: balances/holdings changed
  limit?: number;
}) {
  const { toUsd } = usePrices();
  const [items, setItems] = useState<{ wallet: string; list: HistoryEntry[] } | null>(null);

  const wallet = wallets.join(',');
  const load = useCallback(() => {
    api.history(wallet.split(','))
      .then((h) => setItems((prev) => {
        // A pending entry that just settled means balances moved.
        const before = prev?.wallet === wallet ? prev.list : [];
        if (before.some((b) => inFlight(b) && h.entries.find((x) => x.id === b.id && !inFlight(x)))) onSettled?.();
        return { wallet, list: h.entries };
      })).catch(() => {});
  }, [wallet, onSettled]);

  useEffect(() => {
    load();
    const soon = () => setTimeout(load, 1_500);
    window.addEventListener?.('floorfeed:activity', soon);
    window.addEventListener?.('floorfeed:listing', soon);
    return () => {
      window.removeEventListener?.('floorfeed:activity', soon);
      window.removeEventListener?.('floorfeed:listing', soon);
    };
  }, [load]);

  const list = items?.wallet === wallet ? items.list : null;
  const busy = !!list?.some(inFlight);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 6_000);
    return () => clearInterval(t);
  }, [busy, load]);

  if (list == null) return <Card><ActivityIndicator color={C.accent} /></Card>;
  if (!list.length) {
    return (
      <Card>
        <Text style={T.meta}>Buys, sales, listings and moves you make show up here with their status, so you can see each one went through.</Text>
      </Card>
    );
  }
  const openHistory = () => router.push({ pathname: '/history', params: { w: wallet } });
  return (
    <Card style={{ gap: 0, paddingVertical: 4 }}>
      {list.slice(0, limit).map((i, n) => {
        const st = statusOf(i.status);
        const price = signedPrice(i);
        const dollars = i.price != null && i.unit ? toUsd(i.price, i.unit) : null;
        const detail = lifecycle(i) ?? [i.collection, i.saleKind === 'offer' && i.type === 'sale' ? 'accepted offer' : null].filter(Boolean).join(' · ');
        return (
          <Pressable key={i.id} accessibilityRole="link" onPress={openHistory} style={[s.row, n > 0 && s.divider]}>
            {i.image
              ? <NftImage uri={i.image} name={i.name} radius={10} px={96} style={{ width: 36 }} />
              : <View style={s.icon}><Text style={s.iconTxt}>{TYPE[i.type]?.icon ?? '•'}</Text></View>}
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={T.bodyStrong} numberOfLines={1}>{TYPE[i.type]?.label ?? i.type} · {i.name || i.title}</Text>
              <View style={s.metaRow}>
                <ChainBadge chain={i.chain as never} />
                {i.toChain && <Text style={T.metaNum}>→ {chainName(i.toChain)}</Text>}
                <Text style={T.metaNum} numberOfLines={1}>{timeAgo(i.at)} ago{detail ? ` · ${detail}` : ''}</Text>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              {price && <Text style={[T.num, { color: i.type === 'sale' ? C.up : C.text }]}>{price}</Text>}
              {dollars != null && !inFlight(i) && i.type !== 'listing' && <Text style={T.metaNum}>≈ {usd(dollars)}</Text>}
              <View style={s.status}>
                {inFlight(i) && <ActivityIndicator size="small" color={C.dim} />}
                <Text style={[T.label, { color: st.color }]}>{st.label}</Text>
              </View>
            </View>
          </Pressable>
        );
      })}
      <Pressable accessibilityRole="link" onPress={openHistory} style={s.more}>
        <Text style={[T.label, { color: C.text }]}>Full history{list.length > limit ? ` (${list.length})` : ''} · filter & export CSV →</Text>
      </Pressable>
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  iconTxt: { ...T.bodyStrong, color: C.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  more: { paddingVertical: 12, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
