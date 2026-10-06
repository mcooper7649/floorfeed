import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { Empty, Screen } from '@/components/screen';
import { Sparkline } from '@/components/sparkline';
import { C } from '@/constants/brand';
import { api, type CollectionSummary } from '@/lib/api';
import { sol } from '@/lib/format';

export default function MarketsScreen() {
  const [rows, setRows] = useState<CollectionSummary[]>([]);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(() => {
    api.collections().then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setRefreshing(false));
  }, []);
  useEffect(fetchRows, [fetchRows]);
  const refresh = () => { setRefreshing(true); fetchRows(); };

  return (
    <Screen title="Markets" subtitle="Tracked collections by 7-day volume">
      <FlatList
        data={rows}
        keyExtractor={(r) => r.symbol}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListEmptyComponent={refreshing ? null : <Empty text={error ?? 'No collections yet.'} />}
        ListHeaderComponent={
          <View style={s.headRow}>
            <Text style={[s.colHead, { flex: 1 }]}>COLLECTION</Text>
            <Text style={[s.colHead, { width: 72, textAlign: 'center' }]}>14D</Text>
            <Text style={[s.colHead, { width: 84, textAlign: 'right' }]}>FLOOR</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Link href={{ pathname: '/collection/[symbol]', params: { symbol: item.symbol } }} asChild>
            <Pressable style={s.row}>
              <CollIcon name={item.name} uri={item.image} />
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>{item.name}</Text>
                <Text style={s.meta}>
                  {item.sales24h} sales 24h · {item.volume7d != null ? `${Math.round(item.volume7d).toLocaleString()} ◎ 7d` : '—'}
                </Text>
              </View>
              <Sparkline values={item.spark.map((p) => p.median)} />
              <Text style={s.floor}>{item.floor != null ? sol(item.floor) : '—'}</Text>
            </Pressable>
          </Link>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  headRow: { flexDirection: 'row', paddingBottom: 6, gap: 12 },
  colHead: { color: C.dim, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  meta: { color: C.dim, fontSize: 12, marginTop: 2 },
  floor: { color: C.text, fontWeight: '800', width: 84, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
