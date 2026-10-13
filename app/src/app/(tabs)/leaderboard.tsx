import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Empty, Screen } from '@/components/screen';
import { Chip, ChipRow } from '@/components/ui';
import { TraderCard } from '@/components/trader-card';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Ecosystem, type Leaderboard, type LeaderSort, type LeaderWindow } from '@/lib/api';
import { signedSol } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// P&L is in each chain's unit (SOL vs ETH), so the boards are separate.
const CHAINS: { key: Ecosystem; label: string }[] = [{ key: 'solana', label: 'Solana' }, { key: 'evm', label: 'Ethereum' }];
const WINDOWS: { key: LeaderWindow; label: string }[] = [
  { key: '7', label: '7D' }, { key: '30', label: '30D' }, { key: 'all', label: 'All' },
];
const SORTS: { key: LeaderSort; label: string }[] = [
  { key: 'pnl', label: 'P&L' }, { key: 'winrate', label: 'Win rate' }, { key: 'roi', label: 'ROI' }, { key: 'flips', label: 'Flips' },
];

export default function LeaderboardScreen() {
  const [chain, setChain] = useState<Ecosystem>('solana');
  useTitle(chain === 'evm' ? 'Top Ethereum NFT flippers: P&L leaderboard | FloorFeed' : 'Top Solana NFT flippers: 30-day P&L leaderboard | FloorFeed');
  const { following, toggleFollow } = useSession();
  const [win, setWin] = useState<LeaderWindow>('30');
  const [sort, setSort] = useState<LeaderSort>('pnl');
  const [hideMM, setHideMM] = useState(true);
  const [data, setData] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { wide, pad } = useLayout();
  const cols = wide ? 2 : 1;

  const fetchRows = useCallback(() => {
    api.leaderboard({ window: win, sort, hideMM, chain })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [win, sort, hideMM, chain]);
  useEffect(fetchRows, [fetchRows]);

  // Filters keep the previous list on screen (dimmed) while refetching.
  const change = (fn: () => void) => { setLoading(true); fn(); };
  const refresh = () => { setRefreshing(true); fetchRows(); };
  const sm = data?.summary;

  return (
    <Screen title="Leaders" subtitle="Wallets ranked by completed flips: buying an NFT and selling it later. Before fees.">
      <ChipRow pad={pad} groups={[
        CHAINS.map((c) => <Chip key={c.key} label={c.label} on={chain === c.key} onPress={() => change(() => setChain(c.key))} />),
        WINDOWS.map((w) => <Chip key={w.key} label={w.label} on={win === w.key} onPress={() => change(() => setWin(w.key))} />),
        SORTS.map((o) => <Chip key={o.key} label={o.label} on={sort === o.key} onPress={() => change(() => setSort(o.key))} />),
        <Chip key="mm" label={chain === 'evm' ? 'Hide bid bots' : 'Hide market makers'} on={hideMM} onPress={() => change(() => setHideMM((v) => !v))} />,
      ]} />

      {sm && (
        <Text style={[T.metaNum, s.summary, { paddingHorizontal: pad }]}>
          {sm.wallets} wallets with 3+ flips made {sm.flips.toLocaleString()} flips; {sm.profitableWallets} are in profit,{' '}
          <Text style={{ color: sm.realizedSol >= 0 ? C.up : C.down }}>{signedSol(sm.realizedSol, 1, chain === 'evm' ? 'ETH' : 'SOL')}</Text> combined.
          {sm.hiddenMarketMakers ? ` ${sm.hiddenMarketMakers} likely ${chain === 'evm' ? 'bid bots' : 'market makers'} hidden.` : ''}
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
    </Screen>
  );
}

const s = StyleSheet.create({
  summary: { paddingTop: 4, paddingBottom: 12 },
});
