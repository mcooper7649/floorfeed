import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { EvmBuySheet } from '@/components/evm-buy-sheet';
import { EvmListSheet } from '@/components/evm-list-sheet';
import { EvmSellSheet } from '@/components/evm-sell-sheet';
import { Avatar, TierBadge } from '@/components/event-card';
import { NftImage, Pill } from '@/components/nft-image';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { Stat } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { api, type ItemDetail } from '@/lib/api';
import { shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { useTitle } from '@/lib/use-title';

// Rarity band from the rank's percentile; the rank itself is always shown too.
function band(rank: number, total: number | null) {
  if (!total) return null;
  const p = rank / total;
  if (p <= 0.01) return { label: 'Legendary', color: '#FFB547' };
  if (p <= 0.05) return { label: 'Epic', color: C.ai };
  if (p <= 0.15) return { label: 'Rare', color: '#4DA3FF' };
  if (p <= 0.4) return { label: 'Uncommon', color: C.up };
  return { label: 'Common', color: C.dim };
}

const pctLabel = (p: number) => (p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);

export default function ItemScreen() {
  const { symbol, id } = useLocalSearchParams<{ symbol: string; id: string }>();
  // Keyed by the item, so moving to another NFT never shows the previous one.
  const key = `${symbol}/${id}`;
  const [loaded, setLoaded] = useState<{ key: string; d?: ItemDetail; error?: string } | null>(null);
  const data = loaded?.key === key ? loaded.d ?? null : null;
  const error = loaded?.key === key ? loaded.error ?? null : null;
  const { wide, pad, maxWidth } = useLayout();
  const { mode } = useTradeMode();
  const [buyOpen, setBuyOpen] = useState(false);
  const [sellOpen, setSellOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const evmWallet = useEvmWallet();

  useTitle(data && `${data.name ?? data.collection.name}${data.rarity ? ` · Rank ${data.rarity.rank.toLocaleString()}` : ''}: traits, rarity & sales | FloorFeed`);

  useEffect(() => {
    let alive = true;
    api.item(symbol, id)
      .then((d) => alive && setLoaded({ key: `${symbol}/${id}`, d }))
      .catch((e) => alive && setLoaded({ key: `${symbol}/${id}`, error: (e as Error).message }));
    return () => { alive = false; };
  }, [symbol, id]);

  const nav = Platform.OS === 'web' && <TopNav back />;
  if (error) return <View style={s.fill}>{nav}<Empty text={error} /></View>;
  if (!data) return <View style={s.fill}>{nav}<ActivityIndicator style={{ marginTop: 40 }} color={C.accent} /></View>;

  const u = data.currency;
  const title = data.name ?? `${data.collection.name} ${shortAddr(data.id)}`;
  const b = data.rarity ? band(data.rarity.rank, data.rarity.total) : null;
  const market = data.chain === 'solana' ? 'Magic Eden' : 'OpenSea';
  // The connected Ethereum wallet holds this NFT: offer the in-app sale (the quote re-checks ownership on chain).
  const mine = data.chain !== 'solana' && !!evmWallet.address && data.owner?.wallet?.toLowerCase() === evmWallet.address;
  const vsFloor = data.listing && data.collection.floor
    ? ((data.listing.price - data.collection.floor) / data.collection.floor) * 100 : null;

  const art = (
    <NftImage uri={data.image} name={title} radius={18} px={wide ? 900 : 640}>
      {b && <Pill text={`${b.label} · #${data.rarity!.rank.toLocaleString()}`} style={{ top: 12, left: 12 }} />}
    </NftImage>
  );

  const facts = (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Link href={{ pathname: '/collection/[symbol]', params: { symbol: data.symbol } }} asChild>
          <Pressable style={s.collRow}>
            <ChainBadge chain={data.chain} />
            <Text style={s.collName}>{data.collection.name} ›</Text>
          </Pressable>
        </Link>
        <Text {...display} style={wide ? T.displayL : T.display}>{title}</Text>
      </View>

      <View style={s.statRow}>
        <Fact label="Rarity rank" value={data.rarity ? `#${data.rarity.rank.toLocaleString()}` : data.rarityPending ? 'Ranking…' : '—'}
          sub={data.rarity?.total ? `of ${data.rarity.total.toLocaleString()} · top ${pctLabel((data.rarity.rank / data.rarity.total) * 100)}` : undefined}
          color={b?.color} />
        <Fact label={data.listing ? 'Listed at' : 'Last sale'}
          value={data.listing ? sol(data.listing.price, 2, u) : data.lastSale ? sol(data.lastSale.price, 2, u) : '—'}
          sub={data.listing
            ? (vsFloor != null ? `${vsFloor >= 0 ? '+' : '−'}${Math.abs(vsFloor).toFixed(1)}% vs floor` : `on ${market}`)
            : data.lastSale ? `${timeAgo(data.lastSale.t)} ago` : 'not tracked'} />
        <Fact label="Collection floor" value={data.collection.floor != null ? sol(data.collection.floor, 2, u) : '—'} />
      </View>

      {data.owner && (
        <Link href={{ pathname: '/wallet/[address]', params: { address: data.owner.wallet } }} asChild>
          <Pressable style={s.owner}>
            <Avatar t={data.owner} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={s.label}>OWNER</Text>
              <View style={s.nameRow}>
                <Text style={s.ownerName} numberOfLines={1}>{data.owner.name ?? shortAddr(data.owner.wallet)}</Text>
                <TierBadge tier={data.owner.tier === 'new' ? null : data.owner.tier} />
              </View>
            </View>
            <Text style={s.chev}>›</Text>
          </Pressable>
        </Link>
      )}

      <View style={s.ctaRow}>
        {mine ? (
          <>
            <Pressable accessibilityRole="button" onPress={() => setSellOpen(true)} style={s.primary}>
              <Text style={s.primaryTxt}>Sell to the best offer</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setListOpen(true)} style={s.secondary}>
              <Text style={s.secondaryTxt}>List for sale</Text>
            </Pressable>
          </>
        ) : data.listing && data.chain !== 'solana' && mode === 'real' ? (
          <Pressable accessibilityRole="button" onPress={() => setBuyOpen(true)} style={s.primary}>
            <Text style={s.primaryTxt}>Buy now · {sol(data.listing.price, 2, u)}</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(data.listing?.url ?? data.marketUrl)}
            style={data.listing ? s.primary : s.secondary}>
            <Text style={data.listing ? s.primaryTxt : s.secondaryTxt}>
              {data.listing ? `Buy on ${market} · ${sol(data.listing.price, 2, u)} ↗` : `View on ${market} ↗`}
            </Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="link" onPress={() => Linking.openURL(data.explorerUrl)} style={s.secondary}>
          <Text style={s.secondaryTxt}>Explorer ↗</Text>
        </Pressable>
      </View>
    </View>
  );

  const traits = (
    <View style={{ gap: 10 }}>
      <Text style={s.section}>Traits, rarest first</Text>
      {data.traits.length === 0 ? <Text style={s.note}>This NFT has no trait metadata.</Text> : (
        <View style={s.traitGrid}>
          {data.traits.map((t) => (
            <View key={`${t.type}:${t.value}`} style={[s.trait, wide && { flexBasis: '31%' }]}>
              <Text style={s.traitType} numberOfLines={1}>{t.type}</Text>
              <Text style={s.traitVal} numberOfLines={2}>{t.value}</Text>
              {t.pct != null && (
                <>
                  <View style={s.bar}><View style={[s.barFill, { width: `${Math.max(2, Math.min(100, t.pct))}%`, backgroundColor: t.pct < 5 ? C.accent : C.dim }]} /></View>
                  <Text style={s.traitPct}>{pctLabel(t.pct)} have this{t.count != null ? ` · ${t.count.toLocaleString()}` : ''}</Text>
                </>
              )}
            </View>
          ))}
        </View>
      )}
      {data.rarity && (
        <Text style={s.note}>
          {data.rarity.source === 'FloorFeed'
            ? 'Rank computed by FloorFeed from every item in the collection: rarer trait values score higher (OpenRarity-style).'
            : `Rank from ${data.rarity.source}.`}
        </Text>
      )}
    </View>
  );

  const history = (
    <View style={{ gap: 4 }}>
      <Text style={s.section}>Sales of this NFT</Text>
      {data.history.length === 0 ? <Text style={s.note}>No sales of this NFT in FloorFeed&apos;s history yet.</Text> :
        data.history.map((h) => (
          <View key={h.signature} style={s.saleRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.saleWho} numberOfLines={1}>
                <Link href={{ pathname: '/wallet/[address]', params: { address: h.seller } }}><Text style={s.link}>{h.sellerName ?? shortAddr(h.seller)}</Text></Link>
                <Text style={s.meta}> → </Text>
                <Link href={{ pathname: '/wallet/[address]', params: { address: h.buyer } }}><Text style={s.link}>{h.buyerName ?? shortAddr(h.buyer)}</Text></Link>
              </Text>
              <Text style={s.meta}>
                {timeAgo(h.t)} ago
                {h.flipPnl != null && <Text style={{ color: h.flipPnl >= 0 ? C.up : C.down }}> · seller {h.flipPnl >= 0 ? 'flipped' : 'sold at a loss'} {signedSol(h.flipPnl, 2, u)}</Text>}
              </Text>
            </View>
            <Text style={s.salePrice}>{sol(h.price, 2, u)}</Text>
          </View>
        ))}
    </View>
  );

  return (
    <View style={s.fill}>
      <Stack.Screen options={{ title }} />
      {nav}
      {data.chain !== 'solana' && <EvmBuySheet symbol={data.symbol} id={data.id} open={buyOpen} onClose={() => setBuyOpen(false)} />}
      {mine && <EvmSellSheet symbol={data.symbol} id={data.id} open={sellOpen} onClose={() => setSellOpen(false)} />}
      {mine && listOpen && <EvmListSheet symbol={data.symbol} id={data.id} open onClose={() => setListOpen(false)} />}
      <ScrollView contentContainerStyle={{ padding: pad, paddingBottom: 60, width: '100%', maxWidth, alignSelf: 'center', gap: 24 }}>
        {wide ? (
          <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>{art}</View>
            <View style={{ flex: 1, gap: 24 }}>{facts}{traits}</View>
          </View>
        ) : (
          <>{art}{facts}{traits}</>
        )}
        {history}
      </ScrollView>
    </View>
  );
}

const Fact = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
  <Stat label={label} value={value} sub={sub} color={color} style={{ flexBasis: '30%', minWidth: 140 }} />
);

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  collRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  collName: { ...T.label, color: C.accent },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: T.label,
  meta: T.metaNum,
  note: T.caption,
  owner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: C.border },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ownerName: { ...T.bodyStrong, flexShrink: 1 },
  chev: { color: C.dim, fontSize: 21 },
  ctaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primary: { flexGrow: 1, backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { flexGrow: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  section: T.title,
  traitGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  trait: { flexGrow: 1, flexBasis: '46%', backgroundColor: C.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, gap: 2 },
  traitType: T.caption,
  traitVal: T.bodyStrong,
  bar: { height: 4, borderRadius: 2, backgroundColor: C.grid, overflow: 'hidden', marginTop: 4 },
  barFill: { height: 4, borderRadius: 2 },
  traitPct: T.metaNum,
  saleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  saleWho: T.body,
  link: { ...T.bodyStrong },
  salePrice: T.num,
});
