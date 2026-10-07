import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Screen } from '@/components/screen';
import { TradeCard } from '@/components/trade-card';
import { C } from '@/constants/brand';
import { api, type FeedItem } from '@/lib/api';
import { columnsFor, useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';

type Mode = 'all' | 'following';

export default function FeedScreen() {
  const { userId, following } = useSession();
  const [mode, setMode] = useState<Mode>('all');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { wide, pad, contentWidth } = useLayout();
  const cols = wide ? columnsFor(contentWidth, 290, 16, 4) : 1;

  const load = useCallback(async (before?: number) => {
    if (mode === 'following' && !userId) return [];
    return api.feed({ before, following: mode === 'following' ? userId! : undefined });
  }, [mode, userId]);

  const fetchFirst = useCallback(() => {
    load()
      .then((rows) => { setItems(rows); setDone(rows.length === 0); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, [load]);

  useEffect(() => { fetchFirst(); }, [fetchFirst, following.size]);

  const refresh = () => { setRefreshing(true); fetchFirst(); };
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setLoading(true); setMode(m);
  };

  const more = async () => {
    if (done || refreshing || !items.length) return;
    const rows = await load(items[items.length - 1].blockTime).catch(() => []);
    if (!rows.length) setDone(true);
    setItems((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.signature === r.signature))]);
  };

  return (
    <Screen title="FloorFeed" subtitle="Live Solana NFT buys from wallets with a track record">
      <View style={[s.seg, { paddingHorizontal: pad }]}>
        {(['all', 'following'] as const).map((m) => (
          <Pressable key={m} onPress={() => switchMode(m)} style={[s.segBtn, mode === m && s.segOn]}>
            <Text style={[s.segTxt, mode === m && { color: C.bg }]}>
              {m === 'all' ? 'Everyone' : `Following${following.size ? ` (${following.size})` : ''}`}
            </Text>
          </Pressable>
        ))}
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          key={cols}
          data={items}
          keyExtractor={(t) => t.signature}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? { gap: 16 } : undefined}
          renderItem={({ item }) => (
            cols > 1
              ? <View style={{ flex: 1 / cols }}><TradeCard item={item} tile /></View>
              : <TradeCard item={item} />
          )}
          contentContainerStyle={[s.list, { paddingHorizontal: pad }]}
          ItemSeparatorComponent={() => <View style={{ height: cols > 1 ? 16 : 12 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
          onEndReached={more}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <Empty text={error ? `Can't reach the server: ${error}`
              : mode === 'following' ? 'Follow wallets from the feed or the leaderboard to see their buys here.'
              : 'No trades yet. The server is still ingesting.'} />
          }
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  seg: { flexDirection: 'row', gap: 8, paddingBottom: 10 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  segOn: { backgroundColor: C.accent, borderColor: C.accent },
  segTxt: { color: C.text, fontWeight: '600', fontSize: 13 },
  list: { paddingBottom: 120 },
});
