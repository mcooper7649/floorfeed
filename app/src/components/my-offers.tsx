import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { EvmOfferSheet } from '@/components/evm-offer-sheet';
import { NftImage } from '@/components/nft-image';
import { useQuickMenu, type MenuItem } from '@/components/quick-menu';
import { Card, ListRow, RowAction, SectionHeader } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type MyOffer } from '@/lib/api';
import { cancelEvmListing, daysLeft } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { sol, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// Every live OpenSea offer this wallet has made (EVM), on single NFTs and
// whole collections, with Cancel (free on OpenSea's signed zone). Hidden when
// there are none. Refreshes every minute and after an offer anywhere on the page.

type RowState = { kind: 'confirm' } | { kind: 'cancelling' } | { kind: 'error'; message: string };

export function MyOffers({ address }: { address: string }) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [data, setData] = useState<{ address: string; offers: MyOffer[] } | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<MyOffer | null>(null);
  const quick = useQuickMenu();

  const load = useCallback(() => {
    api.evmOffers(address).then((r) => setData({ address, offers: r.offers })).catch(() => {});
  }, [address]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const onOffer = () => { setTimeout(load, 4_000); setTimeout(load, 15_000); };
    window.addEventListener?.('floorfeed:offer', onOffer);
    return () => { clearInterval(t); window.removeEventListener?.('floorfeed:offer', onOffer); };
  }, [load]);

  const offers = data?.address === address ? data.offers.filter((o) => !gone.has(o.orderHash)) : [];
  const setRow = (hash: string, st: RowState | null) => setRows((r) => {
    const next = { ...r };
    if (st) next[hash] = st; else delete next[hash];
    return next;
  });

  const cancel = async (o: MyOffer) => {
    setRow(o.orderHash, { kind: 'cancelling' });
    try {
      await cancelEvmListing(w, { chain: o.chain, orderHash: o.orderHash, name: o.name });
      track('offer_cancel', { chain: o.chain, from: 'offers' });
      setGone((g) => new Set(g).add(o.orderHash));
      setRow(o.orderHash, null);
      setTimeout(load, 4_000);
    } catch (e) {
      const m = (e as Error).message;
      if (/isn't live anymore/i.test(m)) { setGone((g) => new Set(g).add(o.orderHash)); setRow(o.orderHash, null); return; }
      setRow(o.orderHash, { kind: 'error', message: /reject|denied|cancel/i.test(m) && !/didn't cancel|can't cancel/i.test(m) ? 'You cancelled in your wallet. The offer is still up.' : m });
    }
  };

  if (!offers.length) return null;
  return (
    <View style={{ gap: 8 }}>
      {quick.node}
      {editing?.symbol && (
        <EvmOfferSheet symbol={editing.symbol} id={editing.mint} open onClose={() => { setEditing(null); setTimeout(load, 4_000); }}
          replacing={{ orderHash: editing.orderHash, chain: editing.chain, price: editing.price }} />
      )}
      <SectionHeader title="Your offers" count={offers.length} />
      <Card><Text style={T.meta}>Nothing leaves your wallet until someone accepts. Cancelling is free.</Text></Card>
      {offers.map((o) => {
        const st = rows[o.orderHash];
        const dollars = toUsd(o.price, o.unit);
        const vsFloor = o.floor ? o.price / o.floor - 1 : null;
        const meta = [
          o.kind === 'item' ? o.collection : o.kind === 'trait' ? 'Trait offer' : `Collection offer${o.quantity > 1 ? ` × ${o.quantity}` : ''}`,
          chainName(o.chain), daysLeft(o.expiresAt),
          vsFloor != null ? `${Math.abs(vsFloor * 100).toFixed(0)}% ${vsFloor >= 0 ? 'above' : 'below'} floor` : null,
        ].filter(Boolean).join(' · ');
        const view = () => (o.symbol && o.mint
          ? router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: o.symbol, id: o.mint } })
          : o.symbol ? router.push({ pathname: '/collection/[symbol]', params: { symbol: o.symbol } })
          : Linking.openURL(o.url));
        // Edit needs a collection FloorFeed tracks (the offer sheet prices against it); not for trait offers.
        const items: MenuItem[] = [
          ...(o.symbol && o.kind !== 'trait' ? [{ label: 'Edit offer', onPress: () => setEditing(o) }] : []),
          { label: 'Cancel offer', danger: true, onPress: () => { void cancel(o); } },
          'sep', { label: o.mint ? 'View NFT' : 'View collection', onPress: () => { void view(); } },
        ];
        return (
          <View key={o.orderHash}>
            <ListRow
              onPress={() => { void view(); }}
              onMenu={(e) => quick.open(e as never, items, o.name)}
              art={<NftImage uri={o.image} name={o.name} radius={10} px={120} style={{ width: 44 }} />}
              title={o.name}
              meta={meta}
              value={sol(o.price, 4, o.unit)}
              note={dollars != null ? `≈ ${usd(dollars)}` : undefined}
              action={st?.kind === 'cancelling' ? (
                <Text style={T.meta}>Cancelling…</Text>
              ) : st?.kind === 'confirm' ? (
                <View style={s.actions}>
                  <Pressable accessibilityRole="button" onPress={() => cancel(o)} hitSlop={6} style={s.danger}>
                    <Text style={[T.label, { color: C.down }]}>Yes, cancel</Text>
                  </Pressable>
                  <RowAction label="Keep" onPress={() => setRow(o.orderHash, null)} />
                </View>
              ) : (
                <View style={s.actions}>
                  {o.symbol && o.kind !== 'trait' && <RowAction label="Edit" onPress={() => setEditing(o)} />}
                  <RowAction label="Cancel" onPress={() => setRow(o.orderHash, { kind: 'confirm' })} />
                </View>
              )}
            />
            {st?.kind === 'confirm' && (
              <Text style={[T.caption, s.note]}>
                {o.cancelFree ? 'Free: your wallet signs a message, no gas.' : 'This offer cancels on chain, so it costs a network fee.'}
              </Text>
            )}
            {st?.kind === 'error' && <Text style={[T.caption, s.note, { color: C.down }]}>{st.message}</Text>}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  danger: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.down },
  note: { paddingLeft: 56, paddingTop: 2 },
});
