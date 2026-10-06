import { Image } from 'expo-image';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Empty } from '@/components/screen';
import { C } from '@/constants/brand';
import { api, type WalletDetail } from '@/lib/api';
import { shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
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
            </View>
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
            {t.image ? <Image source={t.image} style={s.img} /> : <View style={s.img} />}
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
  section: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  img: { width: 40, height: 40, borderRadius: 8, backgroundColor: C.cardHi },
  name: { color: C.text, fontWeight: '600' },
  meta: { color: C.dim, fontSize: 12 },
  side: { fontWeight: '800', fontSize: 11, letterSpacing: 0.5 },
  price: { color: C.text, fontWeight: '700', width: 82, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
