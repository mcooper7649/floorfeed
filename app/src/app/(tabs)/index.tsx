import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { AlertsBell } from '@/components/alerts-bell';
import { EventCard } from '@/components/event-card';
import { Empty, Screen } from '@/components/screen';
import { SuggestedFollows } from '@/components/suggested-follows';
import { Card, Chip, ChipRow } from '@/components/ui';
import { ThesisFeedRow } from '@/components/thesis';
import { WelcomeCard } from '@/components/welcome-card';
import { useThesisFeed } from '@/components/discovery-panel';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type FeedChain, type FeedEvent, type FeedView } from '@/lib/api';
import { columnsFor, useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

type Scope = 'all' | 'following';

const CHAINS: { key: FeedChain; label: string }[] = [
  { key: 'all', label: 'All chains' }, { key: 'solana', label: 'Solana' }, { key: 'evm', label: 'Ethereum & L2s' },
];

type View_ = FeedView | 'thesis';
const VIEWS: { key: View_; label: string; hint: string }[] = [
  { key: 'top', label: 'Top', hint: 'The last 72 hours, ranked by who traded, how much and how recently.' },
  { key: 'latest', label: 'Latest', hint: 'Every buy, flip and sweep as it happens.' },
  { key: 'wins', label: 'Wins', hint: 'Profitable flips, newest first.' },
  { key: 'thesis', label: 'Thesis', hint: 'What holders and traders think, from every collection, newest first.' },
];

export default function FeedScreen() {
  useTitle('FloorFeed: live Solana NFT trades from proven wallets');
  const { userId, following } = useSession();
  const [scope, setScope] = useState<Scope>('all');
  const [view, setView] = useState<View_>('top');
  const theses = useThesisFeed();
  const [chain, setChain] = useState<FeedChain>('all');
  const [items, setItems] = useState<FeedEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { wide, pad, contentWidth } = useLayout();
  const cols = wide ? columnsFor(contentWidth, 290, 16, 4) : 1;

  const load = useCallback(async (before?: number) => {
    if (scope === 'following' && !userId) return { events: [], next: null };
    return api.events({ view: view === 'thesis' ? 'latest' : view, before, chain, following: scope === 'following' ? userId! : undefined });
  }, [scope, view, chain, userId]);

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
    <Screen title="FloorFeed" subtitle="Live NFT trades from wallets with a track record" corner={wide ? undefined : <AlertsBell />}>
      <View style={[s.tabs, { paddingHorizontal: pad }]}>
        {VIEWS.map((v) => (
          <Pressable key={v.key} accessibilityRole="tab" accessibilityState={{ selected: view === v.key }}
            onPress={() => v.key !== view && pick(() => setView(v.key))} style={[s.tab, view === v.key && s.tabOn]}>
            <Text style={[T.bodyStrong, { color: view === v.key ? C.text : C.dim }]}>{v.label}</Text>
          </Pressable>
        ))}
      </View>
      {view !== 'thesis' && (
      <ChipRow pad={pad} groups={[
        (['all', 'following'] as const).map((m) => (
          <Chip key={m} on={scope === m} onPress={() => m !== scope && pick(() => setScope(m))}
            label={m === 'all' ? 'Everyone' : `Following${following.size ? ` ${following.size}` : ''}`} />
        )),
        CHAINS.map((c) => <Chip key={c.key} label={c.label} on={chain === c.key} onPress={() => c.key !== chain && pick(() => setChain(c.key))} />),
      ]} />
      )}
      <Text style={[T.meta, s.hint, { paddingHorizontal: pad }]}>{VIEWS.find((v) => v.key === view)!.hint}</Text>

      {view === 'thesis' ? (
        <FlatList
          data={theses ?? []}
          keyExtractor={(t) => `${t.kind}:${t.id}`}
          renderItem={({ item }) => <ThesisFeedRow t={item} />}
          contentContainerStyle={[s.list, { paddingHorizontal: pad, maxWidth: 760 }]}
          ListEmptyComponent={theses ? <Empty text="No theses yet. Open any collection and post the first one in its Thesis tab." /> : <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />}
        />
      ) : loading ? (
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
          ListHeaderComponent={scope === 'all' ? <WelcomeCard /> : null}
          ListEmptyComponent={
            scope === 'following' && !error && following.size === 0 ? (
              <Card>
                <Text style={T.bodyStrong}>Your own feed of traders you trust</Text>
                <Text style={T.meta}>Follow a few wallets and only their buys, flips and sweeps show up here. These are the best flippers of the last 30 days:</Text>
                <SuggestedFollows count={5} from="following-empty" />
              </Card>
            ) : (
              <Empty text={error ? `Can't reach the server: ${error}`
                : scope === 'following' ? 'No recent trades from the wallets you follow. They show up here as they happen.'
                : view === 'wins' ? 'No profitable flips in this window yet.'
                : 'No trades yet. The server is still ingesting.'} />
            )
          }
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, marginBottom: 6 },
  tab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -StyleSheet.hairlineWidth },
  tabOn: { borderBottomColor: C.accent },
  hint: { paddingTop: 2, paddingBottom: 12 },
  list: { paddingBottom: 120 },
});
