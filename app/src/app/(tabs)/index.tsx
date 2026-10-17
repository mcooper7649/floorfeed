import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { AlertsBell } from '@/components/alerts-bell';
import { EventCard } from '@/components/event-card';
import { Empty, Screen } from '@/components/screen';
import { SuggestedFollows } from '@/components/suggested-follows';
import { Segmented } from '@/components/segmented';
import { Card } from '@/components/ui';
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
  { key: 'all', label: 'All chains' }, { key: 'solana', label: 'Solana' }, { key: 'evm', label: 'ETH & L2s' },
];

// Buys: what proven wallets are buying right now; every card can Buy floor or Offer.
// Flips: how their trades turned out; every card links to the collection.
type Tab = 'buys' | 'flips' | 'thesis';
const TABS: { key: Tab; label: string }[] = [{ key: 'buys', label: 'Buys' }, { key: 'flips', label: 'Flips' }, { key: 'thesis', label: 'Thesis' }];
type BuySort = 'top' | 'latest';
type FlipSort = 'all' | 'wins';
const hintFor = (tab: Tab, buySort: BuySort, flipSort: FlipSort) => tab === 'thesis'
  ? 'What holders and traders think, from every collection, newest first.'
  : tab === 'buys'
    ? buySort === 'top' ? 'Buys, sweeps and clusters from the last 72 hours, ranked by who bought, how much and how recently.' : 'Every buy, sweep and cluster as it happens.'
    : flipSort === 'wins' ? 'Profitable flips (+2% or more, after fees), newest first.' : 'Every flip and sale, newest first, with the profit after fees.';

export default function FeedScreen() {
  useTitle('FloorFeed: live Solana NFT trades from proven wallets');
  const { userId, following } = useSession();
  const [scope, setScope] = useState<Scope>('all');
  const [tab, setTab] = useState<Tab>('buys');
  const [buySort, setBuySort] = useState<BuySort>('top');
  const [flipSort, setFlipSort] = useState<FlipSort>('all');
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
    const view: FeedView = tab === 'flips' ? (flipSort === 'wins' ? 'wins' : 'latest') : buySort;
    return api.events({ view, kinds: tab === 'flips' ? 'flips' : 'buys', before, chain, following: scope === 'following' ? userId! : undefined });
  }, [scope, tab, buySort, flipSort, chain, userId]);

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
        {TABS.map((t) => (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
            onPress={() => t.key !== tab && pick(() => setTab(t.key))} style={[s.tab, tab === t.key && s.tabOn]}>
            <Text style={[T.bodyStrong, { color: tab === t.key ? C.text : C.dim }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab !== 'thesis' && (
        <View style={[s.controls, { paddingHorizontal: pad }]}>
          {tab === 'buys'
            ? <Segmented label="Order" value={buySort} onChange={(k) => pick(() => setBuySort(k))}
                items={[{ key: 'top', label: 'Top' }, { key: 'latest', label: 'Latest' }]} />
            : <Segmented label="Which flips" value={flipSort} onChange={(k) => pick(() => setFlipSort(k))}
                items={[{ key: 'all', label: 'All' }, { key: 'wins', label: 'Profitable' }]} />}
          <Segmented label="Whose trades" value={scope} onChange={(k) => pick(() => setScope(k))}
            items={[{ key: 'all', label: 'Everyone' }, { key: 'following', label: 'Following', count: following.size }]} />
          <Segmented label="Chain" value={chain} onChange={(k) => pick(() => setChain(k))} items={CHAINS} />
        </View>
      )}
      <Text style={[T.meta, s.hint, { paddingHorizontal: pad }]}>{hintFor(tab, buySort, flipSort)}</Text>

      {tab === 'thesis' ? (
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
                : tab === 'flips' && flipSort === 'wins' ? 'No profitable flips in this window yet.'
                : tab === 'flips' ? 'No flips in this window yet.'
                : 'No trades yet. The server is still ingesting.'} />
            )
          }
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4, paddingBottom: 8 },
  tabs: { flexDirection: 'row', gap: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, marginBottom: 6 },
  tab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent', marginBottom: -StyleSheet.hairlineWidth },
  tabOn: { borderBottomColor: C.accent },
  hint: { paddingTop: 2, paddingBottom: 12 },
  list: { paddingBottom: 120 },
});
