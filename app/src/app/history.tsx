import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { NftImage } from '@/components/nft-image';
import { TopNav } from '@/components/top-nav';
import { Button, Card, Chip, ChipRow, Stat } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type History, type HistoryEntry } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, shortAddr, usd } from '@/lib/format';
import { GROUPS, TYPE, clock, dayLabel, inFlight, lifecycle, signedPrice, stamp, statusOf, viaLabel } from '@/lib/history';
import { useLayout } from '@/lib/layout';
import { useWalletName } from '@/lib/names';
import { usePrices } from '@/lib/prices';
import { useTitle } from '@/lib/use-title';
import { useWallet } from '@/lib/wallet';

// Full trading history for the connected wallets (or ?w=a,b): buys, sales,
// listings with their outcome, mints, transfers and wallet moves, grouped by
// day, filterable, and exportable as CSV for records and taxes.

const RANGES = [
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: 'all', label: 'All time', days: 0 },
];
// Outcome filters for orders: listings sell, offers get accepted.
const ORDER_STATES = {
  listings: ['any', 'active', 'sold', 'cancelled', 'expired'],
  offers: ['any', 'active', 'accepted', 'cancelled', 'expired'],
} as const;

export default function HistoryPage() {
  useTitle('History | FloorFeed');
  const params = useLocalSearchParams<{ w?: string; type?: string }>();
  const { pad, wide } = useLayout();
  const { toUsd } = usePrices();
  const sw = useWallet();
  const ew = useEvmWallet();
  const wallets = useMemo(() => (params.w
    ? params.w.split(',').filter(Boolean).slice(0, 3)
    : [ew.address, sw.address].filter((a): a is string => !!a)), [params.w, ew.address, sw.address]);
  const key = wallets.join(',');

  const [data, setData] = useState<{ key: string; h: History } | { key: string; error: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [group, setGroup] = useState(GROUPS.some((g) => g.id === params.type) ? params.type! : 'all');
  const [range, setRange] = useState('all');
  const [lstate, setLstate] = useState<string>('any');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(() => {
    if (!key) return Promise.resolve();
    return api.history(key.split(','))
      .then((h) => setData({ key, h }))
      .catch((e) => setData((d) => (d?.key === key && 'h' in d ? d : { key, error: (e as Error).message })));
  }, [key]);
  useEffect(() => {
    load();
    const soon = () => setTimeout(load, 2_000);
    window.addEventListener?.('floorfeed:activity', soon);
    window.addEventListener?.('floorfeed:listing', soon);
    return () => { window.removeEventListener?.('floorfeed:activity', soon); window.removeEventListener?.('floorfeed:listing', soon); };
  }, [load]);

  const current = data?.key === key ? data : null;
  // One row per id (rows are keyed by it; a repeat would linger after filtering).
  const all = useMemo(() => {
    const seen = new Set<string>();
    return (current && 'h' in current ? current.h.entries : []).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  }, [current]);
  const busy = all.some(inFlight);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, [busy, load]);

  const types = GROUPS.find((g) => g.id === group)?.types ?? null;
  const days = RANGES.find((r) => r.id === range)?.days ?? 0;
  const since = days ? now - days * 86_400 : 0;
  const inRange = useMemo(() => all.filter((e) => !since || e.at >= since), [all, since]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inRange.filter((e) => (!types || types.includes(e.type))
      && (!(group in ORDER_STATES) || lstate === 'any' || e.status === lstate)
      && (!needle || [e.name, e.collection, e.tx, e.counterparty, e.tokenId, e.listing?.orderHash, chainName(e.chain)]
        .some((v) => v?.toLowerCase().includes(needle))));
  }, [inRange, types, group, lstate, q]);

  // Summary over the chosen period (not the type filter), per coin.
  const summary = useMemo(() => {
    const tot = (list: HistoryEntry[]) => {
      const by = new Map<string, number>();
      // Wrapped ETH counts as ETH in the totals.
      for (const e of list) if (e.price != null && e.unit) { const u = /^(WETH|BETH)$/i.test(e.unit) ? 'ETH' : e.unit; by.set(u, (by.get(u) ?? 0) + e.price); }
      const dollars = [...by].reduce<number | null>((s, [u, n]) => { const d = toUsd(n, u); return d == null ? s : (s ?? 0) + d; }, null);
      return { coins: [...by].map(([u, n]) => amt(n, u)).join(' + ') || '—', dollars };
    };
    const buys = inRange.filter((e) => e.type === 'buy' && e.status === 'confirmed');
    const sales = inRange.filter((e) => e.type === 'sale' && e.status === 'confirmed');
    const listings = inRange.filter((e) => e.type === 'listing');
    const offers = inRange.filter((e) => e.type === 'offer');
    const count = (s: string) => listings.filter((e) => e.status === s).length;
    const countOffers = (s: string) => offers.filter((e) => e.status === s).length;
    return { buys, sales, bought: tot(buys), sold: tot(sales), volume: tot([...buys, ...sales]), listings, count, offers, countOffers };
  }, [inRange, toUsd]);

  const byDay = useMemo(() => {
    const out: { day: string; items: HistoryEntry[] }[] = [];
    for (const e of shown) {
      const day = dayLabel(e.at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [shown]);

  const exportCsv = () => {
    const url = api.historyCsvUrl(wallets, { types: types ?? undefined, since: since || undefined });
    track('history_export', { group, range });
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else Linking.openURL(url);
  };

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}>
        <View style={[s.head, !wide && { flexDirection: 'column', alignItems: 'stretch' }]}>
          <View style={{ gap: 6, flex: 1 }}>
            <Text {...display} style={wide ? T.displayL : T.display}>History</Text>
            <Text style={T.meta}>
              Every buy, sale, listing, offer and transfer{wallets.length ? ` for ${wallets.map(shortAddr).join(' and ')}` : ''}, on FloorFeed and the marketplaces.
            </Text>
          </View>
          {wallets.length > 0 && <Button label="Export CSV" tone="secondary" onPress={exportCsv} />}
        </View>

        {!wallets.length ? (
          <Card>
            <Text style={T.bodyStrong}>Connect a wallet to see its history</Text>
            <Text style={T.meta}>Your buys, sales, listings and offers show up here with their outcome, ready to export.</Text>
            <Button label="Go to Portfolio" onPress={() => router.push('/portfolio')} />
          </Card>
        ) : !current ? (
          <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
            <ActivityIndicator color={C.accent} />
            <Text style={T.meta}>Loading your history…</Text>
          </Card>
        ) : 'error' in current ? (
          <Card><Text style={T.meta}>Couldn&apos;t load your history: {current.error}. Pull to refresh.</Text></Card>
        ) : (
          <>
            <View style={s.stats}>
              <Stat label="Bought" value={String(summary.buys.length)} sub={sub(summary.bought)} />
              <Stat label="Sold" value={String(summary.sales.length)} sub={sub(summary.sold)} />
              <Stat label="Listings" value={String(summary.listings.length)}
                sub={(['active', 'sold', 'cancelled', 'expired'] as const).filter((x) => summary.count(x)).map((x) => `${summary.count(x)} ${x}`).join(' · ') || 'none in this period'} />
              <Stat label="Offers" value={String(summary.offers.length)}
                sub={(['active', 'accepted', 'cancelled', 'expired'] as const).filter((x) => summary.countOffers(x)).map((x) => `${summary.countOffers(x)} ${x}`).join(' · ') || 'none in this period'} />
              <Stat label="Volume" value={summary.volume.dollars != null ? usd(summary.volume.dollars) : '—'} sub={summary.volume.coins} />
            </View>

            <View style={{ gap: 4 }}>
              <ChipRow groups={[
                GROUPS.map((g) => <Chip key={g.id} label={g.label} on={group === g.id} onPress={() => { setGroup(g.id); setOpen(null); setLstate('any'); }} />),
                RANGES.map((r) => <Chip key={r.id} label={r.label} on={range === r.id} onPress={() => setRange(r.id)} />),
              ]} />
              {(group === 'listings' || group === 'offers') && (
                <ChipRow groups={[ORDER_STATES[group].map((st) => (
                  <Chip key={st} label={st === 'any' ? 'Any status' : statusOf(st).label} on={lstate === st} onPress={() => setLstate(st)} />
                ))]} />
              )}
              <TextInput value={q} onChangeText={setQ} placeholder="Search by item, collection, address or transaction"
                placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={s.search} accessibilityLabel="Search history" />
            </View>

            {wide && shown.length > 0 && (
              <View style={[s.row, s.thead]}>
                <Text style={[s.th, s.cType]}>Event</Text>
                <Text style={[s.th, { flex: 1 }]}>Item</Text>
                <Text style={[s.th, s.cNet]}>Network</Text>
                <Text style={[s.th, s.cPrice, { textAlign: 'right' }]}>Price</Text>
                <Text style={[s.th, s.cStatus, { textAlign: 'right' }]}>Status</Text>
              </View>
            )}

            {!shown.length ? (
              <Card><Text style={T.meta}>{all.length ? 'Nothing matches these filters.' : 'No history yet. Buys, sales and listings you make show up here.'}</Text></Card>
            ) : byDay.map((d) => (
              <View key={d.day} style={{ gap: 0 }}>
                <View style={s.day}>
                  <Text style={T.label}>{d.day}</Text>
                  <Text style={T.caption}>{d.items.length} event{d.items.length === 1 ? '' : 's'}</Text>
                </View>
                <View style={s.group}>
                  {d.items.map((e, n) => (
                    <HistoryRow key={e.id} e={e} first={n === 0} wide={wide} open={open === e.id}
                      onToggle={() => setOpen((o) => (o === e.id ? null : e.id))} toUsd={toUsd} />
                  ))}
                </View>
              </View>
            ))}

            <Text style={[T.caption, { textAlign: 'center' }]}>
              {current.h.partial ? 'OpenSea didn’t answer, so marketplace events may be missing. Pull to retry. ' : ''}
              {current.h.more ? 'Showing your latest 200 marketplace events. ' : ''}
              Prices are the full sale or ask price, before marketplace fees. USD values use today’s coin prices.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const sub = (t: { coins: string; dollars: number | null }) => (t.dollars != null ? `${t.coins} · ≈ ${usd(t.dollars)}` : t.coins);

function HistoryRow({ e, first, wide, open, onToggle, toUsd }: {
  e: HistoryEntry; first: boolean; wide: boolean; open: boolean; onToggle: () => void;
  toUsd: (n: number, u: string) => number | null;
}) {
  const st = statusOf(e.status);
  const price = signedPrice(e);
  const dollars = e.price != null && e.unit ? toUsd(e.price, e.unit) : null;
  const life = lifecycle(e);
  const priceColor = e.type === 'sale' ? C.up : C.text;
  const statusEl = (
    <View style={s.status}>
      {inFlight(e) && <ActivityIndicator size="small" color={C.dim} />}
      <View style={[s.dot, { backgroundColor: st.color }]} />
      <Text style={[T.label, { color: st.color }]}>{st.label}</Text>
    </View>
  );
  const art = <NftImage uri={e.image} name={e.name || TYPE[e.type].label} radius={8} px={96} style={{ width: 40 }} />;
  const sub = [e.collection, e.saleKind === 'offer' ? (e.type === 'sale' ? 'accepted offer' : 'offer') : null,
    e.via === 'floorfeed' ? 'via FloorFeed' : null].filter(Boolean).join(' · ');

  return (
    <View style={!first && s.divider}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle}
        style={({ pressed }) => [s.row, pressed && { backgroundColor: C.cardHi }]}>
        {wide ? (
          <>
            <View style={[s.cType, s.typeCell]}>
              <View style={s.icon}><Text style={s.iconTxt}>{TYPE[e.type].icon}</Text></View>
              <View>
                <Text style={T.bodyStrong}>{TYPE[e.type].label}</Text>
                <Text style={T.metaNum}>{clock(e.at)}</Text>
              </View>
            </View>
            <View style={s.item}>
              {art}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={T.bodyStrong} numberOfLines={1}>{e.name || e.title}</Text>
                <Text style={T.metaNum} numberOfLines={1}>{[sub, life].filter(Boolean).join(' · ') || ' '}</Text>
              </View>
            </View>
            <View style={[s.cNet, s.netCell]}>
              <ChainBadge chain={e.chain as never} />
              {e.toChain && <Text style={T.metaNum}>→ {chainName(e.toChain)}</Text>}
            </View>
            <View style={[s.cPrice, { alignItems: 'flex-end' }]}>
              <Text style={[T.num, { color: priceColor }]}>{price ?? '—'}</Text>
              {dollars != null && <Text style={T.metaNum}>≈ {usd(dollars)}</Text>}
            </View>
            <View style={[s.cStatus, { alignItems: 'flex-end' }]}>{statusEl}</View>
          </>
        ) : (
          <>
            {art}
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={T.bodyStrong} numberOfLines={1}>{TYPE[e.type].label} · {e.name || e.title}</Text>
              <View style={s.metaRow}>
                <ChainBadge chain={e.chain as never} />
                <Text style={T.metaNum} numberOfLines={1}>{clock(e.at)}{life ? ` · ${life}` : sub ? ` · ${sub}` : ''}</Text>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              {price && <Text style={[T.num, { color: priceColor }]}>{price}</Text>}
              {statusEl}
            </View>
          </>
        )}
      </Pressable>
      {open && <Details e={e} dollars={dollars} />}
    </View>
  );
}

function Details({ e, dollars }: { e: HistoryEntry; dollars: number | null }) {
  const l = e.listing;
  const who = useWalletName(e.counterparty);
  const tx = e.tx ?? l?.soldTx ?? null;
  const explorer = e.outUrl ?? e.explorerUrl ?? null;
  const fields: [string, string | null, (() => void)?][] = [
    ['Date', stamp(e.at)],
    ['Network', e.toChain ? `${chainName(e.chain)} → ${chainName(e.toChain)}` : chainName(e.chain)],
    ['Price', e.price != null && e.unit ? `${amt(e.price, e.unit)}${dollars != null ? ` (≈ ${usd(dollars)} today)` : ''}` : null],
    ['Sale type', e.saleKind === 'offer' ? 'Offer / bid' : e.saleKind === 'listing' ? 'Listing' : null],
    [e.type === 'buy' || e.type === 'offer' ? 'Seller' : e.type === 'transfer_in' ? 'From' : e.type === 'listing' ? 'Buyer' : 'To',
      e.counterparty ? (who ? `${who} · ${shortAddr(e.counterparty)}` : shortAddr(e.counterparty)) : null,
      e.counterparty ? () => router.push({ pathname: '/wallet/[address]', params: { address: e.counterparty! } }) : undefined],
    [e.type === 'offer' ? 'Offered' : 'Listed', l ? stamp(l.listedAt) : null],
    ['Expires', l?.expiresAt ? stamp(l.expiresAt) : null],
    [e.status === 'sold' ? 'Sold' : e.status === 'accepted' ? 'Accepted' : e.status === 'cancelled' ? 'Cancelled' : 'Closed', l?.closedAt ? stamp(l.closedAt) : null],
    ['Token ID', e.tokenId && e.tokenId.length < 20 ? e.tokenId : e.tokenId ? shortAddr(e.tokenId) : null],
    ['Order', l ? shortAddr(l.orderHash) : null],
    ['Transaction', tx ? shortAddr(tx) : null, explorer ? () => Linking.openURL(explorer) : undefined],
    ['Recorded by', viaLabel(e.via)],
  ];
  return (
    <View style={s.details}>
      <View style={s.grid}>
        {fields.filter(([, v]) => v).map(([k, v, go]) => (
          <View key={k} style={s.field}>
            <Text style={T.caption}>{k}</Text>
            <Text style={[T.metaNum, { color: go ? C.accent : C.text }]} onPress={go} selectable={!go}>{v}</Text>
          </View>
        ))}
      </View>
      <View style={s.actions}>
        {e.symbol && e.mint && (
          <Button label="View NFT" tone="secondary"
            onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: e.symbol!, id: e.mint! } })} />
        )}
        {explorer && <Button label="Explorer ↗" tone="secondary" onPress={() => Linking.openURL(explorer)} />}
        {e.marketUrl && <Button label={`${e.chain === 'solana' ? 'Magic Eden' : 'OpenSea'} ↗`} tone="secondary" onPress={() => Linking.openURL(e.marketUrl!)} />}
        {(e.status === 'failed' || e.status === 'dropped') && (
          <Button label="Report a problem" tone="secondary"
            onPress={() => router.push({ pathname: '/support', params: { topic: 'trade', tx: tx ?? '', from: 'history' } })} />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 1100, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 18 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 16 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  search: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, marginTop: 4,
  },
  thead: { paddingVertical: 0, paddingHorizontal: 14, marginBottom: -10 },
  th: { ...T.caption, textTransform: 'uppercase', letterSpacing: 0.6 },
  day: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 4, paddingBottom: 6 },
  group: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  cType: { width: 124 },
  cNet: { width: 84 },
  cPrice: { width: 124 },
  cStatus: { width: 100 },
  typeCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  netCell: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  item: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  iconTxt: { ...T.label, color: C.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  details: { paddingHorizontal: 14, paddingBottom: 14, paddingTop: 4, gap: 12, backgroundColor: C.cardHi },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  field: { flexBasis: 180, flexGrow: 1, gap: 1, paddingRight: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
