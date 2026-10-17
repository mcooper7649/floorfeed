import { Link, Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { AboutPanel, PositionsPanel, TradeBox } from '@/components/collection-side';
import { HoldersTab, SalesTab, type TabFilter } from '@/components/collection-tabs';
import { ThesisTab } from '@/components/thesis';
import { CollIcon } from '@/components/coll-icon';
import { DepthChart } from '@/components/depth-chart';
import { Avatar } from '@/components/event-card';
import { FloorLine } from '@/components/floor-line';
import { NftImage, Pill } from '@/components/nft-image';
import { PriceChart } from '@/components/price-chart';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { chainName } from '@/constants/chains';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { api, type ChartMarker, type CollectionDetail } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';
import { amt, shortAddr, signedSol, sol, usdCompact } from '@/lib/format';
import { useUsd } from '@/lib/prices';
import { columnsFor, useLayout } from '@/lib/layout';
import { fmtDay, fmtSol } from '@/lib/scale';
import { useTitle } from '@/lib/use-title';

const RANGES = [{ d: 1, label: '1D' }, { d: 7, label: '1W' }, { d: 30, label: '1M' }, { d: 90, label: '3M' }] as const;
const SCALES = [{ key: 'pct', label: '%' }, { key: 'log', label: 'log' }, { key: 'auto', label: 'auto' }] as const;
type Overlays = { proven: boolean; mine: boolean; following: boolean; minSize: boolean; takes: boolean };
type TabKey = 'holders' | 'sales' | 'thesis' | 'listings' | 'flippers';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'holders', label: 'Holders' }, { key: 'sales', label: 'Sales' }, { key: 'thesis', label: 'Thesis' },
  { key: 'listings', label: 'Listings' }, { key: 'flippers', label: 'Top flippers' },
];
const web = Platform.OS === 'web';

export default function CollectionScreen() {
  const toUsd = useUsd();
  const { symbol, tab: tabParam } = useLocalSearchParams<{ symbol: string; tab?: string }>();
  const { wide, pad, maxWidth, contentWidth } = useLayout();
  const [range, setRange] = useState<number>(7);
  const [data, setData] = useState<CollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [tab, setTab] = useState<TabKey>(TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'holders');
  const [filter, setFilter] = useState<TabFilter>({ proven: false, following: false });
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [scale, setScale] = useState<'auto' | 'pct' | 'log'>('auto');
  const [overlays, setOverlays] = useState<Overlays>({ proven: true, mine: true, following: false, minSize: false, takes: true });
  const [takeCount, setTakeCount] = useState<number | null>(null);
  const [markerState, setMarkerState] = useState<{ key: string; list: ChartMarker[] } | null>(null);
  const { following } = useSession();
  const solAddr = useWallet().address;
  const evmAddr = useEvmWallet().address;

  // Trader avatars for the chart: proven wallets, your own wallets, or only
  // the wallets you follow, per the overlay toggles.
  const followKey = [...following].sort().join(',');
  const mine = overlays.mine ? [solAddr, evmAddr].filter((a): a is string => !!a) : [];
  const markerWallets = [...mine, ...(overlays.following ? followKey.split(',').filter(Boolean) : [])];
  const markerProven = overlays.proven && !overlays.following;
  const markerKey = `${symbol}|${range}|${markerProven}|${markerWallets.join(',')}|${overlays.takes}`;
  useEffect(() => {
    const [sym, r, proven, wallets, takes] = markerKey.split('|');
    if (proven !== 'true' && !wallets && takes !== 'true') return;
    let alive = true;
    api.collectionMarkers(sym, Number(r), proven === 'true', wallets ? wallets.split(',') : [], takes === 'true')
      .then((list) => alive && setMarkerState({ key: markerKey, list }))
      .catch(() => alive && setMarkerState({ key: markerKey, list: [] }));
    return () => { alive = false; };
  }, [markerKey]);
  const markers = markerState?.key === markerKey ? markerState.list : [];
  useTitle(data && `${data.name} floor price, chart & top flippers | FloorFeed`);

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
  // EVM collections have OpenSea sales (in ETH) except the few that trade in other tokens.
  const floorOnly = evm && data.sales.length === 0 && data.historyStartsAt == null;
  const within5 = st.floor ? data.listings.filter((l) => l.price <= st.floor! * 1.05).length : 0;
  const rangeStart = data.asOf - data.rangeDays * 86_400;
  const partial = data.historyStartsAt != null && data.historyStartsAt > rangeStart + 86_400;
  const market = data.source === 'opensea' ? 'OpenSea' : 'Magic Eden';

  // USD per unit, for the "Min size" overlay filter.
  const usdRate = st.floor && st.floorUsd ? st.floorUsd / st.floor : null;
  const withUsd = (sub: string | undefined, n: number | null | undefined) => { const d = toUsd(n, cur); return d ? (sub ? `${d} · ${sub}` : d) : sub; };
  const shownMarkers = overlays.minSize && usdRate != null ? markers.filter((m) => m.price * usdRate >= 1000) : markers;
  const priceCard = (
    <Card title="Price" right={
      <View style={s.toolbar}>
        {RANGES.map((r) => (
          <Pressable key={r.d} onPress={() => pickRange(r.d)} style={[s.tool, range === r.d && s.toolOn]}>
            <Text style={[s.toolTxt, range === r.d && { color: C.text }]}>{r.label}</Text>
          </Pressable>
        ))}
        {web && !table && <View style={s.toolSep} />}
        {web && !table && SCALES.map((sc) => (
          <Pressable key={sc.key} onPress={() => setScale(sc.key)} style={[s.tool, scale === sc.key && s.toolOn]}>
            <Text style={[s.toolTxt, scale === sc.key && { color: C.text }]}>{sc.label}</Text>
          </Pressable>
        ))}
        {data.daily.length >= 2 && (
          <>
            <View style={s.toolSep} />
            <Pressable onPress={() => setTable((t) => !t)} hitSlop={8}>
              <Text style={s.link}>{table ? 'Chart' : 'Table'}</Text>
            </Pressable>
          </>
        )}
      </View>
    }>
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
          rangeDays={data.rangeDays} asOf={data.asOf} dimmed={loading} tall={wide} unit={cur}
          scale={scale} markers={shownMarkers} />
      )}
    </Card>
  );

  const rightW = 360;
  const centerW = wide ? contentWidth - rightW - 16 - 34 : contentWidth - 34; // minus the tabs card padding
  const gridCols = columnsFor(centerW, wide ? 170 : 140, 12, 6);
  const gridW = (centerW - 12 * (gridCols - 1)) / gridCols;
  const about = data.about;
  const ch24 = about?.changes.find((c) => c.label === '24H')?.pct ?? null;

  const header = (
    <View style={s.header}>
      <View style={s.ident}>
        <CollIcon name={data.name} uri={data.image} size={wide ? 56 : 48} radius={14} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text {...display} style={wide ? T.display : T.title} numberOfLines={1}>{data.name}</Text>
          <View style={s.badgeRow}>
            <ChainBadge chain={data.chain} />
            <Text style={s.desc}>{chainName(data.chain)} · {data.category} · data from {market}</Text>
          </View>
        </View>
      </View>
      <View style={s.tiles}>
        <Tile label="Floor" value={st.floor != null ? amt(st.floor, cur) : '—'} sub={st.floorUsd != null ? usdCompact(st.floorUsd) : undefined} />
        <Tile label="24h change" value={ch24 == null ? '—' : `${ch24 >= 0 ? '▲' : '▼'} ${Math.abs(ch24).toFixed(1)}%`} color={ch24 == null ? undefined : ch24 >= 0 ? C.up : C.down} />
        <Tile label="24h volume" value={st.volume24h ? amt(st.volume24h, cur, st.volume24h >= 10 ? 0 : 2) : '—'} sub={withUsd(`${st.sales24h.toLocaleString()} sales`, st.volume24h)} />
        <Tile label="7d volume" value={st.volume7d != null ? amt(st.volume7d, cur, st.volume7d >= 10 ? 0 : 2) : '—'} sub={withUsd(undefined, st.volume7d)} />
        {evm
          ? <Tile label="Owners" value={st.owners != null ? st.owners.toLocaleString() : '—'} sub={st.supply ? `of ${st.supply.toLocaleString()}` : undefined} />
          : <Tile label="Listed" value={st.listed != null ? st.listed.toLocaleString() : '—'} />}
        {about && <Tile label="Holders tracked" value={about.info.holdersTracked.toLocaleString()} />}
      </View>
    </View>
  );

  const chartBlock = floorOnly ? (
    <Card title="Floor history">
      {data.floorHistory.filter((f) => f.floor != null).length >= 2 ? (
        <FloorLine points={data.floorHistory.filter((f) => f.floor != null) as { ts: number; floor: number }[]}
          currency={cur} tall={wide} />
      ) : (
        <Text style={s.desc}>{"FloorFeed records this collection's floor every 10 minutes; the chart fills in as snapshots build up."}</Text>
      )}
      <Text style={s.desc}>
        This collection trades in a token other than ETH, so FloorFeed tracks its floor but not individual sales.
      </Text>
    </Card>
  ) : (
    <View style={{ gap: 10 }}>
      {priceCard}
      {web && !table && (
        <View style={s.filters}>
          <Text style={s.overlayLabel}>Chart overlays</Text>
          <Toggle label="Proven traders" on={overlays.proven} onPress={() => setOverlays((o) => ({ ...o, proven: !o.proven }))} />
          <Toggle label="My trades" on={overlays.mine} onPress={() => setOverlays((o) => ({ ...o, mine: !o.mine }))} />
          <Toggle label="Thesis" on={overlays.takes} onPress={() => setOverlays((o) => ({ ...o, takes: !o.takes }))} />
          <Toggle label="Following only" on={overlays.following} onPress={() => setOverlays((o) => ({ ...o, following: !o.following }))} />
          {usdRate != null && <Toggle label="Min size (>$1K)" on={overlays.minSize} onPress={() => setOverlays((o) => ({ ...o, minSize: !o.minSize }))} />}
          {partial && <Text style={s.note}>Tracking since {fmtDay(data.historyStartsAt!)}</Text>}
        </View>
      )}
      {(!web || table) && partial && <Text style={s.note}>Tracking since {fmtDay(data.historyStartsAt!)}</Text>}
    </View>
  );

  const tabs = (
    <View style={s.card}>
      <View style={s.tabHead}>
        <View style={s.tabRow}>
          {TABS.map((t) => (
            <Pressable key={t.key} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
              <Text style={[s.tab, tab === t.key && s.tabOn]}>
                {t.label}{t.key === 'holders' && (about?.info.holdersTracked ?? holderCount) != null ? ` (${(about?.info.holdersTracked ?? holderCount)!.toLocaleString()})` : ''}
                {t.key === 'thesis' && takeCount ? ` (${takeCount})` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
        {(tab === 'holders' || tab === 'sales') && (
          <View style={s.tabRow}>
            <Toggle label="Proven only" on={filter.proven} onPress={() => setFilter((f) => ({ ...f, proven: !f.proven }))} />
            <Toggle label="Following only" on={filter.following} onPress={() => setFilter((f) => ({ ...f, following: !f.following }))} />
          </View>
        )}
      </View>
      {tab === 'holders' && <HoldersTab symbol={data.symbol} currency={cur} filter={filter} onCount={setHolderCount} />}
      {tab === 'sales' && <SalesTab symbol={data.symbol} currency={cur} filter={filter} />}
      {tab === 'thesis' && <ThesisTab symbol={data.symbol} name={data.name} currency={cur} chain={data.chain} onCount={setTakeCount} />}
      {tab === 'listings' && (
        <View style={{ gap: 14 }}>
          {st.floor != null && data.listings.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={s.desc}>
                {within5} of the {data.listings.length} cheapest listings are within 5% of the floor{within5 <= 3 ? ', a thin floor' : ''}. Live from {market}.
              </Text>
              <DepthChart listings={data.listings} floor={st.floor} tall={false} />
            </View>
          )}
          {data.listings.length === 0 ? <Text style={s.desc}>No listings loaded.</Text> : (
            <View style={s.grid}>
              {data.listings.map((l, i) => (
                <Pressable key={`${i}:${l.mint}`} style={[s.item, { width: gridW }]}
                  onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: data.symbol, id: l.mint } })}>
                  <NftImage uri={l.image} name={l.name ?? data.name} px={gridW}>
                    {l.rank != null && <Pill text={`Rank ${l.rank.toLocaleString()}`} style={{ top: 8, left: 8 }} />}
                  </NftImage>
                  <View style={s.itemBody}>
                    <Text style={s.itemName} numberOfLines={1}>{l.name ?? shortAddr(l.mint)}</Text>
                    <Text style={s.itemPrice}>{sol(l.price, 3, cur)}{toUsd(l.price, cur) ? <Text style={s.rowMeta}> · {toUsd(l.price, cur)}</Text> : null}</Text>
                    {st.floor != null && (
                      <Text style={s.rowMeta}>
                        {l.price <= st.floor * 1.0005 ? 'at floor' : `+${(((l.price - st.floor) / st.floor) * 100).toFixed(1)}% over floor`}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}
      {tab === 'flippers' && (
        data.topFlippers.length === 0 ? <Text style={s.desc}>No completed flips tracked yet.</Text> :
          data.topFlippers.map((f, i) => (
            <Link key={f.wallet} href={{ pathname: '/wallet/[address]', params: { address: f.wallet } }} asChild>
              <Pressable style={s.listRow}>
                <Text style={s.rank}>{i + 1}</Text>
                <Avatar t={f} size={32} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={T.bodyStrong} numberOfLines={1}>{f.name ?? shortAddr(f.wallet)}</Text>
                  <Text style={T.metaNum}>{f.wins} of {f.flips} flips profitable</Text>
                </View>
                <Text style={[T.num, { color: f.realizedSol >= 0 ? C.up : C.down }]}>{signedSol(f.realizedSol, 2, cur)}</Text>
              </Pressable>
            </Link>
          ))
      )}
    </View>
  );

  const side = (
    <>
      <TradeBox data={data} />
      {about && <AboutPanel data={data} about={about} />}
      <PositionsPanel data={data} />
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: data.name }} />
      {web && <TopNav back />}
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        <View style={[s.page, { maxWidth, paddingHorizontal: pad, paddingTop: wide ? 24 : 12 }]}>
          {header}
          {wide ? (
            <View style={s.cols}>
              <View style={{ flex: 1, minWidth: 0, gap: 16 }}>{chartBlock}{tabs}</View>
              <View style={{ width: rightW, gap: 16 }}>{side}</View>
            </View>
          ) : (
            <>
              <TradeBox data={data} />
              {chartBlock}
              {tabs}
              {about && <AboutPanel data={data} about={about} />}
              <PositionsPanel data={data} />
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

// Header stat tiles (FOMO-style boxes).
const Tile = ({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) => (
  <View style={s.tile}>
    <Text style={s.tileLabel}>{label}</Text>
    <Text style={[s.tileValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    {sub ? <Text style={s.tileSub} numberOfLines={1}>{sub}</Text> : null}
  </View>
);

const Toggle = ({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) => (
  <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={s.toggle}>
    <View style={[s.box, on && { backgroundColor: C.accent, borderColor: C.accent }]}>{on && <Text style={s.tick}>✓</Text>}</View>
    <Text style={[s.toggleTxt, on && { color: C.text }]}>{label}</Text>
  </Pressable>
);

const s = StyleSheet.create({
  page: { width: '100%', alignSelf: 'center', gap: 16 },
  header: { gap: 14 },
  ident: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, flexBasis: 100, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 9, gap: 1 },
  tileLabel: { ...T.caption, color: C.dim },
  tileValue: { color: C.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tileSub: { ...T.caption },
  tabHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  tab: { color: C.dim, fontSize: 15, fontWeight: '600' },
  tabOn: { color: C.text },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  box: { width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  tick: { color: C.accentInk, fontSize: 11, fontWeight: '700', lineHeight: 13 },
  toggleTxt: { ...T.caption, color: C.dim, fontWeight: '500' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  desc: T.meta,
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center', paddingHorizontal: 4 },
  overlayLabel: { ...T.caption, color: C.text, fontWeight: '600' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' },
  tool: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7 },
  toolOn: { backgroundColor: C.cardHi },
  toolTxt: { ...T.caption, color: C.dim, fontWeight: '600' },
  toolSep: { width: 1, height: 14, backgroundColor: C.border, marginHorizontal: 4 },
  note: { ...T.caption, marginLeft: 4 },
  cols: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: T.bodyStrong,
  link: { ...T.label, color: C.accent },
  tRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  tHead: { ...T.caption, fontWeight: '500', color: C.dim },
  tCell: { ...T.metaNum, color: C.text },
  num: { flex: 1, textAlign: 'right' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rank: { ...T.num, color: C.dim, width: 18 },
  rowMeta: T.metaNum,
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  item: { backgroundColor: C.card, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  itemBody: { padding: 10, gap: 2 },
  itemName: T.caption,
  itemPrice: T.num,
});
