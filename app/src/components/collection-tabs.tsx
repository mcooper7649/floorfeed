import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar, TierBadge } from '@/components/event-card';
import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type CollectionHolder, type CollectionSale, type WalletRef } from '@/lib/api';
import { holdTime, shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';

// Holders and Sales tables on the collection page (FOMO's Holders / Swaps).

export type TabFilter = { proven: boolean; following: boolean };
const isProven = (w: WalletRef) => w.tier === 'elite' || w.tier === 'pro';
const toWallet = (address: string) => router.push({ pathname: '/wallet/[address]', params: { address } });

function Who({ w, sub }: { w: WalletRef; sub?: string }) {
  return (
    <Pressable onPress={() => toWallet(w.wallet)} style={s.who}>
      <Avatar t={w} size={30} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.nameLine}>
          <Text style={s.name} numberOfLines={1}>{w.name ?? shortAddr(w.wallet)}</Text>
          {w.tier === 'elite' || w.tier === 'pro' || w.tier === 'mm' ? <TierBadge tier={w.tier} /> : null}
        </View>
        {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const Loading = () => <ActivityIndicator style={{ marginVertical: 24 }} color={C.accent} />;
const None = ({ text }: { text: string }) => <Text style={s.none}>{text}</Text>;

// --- Holders ---------------------------------------------------------------------

export function HoldersTab({ symbol, currency, filter, onCount }: {
  symbol: string; currency: string; filter: TabFilter; onCount?: (n: number) => void;
}) {
  const { wide } = useLayout();
  const { following } = useSession();
  const [rows, setRows] = useState<{ key: string; list: CollectionHolder[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api.collectionHolders(symbol).then((list) => { if (alive) { setRows({ key: symbol, list }); onCount?.(list.length); } })
      .catch(() => alive && setRows({ key: symbol, list: [] }));
    return () => { alive = false; };
  }, [symbol, onCount]);
  const list = useMemo(() => (rows?.key === symbol ? rows.list : null)?.filter((h) =>
    (!filter.proven || isProven(h)) && (!filter.following || following.has(h.wallet))), [rows, symbol, filter, following]);

  if (!list) return <Loading />;
  if (!list.length) return <None text={filter.following ? "None of the wallets you follow hold this collection." : filter.proven ? 'No proven wallets hold this collection right now.' : 'No holders tracked yet.'} />;
  return (
    <View>
      {wide && (
        <View style={[s.row, s.headRow]}>
          <Text style={[s.head, { flex: 2.2 }]}>Trader</Text>
          <Text style={[s.head, s.num]}>Holding</Text>
          <Text style={[s.head, s.num]}>P&L after fees</Text>
          <Text style={[s.head, s.num]}>Avg. entry</Text>
        </View>
      )}
      {list.slice(0, 100).map((h) => {
        const pnl = (
          <View style={wide ? s.num : s.numNarrow}>
            <Text style={[s.val, { color: h.pnl == null ? C.dim : h.pnl >= 0 ? C.up : C.down }]}>{h.pnl == null ? '—' : signedSol(h.pnl, 2, currency)}</Text>
            {h.pnlPct != null && <Text style={[s.sub, { color: h.pnlPct >= 0 ? C.up : C.down, textAlign: 'right' }]}>{h.pnlPct >= 0 ? '▲' : '▼'} {Math.abs(h.pnlPct).toFixed(1)}%</Text>}
          </View>
        );
        return wide ? (
          <View key={h.wallet} style={s.row}>
            <View style={{ flex: 2.2 }}><Who w={h} sub={`${holdTime(h.avgHoldHours)} avg. hold`} /></View>
            <View style={s.num}>
              <Text style={s.val}>{h.value != null ? sol(h.value, 2, currency) : '—'}</Text>
              <Text style={[s.sub, { textAlign: 'right' }]}>{h.items} NFT{h.items === 1 ? '' : 's'}</Text>
            </View>
            {pnl}
            <View style={s.num}><Text style={s.val}>{sol(h.avgEntry, 3, currency)}</Text></View>
          </View>
        ) : (
          <View key={h.wallet} style={s.row}>
            <View style={{ flex: 1 }}><Who w={h} sub={`${h.items} NFT${h.items === 1 ? '' : 's'} · avg ${sol(h.avgEntry, 2, currency)} · ${holdTime(h.avgHoldHours)}`} /></View>
            {pnl}
          </View>
        );
      })}
      <Text style={s.foot}>Wallets we have seen buy and that still hold, valued at the floor after selling fees.</Text>
    </View>
  );
}

// --- Sales -----------------------------------------------------------------------

export function SalesTab({ symbol, currency, filter }: { symbol: string; currency: string; filter: TabFilter }) {
  const { wide } = useLayout();
  const { following } = useSession();
  const [rows, setRows] = useState<{ key: string; list: CollectionSale[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api.collectionSales(symbol).then((list) => alive && setRows({ key: symbol, list })).catch(() => alive && setRows({ key: symbol, list: [] }));
    return () => { alive = false; };
  }, [symbol]);
  const list = useMemo(() => (rows?.key === symbol ? rows.list : null)?.filter((r) =>
    (!filter.proven || isProven(r.buyer) || isProven(r.seller))
    && (!filter.following || following.has(r.buyer.wallet) || following.has(r.seller.wallet))), [rows, symbol, filter, following]);

  if (!list) return <Loading />;
  if (!list.length) return <None text="No sales match." />;
  return (
    <View>
      {wide && (
        <View style={[s.row, s.headRow]}>
          <Text style={[s.head, { width: 44 }]} />
          <Text style={[s.head, { flex: 1.6 }]}>Buyer</Text>
          <Text style={[s.head, { flex: 1.6 }]}>Seller</Text>
          <Text style={[s.head, s.num]}>Price</Text>
          <Text style={[s.head, s.num]}>vs floor</Text>
          <Text style={[s.head, { width: 56, textAlign: 'right' }]}>Time</Text>
        </View>
      )}
      {list.map((r) => {
        const art = (
          <Pressable onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol, id: r.mint } })} style={s.art}>
            <NftImage uri={r.image} name={symbol} radius={8} px={80} />
          </Pressable>
        );
        const vs = r.vsFloorPct == null ? '—' : `${r.vsFloorPct >= 0 ? '+' : '−'}${Math.abs(r.vsFloorPct).toFixed(1)}%`;
        return wide ? (
          <View key={r.signature} style={s.row}>
            {art}
            <View style={{ flex: 1.6 }}><Who w={r.buyer} /></View>
            <View style={{ flex: 1.6 }}><Who w={r.seller} /></View>
            <View style={s.num}>
              <Text style={s.val}>{sol(r.price, 3, currency)}</Text>
              {r.kind === 'bid' && <Text style={[s.sub, { textAlign: 'right' }]}>sold into bid/pool</Text>}
            </View>
            <View style={s.num}><Text style={[s.val, { color: C.dim }]}>{vs}</Text></View>
            <Text style={[s.sub, { width: 56, textAlign: 'right' }]}>{timeAgo(r.t)}</Text>
          </View>
        ) : (
          <View key={r.signature} style={s.row}>
            {art}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={1}>{r.buyer.name ?? shortAddr(r.buyer.wallet)} <Text style={s.sub}>bought from</Text> {r.seller.name ?? shortAddr(r.seller.wallet)}</Text>
              <Text style={s.sub}>{timeAgo(r.t)} ago · {vs} vs floor{r.kind === 'bid' ? ' · into bid/pool' : ''}</Text>
            </View>
            <Text style={s.val}>{sol(r.price, 3, currency)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  headRow: { paddingVertical: 8 },
  head: { ...T.caption, color: C.dim, fontWeight: '500' },
  num: { flex: 1, alignItems: 'flex-end', textAlign: 'right' },
  numNarrow: { alignItems: 'flex-end' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  name: { color: C.text, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  sub: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  val: { color: C.text, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  art: { width: 44, height: 44 },
  none: { ...T.meta, textAlign: 'center', paddingVertical: 24 },
  foot: { ...T.caption, paddingTop: 10 },
});
