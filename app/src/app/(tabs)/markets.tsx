import { Link, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { NftImage } from '@/components/nft-image';
import { Empty, Screen } from '@/components/screen';
import { Sparkline } from '@/components/sparkline';
import { C } from '@/constants/brand';
import { api, type Chain, type CollectionSummary, type MarketCategory } from '@/lib/api';
import { amt, pct, usdCompact } from '@/lib/format';
import { columnsFor, useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';

type ChainFilter = 'all' | Chain;
type CatFilter = 'all' | MarketCategory | 'watch';
type Sort = 'volume' | 'change' | 'floor' | 'sales';

const CHAINS: { key: ChainFilter; label: string }[] = [
  { key: 'all', label: 'All chains' }, { key: 'solana', label: 'Solana' }, { key: 'ethereum', label: 'Ethereum' },
  { key: 'base', label: 'Base' }, { key: 'polygon', label: 'Polygon' },
];
const CATEGORIES: { key: MarketCategory; blurb: string }[] = [
  { key: 'PFP', blurb: 'Profile-picture collections and their communities' },
  { key: 'Art', blurb: 'Generative and 1/1 art' },
  { key: 'Gaming', blurb: 'Characters, items and virtual land' },
  { key: 'Assets', blurb: 'Tokenized real-world items like graded cards' },
  { key: 'Domains', blurb: 'Onchain names like .eth' },
  { key: 'Memberships', blurb: 'Passes for DAOs, clubs and communities' },
  { key: 'Utility', blurb: 'NFTs that unlock tools, staking or services' },
];
const CATS: { key: CatFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'watch', label: '★ Watchlist' },
  ...CATEGORIES.map((c) => ({ key: c.key as CatFilter, label: c.key })),
];
const SORTS: { key: Sort; label: string }[] = [
  { key: 'volume', label: '7d volume' }, { key: 'change', label: '24h change' }, { key: 'floor', label: 'Floor' }, { key: 'sales', label: '24h sales' },
];

// Cross-chain comparisons use USD; each row still shows its native currency.
const sortKey: Record<Sort, (c: CollectionSummary) => number> = {
  volume: (c) => c.volume7dUsd ?? -1,
  change: (c) => c.change24hPct ?? -Infinity,
  floor: (c) => c.floorUsd ?? -1,
  sales: (c) => c.sales24h ?? -1,
};

export default function MarketsScreen() {
  const { watchlist, toggleWatch } = useSession();
  const [rows, setRows] = useState<CollectionSummary[]>([]);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { q } = useLocalSearchParams<{ q?: string }>();
  const { wide, pad, contentWidth } = useLayout();
  const [query, setQuery] = useState(q ?? '');
  // The header search navigates here with ?q=; adopt each new value.
  const [seenQ, setSeenQ] = useState(q);
  if (q !== seenQ) { setSeenQ(q); setQuery(q ?? ''); }
  const [chain, setChain] = useState<ChainFilter>('all');
  const [cat, setCat] = useState<CatFilter>('all');
  const [sort, setSort] = useState<Sort>('volume');

  const fetchRows = useCallback(() => {
    api.collections().then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e.message)).finally(() => setRefreshing(false));
  }, []);
  useEffect(fetchRows, [fetchRows]);
  const refresh = () => { setRefreshing(true); fetchRows(); };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => chain === 'all' || r.chain === chain)
      .filter((r) => cat === 'all' || (cat === 'watch' ? watchlist.has(r.symbol) : r.category === cat))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.symbol.includes(q))
      .sort((a, b) => sortKey[sort](b) - sortKey[sort](a));
  }, [rows, chain, cat, query, sort, watchlist]);

  // Trending: biggest 24h volume in USD across chains.
  const trending = useMemo(
    () => [...rows].filter((r) => (r.volume24hUsd ?? 0) > 0).sort((a, b) => b.volume24hUsd! - a.volume24hUsd!).slice(0, 8),
    [rows],
  );
  const totalVol = rows.reduce((a, r) => a + (r.volume7dUsd ?? 0), 0);
  const vol24 = rows.reduce((a, r) => a + (r.volume24hUsd ?? 0), 0);
  const trendCols = wide ? columnsFor(contentWidth, 190, 14, 6) : 0;
  const trendW = wide ? (contentWidth - 14 * (trendCols - 1)) / trendCols : 156;
  const catCols = wide ? 4 : 2;
  const catW = (contentWidth - 10 * (catCols - 1)) / catCols;

  // Category cards: count, 7d volume and the three biggest collections' icons.
  const catStats = useMemo(() => CATEGORIES.map((c) => {
    const inCat = rows.filter((r) => r.category === c.key)
      .sort((a, b) => (b.volume7dUsd ?? 0) - (a.volume7dUsd ?? 0));
    return { ...c, count: inCat.length, vol: inCat.reduce((a, r) => a + (r.volume7dUsd ?? 0), 0), top: inCat.slice(0, 3) };
  }).filter((c) => c.count > 0), [rows]);
  const activeCat = CATEGORIES.find((c) => c.key === cat);
  const chains = new Set(rows.map((r) => r.chain)).size;

  const header = (
    <View style={{ gap: 14 }}>
      <View style={s.tiles}>
        <Tile label="7d volume" value={totalVol ? usdCompact(totalVol) : '—'} />
        {wide && <Tile label="24h volume" value={vol24 ? usdCompact(vol24) : '—'} />}
        <Tile label="Collections" value={String(rows.length || '—')} />
        <Tile label="Chains" value={String(chains || '—')} />
      </View>

      {trending.length > 0 && !query && cat === 'all' && chain === 'all' && (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>TRENDING · 24H VOLUME</Text>
          {wide ? (
            <View style={{ flexDirection: 'row', gap: 14 }}>
              {trending.slice(0, trendCols).map((t, i) => <TrendCard key={t.symbol} c={t} rank={i + 1} width={trendW} />)}
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {trending.map((t, i) => <TrendCard key={t.symbol} c={t} rank={i + 1} width={trendW} />)}
            </ScrollView>
          )}
        </View>
      )}

      {cat === 'all' && !query && catStats.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>BROWSE BY CATEGORY</Text>
          <View style={s.catGrid}>
            {catStats.map((c) => (
              <Pressable key={c.key} style={[s.catCard, { width: catW }]} onPress={() => setCat(c.key)}
                accessibilityLabel={`${c.key}, ${c.count} collections`}>
                <View style={[s.mosaic, { height: wide ? 120 : 84 }]}>
                  {c.top.map((t) => (
                    <View key={t.symbol} style={{ flex: 1 }}>
                      <NftImage uri={t.image} name={t.name} ratio={null} />
                    </View>
                  ))}
                </View>
                <View style={s.catBody}>
                  <Text style={s.catName}>{c.key}</Text>
                  <Text style={s.catBlurb} numberOfLines={2}>{c.blurb}</Text>
                  <Text style={s.meta}>{c.count} {c.count === 1 ? 'collection' : 'collections'}{c.vol ? ` · ${usdCompact(c.vol)} 7d` : ''}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={wide ? s.filterWide : { gap: 8 }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search collections"
          placeholderTextColor={C.dim}
          style={[s.search, wide && { width: 300 }]}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        <View style={wide ? { flex: 1, gap: 8 } : { gap: 8 }}>
          <ChipRow items={CHAINS} value={chain} onChange={setChain} />
          <ChipRow items={CATS} value={cat} onChange={setCat} />
        </View>
      </View>
      {!wide && (
        <View style={s.sortRow}>
          <Text style={s.meta}>Sort</Text>
          {SORTS.map((o) => (
            <Pressable key={o.key} onPress={() => setSort(o.key)} hitSlop={6}>
              <Text style={[s.sortTxt, sort === o.key && s.sortOn]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {activeCat && (
        <View style={s.catHead}>
          <View style={{ flex: 1 }}>
            <Text style={s.catHeadName}>{activeCat.key}</Text>
            <Text style={s.catBlurb}>{activeCat.blurb}</Text>
          </View>
          <Pressable onPress={() => setCat('all')} hitSlop={8}><Text style={s.clear}>Clear</Text></Pressable>
        </View>
      )}

      <Text style={s.count}>
        {visible.length} {visible.length === 1 ? 'collection' : 'collections'}
        {sort === 'change' ? ' · floor change builds up from our own snapshots' : ''}
      </Text>
      {wide && <TableHead sort={sort} onSort={setSort} />}
    </View>
  );

  return (
    <Screen title="Markets" subtitle="NFT collections on Solana, Ethereum, Base and Polygon, ranked in USD">
      <FlatList
        data={visible}
        keyExtractor={(r) => r.symbol}
        contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListHeaderComponent={header}
        ListEmptyComponent={refreshing ? null : (
          <Empty text={error ?? (cat === 'watch' ? 'Tap ☆ on any collection to add it to your watchlist.' : 'No collections match.')} />
        )}
        renderItem={({ item, index }) => (
          wide
            ? <TableRow c={item} rank={index + 1} watched={watchlist.has(item.symbol)} onWatch={() => toggleWatch(item.symbol)} />
            : <Row c={item} watched={watchlist.has(item.symbol)} onWatch={() => toggleWatch(item.symbol)} />
        )}
      />
    </Screen>
  );
}

function Row({ c, watched, onWatch }: { c: CollectionSummary; watched: boolean; onWatch: () => void }) {
  const ch = c.change24hPct;
  return (
    <View style={s.row}>
      <Pressable hitSlop={8} onPress={onWatch} accessibilityLabel={watched ? 'Remove from watchlist' : 'Add to watchlist'}>
        <Text style={[s.star, watched && { color: C.accent }]}>{watched ? '★' : '☆'}</Text>
      </Pressable>
      <Link href={{ pathname: '/collection/[symbol]', params: { symbol: c.symbol } }} asChild>
        <Pressable style={s.rowMain}>
          <CollIcon name={c.name} uri={c.image} size={48} radius={12} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={s.name} numberOfLines={1}>{c.name}</Text>
            <View style={s.nameRow}>
              <ChainBadge chain={c.chain} />
              <Text style={[s.meta, { flexShrink: 1 }]} numberOfLines={1}>
                {c.volume7dUsd != null ? `${usdCompact(c.volume7dUsd)} 7d` : c.category}
              </Text>
            </View>
          </View>
          <Sparkline values={c.spark.map((p) => p.median)} width={48} height={26} />
          <View style={s.right}>
            <Text style={s.floor}>{c.floor != null ? amt(c.floor, c.currency) : '—'}</Text>
            {ch != null ? (
              <Text style={[s.change, { color: ch >= 0 ? C.up : C.down }]}>{pct(ch)}</Text>
            ) : (
              <Text style={s.meta}>{c.floorUsd != null ? usdCompact(c.floorUsd) : ''}</Text>
            )}
          </View>
        </Pressable>
      </Link>
    </View>
  );
}

function TrendCard({ c, rank, width }: { c: CollectionSummary; rank: number; width: number }) {
  return (
    <Pressable style={[s.trend, { width }]}
      onPress={() => router.push({ pathname: '/collection/[symbol]', params: { symbol: c.symbol } })}>
      <NftImage uri={c.image} name={c.name}>
        <View style={s.trendRank}><Text style={s.trendRankTxt}>{rank}</Text></View>
      </NftImage>
      <View style={s.trendBody}>
        <View style={s.nameRow}>
          <Text style={s.name} numberOfLines={1}>{c.name}</Text>
          <ChainBadge chain={c.chain} />
        </View>
        <View style={s.trendStats}>
          <View>
            <Text style={s.trendLabel}>Floor</Text>
            <Text style={s.trendVal}>{c.floor != null ? amt(c.floor, c.currency) : '—'}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.trendLabel}>24h vol</Text>
            <Text style={s.trendVal}>{usdCompact(c.volume24hUsd!)}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// Desktop table: every column sortable where the data supports it.
const COLS = { rank: 36, floor: 130, chg: 80, vol: 110, sales: 80, supply: 100, spark: 120 };

function H({ label, w, k, left, sort, onSort }: {
  label: string; w?: number; k?: Sort; left?: boolean; sort: Sort; onSort: (s: Sort) => void;
}) {
  return (
    <Pressable disabled={!k} onPress={() => k && onSort(k)} style={[w ? { width: w } : { flex: 1 }]}>
      <Text style={[s.th, !left && { textAlign: 'right' }, k === sort && { color: C.text }]}>
        {label}{k === sort ? ' ↓' : ''}
      </Text>
    </Pressable>
  );
}

function TableHead({ sort, onSort }: { sort: Sort; onSort: (s: Sort) => void }) {
  const p = { sort, onSort };
  return (
    <View style={s.thRow}>
      <View style={{ width: 28 }} />
      <H label="#" w={COLS.rank} left {...p} />
      <H label="Collection" left {...p} />
      <H label="Floor" w={COLS.floor} k="floor" {...p} />
      <H label="24h" w={COLS.chg} k="change" {...p} />
      <H label="24h volume" w={COLS.vol} {...p} />
      <H label="7d volume" w={COLS.vol} k="volume" {...p} />
      <H label="24h sales" w={COLS.sales} k="sales" {...p} />
      <H label="Owners" w={COLS.supply} {...p} />
      <H label="Last 7 days" w={COLS.spark} {...p} />
    </View>
  );
}

function TableRow({ c, rank, watched, onWatch }: { c: CollectionSummary; rank: number; watched: boolean; onWatch: () => void }) {
  const chg = (v: number | null) => v == null
    ? <Text style={[s.td, { color: C.dim }]}>—</Text>
    : <Text style={[s.td, { color: v >= 0 ? C.up : C.down }]}>{pct(v)}</Text>;
  return (
    <View style={s.tr}>
      <Pressable hitSlop={8} onPress={onWatch} style={{ width: 28 }} accessibilityLabel={watched ? 'Remove from watchlist' : 'Add to watchlist'}>
        <Text style={[s.star, watched && { color: C.accent }]}>{watched ? '★' : '☆'}</Text>
      </Pressable>
      <Link href={{ pathname: '/collection/[symbol]', params: { symbol: c.symbol } }} asChild>
        <Pressable style={s.trMain}>
          <Text style={[s.rankTxt, { width: COLS.rank }]}>{rank}</Text>
          <View style={[s.nameCell, { flex: 1 }]}>
            <CollIcon name={c.name} uri={c.image} size={56} radius={12} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[s.name, { fontSize: 15.5 }]} numberOfLines={1}>{c.name}</Text>
              <View style={s.nameRow}>
                <ChainBadge chain={c.chain} />
                <Text style={s.meta}>{c.category}</Text>
              </View>
            </View>
          </View>
          <View style={{ width: COLS.floor, alignItems: 'flex-end' }}>
            <Text style={s.td}>{c.floor != null ? amt(c.floor, c.currency) : '—'}</Text>
            <Text style={s.meta}>{c.floorUsd != null ? usdCompact(c.floorUsd) : ''}</Text>
          </View>
          <View style={{ width: COLS.chg, alignItems: 'flex-end' }}>{chg(c.change24hPct)}</View>
          <Text style={[s.td, { width: COLS.vol, textAlign: 'right' }]}>{c.volume24hUsd != null ? usdCompact(c.volume24hUsd) : '—'}</Text>
          <Text style={[s.td, { width: COLS.vol, textAlign: 'right' }]}>{c.volume7dUsd != null ? usdCompact(c.volume7dUsd) : '—'}</Text>
          <Text style={[s.td, { width: COLS.sales, textAlign: 'right' }]}>{c.sales24h != null ? c.sales24h.toLocaleString() : '—'}</Text>
          {/* Magic Eden has no owner count; show its listed count, labeled */}
          <View style={{ width: COLS.supply, alignItems: 'flex-end' }}>
            <Text style={s.td}>{c.owners != null ? c.owners.toLocaleString() : '—'}</Text>
            {c.owners == null && c.listed != null && <Text style={s.meta}>{c.listed.toLocaleString()} listed</Text>}
          </View>
          <View style={{ width: COLS.spark, alignItems: 'flex-end' }}>
            <Sparkline values={c.spark.map((p) => p.median)} width={110} height={36} />
          </View>
        </Pressable>
      </Link>
    </View>
  );
}

function ChipRow<K extends string>({ items, value, onChange }: { items: { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  // Fixed-height wrapper: a horizontal ScrollView collapses its height on web.
  return (
    <View style={{ height: 36 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
        {items.map((i) => (
          <Pressable key={i.key} onPress={() => onChange(i.key)} style={[s.chip, value === i.key && s.chipOn]}>
            <Text style={[s.chipTxt, value === i.key && { color: C.accentInk }]}>{i.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const Tile = ({ label, value }: { label: string; value: string }) => (
  <View style={s.tile}>
    <Text style={s.tileLabel}>{label}</Text>
    <Text style={s.tileVal}>{value}</Text>
  </View>
);

const s = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: C.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border },
  tileLabel: { color: C.dim, fontSize: 12, fontWeight: '600' },
  tileVal: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  section: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  catCard: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  mosaic: { flexDirection: 'row', gap: 2, backgroundColor: C.border },
  catBody: { padding: 12, gap: 4 },
  catName: { color: C.text, fontWeight: '800', fontSize: 16 },
  catBlurb: { color: C.dim, fontSize: 12, lineHeight: 16 },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border },
  catHeadName: { color: C.text, fontWeight: '800', fontSize: 18 },
  clear: { color: C.accent, fontWeight: '700' },
  trend: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  trendRank: { position: 'absolute', top: 8, left: 8, minWidth: 26, height: 26, borderRadius: 8, backgroundColor: '#0B0B10CC', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  trendRankTxt: { color: C.text, fontWeight: '800', fontSize: 13 },
  trendBody: { padding: 10, gap: 8 },
  trendStats: { flexDirection: 'row', justifyContent: 'space-between' },
  trendLabel: { color: C.dim, fontSize: 11, fontWeight: '600' },
  trendVal: { color: C.text, fontWeight: '800', fontSize: 13.5, fontVariant: ['tabular-nums'] },
  filterWide: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  thRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, marginTop: 4 },
  th: { color: C.dim, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  tr: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  trMain: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rankTxt: { color: C.dim, fontWeight: '700', fontVariant: ['tabular-nums'] },
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingRight: 12 },
  td: { color: C.text, fontWeight: '700', fontSize: 14, fontVariant: ['tabular-nums'] },
  search: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
  },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  sortRow: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingTop: 2 },
  sortTxt: { color: C.dim, fontWeight: '700', fontSize: 13 },
  sortOn: { color: C.text, textDecorationLine: 'underline' },
  count: { color: C.dim, fontSize: 12, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  star: { color: C.dim, fontSize: 18, width: 20, textAlign: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: C.text, fontWeight: '700', fontSize: 14.5, flexShrink: 1 },
  meta: { color: C.dim, fontSize: 12 },
  right: { width: 92, alignItems: 'flex-end', gap: 2 },
  floor: { color: C.text, fontWeight: '800', fontSize: 13.5, fontVariant: ['tabular-nums'] },
  change: { fontWeight: '800', fontSize: 12 },
});
