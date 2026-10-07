import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Screen } from '@/components/screen';
import { WalletCard } from '@/components/wallet-card';
import { C } from '@/constants/brand';
import { api, type PaperPosition } from '@/lib/api';
import { signedSol, sol } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function PortfolioScreen() {
  const { userId, portfolioVersion, bumpPortfolio } = useSession();
  const [data, setData] = useState<{ positions: PaperPosition[]; realizedSol: number; unrealizedSol: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(() => {
    if (!userId) return;
    api.paper(userId).then(setData).catch(() => {}).finally(() => setRefreshing(false));
  }, [userId]);
  useEffect(fetchData, [fetchData, portfolioVersion]);
  const refresh = () => { setRefreshing(true); fetchData(); };

  const sell = async (id: number) => {
    if (!userId) return;
    await api.sell(userId, id).catch(() => {});
    bumpPortfolio();
  };

  const total = (data?.realizedSol ?? 0) + (data?.unrealizedSol ?? 0);

  return (
    <Screen title="Portfolio" subtitle="Paper mode: no real SOL moves">
      <WalletCard />
      <View style={s.summary}>
        <Text style={s.label}>TOTAL P&L</Text>
        <Text style={[s.big, { color: total >= 0 ? C.up : C.down }]}>{signedSol(total, 3)}</Text>
        <Text style={s.meta}>
          {signedSol(data?.realizedSol ?? 0, 3)} realized · {signedSol(data?.unrealizedSol ?? 0, 3)} open (marked at est. bid)
        </Text>
      </View>
      <FlatList
        data={data?.positions ?? []}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListEmptyComponent={<Empty text="Tap “Copy · buy floor” on a trade in the feed to open a paper position." />}
        renderItem={({ item: p }) => (
          <View style={s.row}>
            <Link href={{ pathname: '/collection/[symbol]', params: { symbol: p.collection.symbol } }} asChild>
            <Pressable style={{ flex: 1 }}>
              <Text style={s.name}>{p.collection.name}</Text>
              <Text style={s.meta}>
                in {sol(p.entryPrice)}{p.exitPrice != null ? ` · out ${sol(p.exitPrice)}` : ''}
                {p.copiedFrom ? ' · copied' : ''}
              </Text>
            </Pressable>
            </Link>
            <Text style={[s.pnl, { color: p.pnlSol >= 0 ? C.up : C.down }]}>{signedSol(p.pnlSol, 3)}</Text>
            {p.open ? (
              <Pressable onPress={() => sell(p.id)} style={s.sell}><Text style={s.sellTxt}>Sell</Text></Pressable>
            ) : (
              <Text style={[s.meta, { width: 52, textAlign: 'center' }]}>closed</Text>
            )}
          </View>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  summary: { marginHorizontal: 16, marginBottom: 8, padding: 16, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, gap: 4 },
  label: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  big: { fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] },
  meta: { color: C.dim, fontSize: 12.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  pnl: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  sell: { backgroundColor: C.cardHi, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, width: 52, alignItems: 'center' },
  sellTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
});
