import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Screen } from '@/components/screen';
import { C } from '@/constants/brand';
import { api, type WalletStats } from '@/lib/api';
import { shortAddr, signedSol } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function LeaderboardScreen() {
  const { following, toggleFollow } = useSession();
  const [rows, setRows] = useState<WalletStats[]>([]);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(() => {
    api.leaderboard().then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setRefreshing(false));
  }, []);
  useEffect(fetchRows, [fetchRows]);
  const refresh = () => { setRefreshing(true); fetchRows(); };

  return (
    <Screen title="Leaders" subtitle="Realized P&L on tracked flips, gross of fees">
      <FlatList
        data={rows}
        keyExtractor={(r) => r.wallet}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListEmptyComponent={refreshing ? null : <Empty text={error ?? 'No completed flips tracked yet.'} />}
        renderItem={({ item, index }) => (
          <Link href={{ pathname: '/wallet/[address]', params: { address: item.wallet } }} asChild>
            <Pressable style={s.row}>
              <Text style={[s.rank, index < 3 && { color: C.accent }]}>{index + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.addr}>{shortAddr(item.wallet)}</Text>
                <Text style={s.meta}>
                  {Math.round((item.winRate ?? 0) * 100)}% win · {item.flips} flip{item.flips === 1 ? '' : 's'} · {item.openPositions} holding
                </Text>
              </View>
              <Text style={[s.pnl, { color: item.realizedSol >= 0 ? C.up : C.down }]}>{signedSol(item.realizedSol)}</Text>
              <Pressable hitSlop={8} onPress={() => toggleFollow(item.wallet)} style={s.star}>
                <Text style={{ color: following.has(item.wallet) ? C.accent : C.dim, fontSize: 18 }}>
                  {following.has(item.wallet) ? '★' : '☆'}
                </Text>
              </Pressable>
            </Pressable>
          </Link>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rank: { color: C.dim, width: 24, fontWeight: '800', fontSize: 16, fontVariant: ['tabular-nums'] },
  addr: { color: C.text, fontWeight: '700', fontSize: 15 },
  meta: { color: C.dim, fontSize: 12.5, marginTop: 2 },
  pnl: { fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] },
  star: { paddingLeft: 4 },
});
