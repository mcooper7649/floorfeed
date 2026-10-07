import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { NftImage, Pill } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { api, type FeedItem, type Take } from '@/lib/api';
import { pct, shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

// `tile` is the desktop grid card: artwork on top, details below.
export function TradeCard({ item, tile }: { item: FeedItem; tile?: boolean }) {
  const { userId, following, toggleFollow, bumpPortfolio } = useSession();
  const [take, setTake] = useState<Take | null>(item.take);
  const [takeState, setTakeState] = useState<'idle' | 'loading' | 'none'>(item.take ? 'idle' : 'loading');
  const [buyState, setBuyState] = useState<'idle' | 'busy' | string>('idle');
  const b = item.buyer;
  const isFollowing = following.has(b.wallet);

  // AI takes are generated lazily server-side and cached per trade.
  useEffect(() => {
    if (item.take) return;
    let alive = true;
    api.take(item.signature)
      .then((t) => alive && (setTake(t), setTakeState(t ? 'idle' : 'none')))
      .catch(() => alive && setTakeState('none'));
    return () => { alive = false; };
  }, [item.signature, item.take]);

  const copy = async () => {
    if (!userId || buyState === 'busy') return;
    tap();
    setBuyState('busy');
    try {
      const r = await api.buyFloor(userId, item.collection.symbol, item.signature);
      setBuyState(`Bought floor @ ${sol(r.entryPrice)}`);
      bumpPortfolio();
    } catch (e) {
      setBuyState((e as Error).message);
    }
  };

  const collHref = { pathname: '/collection/[symbol]' as const, params: { symbol: item.collection.symbol } };
  const below = item.vsFloorPct != null && item.vsFloorPct <= 0;

  const buyer = (
    <View style={s.row}>
      <Link href={{ pathname: '/wallet/[address]', params: { address: b.wallet } }} asChild>
        <Pressable style={s.who}>
          <Text style={s.addr}>{shortAddr(b.wallet)}</Text>
          {b.flips ? (
            <Text style={s.meta}>
              {Math.round((b.winRate ?? 0) * 100)}% win · {b.flips} flip{b.flips === 1 ? '' : 's'} ·{' '}
              <Text style={{ color: b.realizedSol >= 0 ? C.up : C.down }}>{signedSol(b.realizedSol)}</Text>
            </Text>
          ) : (
            <Text style={s.meta}>no tracked flips yet</Text>
          )}
        </Pressable>
      </Link>
      <Pressable onPress={() => toggleFollow(b.wallet)} style={[s.follow, isFollowing && s.following]}>
        <Text style={[s.followTxt, isFollowing && { color: C.dim }]}>{isFollowing ? 'Following' : 'Follow'}</Text>
      </Pressable>
    </View>
  );

  const aiTake = takeState !== 'none' && (
    <View style={s.take}>
      <Text style={s.takeLabel}>AI TAKE</Text>
      {takeState === 'loading' ? (
        <View style={s.row}><ActivityIndicator size="small" color={C.ai} /><Text style={s.meta}>  reading this trade…</Text></View>
      ) : (
        <Text style={s.takeTxt}>{take?.text}</Text>
      )}
    </View>
  );

  const cta = (
    <Pressable onPress={copy} style={({ pressed }) => [s.cta, pressed && { opacity: 0.8 }]}>
      <Text style={s.ctaTxt}>
        {buyState === 'idle' ? `Copy · buy floor ${item.collection.floor ? sol(item.collection.floor) : ''}`
          : buyState === 'busy' ? 'Buying…' : buyState}
      </Text>
    </Pressable>
  );

  if (tile) {
    return (
      <View style={[s.card, s.tile]}>
        <Link href={collHref} asChild>
          <Pressable>
            <NftImage uri={item.image} name={item.collection.name}>
              {item.vsFloorPct != null && (
                <Pill text={`${pct(item.vsFloorPct)} vs floor`} tone={below ? 'up' : 'dark'} style={{ top: 10, left: 10 }} />
              )}
              <Pill text={`${timeAgo(item.blockTime)} ago`} style={{ top: 10, right: 10 }} />
            </NftImage>
          </Pressable>
        </Link>
        <View style={s.tileBody}>
          <Link href={collHref} asChild>
            <Pressable style={{ gap: 2 }}>
              <Text style={s.coll} numberOfLines={1}>{item.collection.name}</Text>
              <Text style={s.price}>{sol(item.price, 3)}</Text>
            </Pressable>
          </Link>
          {buyer}
          {aiTake}
          <View style={{ flex: 1 }} />
          {cta}
        </View>
      </View>
    );
  }

  return (
    <View style={s.card}>
      {buyer}
      <Link href={collHref} asChild>
        <Pressable style={s.trade}>
          <CollIcon name={item.collection.name} uri={item.image} size={96} radius={14} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.bought}>bought <Text style={s.coll}>{item.collection.name}</Text></Text>
            <Text style={s.price}>{sol(item.price, 3)}</Text>
            <Text style={s.meta}>
              {item.vsFloorPct != null && (
                <Text style={{ color: below ? C.up : C.dim }}>{pct(item.vsFloorPct)} vs floor · </Text>
              )}
              {timeAgo(item.blockTime)} ago
            </Text>
          </View>
          <Text style={s.chev}>›</Text>
        </Pressable>
      </Link>
      {aiTake}
      {cta}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 18, padding: 14, gap: 12, borderWidth: 1, borderColor: C.border },
  tile: { flex: 1, padding: 0, gap: 0, overflow: 'hidden' },
  tileBody: { flex: 1, padding: 14, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  who: { flex: 1, gap: 2 },
  addr: { color: C.text, fontWeight: '700', fontSize: 15, fontVariant: ['tabular-nums'] },
  meta: { color: C.dim, fontSize: 12.5 },
  follow: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: C.text },
  following: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
  followTxt: { color: C.bg, fontWeight: '700', fontSize: 13 },
  trade: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  bought: { color: C.dim, fontSize: 13 },
  chev: { color: C.dim, fontSize: 26, fontWeight: '300', paddingHorizontal: 4 },
  coll: { color: C.text, fontWeight: '600' },
  price: { color: C.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  take: { backgroundColor: '#A78BFA14', borderRadius: 12, padding: 10, gap: 4, borderLeftWidth: 3, borderLeftColor: C.ai },
  takeLabel: { color: C.ai, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  takeTxt: { color: C.text, fontSize: 13.5, lineHeight: 19 },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  ctaTxt: { color: C.accentInk, fontWeight: '800', fontSize: 14.5 },
});
