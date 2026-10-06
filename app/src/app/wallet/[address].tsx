import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { Empty } from '@/components/screen';
import { C } from '@/constants/brand';
import { api, type WalletDetail } from '@/lib/api';
import { holdTime, pct, shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function WalletScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const { following, toggleFollow } = useSession();
  const [data, setData] = useState<WalletDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.wallet(address).then(setData).catch((e) => setError(e.message)); }, [address]);

  if (error) return <Empty text={error} />;
  if (!data) return <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />;
  const st = data.stats;
  const pf = data.profile;
  const isFollowing = following.has(address);

  return (
    <>
      <Stack.Screen options={{ title: shortAddr(address) }} />
      <FlatList
        data={data.trades}
        keyExtractor={(t) => t.signature + t.side}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <View style={s.grid}>
              <Stat label="Realized" value={signedSol(st.realizedSol)} color={st.realizedSol >= 0 ? C.up : C.down} />
              <Stat label="Win rate" value={st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`} />
              <Stat label="Flips" value={String(st.flips)} />
              <Stat label="Holding" value={String(st.openPositions)} />
              <Stat label="ROI" value={pf.roiPct == null ? '—' : pct(pf.roiPct)}
                color={pf.roiPct == null ? undefined : pf.roiPct >= 0 ? C.up : C.down} />
              <Stat label="Avg / flip" value={pf.avgPnlSol == null ? '—' : signedSol(pf.avgPnlSol)} />
              <Stat label="Avg hold" value={pf.avgHoldHours == null ? '—' : holdTime(pf.avgHoldHours)} />
              <Stat label="Via AMM pools" value={`${Math.round(pf.poolShare * 100)}%`} />
            </View>
            {pf.collections.length > 0 && (
              <View style={s.chips}>
                {pf.collections.map((c) => (
                  <View key={c.symbol} style={s.chip}>
                    <Text style={s.chipTxt}>{c.name}</Text>
                    <Text style={s.chipMeta}>×{c.flips} · <Text style={{ color: c.pnlSol >= 0 ? C.up : C.down }}>{signedSol(c.pnlSol, 1)}</Text></Text>
                  </View>
                ))}
              </View>
            )}
            {pf.likelyMarketMaker && (
              <Text style={s.note}>{"Most of this wallet's trades run through AMM pools, so it's likely a market maker rather than a discretionary trader."}</Text>
            )}
            <Pressable onPress={() => toggleFollow(address)} style={[s.follow, isFollowing && s.following]}>
              <Text style={[s.followTxt, isFollowing && { color: C.text }]}>
                {isFollowing ? 'Following · get alerts on buys' : 'Follow this wallet'}
              </Text>
            </Pressable>
            <Text style={s.section}>RECENT ACTIVITY</Text>
          </View>
        }
        ListEmptyComponent={<Empty text="No tracked trades." />}
        renderItem={({ item: t }) => (
          <Link href={{ pathname: '/collection/[symbol]', params: { symbol: t.symbol } }} asChild>
          <Pressable style={s.row}>
            <CollIcon name={t.collection} uri={t.image} size={40} radius={8} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{t.collection}</Text>
              <Text style={s.meta}>{timeAgo(t.blockTime)} ago</Text>
            </View>
            <Text style={[s.side, { color: t.side === 'buy' ? C.up : C.down }]}>{t.side.toUpperCase()}</Text>
            <Text style={s.price}>{sol(t.price, 3)}</Text>
          </Pressable>
          </Link>
        )}
      />
    </>
  );
}

const Stat = ({ label, value, color }: { label: string; value: string; color?: string }) => (
  <View style={s.stat}>
    <Text style={s.statLabel}>{label}</Text>
    <Text style={[s.statVal, color ? { color } : null]}>{value}</Text>
  </View>
);

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, flexBasis: '45%', backgroundColor: C.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border },
  statLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  statVal: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  follow: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  following: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  followTxt: { color: C.accentInk, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 4 },
  chipTxt: { color: C.text, fontWeight: '600', fontSize: 12.5 },
  chipMeta: { color: C.dim, fontSize: 12 },
  note: { color: C.dim, fontSize: 12.5, lineHeight: 18 },
  section: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '600' },
  meta: { color: C.dim, fontSize: 12 },
  side: { fontWeight: '800', fontSize: 11, letterSpacing: 0.5 },
  price: { color: C.text, fontWeight: '700', width: 82, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
