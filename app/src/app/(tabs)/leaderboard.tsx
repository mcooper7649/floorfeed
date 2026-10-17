import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { PracticeBoard } from '@/components/practice-board';
import { Empty, Screen } from '@/components/screen';
import { Chip, ChipRow } from '@/components/ui';
import { TraderCard } from '@/components/trader-card';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Leaderboard, type LeaderSort, type LeaderWindow, type PracticeWindow, type Unit } from '@/lib/api';
import { signedSol } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';
import { useWithUsd } from '@/lib/prices';

// One board per currency: profits in SOL, ETH, HYPE... can't be added up.
const BOARDS: { key: Unit; label: string }[] = [
  { key: 'SOL', label: 'Solana' }, { key: 'ETH', label: 'Ethereum & L2s' }, { key: 'HYPE', label: 'HyperEVM' },
  { key: 'RON', label: 'Ronin' }, { key: 'APE', label: 'ApeChain' }, { key: 'MON', label: 'Monad' },
];
const WINDOWS: { key: LeaderWindow; label: string }[] = [
  { key: '7', label: '7D' }, { key: '30', label: '30D' }, { key: 'all', label: 'All' },
];
// The practice board runs in weekly seasons (Monday to Monday, UTC).
const PRACTICE_WINDOWS: { key: PracticeWindow; label: string }[] = [
  { key: 'season', label: 'This season' }, { key: 'last', label: 'Last season' }, { key: 'all', label: 'All time' },
];
const SORTS: { key: LeaderSort; label: string }[] = [
  { key: 'pnl', label: 'P&L' }, { key: 'winrate', label: 'Win rate' }, { key: 'roi', label: 'ROI' }, { key: 'flips', label: 'Flips' },
];

export default function LeaderboardScreen() {
  const withUsd = useWithUsd();
  // A wallet board per currency, or the Top practice traders board (?board=practice).
  const params = useLocalSearchParams<{ board?: string }>();
  const [unit, setUnit] = useState<Unit | 'practice'>(params.board === 'practice' ? 'practice' : 'SOL');
  const practice = unit === 'practice';
  const board = BOARDS.find((b) => b.key === unit);
  useTitle(practice ? 'Top practice traders | FloorFeed' : `Top ${board?.label} NFT flippers: P&L leaderboard | FloorFeed`);
  // Opening ?board=practice while the tab is already mounted (Portfolio's rank card) switches to it.
  const [prevParam, setPrevParam] = useState(params.board);
  if (params.board !== prevParam) {
    setPrevParam(params.board);
    if (params.board === 'practice') setUnit('practice');
  }
  const { following, toggleFollow } = useSession();
  const [win, setWin] = useState<LeaderWindow>('30');
  const [pwin, setPwin] = useState<PracticeWindow>('season');
  const [sort, setSort] = useState<LeaderSort>('pnl');
  const [hideMM, setHideMM] = useState(true);
  const [data, setData] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { wide, pad } = useLayout();
  const cols = wide ? 2 : 1;

  const fetchRows = useCallback(() => {
    if (unit === 'practice') return;
    api.leaderboard({ window: win, sort, hideMM, unit })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [win, sort, hideMM, unit]);
  useEffect(fetchRows, [fetchRows]);

  // Filters keep the previous list on screen (dimmed) while refetching.
  const change = (fn: () => void) => { setLoading(true); fn(); };
  const refresh = () => { setRefreshing(true); fetchRows(); };
  const sm = data?.summary;

  return (
    <Screen title="Leaders" subtitle={practice
      ? 'Top practice traders: FloorFeed members ranked by their practice trades. Simulated money, live prices, real fees.'
      : 'Wallets ranked by completed flips: buying an NFT and selling it later. After marketplace fees and royalties.'}>
      <ChipRow pad={pad} groups={[
        <Chip key="practice" label="Practice traders" on={practice} onPress={() => setUnit('practice')} />,
        BOARDS.map((b) => <Chip key={b.key} label={b.label} on={unit === b.key} onPress={() => change(() => setUnit(b.key))} />),
        practice
          ? PRACTICE_WINDOWS.map((w) => <Chip key={w.key} label={w.label} on={pwin === w.key} onPress={() => setPwin(w.key)} />)
          : WINDOWS.map((w) => <Chip key={w.key} label={w.label} on={win === w.key} onPress={() => change(() => setWin(w.key))} />),
        !practice && SORTS.map((o) => <Chip key={o.key} label={o.label} on={sort === o.key} onPress={() => change(() => setSort(o.key))} />),
        !practice && <Chip key="mm" label={unit === 'SOL' ? 'Hide market makers' : 'Hide bid bots'} on={hideMM} onPress={() => change(() => setHideMM((v) => !v))} />,
      ]} />

      {practice ? <PracticeBoard window={pwin} pad={pad} cols={cols} /> : <>
      {sm && (
        <Text style={[T.metaNum, s.summary, { paddingHorizontal: pad }]}>
          Ranked in {unit}. {sm.wallets} wallets with 3+ flips made {sm.flips.toLocaleString()} flips; {sm.profitableWallets} are in profit,{' '}
          <Text style={{ color: sm.realizedSol >= 0 ? C.up : C.down }}>{withUsd(signedSol(sm.realizedSol, 1, unit), sm.realizedSol, unit, true)}</Text> combined.
          {sm.hiddenMarketMakers ? ` ${sm.hiddenMarketMakers} likely ${unit === 'SOL' ? 'market makers' : 'bid bots'} hidden.` : ''}{' '}
          <Text style={{ color: C.accent }} onPress={() => router.push({ pathname: '/how-it-works', params: { s: 'badges' } })}>What the badges mean</Text>
        </Text>
      )}

      {!data && loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          style={{ opacity: loading ? 0.5 : 1 }}
          key={cols}
          data={data?.rows ?? []}
          keyExtractor={(r) => r.wallet}
          numColumns={cols}
          columnWrapperStyle={cols > 1 ? { gap: 16 } : undefined}
          contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
          ItemSeparatorComponent={() => <View style={{ height: cols > 1 ? 16 : 12 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
          ListEmptyComponent={<Empty text={error ?? 'No wallets with 3+ completed flips in this window yet.'} />}
          renderItem={({ item, index }) => (
            <View style={{ flex: 1 / cols }}>
              <TraderCard t={item} rank={index + 1} following={following.has(item.wallet)}
                onToggleFollow={() => toggleFollow(item.wallet)} />
            </View>
          )}
        />
      )}
      </>}
    </Screen>
  );
}

const s = StyleSheet.create({
  summary: { paddingTop: 4, paddingBottom: 12 },
});
