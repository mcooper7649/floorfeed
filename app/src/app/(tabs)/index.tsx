import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EventCard } from '@/components/event-card';
import { Empty, Screen } from '@/components/screen';
import { C } from '@/constants/brand';
import { api, type FeedEvent, type FeedView } from '@/lib/api';
import { columnsFor, useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';

type Scope = 'all' | 'following';

const VIEWS: { key: FeedView; label: string; hint: string }[] = [
  { key: 'top', label: 'Top', hint: 'Ranked by who traded, how big, and how recently (72h)' },
  { key: 'latest', label: 'Latest', hint: 'Every buy, flip and sweep as it lands' },
  { key: 'wins', label: 'Wins', hint: 'Profitable flips, newest first' },
];

export default function FeedScreen() {
  const { userId, following } = useSession();
  const [scope, setScope] = useState<Scope>('all');
  const [view, setView] = useState<FeedView>('top');
  const [items, setItems] = useState<FeedEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { wide, pad, contentWidth } = useLayout();
  const cols = wide ? columnsFor(contentWidth, 290, 16, 4) : 1;

  const load = useCallback(async (before?: number) => {
    if (scope === 'following' && !userId) return { events: [], next: null };
    return api.events({ view, before, following: scope === 'following' ? userId! : undefined });
  }, [scope, view, userId]);

  const fetchFirst = useCallback(() => {
    load()
      .then((r) => { setItems(r.events); setNext(r.next); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, [load]);

  useEffect(() => { fetchFirst(); }, [fetchFirst, following.size]);

  const refresh = () => { setRefreshing(true); fetchFirst(); };
  const pick = (fn: () => void) => { setLoading(true); fn(); };

  const more = async () => {
    if (next == null || refreshing) return;
    const r = await load(next).catch(() => null);
    if (!r) return;
    setNext(r.next);
    setItems((prev) => [...prev, ...r.events.filter((e) => !prev.some((p) => p.id === e.id))]);
  };

  return (
    <Screen title="FloorFeed" subtitle="Live Solana NFT trades from wallets with a track record">
      <View style={[s.bar, { paddingHorizontal: pad }]}>
        <View style={s.seg}>
          {VIEWS.map((v) => (
            <Pressable key={v.key} onPress={() => v.key !== view && pick(() => setView(v.key))}
              style={view === v.key ? s.tabOn : s.tab}>
              <Text style={[s.tabTxt, view === v.key && { color: C.text }]}>{v.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={s.seg}>
          {(['all', 'following'] as const).map((m) => (
            <Pressable key={m} onPress={() => m !== scope && pick(() => setScope(m))} style={[s.segBtn, scope === m && s.segOn]}>
              <Text style={[s.segTxt, scope === m && { color: C.bg }]}>
                {m === 'all' ? 'Everyone' : `Following${following.size ? ` (${following.size})` : ''}`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={[s.hint, { paddingHorizontal: pad }]}>{VIEWS.find((v) => v.key === view)!.hint}</Text>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          key={cols}
          data={items}
          keyExtractor={(e) => e.id}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? { gap: 16 } : undefined}
          renderItem={({ item }) => (
            cols > 1
              ? <View style={{ flex: 1 / cols }}><EventCard e={item} tile /></View>
              : <EventCard e={item} />
          )}
          contentContainerStyle={[s.list, { paddingHorizontal: pad }]}
          ItemSeparatorComponent={() => <View style={{ height: cols > 1 ? 16 : 12 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
          onEndReached={more}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <Empty text={error ? `Can't reach the server: ${error}`
              : scope === 'following' ? 'Follow wallets from the feed or the leaderboard to see their trades here.'
              : view === 'wins' ? 'No profitable flips in this window yet.'
              : 'No trades yet. The server is still ingesting.'} />
          }
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingBottom: 6 },
  seg: { flexDirection: 'row', gap: 8 },
  tab: { paddingHorizontal: 4, paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { paddingHorizontal: 4, paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: C.accent },
  tabTxt: { color: C.dim, fontWeight: '800', fontSize: 16, marginRight: 8 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  segOn: { backgroundColor: C.accent, borderColor: C.accent },
  segTxt: { color: C.text, fontWeight: '600', fontSize: 13 },
  hint: { color: C.dim, fontSize: 12.5, paddingBottom: 12 },
  list: { paddingBottom: 120 },
});
