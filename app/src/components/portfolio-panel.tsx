import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { FlashBg, SalePulse, TickArrow, useBump, useTick } from '@/components/flash';
import { EvmListSheet } from '@/components/evm-list-sheet';
import { EvmOfferSheet } from '@/components/evm-offer-sheet';
import { EvmSellSheet } from '@/components/evm-sell-sheet';
import { menuProps, useQuickMenu, type MenuItem } from '@/components/quick-menu';
import { networkLines } from '@/components/networks-card';
import { ListingRows, OfferRows, OrderTabs, useMyOrders, type OpenMenu, type PanelAction, type Tab } from '@/components/your-orders';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Chain, type EvmNetwork, type Holding, type Mark } from '@/lib/api';
import { announceListing, cancelEvmListing, type ListingChange } from '@/lib/evm-listing';
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
const CASH_EVERY = 3 * 60_000; // coin balances on every network (RPC reads, cached 15s server-side)
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

// Holdings + live values for the connected wallets; shared by the desktop
// panel and the phone sheet (your-nfts-sheet.tsx).
export function useYourNfts() {
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
  // Cash: SOL comes with the Solana holdings; EVM coins (and wrapped ones) from /chain/evm/networks.
  const [cash, setCash] = useState<{ wallets: string; sol: number | null; nets: EvmNetwork[] | null } | null>(null);
  const loadCash = useCallback(() => {
    if (!ew.address) return;
    api.evmNetworks(ew.address).then((nets) => setCash((c) => ({ wallets, sol: c?.wallets === wallets ? c.sol : null, nets }))).catch(() => {});
  }, [wallets, ew.address]);
  const loadHoldings = useCallback(() => {
    if (!wallets) return;
    loadedAt.current = Date.now();
    const [sol, evm] = [sw.address, ew.address];
    Promise.all([
      sol ? api.holdings(sol).then((h) => {
        setCash((c) => ({ wallets, sol: h.sol, nets: c?.wallets === wallets ? c.nets : null }));
        return h.nfts.map((n) => ({ ...n, chain: 'solana' }));
      }) : [],
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
    loadCash();
    const t = setInterval(() => { if (visible()) loadCash(); }, CASH_EVERY);
    // A trade, bridge, wrap or deposit moves coins: check again once the chain has it.
    const soon = () => { setTimeout(loadCash, 8_000); setTimeout(loadCash, 30_000); };
    const onShow = () => { if (visible()) loadCash(); };
    window.addEventListener?.('floorfeed:activity', soon);
    document.addEventListener?.('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      window.removeEventListener?.('floorfeed:activity', soon);
      document.removeEventListener?.('visibilitychange', onShow);
    };
  }, [loadCash]);

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

  const priced = rows.some((r) => r.usd != null);
  // Coins in dollars across every network; null until both wallets' balances are in.
  const c = cash?.wallets === wallets ? cash : null;
  const cashReady = !!c && (!sw.address || c.sol != null) && (!ew.address || c.nets != null);
  const cashLines = cashReady ? networkLines(c!.sol, c!.nets, toUsd) : [];
  const cashUsd = cashReady ? cashLines.reduce<number | null>((a, l) => (a == null || l.usd == null ? null : a + l.usd), 0) : null;
  return { wallets, list, error, checkedAt, rows, totalUsd, priced, plUsd, plPct, totalChange, cashUsd, cashNetworks: cashLines.length };
}

export type YourNfts = ReturnType<typeof useYourNfts>;

function Panel({ onCollapse }: { onCollapse: () => void }) {
  const nfts = useYourNfts();
  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Text style={[T.label, { flex: 1 }]}>Your NFTs</Text>
        {nfts.checkedAt && <Live at={nfts.checkedAt} />}
        <Pressable onPress={onCollapse} accessibilityLabel="Collapse your NFTs panel" hitSlop={8}>
          <Text style={s.collapse}>»</Text>
        </Pressable>
      </View>
      <YourNftsBody nfts={nfts} />
    </View>
  );
}

// Total, rows and footnote. `onOpen` runs before a row opens its NFT (the phone sheet closes).
export function YourNftsBody({ nfts, onOpen }: { nfts: YourNfts; onOpen?: () => void }) {
  const { wallets, list, error, rows, totalUsd, priced, plUsd, plPct, totalChange } = nfts;
  const ew = useEvmWallet();
  const orders = useMyOrders(ew.address);
  const [tab, setTab] = useState<Tab>('owned');
  // Right-click / long-press menus on every row, and the sheets their items open.
  const quick = useQuickMenu();
  const [act, setAct] = useState<PanelAction | null>(null);
  const menus = { onOpen, reload: orders.reload, menu: quick.open as OpenMenu, act: setAct };
  if (!wallets) {
    return (
      <View style={s.empty}>
        <Text style={T.meta}>Connect a wallet to watch what your NFTs are worth, live.</Text>
        <Pressable onPress={() => { onOpen?.(); router.push('/portfolio'); }}><Text style={s.link}>Go to Portfolio →</Text></Pressable>
      </View>
    );
  }
  if (list == null) return error ? <Text style={[T.meta, s.empty]}>{error}</Text> : <ActivityIndicator color={C.accent} style={{ marginTop: 24 }} />;
  const { cashUsd, cashNetworks } = nfts;
  const nftUsd = priced || rows.length === 0 ? totalUsd : null;
  const grand = cashUsd != null && nftUsd != null ? cashUsd + nftUsd : null;
  return (
    <>
      {/* Everything you have, always in view: total, then coins and NFTs. Tap for Portfolio. */}
      <Pressable onPress={() => { onOpen?.(); router.push('/portfolio'); }} accessibilityRole="link" accessibilityLabel="Open Portfolio"
        style={({ hovered }: { hovered?: boolean }) => [s.total, hovered && { opacity: 0.85 }]}>
        <Text style={s.totalLbl}>Total</Text>
        <Text style={s.totalNum}>{grand != null ? usd(grand) : '…'}</Text>
        <View style={s.split}>
          <View style={s.splitCol}>
            <Text style={s.splitLbl}>Cash</Text>
            <Text style={s.splitVal}>{cashUsd != null ? usd(cashUsd) : '…'}</Text>
            <Text style={s.small} numberOfLines={1}>{cashNetworks ? `${cashNetworks} network${cashNetworks === 1 ? '' : 's'}` : cashUsd != null ? 'no coins yet' : ' '}</Text>
          </View>
          <View style={s.splitCol}>
            <Text style={s.splitLbl}>NFTs · {rows.length}</Text>
            <Text style={s.splitVal}>{nftUsd != null ? usd(nftUsd) : '—'}</Text>
            {plPct != null
              ? <Text style={[s.small, { color: plUsd >= 0 ? C.up : C.down }]} numberOfLines={1}>{signedUsd(plUsd)} ({pct(plPct)})</Text>
              : <Text style={[s.small, totalChange != null && { color: totalChange >= 0 ? C.up : C.down }]} numberOfLines={1}>{totalChange != null ? `${pct(totalChange)} 24h` : ' '}</Text>}
          </View>
        </View>
      </Pressable>
      {/* Listings and offers are OpenSea orders, so only with an Ethereum wallet. */}
      {ew.address && (
        <OrderTabs tab={tab} onTab={setTab}
          counts={{ owned: rows.length, listed: orders.listings?.length ?? null, offers: orders.offers?.length ?? null }} />
      )}
      {tab === 'listed' && ew.address ? (
        <ListingRows listings={orders.listings} {...menus} />
      ) : tab === 'offers' && ew.address ? (
        <OfferRows offers={orders.offers} {...menus} />
      ) : rows.length === 0 ? (
        <Text style={[T.meta, s.empty]}>No NFTs from collections FloorFeed tracks in your wallets yet.</Text>
      ) : (
        <ScrollView contentContainerStyle={s.list}>
          {rows.map((r) => <NftRow key={`${r.n.chain}:${r.n.mint}`} {...r} onOpen={onOpen} menu={quick.open as OpenMenu} act={setAct} />)}
        </ScrollView>
      )}
      <Text style={s.foot}>
        {tab === 'listed' && ew.address ? 'Your OpenSea listings. Cancelling is free on newer ones.'
          : tab === 'offers' && ew.address ? 'Nothing leaves your wallet until someone accepts.'
          : 'Valued at the estimated bid (floor −3%). Prices update every 30s.'}
        {ew.address ? (onOpen ? ' Long-press a row for quick actions.' : ' Right-click a row for quick actions.') : ''}
      </Text>
      {quick.node}
      {act?.kind === 'list' && <EvmListSheet symbol={act.symbol} id={act.id} open onClose={() => setAct(null)} onDone={orders.reload} />}
      {act?.kind === 'sell' && <EvmSellSheet symbol={act.symbol} id={act.id} open onClose={() => setAct(null)} onSold={orders.reload} />}
      {act?.kind === 'offer' && (
        <EvmOfferSheet symbol={act.symbol} id={act.id} replacing={act.replacing} open onClose={() => setAct(null)} />
      )}
    </>
  );
}

// One NFT. Flashes green/red when its value moves, and pulses "+N sales" when
// its collection trades (a quick read on volume).
function NftRow({ n, unit, value, usd: dollars, change, sales, pl, plUsd, onOpen, menu, act }: {
  onOpen?: () => void; menu: OpenMenu; act: (a: PanelAction) => void; n: Item; unit: string; value: number | null; usd: number | null; change: number | null; sales: number | null;
  pl: { pct: number; amt: number } | null; plUsd: number | null;
}) {
  const { tick, at } = useTick(value);
  const bump = useBump(sales);
  const ew = useEvmWallet();
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const view = () => { onOpen?.(); router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: n.collection.symbol, id: n.mint } }); };
  // Selling and listing in-app are OpenSea (EVM) only, and not for launchpad drops yet.
  const tradable = n.chain !== 'solana' && !n.drop && !!ew.address;
  const cancelListing = async () => {
    if (!n.listing) return;
    setNote({ text: 'Sign to cancel…' });
    try {
      await cancelEvmListing(ew, { chain: n.chain, orderHash: n.listing.orderHash, name: n.name ?? n.collection.name, mint: n.mint });
      setNote(null);
    } catch (e) {
      const m = (e as Error).message;
      if (/isn't live anymore/i.test(m)) { announceListing(n.mint, null); setNote(null); return; }
      setNote({ text: /reject|denied|cancel/i.test(m) && !/didn't cancel|can't cancel/i.test(m) ? 'Still listed' : m, bad: true });
    }
  };
  const target = { symbol: n.collection.symbol, id: n.mint };
  const items: MenuItem[] = tradable ? [
    ...(n.listing
      ? [{ label: 'Edit listing', onPress: () => act({ kind: 'list', ...target }) },
         { label: 'Cancel listing', danger: true, onPress: () => { void cancelListing(); } }]
      : [{ label: 'List for sale', onPress: () => act({ kind: 'list', ...target }) }]),
    { label: 'Sell to best offer', onPress: () => act({ kind: 'sell', ...target }) },
    'sep',
    { label: 'View NFT', onPress: view },
  ] : [{ label: 'View NFT', onPress: view }];
  return (
    <Pressable style={({ hovered }: { hovered?: boolean }) => [s.row, hovered && { backgroundColor: C.card }]}
      onPress={view} {...menuProps((e) => menu(e, items, n.name ?? n.collection.name))}>
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
          {note ? <Text style={[s.coll, note.bad && { color: C.down }]} numberOfLines={1}>{note.text}</Text>
            : n.listing ? <Text style={s.listed} numberOfLines={1}>Listed {amt(n.listing.price, unit, 3)}</Text>
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
export function Live({ at }: { at: number }) {
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
  totalLbl: { color: C.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  totalNum: { ...T.title, fontSize: 24, fontVariant: ['tabular-nums'] },
  split: { flexDirection: 'row', gap: 8, marginTop: 8 },
  splitCol: { flex: 1, gap: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.card },
  splitLbl: { color: C.dim, fontSize: 11, fontWeight: '600' },
  splitVal: { color: C.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
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
