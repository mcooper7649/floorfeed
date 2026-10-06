import { Link, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { Empty, Screen } from '@/components/screen';
import { Sparkline } from '@/components/sparkline';
import { C } from '@/constants/brand';
import { api, type Chain, type CollectionSummary, type MarketCategory } from '@/lib/api';
import { amt, pct, usdCompact } from '@/lib/format';
import { useSession } from '@/lib/session';

type ChainFilter = 'all' | Chain;
type CatFilter = 'all' | MarketCategory | 'watch';
type Sort = 'volume' | 'change' | 'floor' | 'sales';

const CHAINS: { key: ChainFilter; label: string }[] = [
  { key: 'all', label: 'All chains' }, { key: 'solana', label: 'Solana' }, { key: 'ethereum', label: 'Ethereum' }, { key: 'base', label: 'Base' },
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
  const [query, setQuery] = useState('');
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
        <Tile label="Collections" value={String(rows.length || '—')} />
        <Tile label="Chains" value={String(chains || '—')} />
      </View>

      {trending.length > 0 && !query && cat === 'all' && chain === 'all' && (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>TRENDING · 24H VOLUME</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
            {trending.map((t) => (
              <Pressable key={t.symbol} style={s.trend}
                onPress={() => router.push({ pathname: '/collection/[symbol]', params: { symbol: t.symbol } })}>
                <CollIcon name={t.name} uri={t.image} size={128} radius={12} />
                <View style={s.trendName}>
                  <Text style={s.name} numberOfLines={1}>{t.name}</Text>
                </View>
                <View style={s.trendRow}>
                  <ChainBadge chain={t.chain} />
                  <Text style={s.meta}>{usdCompact(t.volume24hUsd!)} 24h</Text>
                </View>
                {t.floor != null && <Text style={s.trendFloor}>{amt(t.floor, t.currency)}</Text>}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {cat === 'all' && !query && catStats.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>BROWSE BY CATEGORY</Text>
          <View style={s.catGrid}>
            {catStats.map((c) => (
              <Pressable key={c.key} style={s.catCard} onPress={() => setCat(c.key)}
                accessibilityLabel={`${c.key}, ${c.count} collections`}>
                <View style={s.catIcons}>
                  {c.top.map((t, i) => (
                    <View key={t.symbol} style={[s.catIconWrap, { marginLeft: i ? -10 : 0, zIndex: 3 - i }]}>
                      <CollIcon name={t.name} uri={t.image} size={30} radius={15} />
                    </View>
                  ))}
                </View>
                <Text style={s.catName}>{c.key}</Text>
                <Text style={s.catBlurb} numberOfLines={2}>{c.blurb}</Text>
                <Text style={s.meta}>{c.count} {c.count === 1 ? 'collection' : 'collections'}{c.vol ? ` · ${usdCompact(c.vol)} 7d` : ''}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search collections"
        placeholderTextColor={C.dim}
        style={s.search}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
      />

      <View style={{ gap: 8 }}>
        <ChipRow items={CHAINS} value={chain} onChange={setChain} />
        <ChipRow items={CATS} value={cat} onChange={setCat} />
        <View style={s.sortRow}>
          <Text style={s.meta}>Sort</Text>
          {SORTS.map((o) => (
            <Pressable key={o.key} onPress={() => setSort(o.key)} hitSlop={6}>
              <Text style={[s.sortTxt, sort === o.key && s.sortOn]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

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
    </View>
  );

  return (
    <Screen title="Markets" subtitle="NFT collections on Solana, Ethereum, Base and Polygon, ranked in USD">
      <FlatList
        data={visible}
        keyExtractor={(r) => r.symbol}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        ListHeaderComponent={header}
        ListEmptyComponent={refreshing ? null : (
          <Empty text={error ?? (cat === 'watch' ? 'Tap ☆ on any collection to add it to your watchlist.' : 'No collections match.')} />
        )}
        renderItem={({ item }) => (
          <Row c={item} watched={watchlist.has(item.symbol)} onWatch={() => toggleWatch(item.symbol)} />
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
          <CollIcon name={c.name} uri={c.image} size={40} />
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
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catCard: { flexGrow: 1, flexBasis: '46%', backgroundColor: C.card, borderRadius: 16, padding: 12, gap: 4, borderWidth: 1, borderColor: C.border },
  catIcons: { flexDirection: 'row', marginBottom: 4 },
  catIconWrap: { borderRadius: 17, borderWidth: 2, borderColor: C.card },
  catName: { color: C.text, fontWeight: '800', fontSize: 16 },
  catBlurb: { color: C.dim, fontSize: 12, lineHeight: 16 },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: C.border },
  catHeadName: { color: C.text, fontWeight: '800', fontSize: 18 },
  clear: { color: C.accent, fontWeight: '700' },
  trend: { width: 140, backgroundColor: C.card, borderRadius: 16, padding: 6, gap: 6, borderWidth: 1, borderColor: C.border },
  trendName: { paddingHorizontal: 4 },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  trendFloor: { color: C.text, fontWeight: '800', paddingHorizontal: 4, paddingBottom: 4 },
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
