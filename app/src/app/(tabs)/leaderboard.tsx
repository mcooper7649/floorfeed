import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Empty, Screen } from '@/components/screen';
import { TraderCard } from '@/components/trader-card';
import { C } from '@/constants/brand';
import { api, type Leaderboard, type LeaderSort, type LeaderWindow } from '@/lib/api';
import { signedSol } from '@/lib/format';
import { useSession } from '@/lib/session';

const WINDOWS: { key: LeaderWindow; label: string }[] = [
  { key: '7', label: '7D' }, { key: '30', label: '30D' }, { key: 'all', label: 'All' },
];
const SORTS: { key: LeaderSort; label: string }[] = [
  { key: 'pnl', label: 'P&L' }, { key: 'winrate', label: 'Win rate' }, { key: 'roi', label: 'ROI' }, { key: 'flips', label: 'Flips' },
];

export default function LeaderboardScreen() {
  const { following, toggleFollow } = useSession();
  const [win, setWin] = useState<LeaderWindow>('30');
  const [sort, setSort] = useState<LeaderSort>('pnl');
  const [hideMM, setHideMM] = useState(true);
  const [data, setData] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(() => {
    api.leaderboard({ window: win, sort, hideMM })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [win, sort, hideMM]);
  useEffect(fetchRows, [fetchRows]);

  // Filters keep the previous list on screen (dimmed) while refetching.
  const change = (fn: () => void) => { setLoading(true); fn(); };
  const refresh = () => { setRefreshing(true); fetchRows(); };
  const sm = data?.summary;

  return (
    <Screen title="Leaders" subtitle="Wallets ranked on completed flips (buy → sell of the same NFT), gross of fees">
      {/* Fixed-height wrapper: a horizontal ScrollView collapses its height on web */}
      <View style={s.filterBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
        {WINDOWS.map((w) => (
          <Chip key={w.key} label={w.label} on={win === w.key} onPress={() => change(() => setWin(w.key))} />
        ))}
        <View style={s.sep} />
        {SORTS.map((o) => (
          <Chip key={o.key} label={o.label} on={sort === o.key} onPress={() => change(() => setSort(o.key))} />
        ))}
        <View style={s.sep} />
        <Chip label="Hide market makers" on={hideMM} onPress={() => change(() => setHideMM((v) => !v))} />
      </ScrollView>
      </View>

      {sm && (
        <Text style={s.summary}>
          {sm.wallets} wallets with 3+ flips · {sm.flips.toLocaleString()} flips · {sm.profitableWallets} profitable ·{' '}
          <Text style={{ color: sm.realizedSol >= 0 ? C.up : C.down }}>{signedSol(sm.realizedSol, 1)}</Text> combined
          {sm.hiddenMarketMakers ? ` · ${sm.hiddenMarketMakers} likely market makers hidden` : ''}
        </Text>
      )}

      {!data && loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          style={{ opacity: loading ? 0.5 : 1 }}
          data={data?.rows ?? []}
          keyExtractor={(r) => r.wallet}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
          ListEmptyComponent={<Empty text={error ?? 'No wallets with 3+ completed flips in this window yet.'} />}
          renderItem={({ item, index }) => (
            <TraderCard t={item} rank={index + 1} following={following.has(item.wallet)}
              onToggleFollow={() => toggleFollow(item.wallet)} />
          )}
        />
      )}
    </Screen>
  );
}

const Chip = ({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) => (
  <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]}>
    <Text style={[s.chipTxt, on && { color: C.accentInk }]}>{label}</Text>
  </Pressable>
);

const s = StyleSheet.create({
  filterBar: { height: 46 },
  filters: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  sep: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 2 },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  summary: { color: C.dim, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 10 },
});
