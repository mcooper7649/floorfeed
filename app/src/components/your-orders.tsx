import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { announceOffer } from '@/components/evm-offer-sheet';
import { menuProps, type MenuItem } from '@/components/quick-menu';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type Chain, type MyListing, type MyOffer } from '@/lib/api';
import { announceListing, cancelEvmListing, cancelledHere, daysLeft } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// Your open orders on OpenSea (EVM) for the Your NFTs panel: what you've
// listed and what you've offered, each with a quiet Cancel. Loads on open,
// every 5 minutes while visible, and soon after a listing or offer changes
// anywhere on the page (OpenSea takes a few seconds to index it).

const EVERY = 2 * 60_000; // also how soon a filled offer or a sale is noticed (server caches a minute)
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

// An offer that leaves the open orders without being cancelled here, before
// it expires, was accepted: the NFT is in the wallet now. Holdings and cash listen for 'floorfeed:activity' and reload;
// the panel shows 'floorfeed:filled' as a note.
// (Only offers: a listing also leaves when its NFT is sold into an offer, so its vanishing proves nothing.)
export type Filled = { name: string; price: number; unit: string; at: number };
export function announceFilled(prev: MyOffer[] | null, next: MyOffer[] | null) {
  if (!prev || !next) return;
  const now = Date.now() / 1000;
  const filled: Filled[] = prev
    .filter((o) => !next.some((x) => x.orderHash === o.orderHash) && !cancelledHere.has(o.orderHash.toLowerCase()) && o.expiresAt > now + 30)
    .map((o) => ({ name: o.name.replace(/^Any /, ''), price: o.price, unit: o.unit, at: Date.now() }));
  if (!filled.length) return;
  globalThis.dispatchEvent?.(new CustomEvent('floorfeed:activity'));
  for (const f of filled) globalThis.dispatchEvent?.(new CustomEvent('floorfeed:filled', { detail: f }));
}

export function useMyOrders(address: string | null) {
  const [data, setData] = useState<{ address: string; listings: MyListing[] | null; offers: MyOffer[] | null } | null>(null);
  const last = useRef<typeof data>(null);
  const load = useCallback(() => {
    if (!address) return;
    Promise.all([
      api.evmListings(address).then((r) => r.listings).catch(() => null),
      api.evmOffers(address).then((r) => r.offers).catch(() => null),
    ]).then(([listings, offers]) => {
      const prev = last.current?.address === address ? last.current : null;
      // A failed refresh keeps what was there.
      const next = { address, listings: listings ?? prev?.listings ?? null, offers: offers ?? prev?.offers ?? null };
      last.current = next;
      setData(next);
      if (prev && offers) announceFilled(prev.offers, offers);
    });
  }, [address]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (visible()) load(); }, EVERY);
    const soon = () => { setTimeout(load, 4_000); setTimeout(load, 15_000); };
    window.addEventListener?.('floorfeed:listing', soon);
    window.addEventListener?.('floorfeed:offer', soon);
    return () => {
      clearInterval(t);
      window.removeEventListener?.('floorfeed:listing', soon);
      window.removeEventListener?.('floorfeed:offer', soon);
    };
  }, [load]);
  const cur = data?.address === address ? data : null;
  return { listings: cur?.listings ?? null, offers: cur?.offers ?? null, reload: load };
}

export type Tab = 'owned' | 'listed' | 'offers';

// What a quick-menu item asks the panel to open.
export type PanelAction =
  | { kind: 'list' | 'sell'; symbol: string; id: string }
  | { kind: 'offer'; symbol: string; id: string | null; replacing: { orderHash: string; chain: string; price: number } };
// Opens the quick menu at the pointer.
export type OpenMenu = (e: unknown, items: MenuItem[], title?: string) => void;
type Menus = { onOpen?: () => void; reload: () => void; menu: OpenMenu; act: (a: PanelAction) => void };

// Owned · Listed · Offers, as one segmented control.
export function OrderTabs({ tab, onTab, counts }: { tab: Tab; onTab: (t: Tab) => void; counts: Record<Tab, number | null> }) {
  const tabs: { key: Tab; label: string }[] = [{ key: 'owned', label: 'Owned' }, { key: 'listed', label: 'Listed' }, { key: 'offers', label: 'Offers' }];
  return (
    <View style={s.seg} accessibilityRole="tablist">
      {tabs.map((t) => {
        const on = tab === t.key;
        return (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onTab(t.key)}
            style={[s.segBtn, on && s.segOn]}>
            <Text style={[s.segTxt, on && { color: C.text }]}>{t.label}</Text>
            {counts[t.key] != null && counts[t.key]! > 0 && <Text style={[s.segCount, on && { color: C.accent }]}>{counts[t.key]}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

type Order = {
  key: string; chain: string; orderHash: string; name: string; image: string | null; sub: string;
  price: number; unit: string; open: () => void; kind: 'listing' | 'offer'; mint: string | null; cancelFree: boolean;
  edit: PanelAction | null; // what Edit opens (needs a collection FloorFeed tracks)
};

export function ListingRows({ listings, ...m }: { listings: MyListing[] | null } & Menus) {
  if (listings == null) return <Text style={[T.meta, s.empty]}>Loading your listings…</Text>;
  if (!listings.length) return <Text style={[T.meta, s.empty]}>Nothing listed. Open an NFT you own and tap List for sale.</Text>;
  const rows: Order[] = listings.map((l) => {
    const vsFloor = l.floor ? l.price / l.floor - 1 : null;
    return {
      key: l.orderHash, chain: l.chain, orderHash: l.orderHash, name: l.name, image: l.image, price: l.price, unit: l.unit,
      kind: 'listing', mint: l.mint, cancelFree: l.cancelFree,
      edit: l.symbol ? { kind: 'list', symbol: l.symbol, id: l.mint } : null,
      sub: [daysLeft(l.expiresAt), vsFloor != null ? (Math.abs(vsFloor) < 0.005 ? 'at floor' : `${Math.abs(vsFloor * 100).toFixed(0)}% ${vsFloor > 0 ? 'over' : 'under'} floor`) : null].filter(Boolean).join(' · '),
      open: () => (l.symbol ? router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: l.symbol, id: l.mint } }) : Linking.openURL(l.url)),
    };
  });
  return <OrderList rows={rows} {...m} />;
}

export function OfferRows({ offers, ...m }: { offers: MyOffer[] | null } & Menus) {
  if (offers == null) return <Text style={[T.meta, s.empty]}>Loading your offers…</Text>;
  if (!offers.length) return <Text style={[T.meta, s.empty]}>No open offers. Tap Make an offer on any Ethereum NFT, or on a collection.</Text>;
  const rows: Order[] = offers.map((o) => ({
    key: o.orderHash, chain: o.chain, orderHash: o.orderHash, name: o.name, image: o.image, price: o.price, unit: o.unit,
    kind: 'offer', mint: o.mint, cancelFree: o.cancelFree,
    edit: o.symbol && o.kind !== 'trait' ? { kind: 'offer', symbol: o.symbol, id: o.mint, replacing: { orderHash: o.orderHash, chain: o.chain, price: o.price } } : null,
    // "Any X" already says it's a collection offer; the time left goes first so it survives truncation.
    sub: [daysLeft(o.expiresAt), o.kind === 'trait' ? 'trait' : o.kind === 'collection' && o.quantity > 1 ? `wants ${o.quantity}` : null].filter(Boolean).join(' · '),
    open: () => (o.symbol && o.mint ? router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: o.symbol, id: o.mint } })
      : o.symbol ? router.push({ pathname: '/collection/[symbol]', params: { symbol: o.symbol } }) : Linking.openURL(o.url)),
  }));
  return <OrderList rows={rows} {...m} />;
}

function OrderList({ rows, onOpen, reload, menu, act }: { rows: Order[] } & Menus) {
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  return (
    <ScrollView contentContainerStyle={s.list}>
      {rows.filter((r) => !gone.has(r.key)).map((r) => (
        <OrderRow key={r.key} r={r} onOpen={onOpen} menu={menu} act={act}
          onGone={() => { setGone((g) => new Set(g).add(r.key)); setTimeout(reload, 4_000); }} />
      ))}
    </ScrollView>
  );
}

type RowState = 'idle' | 'confirm' | 'working' | { error: string };

function OrderRow({ r, onOpen, onGone, menu, act }: { r: Order; onOpen?: () => void; onGone: () => void; menu: OpenMenu; act: (a: PanelAction) => void }) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [st, setSt] = useState<RowState>('idle');
  const dollars = toUsd(r.price, r.unit);
  const cancel = async () => {
    setSt('working');
    try {
      await cancelEvmListing(w, { chain: r.chain, orderHash: r.orderHash, name: r.name, mint: r.kind === 'listing' ? r.mint ?? undefined : undefined });
      if (r.kind === 'offer') announceOffer(); else if (r.mint) announceListing(r.mint, null);
      track(r.kind === 'offer' ? 'offer_cancel' : 'list_cancel', { chain: r.chain, from: 'panel' });
      onGone();
    } catch (e) {
      const m = (e as Error).message;
      if (/isn't live anymore/i.test(m)) { onGone(); return; }
      setSt({ error: /reject|denied|cancel/i.test(m) && !/didn't cancel|can't cancel/i.test(m) ? 'Cancelled in your wallet. Still open.' : m });
    }
  };
  const what = r.kind === 'offer' ? 'offer' : 'listing';
  const items: MenuItem[] = [
    ...(r.edit ? [{ label: `Edit ${what}`, onPress: () => act(r.edit!) }] : []),
    { label: `Cancel ${what}`, danger: true, onPress: () => { void cancel(); } },
    'sep',
    { label: r.mint ? 'View NFT' : 'View collection', onPress: () => { onOpen?.(); r.open(); } },
  ];
  return (
    <View>
      <Pressable style={({ hovered }: { hovered?: boolean }) => [s.row, hovered && { backgroundColor: C.card }]}
        onPress={() => { onOpen?.(); r.open(); }} {...menuProps((e) => menu(e, items, r.name))}>
        <View style={{ width: 40, height: 40 }}>
          <CollIcon uri={r.image} name={r.name} size={40} radius={8} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.name} numberOfLines={1}>{r.name}</Text>
          <View style={s.sub}>
            <ChainBadge chain={r.chain as Chain} />
            <Text style={s.meta} numberOfLines={1}>{r.sub}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Text style={s.value}>{amt(r.price, r.unit, 4)}</Text>
          {st === 'idle' ? (
            <View style={s.sub}>
              {dollars != null && <Text style={s.small}>{usd(dollars)}</Text>}
              <Pressable onPress={(e) => { e.stopPropagation?.(); setSt('confirm'); }} hitSlop={6} accessibilityRole="button">
                <Text style={s.cancel}>Cancel</Text>
              </Pressable>
            </View>
          ) : st === 'confirm' ? (
            <View style={s.sub}>
              <Pressable onPress={(e) => { e.stopPropagation?.(); void cancel(); }} hitSlop={6} accessibilityRole="button">
                <Text style={[s.cancel, { color: C.down }]}>Yes, cancel</Text>
              </Pressable>
              <Pressable onPress={(e) => { e.stopPropagation?.(); setSt('idle'); }} hitSlop={6} accessibilityRole="button">
                <Text style={s.cancel}>Keep</Text>
              </Pressable>
            </View>
          ) : st === 'working' ? (
            <Text style={s.small}>Sign to cancel…</Text>
          ) : (
            <Text style={s.small}>{dollars != null ? usd(dollars) : ''}</Text>
          )}
        </View>
      </Pressable>
      {st === 'confirm' && <Text style={s.note}>{r.cancelFree ? 'Free: your wallet signs a message, no gas.' : 'Cancels on chain, so it costs a network fee.'}</Text>}
      {typeof st === 'object' && <Text style={[s.note, { color: C.down }]} numberOfLines={3}>{st.error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  seg: { flexDirection: 'row', marginHorizontal: 12, marginBottom: 8, padding: 3, gap: 3, borderRadius: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 6, borderRadius: 7 },
  segOn: { backgroundColor: C.cardHi },
  segTxt: { color: C.dim, fontSize: 13, fontWeight: '600' },
  segCount: { color: C.muted, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  list: { paddingHorizontal: 6, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 7, borderRadius: 8 },
  name: { color: C.text, fontSize: 14, fontWeight: '600' },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { color: C.dim, fontSize: 12, flexShrink: 1 },
  value: { color: C.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  small: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  cancel: { color: C.dim, fontSize: 12, fontWeight: '600' },
  note: { color: C.muted, fontSize: 11, paddingLeft: 62, paddingRight: 12, paddingBottom: 4 },
  empty: { paddingHorizontal: 12, paddingVertical: 12 },
});
