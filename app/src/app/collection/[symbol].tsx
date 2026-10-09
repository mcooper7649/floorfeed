import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BuySheet } from '@/components/buy-sheet';
import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { DepthChart } from '@/components/depth-chart';
import { Avatar } from '@/components/event-card';
import { FloorLine } from '@/components/floor-line';
import { MODE_COLOR } from '@/components/mode-toggle';
import { NftImage, Pill } from '@/components/nft-image';
import { PriceChart } from '@/components/price-chart';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { C } from '@/constants/brand';
import { api, type CollectionDetail } from '@/lib/api';
import { amt, shortAddr, signedSol, sol, timeAgo, usdCompact } from '@/lib/format';
import { thumb } from '@/lib/img';
import { columnsFor, useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { fmtDay, fmtSol } from '@/lib/scale';
import { useSession } from '@/lib/session';

const RANGES = [1, 7, 30] as const;
const web = Platform.OS === 'web';
const CHAIN_NAME = { solana: 'Solana', ethereum: 'Ethereum', base: 'Base', polygon: 'Polygon' } as const;

export default function CollectionScreen() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const { userId, bumpPortfolio } = useSession();
  const { wide, pad, maxWidth, contentWidth } = useLayout();
  const [range, setRange] = useState<number>(7);
  const [data, setData] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [buy, setBuy] = useState<string | null>(null);
  const { mode } = useTradeMode();
  const [buyOpen, setBuyOpen] = useState(false);

  const fetchData = useCallback(() => {
    api.collection(symbol, range).then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [symbol, range]);
  useEffect(fetchData, [fetchData]);

  // A Solana collection opened before its history arrived: the server is
  // paging Magic Eden in the background, so check back a few times.
  const pollKey = `${symbol}:${range}`;
  const [pollState, setPollState] = useState({ key: pollKey, n: 0 });
  const polls = pollState.key === pollKey ? pollState.n : 0; // resets per collection/range
  const thin = !!data && data.chain === 'solana' && data.daily.length < 2;
  useEffect(() => {
    if (!thin || polls >= 4) return;
    const t = setTimeout(() => { setPollState({ key: pollKey, n: polls + 1 }); fetchData(); }, 8000);
    return () => clearTimeout(t);
  }, [thin, polls, pollKey, fetchData]);

  // Refetch keeps the frame: the old render stays (dimmed) until new data lands.
  const pickRange = (r: number) => { if (r !== range) { setLoading(true); setRange(r); } };

  const paperBuy = async () => {
    if (!userId || !data) return;
    setBuy('Buying…');
    try {
      const r = await api.buyFloor(userId, data.symbol);
      setBuy(`Bought floor @ ${sol(r.entryPrice)}`);
      bumpPortfolio();
    } catch (e) {
      setBuy((e as Error).message);
    }
  };

  const shell = (body: ReactNode) => (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {web && <TopNav back />}
      {body}
    </View>
  );
  if (error && !data) return shell(<Empty text={error} />);
  if (!data) return shell(<ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />);

  const st = data.stats;
  const cur = data.currency;
  const evm = data.chain !== 'solana';
  const within5 = st.floor ? data.listings.filter((l) => l.price <= st.floor! * 1.05).length : 0;
  const rangeStart = data.asOf - data.rangeDays * 86_400;
  const partial = data.historyStartsAt != null && data.historyStartsAt > rangeStart + 86_400;
  const itemCols = columnsFor(contentWidth, wide ? 190 : 150, 12, 7);
  const itemW = (contentWidth - 12 * (itemCols - 1)) / itemCols;
  const market = data.source === 'opensea' ? 'OpenSea' : 'Magic Eden';
  const avatar = wide ? 132 : 88;

  const priceCard = (
    <Card title="Price" right={
      data.daily.length >= 2 && (
        <Pressable onPress={() => setTable((t) => !t)} hitSlop={8}>
          <Text style={s.link}>{table ? 'Chart' : 'Table'}</Text>
        </Pressable>
      )}>
      {data.daily.length < 2 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {thin && polls < 4 && <ActivityIndicator size="small" color={C.accent} />}
          <Text style={s.desc}>
            {thin && polls < 4 ? 'Loading sales history from Magic Eden…' : 'Not enough sales in this range yet.'}
          </Text>
        </View>
      ) : table ? (
        <View>
          <View style={s.tRow}>
            {['Period', 'Median', 'Low–high', 'Sales', 'Volume'].map((h, i) => (
              <Text key={h} style={[s.tHead, i ? s.num : { flex: 1.4 }]}>{h}</Text>
            ))}
          </View>
          {[...data.daily].reverse().map((d) => (
            <View key={d.day} style={s.tRow}>
              <Text style={[s.tCell, { flex: 1.4 }]}>
                {data.bucketSec >= 86_400 ? fmtDay(d.day)
                  : new Date(d.day * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}
              </Text>
              <Text style={[s.tCell, s.num]}>{fmtSol(d.median)}</Text>
              <Text style={[s.tCell, s.num]}>{fmtSol(d.low)}–{fmtSol(d.high)}</Text>
              <Text style={[s.tCell, s.num]}>{d.count}</Text>
              <Text style={[s.tCell, s.num]}>{fmtSol(d.volume)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <PriceChart sales={data.sales} buckets={data.daily} bucketSec={data.bucketSec} floor={st.floor}
          rangeDays={data.rangeDays} asOf={data.asOf} dimmed={loading} tall={wide} />
      )}
    </Card>
  );

  const depthCard = st.floor != null && data.listings.length > 0 && (
    <Card title="Floor depth">
      <Text style={s.desc}>
        {within5} of the {data.listings.length} cheapest listings are within 5% of the floor
        {within5 <= 3 ? ', a thin floor' : ''}.
      </Text>
      <DepthChart listings={data.listings} floor={st.floor} tall={wide} />
    </Card>
  );

  const flippersCard = (
    <Card title="Top flippers">
      {data.topFlippers.length === 0 ? <Text style={s.desc}>No completed flips tracked yet.</Text> :
        data.topFlippers.map((f, i) => (
          <Link key={f.wallet} href={{ pathname: '/wallet/[address]', params: { address: f.wallet } }} asChild>
            <Pressable style={s.listRow}>
              <Text style={s.rank}>{i + 1}</Text>
              <Avatar t={f} size={32} />
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle} numberOfLines={1}>{f.name ?? shortAddr(f.wallet)}</Text>
                <Text style={s.rowMeta}>{f.wins}/{f.flips} profitable flips</Text>
              </View>
              <Text style={[s.rowVal, { color: f.realizedSol >= 0 ? C.up : C.down }]}>{signedSol(f.realizedSol)}</Text>
            </Pressable>
          </Link>
        ))}
    </Card>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: data.name }} />
      {web && <TopNav back />}
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        {/* Banner: the collection art, blurred and faded into the page */}
        <View style={[s.banner, { height: wide ? 280 : 170 }]}>
          {data.image && <Image source={thumb(data.image, 256)} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={wide ? 60 : 40} />}
          <LinearGradient colors={['#0B0B1033', '#0B0B10AA', C.bg]} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
        </View>

        <View style={[s.page, { maxWidth, paddingHorizontal: pad }]}>
          <View style={[s.hero, { marginTop: -avatar * 0.6 }]}>
            <View style={[s.avatarRing, { borderRadius: avatar * 0.22 + 4 }]}>
              <CollIcon name={data.name} uri={data.image} size={avatar} radius={avatar * 0.22} />
            </View>
            <View style={s.titleRow}>
              <Text style={[s.title, wide && { fontSize: 40 }]}>{data.name}</Text>
              <View style={s.badgeRow}>
                <ChainBadge chain={data.chain} />
                <Text style={s.desc}>{CHAIN_NAME[data.chain]} · {data.category} · data from {market}</Text>
              </View>
            </View>
          </View>

          {data.description ? (
            <Text style={[s.desc, s.about, wide && { maxWidth: 820 }]} numberOfLines={wide ? 3 : 2}>{data.description}</Text>
          ) : null}

          {/* Stat strip, with the actions beside it on wide screens */}
          <View style={wide ? s.statsWide : { gap: 16 }}>
          <View style={[s.stats, wide && { gap: 40 }]}>
            <Stat label="Floor" value={st.floor != null ? amt(st.floor, cur) : '—'}
              sub={st.floorUsd != null ? usdCompact(st.floorUsd) : undefined} />
            <Stat label="24h volume" value={st.volume24h ? amt(st.volume24h, cur, st.volume24h >= 10 ? 0 : 2) : '—'}
              sub={`${st.sales24h.toLocaleString()} sales`} />
            <Stat label="7d volume" value={st.volume7d != null ? amt(st.volume7d, cur, st.volume7d >= 10 ? 0 : 2) : '—'} />
            {evm && st.volume30d != null && <Stat label="30d volume" value={amt(st.volume30d, cur, 0)} />}
            {evm
              ? <Stat label="Owners" value={st.owners != null ? st.owners.toLocaleString() : '—'}
                  sub={st.supply ? `${st.supply.toLocaleString()} supply` : undefined} />
              : <Stat label="Listed" value={st.listed != null ? st.listed.toLocaleString() : '—'} />}
          </View>

          <View style={[s.actions, !wide && { flexDirection: 'column' }]}>
            {!evm && (
              <Pressable onPress={() => (mode === 'real' ? setBuyOpen(true) : paperBuy())}
                style={({ pressed }) => [s.cta, { backgroundColor: MODE_COLOR[mode] }, pressed && { opacity: 0.85 }]}>
                <Text style={s.ctaTxt}>
                  {mode === 'real' ? `Buy floor${st.floor ? ` · ${sol(st.floor)}` : ''}`
                    : buy ?? `Paper buy floor${st.floor ? ` · ${sol(st.floor)}` : ''}`}
                </Text>
              </Pressable>
            )}
            <Pressable onPress={() => Linking.openURL(data.externalUrl)} style={({ pressed }) => [s.ctaAlt, pressed && { opacity: 0.85 }]}>
              <Text style={s.ctaAltTxt}>View on {market} ↗</Text>
            </Pressable>
            {!evm && <BuySheet symbol={data.symbol} open={buyOpen} onClose={() => setBuyOpen(false)} onPaper={paperBuy} />}
          </View>
          </View>

          {evm ? (
            <Card title="Floor history">
              {data.floorHistory.filter((f) => f.floor != null).length >= 2 ? (
                <FloorLine points={data.floorHistory.filter((f) => f.floor != null) as { ts: number; floor: number }[]}
                  currency={cur} tall={wide} />
              ) : (
                <Text style={s.desc}>{"FloorFeed records this collection's floor every 10 minutes; the chart fills in as snapshots build up."}</Text>
              )}
              <Text style={s.desc}>
                Individual sales, listings and flipper stats for {CHAIN_NAME[data.chain]} collections need an OpenSea API key (free), which is not configured yet.
              </Text>
            </Card>
          ) : (
            <>
              {/* One filter row, above everything it scopes */}
              <View style={s.filters}>
                {RANGES.map((r) => (
                  <Pressable key={r} onPress={() => pickRange(r)} style={[s.chip, range === r && s.chipOn]}>
                    <Text style={[s.chipTxt, range === r && { color: C.accentInk }]}>{r === 1 ? '24H' : `${r}D`}</Text>
                  </Pressable>
                ))}
                {partial && <Text style={s.note}>tracking since {fmtDay(data.historyStartsAt!)}</Text>}
              </View>

              {wide ? (
                <View style={s.cols}>
                  <View style={{ flex: 2, gap: 16 }}>{priceCard}</View>
                  <View style={{ flex: 1, gap: 16 }}>{depthCard}{flippersCard}</View>
                </View>
              ) : (
                <>{priceCard}{depthCard}{flippersCard}</>
              )}

              {data.listings.length > 0 && (
                <Section title="Cheapest listings" sub={`Live from ${market}`}>
                  <View style={s.grid}>
                    {data.listings.map((l, i) => (
                      <Pressable key={`${i}:${l.mint}`} style={[s.item, { width: itemW }]}
                        onPress={() => Linking.openURL(`https://magiceden.io/item-details/${l.mint}`)}>
                        <NftImage uri={l.image} name={l.name ?? data.name} px={itemW}>
                          {l.rank != null && <Pill text={`Rank ${l.rank.toLocaleString()}`} style={{ top: 8, left: 8 }} />}
                        </NftImage>
                        <View style={s.itemBody}>
                          <Text style={s.itemName} numberOfLines={1}>{l.name ?? shortAddr(l.mint)}</Text>
                          <Text style={s.itemPrice}>{sol(l.price, 3)}</Text>
                          {st.floor != null && (
                            <Text style={s.rowMeta}>
                              {l.price <= st.floor * 1.0005 ? 'at floor' : `+${(((l.price - st.floor) / st.floor) * 100).toFixed(1)}% over floor`}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </Section>
              )}

              {data.recentSales.length > 0 && (
                <Section title="Recent sales" sub="Tap a sale to see the buyer's track record">
                  <View style={s.grid}>
                    {data.recentSales.map((r) => (
                      <Pressable key={r.signature} style={[s.item, { width: itemW }]}
                        onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: r.buyer } })}>
                        <NftImage uri={r.image} name={data.name} px={itemW}>
                          <Pill text={`${timeAgo(r.t)} ago`} style={{ top: 8, left: 8 }} />
                        </NftImage>
                        <View style={s.itemBody}>
                          <Text style={s.itemPrice}>{sol(r.price, 3)}</Text>
                          <Text style={s.rowMeta} numberOfLines={1}>bought by {r.buyerName ?? shortAddr(r.buyer)}</Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </Section>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const Card = ({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) => (
  <View style={s.card}>
    <View style={s.cardHead}>
      <Text style={s.cardTitle}>{title}</Text>
      {right}
    </View>
    {children}
  </View>
);

const Section = ({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) => (
  <View style={{ gap: 12, marginTop: 8 }}>
    <View>
      <Text style={s.sectionTitle}>{title}</Text>
      {sub ? <Text style={s.desc}>{sub}</Text> : null}
    </View>
    {children}
  </View>
);

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <View style={[s.stat, !useLayout().wide && { flexBasis: '42%' }]}>
    <Text style={s.statVal}>{value}</Text>
    <Text style={s.statLabel}>{label}{sub ? <Text style={s.statSub}>  ·  {sub}</Text> : null}</Text>
  </View>
);

const s = StyleSheet.create({
  banner: { width: '100%', backgroundColor: C.card, overflow: 'hidden' },
  page: { width: '100%', alignSelf: 'center', gap: 16 },
  hero: { flexDirection: 'row', alignItems: 'flex-end', gap: 18 },
  avatarRing: { borderWidth: 4, borderColor: C.bg, backgroundColor: C.bg },
  titleRow: { flex: 1, gap: 6, paddingBottom: 6 },
  title: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  desc: { color: C.dim, fontSize: 13, lineHeight: 19 },
  about: { fontSize: 14, lineHeight: 21 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, rowGap: 14, paddingVertical: 4 },
  stat: { gap: 2 },
  statVal: { color: C.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: C.dim, fontSize: 12.5, fontWeight: '600' },
  statSub: { color: C.dim, fontWeight: '400' },
  actions: { flexDirection: 'row', gap: 10 },
  statsWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 28, alignItems: 'center' },
  ctaTxt: { color: C.accentInk, fontWeight: '800', fontSize: 15 },
  ctaAlt: { borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  ctaAltTxt: { color: C.text, fontWeight: '800', fontSize: 15 },
  filters: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  note: { color: C.dim, fontSize: 12, marginLeft: 4 },
  cols: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  card: { backgroundColor: C.card, borderRadius: 18, padding: 16, gap: 8, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
  sectionTitle: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  link: { color: C.accent, fontWeight: '700', fontSize: 13 },
  tRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  tHead: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  tCell: { color: C.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  num: { flex: 1, textAlign: 'right' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rank: { color: C.dim, width: 18, fontWeight: '800' },
  rowTitle: { color: C.text, fontWeight: '700' },
  rowMeta: { color: C.dim, fontSize: 12 },
  rowVal: { color: C.text, fontWeight: '800', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  item: { backgroundColor: C.card, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  itemBody: { padding: 10, gap: 2 },
  itemName: { color: C.dim, fontSize: 12.5, fontWeight: '600' },
  itemPrice: { color: C.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
