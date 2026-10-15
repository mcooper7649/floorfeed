import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { ActivityList } from '@/components/activity-list';
import { EvmListSheet } from '@/components/evm-list-sheet';
import { EvmSellSheet } from '@/components/evm-sell-sheet';
import { NetworksCard, networkLines } from '@/components/networks-card';
import { MODE_COLOR, ModeToggle } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { Screen } from '@/components/screen';
import { Button, Card, ListRow, RowAction, SectionHeader } from '@/components/ui';
import { WalletSheet } from '@/components/wallet-button';
import { WalletsCard } from '@/components/wallet-card';
import { C } from '@/constants/brand';
import { openseaAsset } from '@/constants/chains';
import { T, display } from '@/constants/type';
import { api, type EvmHoldings, type EvmNetwork, type Holding, type Holdings, type PaperPosition } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { signedSol, signedUsd, sol, usd } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { usePrices } from '@/lib/prices';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';
import { useWallet } from '@/lib/wallet';
import { track } from '@/lib/analytics';

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
  const { toUsd } = usePrices();
  // Each currency in dollars at today's price, plus one combined figure when there are several.
  const usdOf = (u: (typeof units)[number]) => (u.total == null ? null : toUsd(u.total, u.unit));
  const usdAll = units.reduce<number | null>((a, u) => (a == null || usdOf(u) == null ? null : a + usdOf(u)!), 0);
  const fmt = (n: number, colored: boolean) => `≈ ${colored ? signedUsd(n) : usd(n)}`;
  return (
    <Card>
      <View style={s.labelRow}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <Text style={[T.label, { flex: 1 }]}>{label}</Text>
        {many && usdAll != null && <Text style={[T.num, { color: C.text }]}>{fmt(usdAll, units.some((u) => u.colored !== false))} total</Text>}
      </View>
      <View style={[s.totals, many && { gap: 24 }]}>
        {units.map((u) => (
          <View key={u.unit} style={{ gap: 4, flexShrink: 1 }}>
            <Text {...display} numberOfLines={1}
              style={[many ? T.display : T.hero, { color: u.total == null || u.colored === false ? C.text : u.total >= 0 ? C.up : C.down }]}>
              {u.total == null ? `… ${u.unit}` : u.colored === false ? sol(u.total, 3, u.unit) : signedSol(u.total, 3, u.unit)}
            </Text>
            {usdOf(u) != null && <Text style={[T.num, { color: C.text }]}>{fmt(usdOf(u)!, u.colored !== false)}</Text>}
            <Text style={T.metaNum}>{u.line}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// Real mode headline: all money across wallets and networks in dollars, then
// the split (coins vs NFTs) and each currency in its own units.
function MoneyTotal({ loading, cash, nfts, nftCount, networks, units }: {
  loading: boolean; cash: number | null; nfts: number | null; nftCount: number; networks: number;
  units: { unit: string; total: number | null; line: string }[];
}) {
  const total = cash != null && nfts != null ? cash + nfts : null;
  return (
    <Card>
      <View style={s.labelRow}>
        <View style={[s.dot, { backgroundColor: MODE_COLOR.real }]} />
        <Text style={T.label}>Total across your wallets</Text>
      </View>
      <Text {...display} style={[T.hero, { color: C.text }]}>{total != null ? usd(total) : loading ? '…' : '—'}</Text>
      <Text style={T.metaNum}>
        {cash != null ? `${usd(cash)} in coins` : 'Coins …'}{networks > 0 ? ` on ${networks} network${networks === 1 ? '' : 's'}` : ''}
        {' · '}{nfts != null ? `${usd(nfts)} in ${nftCount} NFT${nftCount === 1 ? '' : 's'}` : 'NFTs …'}
      </Text>
      <View style={[s.totals, { gap: 16, marginTop: 4 }]}>
        {units.filter((u) => u.total != null && u.total > 0).map((u) => (
          <Text key={u.unit} style={T.metaNum}>{sol(u.total!, 3, u.unit)}</Text>
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
    await api.sell(userId, id).then(() => track('paper_sell')).catch(() => {});
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
          <Totals label="Paper profit and loss, after fees" color={MODE_COLOR.paper} units={units} />
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
  const { toUsd } = usePrices();
  const pnlUsd = toUsd(p.pnlSol, u);
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
      note={pnlUsd != null ? `≈ ${signedUsd(pnlUsd)}` : undefined}
      sub={p.open ? 'Open' : 'Closed'}
      action={p.open ? <RowAction label="Sell" onPress={onSell} /> : <View style={{ width: 52 }} />}
    />
  );
}

// --- Real -------------------------------------------------------------------

type Row = Omit<Holding, 'unit' | 'chain'> & { unit: string; chain: 'solana' | 'evm'; evmChain?: string };

function RealPortfolio({ solAddress, evmAddress }: { solAddress: string | null; evmAddress: string | null }) {
  const { pad } = useLayout();
  const { toUsd } = usePrices();
  const [solData, setSol] = useState<{ address: string; h: Holdings } | { address: string; error: string } | null>(null);
  const [evm, setEvm] = useState<{ address: string; h: EvmHoldings } | { address: string; error: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selling, setSelling] = useState<Row | null>(null);
  const [listing, setListing] = useState<Row | null>(null);
  const [nets, setNets] = useState<{ address: string; n: EvmNetwork[] } | null>(null);

  const fetchData = useCallback(() => {
    const jobs: Promise<unknown>[] = [];
    if (solAddress) {
      jobs.push(api.holdings(solAddress).then((h) => setSol({ address: solAddress, h }))
        .catch((e) => setSol({ address: solAddress, error: (e as Error).message })));
    }
    if (evmAddress) {
      jobs.push(api.evmHoldings(evmAddress).then((h) => setEvm({ address: evmAddress, h }))
        .catch((e) => setEvm({ address: evmAddress, error: (e as Error).message })));
      jobs.push(api.evmNetworks(evmAddress).then((n) => setNets({ address: evmAddress, n })).catch(() => {}));
    }
    Promise.all(jobs).finally(() => setRefreshing(false));
  }, [solAddress, evmAddress]);
  useEffect(fetchData, [fetchData]);
  const refresh = () => { setRefreshing(true); fetchData(); };

  const sh = solData?.address === solAddress && solData && 'h' in solData ? solData.h : null;
  const eh = evm?.address === evmAddress && evm && 'h' in evm ? evm.h : null;
  const en = nets?.address === evmAddress ? nets.n : null;
  const loading = (!!solAddress && solData?.address !== solAddress) || (!!evmAddress && evm?.address !== evmAddress);
  const error = (solData && 'error' in solData && solData.error) || (evm && 'error' in evm && evm.error) || null;
  const rows: Row[] = [
    ...(sh?.nfts ?? []).map((n) => ({ ...n, unit: 'SOL' as const, chain: 'solana' as const })),
    ...(eh?.nfts ?? []).map((n) => ({ ...n, unit: n.unit ?? 'ETH', chain: 'evm' as const, evmChain: n.chain })),
  ];
  const untracked = (sh?.untracked ?? 0) + (eh?.untracked ?? 0);

  // Everything in dollars: coins on every network (wrapped included) plus NFTs at the estimated bid.
  const cashLines = networkLines(sh?.sol ?? null, en, toUsd);
  const cashUsd = cashLines.reduce<number | null>((a, l) => (a == null || l.usd == null ? null : a + l.usd), 0);
  const nftUsd = rows.reduce<number | null>((a, n) => {
    if (a == null) return null;
    if (n.estValue == null) return a;
    const v = toUsd(n.estValue, n.unit);
    return v == null ? null : a + v;
  }, 0);
  const moneyLoading = (!!solAddress && !sh) || (!!evmAddress && (!eh || !en));
  // The same money per currency (wrapped coins counted as their coin), for the line under the total.
  const perUnit = new Map<string, number>();
  for (const l of cashLines) for (const p of l.parts) perUnit.set(p.unit, (perUnit.get(p.unit) ?? 0) + p.amount);
  for (const n of rows) if (n.estValue != null) perUnit.set(n.unit, (perUnit.get(n.unit) ?? 0) + n.estValue);
  const unitTotals = [...perUnit].map(([unit, total]) => ({ unit, total, line: '' }));


  return (
    <>
    {listing && (
      <EvmListSheet symbol={listing.collection.symbol} id={listing.mint} open onClose={() => setListing(null)}
        onDone={() => setTimeout(fetchData, 3_000)} />
    )}
    {selling && (
      <EvmSellSheet symbol={selling.collection.symbol} id={selling.mint} open onClose={() => setSelling(null)}
        onSold={() => setTimeout(fetchData, 20_000)} />
    )}
    <FlatList
      data={rows}
      keyExtractor={(n) => n.mint}
      contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
      ListHeaderComponent={
        <View style={{ gap: 16, marginBottom: 4 }}>
          <MoneyTotal loading={moneyLoading} cash={cashUsd} nfts={nftUsd} nftCount={rows.length} networks={cashLines.length} units={unitTotals} />
          <WalletsCard />
          <NetworksCard sol={solAddress ? sh?.sol ?? null : null} networks={evmAddress ? en : []} onChanged={fetchData} />
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
      ListFooterComponent={
        <View style={{ gap: 12, paddingTop: 8 }}>
          {untracked > 0 && (
            <Text style={T.caption}>
              {untracked} other NFT{untracked === 1 ? '' : 's'} from collections FloorFeed doesn&apos;t track.
            </Text>
          )}
          {(evmAddress || solAddress) && (
            <>
              <SectionHeader title="Activity" />
              <ActivityList wallets={[evmAddress, solAddress].filter((a): a is string => !!a)} onSettled={fetchData} />
            </>
          )}
        </View>
      }
      renderItem={({ item: n }) => {
        const p = n.boughtAt != null && n.estValue != null ? n.estValue - n.boughtAt : null;
        const valueUsd = n.estValue != null ? toUsd(n.estValue, n.unit) : null;
        const pUsd = p != null ? toUsd(p, n.unit) : null;
        const sellUrl = n.chain === 'solana'
          ? `https://magiceden.io/item-details/${n.mint}`
          : openseaAsset(n.evmChain ?? 'ethereum', n.mint);
        return (
          <ListRow
            onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: n.collection.symbol, id: n.mint } })}
            art={<NftImage uri={n.image} name={n.collection.name} radius={10} px={120} style={{ width: 44 }} />}
            title={n.name || n.collection.name}
            meta={[n.collection.name, n.boughtAt != null ? `bought at ${sol(n.boughtAt, 2, n.unit)}` : null,
              n.listing ? `listed at ${sol(n.listing.price, 3, n.unit)}` : null].filter(Boolean).join(', ')}
            value={n.estValue != null ? sol(n.estValue, 3, n.unit) : '—'}
            note={valueUsd != null ? `≈ ${usd(valueUsd)}` : undefined}
            sub={p != null ? `${signedSol(p, 3, n.unit)}${pUsd != null ? ` (${signedUsd(pUsd)})` : ''}` : undefined}
            subColor={p != null ? (p >= 0 ? C.up : C.down) : undefined}
            // Ethereum-family NFTs sell in-app into the best offer; Solana still finishes on Magic Eden.
            // EVM NFTs can also be listed at your price (OpenSea), from here.
            action={n.chain === 'evm' ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <RowAction label="Sell" onPress={() => setSelling(n)} />
                <RowAction label={n.listing ? 'Listed' : 'List'} onPress={() => setListing(n)} />
              </View>
            ) : <RowAction label="Sell" onPress={() => Linking.openURL(sellUrl)} />}
          />
        );
      }}
    />
    </>
  );
}

const s = StyleSheet.create({
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  totals: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
