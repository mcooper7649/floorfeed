import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { Empty } from '@/components/screen';
import { Avatar, TierBadge } from '@/components/event-card';
import { TopNav } from '@/components/top-nav';
import { Button, Chip, ChipRow, ListRow, Stat as UiStat } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { api, type Unit, type WalletDetail } from '@/lib/api';
import { holdTime, isEvmWallet, pct, shortAddr, signedSol, sol, timeAgo, unitFor } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

const ECOSYSTEM: Record<string, string> = { SOL: 'Solana', ETH: 'Ethereum', HYPE: 'HyperEVM', RON: 'Ronin', APE: 'ApeChain', MON: 'Monad' };

export default function WalletScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const { following, toggleFollow } = useSession();
  const [data, setData] = useState<WalletDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A wallet that trades in several currencies shows one at a time.
  const [unit, setUnit] = useState<Unit | undefined>(undefined);
  const { wide, pad, maxWidth } = useLayout();

  const who = data ? data.identity?.name ?? shortAddr(address) : null;
  const u = data?.unit ?? unitFor(address);
  const eco = ECOSYSTEM[u] ?? (isEvmWallet(address) ? 'Ethereum' : 'Solana');
  useTitle(data && (data.profile.flips
    ? `${who}: ${eco} NFT trader, ${signedSol(data.profile.realizedSol, 2, u)} P&L | FloorFeed`
    : `${who}: ${eco} NFT wallet | FloorFeed`));

  useEffect(() => { api.wallet(address, unit).then(setData).catch((e) => setError(e.message)); }, [address, unit]);

  const nav = Platform.OS === 'web' && <TopNav back />;
  if (error) return <View style={s.fill}>{nav}<Empty text={error} /></View>;
  if (!data) return <View style={s.fill}>{nav}<ActivityIndicator style={{ marginTop: 40 }} color={C.accent} /></View>;
  const st = data.stats;
  const pf = data.profile;
  const isFollowing = following.has(address);
  const id = data.identity;

  return (
    <View style={s.fill}>
      <Stack.Screen options={{ title: id?.name ?? shortAddr(address) }} />
      {nav}
      <FlatList
        data={data.trades}
        keyExtractor={(t) => t.signature + t.side}
        contentContainerStyle={{ padding: pad, paddingBottom: 60, width: '100%', maxWidth, alignSelf: 'center' }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <View style={s.head}>
              {id && <Avatar t={id} size={wide ? 64 : 52} />}
              <View style={{ flex: 1, gap: 3 }}>
                <View style={s.nameRow}>
                  <Text {...display} style={[wide ? T.displayL : T.display, s.title]} numberOfLines={1}>{id?.name ?? shortAddr(address)}</Text>
                  {id && <TierBadge tier={id.tier} />}
                </View>
                <Text style={s.addr} selectable numberOfLines={1}>{id?.name || isEvmWallet(address) ? address : 'no .sol name'}</Text>
              </View>
            </View>
            {(data.units?.length ?? 0) > 1 && (
              <ChipRow groups={[data.units!.map((x) => (
                <Chip key={x.unit} label={`${ECOSYSTEM[x.unit] ?? x.unit} · ${x.flips} flips`} on={x.unit === u} onPress={() => setUnit(x.unit)} />
              ))]} />
            )}
            <View style={s.grid}>
              <Stat wide={wide} label="Realized" value={signedSol(st.realizedSol, 2, u)} color={st.realizedSol >= 0 ? C.up : C.down} />
              <Stat wide={wide} label="Win rate" value={st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`} />
              <Stat wide={wide} label="Flips" value={String(st.flips)} />
              <Stat wide={wide} label="Holding" value={String(st.openPositions)} />
              <Stat wide={wide} label="ROI" value={pf.roiPct == null ? '—' : pct(pf.roiPct)}
                color={pf.roiPct == null ? undefined : pf.roiPct >= 0 ? C.up : C.down} />
              <Stat wide={wide} label="Avg / flip" value={pf.avgPnlSol == null ? '—' : signedSol(pf.avgPnlSol, 2, u)} />
              <Stat wide={wide} label="Avg hold" value={pf.avgHoldHours == null ? '—' : holdTime(pf.avgHoldHours)} />
              {isEvmWallet(address)
                ? <Stat wide={wide} label="Buys via bids" value={`${Math.round((pf.bidBuyShare ?? 0) * 100)}%`} />
                : <Stat wide={wide} label="Via AMM pools" value={`${Math.round(pf.poolShare * 100)}%`} />}
            </View>
            {pf.collections.length > 0 && (
              <View style={s.chips}>
                {pf.collections.map((c) => (
                  <View key={c.symbol} style={s.chip}>
                    <Text style={s.chipTxt}>{c.name}</Text>
                    <Text style={s.chipMeta}>×{c.flips} · <Text style={{ color: c.pnlSol >= 0 ? C.up : C.down }}>{signedSol(c.pnlSol, 1, u)}</Text></Text>
                  </View>
                ))}
              </View>
            )}
            {pf.likelyMarketMaker && (
              <Text style={s.note}>{isEvmWallet(address)
                ? "Nearly all of this wallet's buys are filled by accepted bids, the pattern of a bidding bot, so it's likely a market maker rather than a discretionary trader."
                : "Most of this wallet's trades run through AMM pools, so it's likely a market maker rather than a discretionary trader."}</Text>
            )}
            <View style={wide ? { alignSelf: 'flex-start' } : null}>
              <Button tone={isFollowing ? 'secondary' : 'primary'} onPress={() => toggleFollow(address)}
                label={isFollowing ? 'Following this wallet' : 'Follow this wallet'} />
            </View>
            <Text style={s.section}>Recent activity</Text>
          </View>
        }
        ListEmptyComponent={<Empty text="No tracked trades." />}
        renderItem={({ item: t }) => (
          <ListRow
            onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: t.symbol, id: t.mint } })}
            art={<CollIcon name={t.collection} uri={t.image} size={44} radius={10} />}
            title={t.collection}
            meta={`${timeAgo(t.blockTime)} ago`}
            value={sol(t.price, 2, t.currency ?? u)}
            sub={t.side === 'buy' ? 'Bought' : 'Sold'}
            subColor={t.side === 'buy' ? C.up : C.down}
          />
        )}
      />
    </View>
  );
}

const Stat = ({ label, value, color, wide }: { label: string; value: string; color?: string; wide?: boolean }) => (
  <UiStat label={label} value={value} color={color} style={{ flexBasis: wide ? '22%' : '45%' }} />
);

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  title: { flexShrink: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  addr: T.metaNum,
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 4 },
  chipTxt: { ...T.label, color: C.text },
  chipMeta: T.metaNum,
  note: T.meta,
  section: { ...T.title, marginTop: 8 },
});
