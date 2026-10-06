import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { FloorLine } from '@/components/floor-line';
import { DepthChart } from '@/components/depth-chart';
import { PriceChart } from '@/components/price-chart';
import { Empty } from '@/components/screen';
import { C } from '@/constants/brand';
import { MaxContentWidth } from '@/constants/theme';
import { api, type CollectionDetail } from '@/lib/api';
import { amt, shortAddr, signedSol, sol, timeAgo, usdCompact } from '@/lib/format';
import { fmtDay, fmtSol } from '@/lib/scale';
import { useSession } from '@/lib/session';

const RANGES = [7, 30] as const;

export default function CollectionScreen() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const { userId, bumpPortfolio } = useSession();
  const [range, setRange] = useState<number>(7);
  const [data, setData] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [buy, setBuy] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    api.collection(symbol, range).then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [symbol, range]);
  useEffect(fetchData, [fetchData]);

  // Refetch keeps the frame: the old render stays (dimmed) until new data lands.
  const pickRange = (r: number) => { if (r !== range) { setLoading(true); setRange(r); } };

  const buyFloor = async () => {
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

  if (error && !data) return <Empty text={error} />;
  if (!data) return <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />;

  const st = data.stats;
  const cur = data.currency;
  const evm = data.chain !== 'solana';
  const within5 = st.floor ? data.listings.filter((l) => l.price <= st.floor! * 1.05).length : 0;
  const rangeStart = data.asOf - data.rangeDays * 86_400;
  const partial = data.historyStartsAt != null && data.historyStartsAt > rangeStart + 86_400;

  return (
    <>
      <Stack.Screen options={{ title: data.name }} />
      <ScrollView contentContainerStyle={s.page}>
        <View style={s.hero}>
          <CollIcon name={data.name} uri={data.image} size={64} radius={16} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.title}>{data.name}</Text>
            {data.description ? <Text style={s.desc} numberOfLines={2}>{data.description}</Text> : null}
          </View>
        </View>

        <View style={s.tiles}>
          <Tile label="Floor" value={st.floor != null ? amt(st.floor, cur) : '—'}
            sub={st.floorUsd != null ? usdCompact(st.floorUsd) : undefined} />
          {evm
            ? <Tile label="Owners" value={st.owners != null ? st.owners.toLocaleString() : '—'}
                sub={st.supply ? `${st.supply.toLocaleString()} supply` : undefined} />
            : <Tile label="Listed" value={st.listed != null ? st.listed.toLocaleString() : '—'} />}
          <Tile label="Sales 24h" value={st.sales24h.toLocaleString()} sub={st.volume24h ? amt(st.volume24h, cur) : undefined} />
          <Tile label="Volume 7d" value={st.volume7d != null ? amt(st.volume7d, cur, st.volume7d >= 10 ? 0 : 2) : '—'}
            sub={evm && st.volume30d != null ? `${amt(st.volume30d, cur, 0)} 30d` : undefined} />
        </View>

        <View style={s.badgeRow}>
          <ChainBadge chain={data.chain} />
          <Text style={s.desc}>{data.category} · data from {data.source === 'opensea' ? 'OpenSea' : 'Magic Eden'}</Text>
        </View>

        {evm ? (
          <Pressable onPress={() => Linking.openURL(data.externalUrl)} style={({ pressed }) => [s.ctaAlt, pressed && { opacity: 0.85 }]}>
            <Text style={s.ctaAltTxt}>View on OpenSea ↗</Text>
          </Pressable>
        ) : (
          <Pressable onPress={buyFloor} style={({ pressed }) => [s.cta, pressed && { opacity: 0.85 }]}>
            <Text style={s.ctaTxt}>{buy ?? `Buy floor${st.floor ? ` · ${sol(st.floor)}` : ''} (paper)`}</Text>
          </Pressable>
        )}

        {evm ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>Floor history</Text>
            {data.floorHistory.filter((f) => f.floor != null).length >= 2 ? (
              <FloorLine points={data.floorHistory.filter((f) => f.floor != null) as { ts: number; floor: number }[]} currency={cur} />
            ) : (
              <Text style={s.desc}>{"FloorFeed records this collection's floor every 10 minutes; the chart fills in as snapshots build up."}</Text>
            )}
            <Text style={s.desc}>
              Individual sales, listings and flipper stats for {data.chain === 'polygon' ? 'Polygon' : data.chain === 'base' ? 'Base' : 'Ethereum'} collections need an OpenSea API key (free), which is not configured yet.
            </Text>
          </View>
        ) : null}

        {!evm && <>
        {/* One filter row, above everything it scopes */}
        <View style={s.filters}>
          {RANGES.map((r) => (
            <Pressable key={r} onPress={() => pickRange(r)} style={[s.chip, range === r && s.chipOn]}>
              <Text style={[s.chipTxt, range === r && { color: C.accentInk }]}>{r}D</Text>
            </Pressable>
          ))}
          {partial && <Text style={s.note}>tracking since {fmtDay(data.historyStartsAt!)}</Text>}
        </View>

        <View style={s.card}>
          <View style={s.cardHead}>
            <Text style={s.cardTitle}>Sale price</Text>
            <Pressable onPress={() => setTable((t) => !t)} hitSlop={8}>
              <Text style={s.link}>{table ? 'Chart' : 'Table'}</Text>
            </Pressable>
          </View>
          {data.daily.length < 2 ? (
            <Text style={s.desc}>Not enough sales in this range yet.</Text>
          ) : table ? (
            <View>
              <View style={s.tRow}>
                {['Day', 'Median', 'Low–high', 'Sales'].map((h, i) => (
                  <Text key={h} style={[s.tHead, i ? s.num : { flex: 1.2 }]}>{h}</Text>
                ))}
              </View>
              {[...data.daily].reverse().map((d) => (
                <View key={d.day} style={s.tRow}>
                  <Text style={[s.tCell, { flex: 1.2 }]}>{fmtDay(d.day)}</Text>
                  <Text style={[s.tCell, s.num]}>{fmtSol(d.median)}</Text>
                  <Text style={[s.tCell, s.num]}>{fmtSol(d.low)}–{fmtSol(d.high)}</Text>
                  <Text style={[s.tCell, s.num]}>{d.count}</Text>
                </View>
              ))}
            </View>
          ) : (
            <PriceChart sales={data.sales} daily={data.daily} floor={st.floor} rangeDays={data.rangeDays} asOf={data.asOf} dimmed={loading} />
          )}
        </View>

        {st.floor != null && data.listings.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Floor depth</Text>
            <Text style={s.desc}>
              {within5} of the {data.listings.length} cheapest listings are within 5% of the floor
              {within5 <= 3 ? ', a thin floor' : ''}.
            </Text>
            <DepthChart listings={data.listings} floor={st.floor} />
          </View>
        )}

        <View style={s.card}>
          <Text style={s.cardTitle}>Top flippers</Text>
          {data.topFlippers.length === 0 ? <Text style={s.desc}>No completed flips tracked yet.</Text> :
            data.topFlippers.map((f, i) => (
              <Link key={f.wallet} href={{ pathname: '/wallet/[address]', params: { address: f.wallet } }} asChild>
                <Pressable style={s.listRow}>
                  <Text style={s.rank}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle}>{shortAddr(f.wallet)}</Text>
                    <Text style={s.rowMeta}>{f.wins}/{f.flips} profitable flips</Text>
                  </View>
                  <Text style={[s.rowVal, { color: f.realizedSol >= 0 ? C.up : C.down }]}>{signedSol(f.realizedSol)}</Text>
                </Pressable>
              </Link>
            ))}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Recent sales</Text>
          {data.recentSales.map((r) => (
            <Link key={r.signature} href={{ pathname: '/wallet/[address]', params: { address: r.buyer } }} asChild>
              <Pressable style={s.listRow}>
                <CollIcon name={data.name} uri={r.image} size={36} radius={8} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{shortAddr(r.buyer)}</Text>
                  <Text style={s.rowMeta}>{timeAgo(r.t)} ago</Text>
                </View>
                <Text style={s.rowVal}>{sol(r.price, 3)}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
        </>}
      </ScrollView>
    </>
  );
}

const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <View style={s.tile}>
    <Text style={s.tileLabel}>{label}</Text>
    <Text style={s.tileVal}>{value}</Text>
    {sub ? <Text style={s.rowMeta}>{sub}</Text> : null}
  </View>
);

const s = StyleSheet.create({
  page: { padding: 16, paddingBottom: 60, gap: 14, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  hero: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  title: { color: C.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  desc: { color: C.dim, fontSize: 13, lineHeight: 18 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, flexBasis: '45%', backgroundColor: C.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border },
  tileLabel: { color: C.dim, fontSize: 12, fontWeight: '600' },
  tileVal: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ctaAlt: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  ctaAltTxt: { color: C.text, fontWeight: '800', fontSize: 15 },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  ctaTxt: { color: C.accentInk, fontWeight: '800', fontSize: 15 },
  filters: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  note: { color: C.dim, fontSize: 12, marginLeft: 4 },
  card: { backgroundColor: C.card, borderRadius: 18, padding: 14, gap: 8, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
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
});
