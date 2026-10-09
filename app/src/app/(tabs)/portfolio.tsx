import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { NftImage } from '@/components/nft-image';
import { Empty, Screen } from '@/components/screen';
import { WalletCard } from '@/components/wallet-card';
import { C } from '@/constants/brand';
import { api, type Holdings, type PaperPosition } from '@/lib/api';
import { shortAddr, signedSol, sol } from '@/lib/format';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';

export default function PortfolioScreen() {
  const { mode } = useTradeMode();
  const w = useWallet();
  return mode === 'real' && w.address ? <RealPortfolio address={w.address} /> : <PaperPortfolio />;
}

// Real mode: what the connected wallet actually holds in tracked collections,
// marked at the estimated bid (floor minus the sell haircut), like paper.
function RealPortfolio({ address }: { address: string }) {
  const [data, setData] = useState<{ address: string; h: Holdings } | { address: string; error: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(() => {
    api.holdings(address)
      .then((h) => setData({ address, h }))
      .catch((e) => setData({ address, error: (e as Error).message }))
      .finally(() => setRefreshing(false));
  }, [address]);
  useEffect(fetchData, [fetchData]);
  const refresh = () => { setRefreshing(true); fetchData(); };

  const current = data?.address === address ? data : null;
  const h = current && 'h' in current ? current.h : null;
  const pnl = h?.nfts.reduce((t, n) => (n.boughtAt != null && n.estValue != null ? t + n.estValue - n.boughtAt : t), 0) ?? 0;
  const known = h?.nfts.filter((n) => n.boughtAt != null).length ?? 0;

  return (
    <Screen title="Portfolio" subtitle={`Real mode · ${shortAddr(address)}`}>
      <WalletCard />
      <View style={s.summary}>
        <Text style={s.label}>WALLET VALUE</Text>
        <Text style={[s.big, { color: C.text }]}>{h ? sol(h.totalValue, 3) : '…'}</Text>
        {h && (
          <Text style={s.meta}>
            {sol(h.sol, 3)} + {h.nfts.length} NFT{h.nfts.length === 1 ? '' : 's'} at est. bid {sol(h.nftValue, 3)}
            {known > 0 ? ` · ${signedSol(pnl, 3)} on ${known} we saw you buy` : ''}
          </Text>
        )}
      </View>
      <FlatList
        data={h?.nfts ?? []}
        keyExtractor={(n) => n.mint}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListEmptyComponent={
          <Empty text={
            !current ? 'Loading your NFTs…'
              : !h ? `Couldn't load holdings: ${'error' in current ? current.error : ''}`
              : 'No NFTs from tracked collections in this wallet yet. Switch to Real and tap "Copy · buy floor" on a trade to buy one.'
          } />
        }
        ListFooterComponent={h && h.untracked > 0 ? (
          <Text style={[s.meta, { paddingVertical: 12 }]}>
            {h.untracked} other NFT{h.untracked === 1 ? '' : 's'} from collections FloorFeed doesn&apos;t track.
          </Text>
        ) : null}
        renderItem={({ item: n }) => {
          const p = n.boughtAt != null && n.estValue != null ? n.estValue - n.boughtAt : null;
          return (
            <View style={s.row}>
              <NftImage uri={n.image} name={n.collection.name} radius={10} px={120} style={{ width: 48 }} />
              <Link href={{ pathname: '/collection/[symbol]', params: { symbol: n.collection.symbol } }} asChild>
                <Pressable style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{n.name ?? n.collection.name}</Text>
                  <Text style={s.meta}>
                    {n.collection.name}{n.estValue != null ? ` · est. ${sol(n.estValue, 3)}` : ''}
                    {n.boughtAt != null ? ` · in ${sol(n.boughtAt, 3)}` : ''}
                  </Text>
                </Pressable>
              </Link>
              {p != null && <Text style={[s.pnl, { color: p >= 0 ? C.up : C.down }]}>{signedSol(p, 3)}</Text>}
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(`https://magiceden.io/item-details/${n.mint}`)} style={s.sell}>
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
  const [data, setData] = useState<{ positions: PaperPosition[]; realizedSol: number; unrealizedSol: number } | null>(null);
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

  const total = (data?.realizedSol ?? 0) + (data?.unrealizedSol ?? 0);

  return (
    <Screen title="Portfolio" subtitle="Paper mode: no real SOL moves">
      <WalletCard />
      <View style={s.summary}>
        <Text style={s.label}>TOTAL P&L</Text>
        <Text style={[s.big, { color: total >= 0 ? C.up : C.down }]}>{signedSol(total, 3)}</Text>
        <Text style={s.meta}>
          {signedSol(data?.realizedSol ?? 0, 3)} realized · {signedSol(data?.unrealizedSol ?? 0, 3)} open (marked at est. bid)
        </Text>
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
                in {sol(p.entryPrice)}{p.exitPrice != null ? ` · out ${sol(p.exitPrice)}` : ''}
                {p.copiedFrom ? ' · copied' : ''}
              </Text>
            </Pressable>
            </Link>
            <Text style={[s.pnl, { color: p.pnlSol >= 0 ? C.up : C.down }]}>{signedSol(p.pnlSol, 3)}</Text>
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
  summary: { marginHorizontal: 16, marginBottom: 8, padding: 16, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, gap: 4 },
  label: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  big: { fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] },
  meta: { color: C.dim, fontSize: 12.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  name: { color: C.text, fontWeight: '700', fontSize: 15 },
  pnl: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  sell: { backgroundColor: C.cardHi, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, minWidth: 52, alignItems: 'center' },
  sellTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
});
