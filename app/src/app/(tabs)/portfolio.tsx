import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { MODE_COLOR, ModeToggle } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { Screen } from '@/components/screen';
import { Button, Card, ListRow, RowAction, SectionHeader } from '@/components/ui';
import { WalletSheet } from '@/components/wallet-button';
import { WalletsCard } from '@/components/wallet-card';
import { C } from '@/constants/brand';
import { openseaAsset } from '@/constants/chains';
import { T, display } from '@/constants/type';
import { api, type EvmHoldings, type Holding, type Holdings, type PaperPosition } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { signedSol, sol } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';
import { useWallet } from '@/lib/wallet';

// Portfolio: two separate accounts behind one switch. Paper is simulated
// trades at live prices; Real is what the user's wallets hold. Both share one
// layout: the switch in the header, a summary card with the one big number,
// then a list in the same row style.
export default function PortfolioScreen() {
  useTitle('Portfolio | FloorFeed');
  const { mode } = useTradeMode();
  const w = useWallet();
  const ew = useEvmWallet();
  const real = mode === 'real' && !!(w.address || ew.address);
  return (
    <Screen
      title="Portfolio"
      subtitle={real ? 'What your wallets hold, valued at the estimated bid' : 'Practice account: simulated trades at live prices'}
      right={<ModeSwitch />}>
      {real ? <RealPortfolio solAddress={w.address} evmAddress={ew.address} /> : <PaperPortfolio />}
    </Screen>
  );
}

function ModeSwitch() {
  const { canReal } = useTradeMode();
  const w = useWallet();
  const auth = useAuth();
  const { wide } = useLayout();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6, width: wide ? 260 : undefined }}>
      {w.supported && <ModeToggle describe={false} />}
      {w.supported && !canReal && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(true)} hitSlop={6}>
          <Text style={[T.label, { color: C.accent, textAlign: wide ? 'right' : 'left' }]}>
            {auth.supported ? 'Sign in to trade for real' : 'Connect a wallet to trade for real'}
          </Text>
        </Pressable>
      )}
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}

// One P&L per unit (SOL and ETH can't be added). With two units the numbers
// sit side by side at a smaller size.
function Totals({ label, color, units }: {
  label: string;
  color: string;
  units: { unit: string; total: number | null; line: string; colored?: boolean }[];  // null = loading
}) {
  const many = units.length > 1;
  return (
    <Card>
      <View style={s.labelRow}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <Text style={T.label}>{label}</Text>
      </View>
      <View style={[s.totals, many && { gap: 24 }]}>
        {units.map((u) => (
          <View key={u.unit} style={{ gap: 4, flexShrink: 1 }}>
            <Text {...display} numberOfLines={1}
              style={[many ? T.display : T.hero, { color: u.total == null || u.colored === false ? C.text : u.total >= 0 ? C.up : C.down }]}>
              {u.total == null ? `… ${u.unit}` : u.colored === false ? sol(u.total, 3, u.unit) : signedSol(u.total, 3, u.unit)}
            </Text>
            <Text style={T.metaNum}>{u.line}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// --- Paper --------------------------------------------------------------------

function PaperPortfolio() {
  const { userId, portfolioVersion, bumpPortfolio } = useSession();
  const { pad } = useLayout();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.paper>> | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(() => {
    if (!userId) return;
    api.paper(userId).then(setData).catch(() => {}).finally(() => setRefreshing(false));
  }, [userId]);
  useEffect(fetchData, [fetchData, portfolioVersion]);
  const refresh = () => { setRefreshing(true); fetchData(); };

  const sell = async (id: number) => {
    if (!userId) return;
    await api.sell(userId, id).catch(() => {});
    bumpPortfolio();
  };

  // Two taps to reset (no blocking confirm dialogs on web); the arm expires.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const reset = async () => {
    if (!userId) return;
    if (!armed) return setArmed(true);
    setArmed(false);
    await api.resetPaper(userId).catch(() => {});
    bumpPortfolio();
  };

  const positions = data?.positions ?? [];
  const totals = data?.totals ?? { SOL: { realized: data?.realizedSol ?? 0, unrealized: data?.unrealizedSol ?? 0 } };
  const units = (Object.keys(totals).length ? Object.keys(totals) : ['SOL'])
    .sort((a, b) => (a === 'SOL' ? -1 : b === 'SOL' ? 1 : a.localeCompare(b)))
    .map((unit) => {
      const t = totals[unit] ?? { realized: 0, unrealized: 0 };
      return { unit, total: t.realized + t.unrealized, line: `${signedSol(t.realized, 3, unit)} realized, ${signedSol(t.unrealized, 3, unit)} open` };
    });
  const open = positions.filter((p) => p.open).length;

  return (
    <FlatList
      data={positions}
      keyExtractor={(p) => String(p.id)}
      contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 16, marginBottom: 4 }}>
          <Totals label="Paper profit and loss" color={MODE_COLOR.paper} units={units} />
          <SectionHeader
            title="Positions"
            count={positions.length || undefined}
            action={positions.length ? (
              <Pressable accessibilityRole="button" onPress={reset} hitSlop={8}>
                <Text style={[T.label, armed && { color: C.down }]}>{armed ? 'Tap again to delete all paper trades' : 'Reset'}</Text>
              </Pressable>
            ) : null}
          />
          {positions.length > 0 && <Text style={T.meta}>{open} open, {positions.length - open} closed. Open positions are marked at the estimated bid.</Text>}
        </View>
      }
      ListEmptyComponent={
        <Card style={{ alignItems: 'flex-start' }}>
          <Text style={T.bodyStrong}>No paper trades yet</Text>
          <Text style={T.meta}>Open a position from any trade in the feed with Copy. It buys the collection&apos;s floor with simulated money.</Text>
          <Button label="Go to the feed" tone="secondary" onPress={() => router.push('/')} />
        </Card>
      }
      renderItem={({ item: p }) => <PositionRow p={p} onSell={() => sell(p.id)} />}
    />
  );
}

function PositionRow({ p, onSell }: { p: PaperPosition; onSell: () => void }) {
  const u = p.currency ?? 'SOL';
  return (
    <ListRow
      onPress={() => router.push({ pathname: '/collection/[symbol]', params: { symbol: p.collection.symbol } })}
      art={<CollIcon name={p.collection.name} uri={p.collection.image ?? null} size={44} radius={10} />}
      title={p.collection.name}
      meta={p.open
        ? `Bought at ${sol(p.entryPrice, 2, u)}${p.copiedFrom ? ', copied' : ''}`
        : `${sol(p.entryPrice, 2, u)} → ${sol(p.exitPrice ?? 0, 2, u)}`}
      value={signedSol(p.pnlSol, 3, u)}
      valueColor={p.pnlSol >= 0 ? C.up : C.down}
      sub={p.open ? 'Open' : 'Closed'}
      action={p.open ? <RowAction label="Sell" onPress={onSell} /> : <View style={{ width: 52 }} />}
    />
  );
}

// --- Real -------------------------------------------------------------------

type Row = Holding & { unit: 'SOL' | 'ETH'; chain: 'solana' | 'evm'; evmChain?: string };

function RealPortfolio({ solAddress, evmAddress }: { solAddress: string | null; evmAddress: string | null }) {
  const { pad } = useLayout();
  const [solData, setSol] = useState<{ address: string; h: Holdings } | { address: string; error: string } | null>(null);
  const [evm, setEvm] = useState<{ address: string; h: EvmHoldings } | { address: string; error: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(() => {
    const jobs: Promise<unknown>[] = [];
    if (solAddress) {
      jobs.push(api.holdings(solAddress).then((h) => setSol({ address: solAddress, h }))
        .catch((e) => setSol({ address: solAddress, error: (e as Error).message })));
    }
    if (evmAddress) {
      jobs.push(api.evmHoldings(evmAddress).then((h) => setEvm({ address: evmAddress, h }))
        .catch((e) => setEvm({ address: evmAddress, error: (e as Error).message })));
    }
    Promise.all(jobs).finally(() => setRefreshing(false));
  }, [solAddress, evmAddress]);
  useEffect(fetchData, [fetchData]);
  const refresh = () => { setRefreshing(true); fetchData(); };

  const sh = solData?.address === solAddress && solData && 'h' in solData ? solData.h : null;
  const eh = evm?.address === evmAddress && evm && 'h' in evm ? evm.h : null;
  const loading = (!!solAddress && solData?.address !== solAddress) || (!!evmAddress && evm?.address !== evmAddress);
  const error = (solData && 'error' in solData && solData.error) || (evm && 'error' in evm && evm.error) || null;
  const rows: Row[] = [
    ...(sh?.nfts ?? []).map((n) => ({ ...n, unit: 'SOL' as const, chain: 'solana' as const })),
    ...(eh?.nfts ?? []).map((n) => ({ ...n, unit: 'ETH' as const, chain: 'evm' as const, evmChain: n.chain })),
  ];
  const untracked = (sh?.untracked ?? 0) + (eh?.untracked ?? 0);

  const units = [
    ...(solAddress ? [{ unit: 'SOL', total: sh?.totalValue ?? null, line: sh ? `${sol(sh.sol, 3)} plus ${sh.nfts.length} NFT${sh.nfts.length === 1 ? '' : 's'}` : solData && 'error' in solData ? "Couldn't load" : 'Loading…', colored: false }] : []),
    ...(evmAddress ? [{ unit: 'ETH', total: eh?.totalValue ?? null, line: eh ? `${sol(eh.eth, 3, 'ETH')} plus ${eh.nfts.length} NFT${eh.nfts.length === 1 ? '' : 's'}` : evm && 'error' in evm ? "Couldn't load" : 'Loading…', colored: false }] : []),
  ];

  return (
    <FlatList
      data={rows}
      keyExtractor={(n) => n.mint}
      contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 16, marginBottom: 4 }}>
          <Totals label="Wallet value" color={MODE_COLOR.real} units={units} />
          <WalletsCard />
          <SectionHeader title="Holdings" count={rows.length || undefined} />
        </View>
      }
      ListEmptyComponent={
        <Card style={{ alignItems: 'flex-start' }}>
          {loading ? <Text style={T.meta}>Loading your NFTs…</Text> : error ? (
            <Text style={T.meta}>Couldn&apos;t load your holdings: {error}. Pull to refresh.</Text>
          ) : (
            <>
              <Text style={T.bodyStrong}>No NFTs from tracked collections yet</Text>
              <Text style={T.meta}>Buy the floor of any collection from its page, or copy a trade from the feed.</Text>
              <Button label="Go to the feed" tone="secondary" onPress={() => router.push('/')} />
            </>
          )}
        </Card>
      }
      ListFooterComponent={untracked > 0 ? (
        <Text style={[T.caption, { paddingVertical: 12 }]}>
          {untracked} other NFT{untracked === 1 ? '' : 's'} from collections FloorFeed doesn&apos;t track.
        </Text>
      ) : null}
      renderItem={({ item: n }) => {
        const p = n.boughtAt != null && n.estValue != null ? n.estValue - n.boughtAt : null;
        const sellUrl = n.chain === 'solana'
          ? `https://magiceden.io/item-details/${n.mint}`
          : openseaAsset(n.evmChain ?? 'ethereum', n.mint);
        return (
          <ListRow
            onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: n.collection.symbol, id: n.mint } })}
            art={<NftImage uri={n.image} name={n.collection.name} radius={10} px={120} style={{ width: 44 }} />}
            title={n.name || n.collection.name}
            meta={n.boughtAt != null ? `${n.collection.name}, bought at ${sol(n.boughtAt, 2, n.unit)}` : n.collection.name}
            value={n.estValue != null ? sol(n.estValue, 3, n.unit) : '—'}
            sub={p != null ? signedSol(p, 3, n.unit) : undefined}
            subColor={p != null ? (p >= 0 ? C.up : C.down) : undefined}
            action={<RowAction label="Sell" onPress={() => Linking.openURL(sellUrl)} />}
          />
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  totals: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
