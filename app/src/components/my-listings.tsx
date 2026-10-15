import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { EvmListSheet } from '@/components/evm-list-sheet';
import { NftImage } from '@/components/nft-image';
import { Card, ListRow, RowAction, SectionHeader } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type MyListing } from '@/lib/api';
import { cancelEvmListing, daysLeft } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { sol, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// Everything this wallet has listed on OpenSea (EVM), with Change price and
// Cancel (free on OpenSea's signed zone). Refreshes every minute and after a
// list / cancel anywhere on the page.

type RowState = { kind: 'confirm' } | { kind: 'cancelling' } | { kind: 'error'; message: string };

export function MyListings({ address, onChanged }: { address: string; onChanged?: () => void }) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [data, setData] = useState<{ address: string; listings: MyListing[] } | { address: string; error: string } | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<MyListing | null>(null);

  const load = useCallback(() => {
    api.evmListings(address).then((r) => setData({ address, listings: r.listings }))
      .catch((e) => setData((d) => (d?.address === address && 'listings' in d ? d : { address, error: (e as Error).message })));
  }, [address]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    // Listed or cancelled anywhere on the page: OpenSea takes a few seconds to show it.
    const onListing = () => { setTimeout(load, 4_000); setTimeout(load, 15_000); };
    window.addEventListener?.('floorfeed:listing', onListing);
    return () => { clearInterval(t); window.removeEventListener?.('floorfeed:listing', onListing); };
  }, [load]);

  const current = data?.address === address ? data : null;
  const listings = current && 'listings' in current ? current.listings.filter((l) => !gone.has(l.orderHash)) : [];
  const setRow = (hash: string, st: RowState | null) => setRows((r) => {
    const next = { ...r };
    if (st) next[hash] = st; else delete next[hash];
    return next;
  });

  const cancel = async (l: MyListing) => {
    setRow(l.orderHash, { kind: 'cancelling' });
    try {
      await cancelEvmListing(w, l);
      track('list_cancel', { chain: l.chain, from: 'listings' });
      setGone((g) => new Set(g).add(l.orderHash));
      setRow(l.orderHash, null);
      onChanged?.();
      setTimeout(load, 4_000);
    } catch (e) {
      const m = (e as Error).message;
      setRow(l.orderHash, { kind: 'error', message: /reject|denied|cancel/i.test(m) && !/didn't cancel|can't cancel/i.test(m) ? 'You cancelled in your wallet. The listing is still up.' : m });
    }
  };

  return (
    <View style={{ gap: 8 }}>
      {editing?.symbol && (
        <EvmListSheet symbol={editing.symbol} id={editing.mint} open onClose={() => setEditing(null)}
          onDone={() => { setTimeout(load, 3_000); onChanged?.(); }} />
      )}
      <SectionHeader title="Your listings" count={listings.length || undefined} />
      {!current ? (
        <Card><Text style={T.meta}>Loading your listings…</Text></Card>
      ) : 'error' in current ? (
        <Card><Text style={T.meta}>Couldn&apos;t load your listings: {current.error}</Text></Card>
      ) : !listings.length ? (
        <Card><Text style={T.meta}>Nothing listed for sale. Tap List on any NFT below to set your price on OpenSea.</Text></Card>
      ) : listings.map((l) => {
        const st = rows[l.orderHash];
        const dollars = toUsd(l.price, l.unit);
        const vsFloor = l.floor ? l.price / l.floor - 1 : null;
        const meta = [l.collection, chainName(l.chain), daysLeft(l.expiresAt),
          vsFloor != null ? (Math.abs(vsFloor) < 0.005 ? 'at floor' : `${Math.abs(vsFloor * 100).toFixed(0)}% ${vsFloor > 0 ? 'above' : 'below'} floor`) : null,
        ].filter(Boolean).join(' · ');
        return (
          <View key={l.orderHash}>
            <ListRow
              onPress={() => (l.symbol
                ? router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: l.symbol, id: l.mint } })
                : Linking.openURL(l.url))}
              art={<NftImage uri={l.image} name={l.name} radius={10} px={120} style={{ width: 44 }} />}
              title={l.name}
              meta={meta}
              value={sol(l.price, 4, l.unit)}
              note={dollars != null ? `≈ ${usd(dollars)}` : undefined}
              action={st?.kind === 'cancelling' ? (
                <Text style={T.meta}>Cancelling…</Text>
              ) : st?.kind === 'confirm' ? (
                <View style={s.actions}>
                  <Pressable accessibilityRole="button" onPress={() => cancel(l)} hitSlop={6} style={s.danger}>
                    <Text style={[T.label, { color: C.down }]}>Yes, cancel</Text>
                  </Pressable>
                  <RowAction label="Keep" onPress={() => setRow(l.orderHash, null)} />
                </View>
              ) : (
                <View style={s.actions}>
                  {l.symbol && <RowAction label="Change" onPress={() => setEditing(l)} />}
                  <RowAction label="Cancel" onPress={() => setRow(l.orderHash, { kind: 'confirm' })} />
                </View>
              )}
            />
            {st?.kind === 'confirm' && (
              <Text style={[T.caption, s.note]}>
                {l.cancelFree ? 'Free: your wallet signs a message, no gas.' : 'This older listing cancels on chain, so it costs a network fee.'}
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
