import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { MODE_COLOR, ModeToggle } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { Empty, Screen } from '@/components/screen';
import { WalletSheet } from '@/components/wallet-button';
import { EvmWalletCard, WalletCard } from '@/components/wallet-card';
import { C } from '@/constants/brand';
import { api, type EvmHoldings, type Holding, type Holdings } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { shortAddr, signedSol, sol } from '@/lib/format';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';
import { useTitle } from '@/lib/use-title';

export default function PortfolioScreen() {
  useTitle('Portfolio | FloorFeed');
  const { mode } = useTradeMode();
  const w = useWallet();
  const ew = useEvmWallet();
  return mode === 'real' && (w.address || ew.address)
    ? <RealPortfolio solAddress={w.address} evmAddress={ew.address} />
    : <PaperPortfolio />;
}

// Paper and Real are two separate accounts: the switch sits on top, tinted
// with the mode's color, and only Real shows the wallet (balance, Deposit).
function ModeCard() {
  const { mode, canReal } = useTradeMode();
  const w = useWallet();
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <View style={[s.modeCard, { borderColor: `${MODE_COLOR[mode]}55` }]}>
      {w.supported && <ModeToggle describe={false} />}
      <Text style={s.meta}>
        {mode === 'paper'
          ? 'Paper account: simulated trades at live prices, tracked separately. Nothing here touches a real wallet.'
          : 'Real account: the NFTs, SOL and ETH in your wallets. Your wallet asks before anything is signed.'}
      </Text>
      {w.supported && !canReal && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={s.unlock}>
          <Text style={s.unlockTxt}>{auth.supported ? 'Sign in to trade for real' : 'Connect a wallet to trade for real'}</Text>
        </Pressable>
      )}
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}

// Real mode: what the user's wallets actually hold in tracked collections,
// marked at the estimated bid (floor minus the sell haircut), like paper.
// Solana and Ethereum each get their own wallet card and value (SOL vs ETH).
type Row = Holding & { unit: 'SOL' | 'ETH'; chain: 'solana' | 'evm' };

function RealPortfolio({ solAddress, evmAddress }: { solAddress: string | null; evmAddress: string | null }) {
  const [sol_, setSol] = useState<{ address: string; h: Holdings } | { address: string; error: string } | null>(null);
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

  const sh = sol_?.address === solAddress && sol_ && 'h' in sol_ ? sol_.h : null;
  const eh = evm?.address === evmAddress && evm && 'h' in evm ? evm.h : null;
  const loading = (solAddress && sol_?.address !== solAddress) || (evmAddress && evm?.address !== evmAddress);
  const rows: Row[] = [
    ...(sh?.nfts ?? []).map((n) => ({ ...n, unit: 'SOL' as const, chain: 'solana' as const })),
    ...(eh?.nfts ?? []).map((n) => ({ ...n, unit: 'ETH' as const, chain: 'evm' as const })),
  ];
  const untracked = (sh?.untracked ?? 0) + (eh?.untracked ?? 0);

  const summary = (label: string, unit: 'SOL' | 'ETH', total: number | null, cash: number | null, nfts: Holding[] | null, nftValue: number | null) => {
    const known = nfts?.filter((n) => n.boughtAt != null) ?? [];
    const pnl = known.reduce((t, n) => (n.estValue != null ? t + n.estValue - n.boughtAt! : t), 0);
    return (
      <View style={s.summary}>
        <Text style={s.label}>{label}</Text>
        <Text style={[s.big, { color: C.text }]}>{total != null ? sol(total, 3, unit) : '…'}</Text>
        {nfts && (
          <Text style={s.meta}>
            {sol(cash ?? 0, 3, unit)} + {nfts.length} NFT{nfts.length === 1 ? '' : 's'} at est. bid {sol(nftValue ?? 0, 3, unit)}
            {known.length > 0 ? ` · ${signedSol(pnl, 3, unit)} on ${known.length} we saw you buy` : ''}
          </Text>
        )}
      </View>
    );
  };

  const subtitle = [solAddress && shortAddr(solAddress), evmAddress && shortAddr(evmAddress)].filter(Boolean).join(' · ');
  return (
    <Screen title="Portfolio" subtitle={`Real account · ${subtitle}`}>
      <FlatList
        data={rows}
        keyExtractor={(n) => n.mint}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListHeaderComponent={
          <View>
            <ModeCard />
            {solAddress && <WalletCard />}
            {solAddress && summary('SOLANA WALLET VALUE', 'SOL', sh?.totalValue ?? null, sh?.sol ?? null, sh?.nfts ?? null, sh?.nftValue ?? null)}
            {evmAddress && <EvmWalletCard />}
            {evmAddress && summary('ETHEREUM WALLET VALUE', 'ETH', eh?.totalValue ?? null, eh?.eth ?? null, eh?.nfts ?? null, eh?.nftValue ?? null)}
          </View>
        }
        ListEmptyComponent={
          <View style={{ paddingHorizontal: 16 }}>
            <Empty text={loading ? 'Loading your NFTs…'
              : sol_ && 'error' in sol_ ? `Couldn't load Solana holdings: ${sol_.error}`
              : evm && 'error' in evm ? `Couldn't load Ethereum holdings: ${evm.error}`
              : 'No NFTs from tracked collections in your wallets yet. Tap "Copy · buy floor" on a trade in the feed to buy one.'} />
          </View>
        }
        ListFooterComponent={untracked > 0 ? (
          <Text style={[s.meta, { paddingVertical: 12, paddingHorizontal: 16 }]}>
            {untracked} other NFT{untracked === 1 ? '' : 's'} from collections FloorFeed doesn&apos;t track.
          </Text>
        ) : null}
        renderItem={({ item: n }) => {
          const p = n.boughtAt != null && n.estValue != null ? n.estValue - n.boughtAt : null;
          const sellUrl = n.chain === 'solana'
            ? `https://magiceden.io/item-details/${n.mint}`
            : `https://opensea.io/assets/ethereum/${n.mint.replace(':', '/')}`;
          return (
            <View style={[s.row, { marginHorizontal: 16 }]}>
              <NftImage uri={n.image} name={n.collection.name} radius={10} px={120} style={{ width: 48 }} />
              <Link href={{ pathname: '/item/[symbol]/[id]', params: { symbol: n.collection.symbol, id: n.mint } }} asChild>
                <Pressable style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{n.name ?? n.collection.name}</Text>
                  <Text style={s.meta}>
                    {n.collection.name}{n.estValue != null ? ` · est. ${sol(n.estValue, 3, n.unit)}` : ''}
                    {n.boughtAt != null ? ` · in ${sol(n.boughtAt, 3, n.unit)}` : ''}
                  </Text>
                </Pressable>
              </Link>
              {p != null && <Text style={[s.pnl, { color: p >= 0 ? C.up : C.down }]}>{signedSol(p, 3, n.unit)}</Text>}
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(sellUrl)} style={s.sell}>
                <Text style={s.sellTxt}>Sell ↗</Text>
              </Pressable>
            </View>
          );
        }}
      />
    </Screen>
  );
}

function PaperPortfolio() {
  const { userId, portfolioVersion, bumpPortfolio } = useSession();
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

  // One P&L per unit (SOL and ETH can't be added); SOL shows even when empty.
  const totals = data?.totals ?? { SOL: { realized: data?.realizedSol ?? 0, unrealized: data?.unrealizedSol ?? 0 } };
  const units = Object.keys(totals).length ? Object.keys(totals).sort((a, b) => (a === 'SOL' ? -1 : b === 'SOL' ? 1 : a.localeCompare(b))) : ['SOL'];

  return (
    <Screen title="Portfolio" subtitle="Paper account · practice trades, no real SOL">
      <ModeCard />
      <View style={[s.summary, { borderColor: `${MODE_COLOR.paper}55` }]}>
        <View style={s.labelRow}>
          <Text style={[s.label, { color: MODE_COLOR.paper }]}>PAPER P&L</Text>
          {!!data?.positions.length && (
            <Pressable onPress={reset} style={armed ? s.resetArmed : s.reset}>
              <Text style={[s.resetTxt, armed && { color: C.down }]}>{armed ? 'Tap again to wipe all paper trades' : 'Reset paper stats'}</Text>
            </Pressable>
          )}
        </View>
        {units.map((u) => {
          const t = totals[u] ?? { realized: 0, unrealized: 0 };
          const total = t.realized + t.unrealized;
          return (
            <View key={u} style={{ gap: 2 }}>
              <Text style={[s.big, units.length > 1 && { fontSize: 26 }, { color: total >= 0 ? C.up : C.down }]}>{signedSol(total, 3, u)}</Text>
              <Text style={s.meta}>
                {signedSol(t.realized, 3, u)} realized · {signedSol(t.unrealized, 3, u)} open (marked at est. bid)
              </Text>
            </View>
          );
        })}
      </View>
      <FlatList
        data={data?.positions ?? []}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListEmptyComponent={<Empty text="Tap “Copy · paper buy” on a trade in the feed to open a paper position." />}
        renderItem={({ item: p }) => (
          <View style={s.row}>
            <Link href={{ pathname: '/collection/[symbol]', params: { symbol: p.collection.symbol } }} asChild>
            <Pressable style={{ flex: 1 }}>
              <Text style={s.name}>{p.collection.name}</Text>
              <Text style={s.meta}>
                in {sol(p.entryPrice, 2, p.currency)}{p.exitPrice != null ? ` · out ${sol(p.exitPrice, 2, p.currency)}` : ''}
                {p.copiedFrom ? ' · copied' : ''}
              </Text>
            </Pressable>
            </Link>
            <Text style={[s.pnl, { color: p.pnlSol >= 0 ? C.up : C.down }]}>{signedSol(p.pnlSol, 3, p.currency ?? 'SOL')}</Text>
            {p.open ? (
              <Pressable onPress={() => sell(p.id)} style={s.sell}><Text style={s.sellTxt}>Sell</Text></Pressable>
            ) : (
              <Text style={[s.meta, { width: 52, textAlign: 'center' }]}>closed</Text>
            )}
          </View>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  modeCard: { marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, gap: 10 },
  unlock: { alignSelf: 'flex-start', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: C.accent },
  unlockTxt: { color: C.accentInk, fontWeight: '800' },
  summary: { marginHorizontal: 16, marginBottom: 8, padding: 16, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, gap: 4 },
  label: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  reset: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 4 },
  resetArmed: { borderRadius: 999, borderWidth: 1, borderColor: C.down, paddingHorizontal: 10, paddingVertical: 4 },
  resetTxt: { color: C.dim, fontSize: 12, fontWeight: '700' },
  big: { fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] },
  meta: { color: C.dim, fontSize: 12.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  pnl: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  sell: { backgroundColor: C.cardHi, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, minWidth: 52, alignItems: 'center' },
  sellTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
});
