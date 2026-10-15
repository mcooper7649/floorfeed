import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { FlashBg, SalePulse, TickArrow, useBump, useTick } from '@/components/flash';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Chain, type Holding, type Mark } from '@/lib/api';
import { type ListingChange } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, pct, signedSol, signedUsd, usd } from '@/lib/format';
import { PANEL_GAP, PANEL_WIDTH, usePanel } from '@/lib/panel';
import { usePrices } from '@/lib/prices';
import { useWallet } from '@/lib/wallet';

// Your NFTs at a glance, on the right of wide web windows. Two speeds keep
// API use flat however long the panel stays open:
// - what you own (a marketplace call per wallet) loads on open, then every
//   10 minutes, when the tab comes back, and after a trade;
// - what each is worth polls every 30s from our own database (/portfolio/marks),
//   which also tells ingest to refresh those collections' floors every 2 min.

const HOLDINGS_EVERY = 10 * 60_000;
const MARKS_EVERY = 30_000;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

type Item = Holding & { chain: string };

export function PortfolioPanel() {
  const { right } = usePanel();
  if (!right.open) {
    return (
      <View style={s.rail}>
        <Pressable onPress={right.toggle} accessibilityLabel="Show your NFTs panel" style={s.railBtn} hitSlop={6}>
          <Text style={s.railTxt}>«</Text>
        </Pressable>
      </View>
    );
  }
  return <Panel onCollapse={right.toggle} />;
}

function Panel({ onCollapse }: { onCollapse: () => void }) {
  const sw = useWallet();
  const ew = useEvmWallet();
  const { toUsd } = usePrices();
  const wallets = [sw.address, ew.address].filter(Boolean).join(',');

  // --- holdings: slow ---
  const [items, setItems] = useState<{ wallets: string; list: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedAt = useRef(0);
  // Listings changed on this page, applied over holdings for a minute (until OpenSea shows them).
  const [listingOverrides, setListingOverrides] = useState<Record<string, ListingChange>>({});
  const loadHoldings = useCallback(() => {
    if (!wallets) return;
    loadedAt.current = Date.now();
    const [sol, evm] = [sw.address, ew.address];
    Promise.all([
      sol ? api.holdings(sol).then((h) => h.nfts.map((n) => ({ ...n, chain: 'solana' }))) : [],
      evm ? api.evmHoldings(evm).then((h) => h.nfts.map((n) => ({ ...n, chain: n.chain ?? 'ethereum' }))) : [],
    ].map((p) => Promise.resolve(p).catch(() => null))).then(([a, b]) => {
      if (a == null && b == null) { setError('Couldn’t load your NFTs. Retrying soon.'); return; }
      setError(null);
      setItems({ wallets, list: [...(a ?? []), ...(b ?? [])] });
      // OpenSea has had 15s+ to index a listing change by now: its data wins again.
      const cutoff = Date.now() - 15_000;
      setListingOverrides((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.at > cutoff)));
    });
  }, [wallets, sw.address, ew.address]);

  useEffect(() => {
    loadHoldings();
    const t = setInterval(() => { if (visible()) loadHoldings(); }, HOLDINGS_EVERY);
    // A trade changes what you own; give the chain a moment to settle first.
    const onTrade = () => setTimeout(loadHoldings, 20_000);
    // A listing / cancel: shown at once (below), then confirmed from OpenSea, which can take a few seconds to index it.
    const onListing = (e: Event) => {
      const d = (e as CustomEvent<ListingChange>).detail;
      setListingOverrides((o) => ({ ...o, [d.mint]: d }));
      setTimeout(loadHoldings, 5_000);
      setTimeout(loadHoldings, 20_000);
    };
    window.addEventListener?.('floorfeed:listing', onListing);
    const onShow = () => { if (visible() && Date.now() - loadedAt.current > 2 * 60_000) loadHoldings(); };
    window.addEventListener?.('floorfeed:activity', onTrade);
    document.addEventListener?.('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      window.removeEventListener?.('floorfeed:activity', onTrade);
      window.removeEventListener?.('floorfeed:listing', onListing);
      document.removeEventListener?.('visibilitychange', onShow);
    };
  }, [loadHoldings]);

  const list = useMemo(() => {
    const l = items?.wallets === wallets ? items.list : null;
    if (!l || !Object.keys(listingOverrides).length) return l;
    return l.map((n) => {
      const o = listingOverrides[n.mint.toLowerCase()];
      return o ? { ...n, listing: o.listing } : n;
    });
  }, [items, wallets, listingOverrides]);
  const symbols = useMemo(() => [...new Set((list ?? []).map((n) => n.collection.symbol))].sort().join(','), [list]);

  // --- values: fast, from our DB ---
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!symbols) return;
    let alive = true;
    const load = () => {
      if (!visible()) return;
      api.marks(symbols.split(',')).then((m) => {
        if (!alive) return;
        setMarks(m);
        setCheckedAt(Date.now());
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, MARKS_EVERY);
    const onShow = () => { if (visible()) load(); };
    document.addEventListener?.('visibilitychange', onShow);
    return () => { alive = false; clearInterval(t); document.removeEventListener?.('visibilitychange', onShow); };
  }, [symbols]);

  // Each NFT valued at its collection's live mark (falls back to the holdings snapshot).
  const rows = useMemo(() => (list ?? []).map((n) => {
    const m = marks[n.collection.symbol];
    const unit = m?.unit ?? n.unit ?? (n.chain === 'solana' ? 'SOL' : 'ETH');
    const value = m?.value ?? n.estValue;
    // Since purchase, when we know what this wallet paid (its on-chain buy, or a FloorFeed buy).
    const cost = n.boughtAt;
    const pl = value != null && cost != null && cost > 0 ? { pct: ((value - cost) / cost) * 100, amt: value - cost } : null;
    return {
      n, unit, value, usd: value != null ? toUsd(value, unit) : null, change: m?.change24h ?? null, sales: m?.sales24h ?? null,
      pl, plUsd: pl ? toUsd(pl.amt, unit) : null, costUsd: cost != null ? toUsd(cost, unit) : null,
    };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)), [list, marks, toUsd]);

  const totalUsd = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
  // Since purchase, over the NFTs with a known cost (in USD at today's prices).
  const based = rows.filter((r) => r.plUsd != null && r.costUsd != null && r.costUsd > 0);
  const plUsd = based.reduce((a, r) => a + r.plUsd!, 0);
  const plPct = based.length ? (plUsd / based.reduce((a, r) => a + r.costUsd!, 0)) * 100 : null;
  // 24h change of the whole bag: today's value vs the same NFTs at yesterday's floors.
  const before = rows.reduce((a, r) => a + (r.usd != null && r.change != null ? r.usd / (1 + r.change / 100) : r.usd ?? 0), 0);
  const totalChange = before > 0 && rows.some((r) => r.change != null) ? ((totalUsd - before) / before) * 100 : null;

  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Text style={[T.label, { flex: 1 }]}>Your NFTs</Text>
        {checkedAt && <Live at={checkedAt} />}
        <Pressable onPress={onCollapse} accessibilityLabel="Collapse your NFTs panel" hitSlop={8}>
          <Text style={s.collapse}>»</Text>
        </Pressable>
      </View>

      {!wallets ? (
        <View style={s.empty}>
          <Text style={T.meta}>Connect a wallet to watch what your NFTs are worth, live.</Text>
          <Pressable onPress={() => router.push('/portfolio')}><Text style={s.link}>Go to Portfolio →</Text></Pressable>
        </View>
      ) : list == null ? (
        error ? <Text style={[T.meta, s.empty]}>{error}</Text> : <ActivityIndicator color={C.accent} style={{ marginTop: 24 }} />
      ) : (
        <>
          <View style={s.total}>
            <Text style={s.totalNum}>{usd(totalUsd)}</Text>
            <Text style={T.metaNum}>
              {rows.length} NFT{rows.length === 1 ? '' : 's'}
              {plPct != null
                ? <Text style={{ color: plUsd >= 0 ? C.up : C.down }}> · {signedUsd(plUsd)} ({pct(plPct)}) since bought</Text>
                : totalChange != null && <Text style={{ color: totalChange >= 0 ? C.up : C.down }}> · {pct(totalChange)} 24h</Text>}
            </Text>
          </View>
          {rows.length === 0 ? (
            <Text style={[T.meta, s.empty]}>No NFTs from collections FloorFeed tracks in your wallets yet.</Text>
          ) : (
            <ScrollView contentContainerStyle={s.list}>
              {rows.map((r) => <NftRow key={`${r.n.chain}:${r.n.mint}`} {...r} />)}
            </ScrollView>
          )}
          <Text style={s.foot}>Valued at the estimated bid (floor −3%). Prices update every 30s.</Text>
        </>
      )}
    </View>
  );
}

// One NFT. Flashes green/red when its value moves, and pulses "+N sales" when
// its collection trades (a quick read on volume).
function NftRow({ n, unit, value, usd: dollars, change, sales, pl, plUsd }: {
  n: Item; unit: string; value: number | null; usd: number | null; change: number | null; sales: number | null;
  pl: { pct: number; amt: number } | null; plUsd: number | null;
}) {
  const { tick, at } = useTick(value);
  const bump = useBump(sales);
  return (
    <Pressable style={({ hovered }: { hovered?: boolean }) => [s.row, hovered && { backgroundColor: C.card }]}
      onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: n.collection.symbol, id: n.mint } })}>
      <FlashBg tick={tick} at={at} />
      <View style={{ width: 40, height: 40 }}>
        <CollIcon uri={n.image} name={n.name ?? n.collection.name} size={40} radius={8} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={s.sub}>
          <Text style={[s.name, { flexShrink: 1 }]} numberOfLines={1}>{n.name ?? n.collection.name}</Text>
          <SalePulse by={bump.by} at={bump.at} />
        </View>
        <View style={s.sub}>
          <ChainBadge chain={n.chain as Chain} />
          {n.listing ? <Text style={s.listed} numberOfLines={1}>Listed {amt(n.listing.price, unit, 3)}</Text>
            : <Text style={s.coll} numberOfLines={1}>{n.collection.name}</Text>}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[s.value, tick === 'up' && { color: C.up }, tick === 'down' && { color: C.down }]}>
          <TickArrow tick={tick} />{value != null ? amt(value, unit, 3) : '—'}
        </Text>
        {pl ? (
          // Since purchase: % and the gain or loss in dollars (or the coin when there's no USD price).
          <Text style={[s.small, { color: pl.amt >= 0 ? C.up : C.down }]}>
            {pct(pl.pct)} · {plUsd != null ? signedUsd(plUsd) : signedSol(pl.amt, 4, unit)}
          </Text>
        ) : (
          <Text style={s.small}>
            {dollars != null ? usd(dollars) : ''}
            {change != null && <Text style={{ color: change >= 0 ? C.up : C.down }}> {pct(change)} 24h</Text>}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

// "Live" with a pulse while values are fresh; the time since the last check otherwise.
function Live({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const age = Math.max(0, Math.round((now - at) / 1000));
  const fresh = age < 75;
  return (
    <View style={s.live}>
      <View style={[s.dot, { backgroundColor: fresh ? C.up : C.dim }]} />
      <Text style={s.liveTxt}>{fresh ? 'Live' : `${Math.round(age / 60)}m ago`}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    width: PANEL_WIDTH, marginRight: PANEL_GAP, marginVertical: 12, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, overflow: 'hidden', backgroundColor: C.bg,
  },
  rail: { width: 44, alignItems: 'center', paddingTop: 16 },
  railBtn: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  railTxt: { color: C.dim, fontSize: 16, lineHeight: 18 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  collapse: { color: C.dim, fontSize: 18, lineHeight: 20 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  liveTxt: { color: C.dim, fontSize: 11, fontWeight: '600' },
  total: { paddingHorizontal: 12, paddingBottom: 10, gap: 2 },
  totalNum: { ...T.title, fontVariant: ['tabular-nums'] },
  list: { paddingHorizontal: 6, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 7, borderRadius: 8 },
  name: { color: C.text, fontSize: 14, fontWeight: '600' },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  coll: { color: C.dim, fontSize: 12, flexShrink: 1 },
  listed: { color: C.accent, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  value: { color: C.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  small: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  empty: { paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  link: { ...T.label, color: C.accent },
  foot: { color: C.muted, fontSize: 11, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
