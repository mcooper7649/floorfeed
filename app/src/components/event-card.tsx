import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { BuySheet } from '@/components/buy-sheet';
import { CollIcon } from '@/components/coll-icon';
import { MODE_COLOR } from '@/components/mode-toggle';
import { NftImage, Pill } from '@/components/nft-image';
import { C } from '@/constants/brand';
import {
  api, type BuyEvent, type ClusterEvent, type FeedEvent, type FlipEvent, type SweepEvent, type Take, type Tier, type Trader,
} from '@/lib/api';
import { holdTime, pct, shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { thumb } from '@/lib/img';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';

// One card per feed event. `tile` is the desktop grid card: artwork on top,
// details below; otherwise a compact list card for phones.
export function EventCard({ e, tile }: { e: FeedEvent; tile?: boolean }) {
  switch (e.kind) {
    case 'buy': return <BuyCard e={e} tile={tile} />;
    case 'flip': return <FlipCard e={e} tile={tile} />;
    case 'sweep': return <SweepCard e={e} tile={tile} />;
    case 'cluster': return <ClusterCard e={e} tile={tile} />;
  }
}

const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

// --- trader identity --------------------------------------------------------

export const traderName = (t: Trader) => t.name ?? shortAddr(t.wallet);

// Fallback avatar color from the address, so a wallet looks the same everywhere.
const hue = (w: string) => [...w].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

export function Avatar({ t, size = 36, ring }: { t: Trader; size?: number; ring?: boolean }) {
  return (
    <View style={[s.avatar, {
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: `hsl(${hue(t.wallet)}, 45%, 32%)`,
    }, ring && { borderWidth: 2, borderColor: C.card }]}>
      <Text style={[s.avatarTxt, { fontSize: size * 0.36 }]}>{(t.name ?? t.wallet).slice(0, 2).toUpperCase()}</Text>
      {t.avatar ? <Image source={thumb(t.avatar, size * 2)} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
    </View>
  );
}

const TIER: Record<Exclude<Tier, null>, { label: string; color: string }> = {
  elite: { label: 'TOP FLIPPER', color: C.accent },
  pro: { label: 'PROVEN', color: C.up },
  mm: { label: 'MARKET MAKER', color: C.dim },
  new: { label: 'NEW', color: C.dim },
};

export function TierBadge({ tier }: { tier: Tier }) {
  if (!tier) return null;
  const t = TIER[tier];
  return (
    <View style={[s.badge, { borderColor: t.color + '55' }]}>
      <Text style={[s.badgeTxt, { color: t.color }]}>{t.label}</Text>
    </View>
  );
}

function statLine(t: Trader) {
  if (!t.flips) return 'no tracked flips yet';
  return `${Math.round((t.winRate ?? 0) * 100)}% win · ${t.flips} flip${t.flips === 1 ? '' : 's'}`;
}

function TraderRow({ t }: { t: Trader }) {
  const { following, toggleFollow } = useSession();
  const on = following.has(t.wallet);
  return (
    <View style={s.row}>
      <Link href={{ pathname: '/wallet/[address]', params: { address: t.wallet } }} asChild>
        <Pressable style={s.who}>
          <Avatar t={t} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={s.nameRow}>
              <Text style={s.name} numberOfLines={1}>{traderName(t)}</Text>
              <TierBadge tier={t.tier} />
            </View>
            <Text style={s.meta} numberOfLines={1}>
              {statLine(t)}
              {t.flips > 0 && <Text style={{ color: t.realizedSol >= 0 ? C.up : C.down }}> · {signedSol(t.realizedSol, Math.abs(t.realizedSol) >= 10 ? 0 : 1)}</Text>}
            </Text>
          </View>
        </Pressable>
      </Link>
      <Pressable onPress={() => toggleFollow(t.wallet)} style={on ? s.following : s.follow}>
        <Text style={[s.followTxt, on && { color: C.dim }]}>{on ? 'Following' : 'Follow'}</Text>
      </Pressable>
    </View>
  );
}

// --- shared pieces ---------------------------------------------------------

function Kicker({ text, color }: { text: string; color: string }) {
  return <Text style={[s.kicker, { color }]}>{text}</Text>;
}

// Copy = buy the collection's floor (paper or real, per the wallet mode).
function CopyCta({ symbol, floor, copiedFrom }: { symbol: string; floor: number | null; copiedFrom?: string }) {
  const { userId, bumpPortfolio } = useSession();
  const { mode } = useTradeMode();
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  const [open, setOpen] = useState(false);
  const paperBuy = async () => {
    if (!userId || state === 'busy') return;
    tap();
    setState('busy');
    try {
      const r = await api.buyFloor(userId, symbol, copiedFrom);
      setState(`Bought floor @ ${sol(r.entryPrice)}`);
      bumpPortfolio();
    } catch (err) {
      setState((err as Error).message);
    }
  };
  const f = floor ? ` · ${sol(floor)}` : '';
  return (
    <>
      <Pressable onPress={() => (mode === 'real' ? (tap(), setOpen(true)) : paperBuy())}
        style={({ pressed }) => [s.cta, { backgroundColor: MODE_COLOR[mode] }, pressed && { opacity: 0.8 }]}>
        <Text style={s.ctaTxt}>
          {mode === 'real' ? `Copy · buy floor${f}`
            : state === 'idle' ? `Copy · paper buy floor${f}`
            : state === 'busy' ? 'Buying…' : state}
        </Text>
      </Pressable>
      <BuySheet symbol={symbol} open={open} onClose={() => setOpen(false)} onPaper={paperBuy} />
    </>
  );
}

const collHref = (symbol: string) => ({ pathname: '/collection/[symbol]' as const, params: { symbol } });

// Up to four distinct artworks, never leaving an empty cell.
// Tiles: a square (1 full · 2 halves · 3 = one large + two stacked · 4 = 2×2).
// List cards: a full-width banner split evenly between the images.
function Mosaic({ images, name, tile, badge }: { images: string[]; name: string; tile?: boolean; badge?: ReactNode }) {
  const imgs: (string | null)[] = images.length ? images.slice(-4) : [null];
  const art = (u: string | null, px = 256) => <NftImage uri={u} name={name} ratio={null} px={px} />;
  if (!tile) {
    return (
      <View style={s.banner}>
        {imgs.map((u, i) => <View key={i} style={s.bannerCell}>{art(u, imgs.length === 1 ? 512 : 256)}</View>)}
      </View>
    );
  }
  const n = imgs.length;
  return (
    <View style={s.mosaic}>
      {n === 1 && <View style={s.cellFull}>{art(imgs[0], 512)}</View>}
      {n === 2 && imgs.map((u, i) => <View key={i} style={s.cellHalf}>{art(u, 384)}</View>)}
      {n === 3 && (
        <>
          <View style={s.cellHalf}>{art(imgs[0], 384)}</View>
          <View style={s.cellHalf}>
            <View style={s.cellStack}>{art(imgs[1])}</View>
            <View style={s.cellStack}>{art(imgs[2])}</View>
          </View>
        </>
      )}
      {n === 4 && imgs.map((u, i) => <View key={i} style={s.cellQuarter}>{art(u)}</View>)}
      {badge}
    </View>
  );
}

function Card({ children, tile, accent }: { children: ReactNode; tile?: boolean; accent?: string }) {
  return <View style={[s.card, tile && s.tile, accent ? { borderColor: accent } : null]}>{children}</View>;
}

// --- buy ---------------------------------------------------------------------

function BuyCard({ e, tile }: { e: BuyEvent; tile?: boolean }) {
  const [take, setTake] = useState<Take | null>(e.take);
  const [takeState, setTakeState] = useState<'idle' | 'loading' | 'none'>(e.take ? 'idle' : 'loading');
  // AI takes are generated lazily server-side and cached per trade.
  useEffect(() => {
    if (e.take) return;
    let alive = true;
    api.take(e.signature)
      .then((t) => alive && (setTake(t), setTakeState(t ? 'idle' : 'none')))
      .catch(() => alive && setTakeState('none'));
    return () => { alive = false; };
  }, [e.signature, e.take]);

  const below = e.vsFloorPct != null && e.vsFloorPct <= 0;
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

  if (tile) {
    return (
      <Card tile>
        <Link href={collHref(e.collection.symbol)} asChild>
          <Pressable>
            <NftImage uri={e.image} name={e.collection.name}>
              {e.vsFloorPct != null && <Pill text={`${pct(e.vsFloorPct)} vs floor`} tone={below ? 'up' : 'dark'} style={{ top: 10, left: 10 }} />}
              <Pill text={`${timeAgo(e.t)} ago`} style={{ top: 10, right: 10 }} />
            </NftImage>
          </Pressable>
        </Link>
        <View style={s.tileBody}>
          <TraderRow t={e.wallet} />
          <View style={{ gap: 2 }}>
            <Text style={s.verb}>bought <Text style={s.coll}>{e.collection.name}</Text></Text>
            <Text style={s.big}>{sol(e.price, 3)}</Text>
          </View>
          {aiTake}
          <View style={{ flex: 1 }} />
          <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} copiedFrom={e.signature} />
        </View>
      </Card>
    );
  }
  return (
    <Card>
      <TraderRow t={e.wallet} />
      <Link href={collHref(e.collection.symbol)} asChild>
        <Pressable style={s.trade}>
          <CollIcon name={e.collection.name} uri={e.image} size={96} radius={14} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.verb}>bought <Text style={s.coll}>{e.collection.name}</Text></Text>
            <Text style={s.big}>{sol(e.price, 3)}</Text>
            <Text style={s.meta}>
              {e.vsFloorPct != null && <Text style={{ color: below ? C.up : C.dim }}>{pct(e.vsFloorPct)} vs floor · </Text>}
              {timeAgo(e.t)} ago
            </Text>
          </View>
          <Text style={s.chev}>›</Text>
        </Pressable>
      </Link>
      {aiTake}
      <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} copiedFrom={e.signature} />
    </Card>
  );
}

// --- flip (realized P&L) --------------------------------------------------

function FlipCard({ e, tile }: { e: FlipEvent; tile?: boolean }) {
  const win = e.pnl >= 0;
  const color = win ? C.up : C.down;
  const detail = (
    <>
      <Text style={s.verb}>{win ? 'flipped' : 'sold at a loss'} <Text style={s.coll}>{e.collection.name}</Text></Text>
      <Text style={[s.big, { color }]}>{signedSol(e.pnl, 2)}</Text>
      <Text style={s.meta}>
        <Text style={{ color }}>{pct(e.pnlPct)}</Text> · {e.buy.toFixed(2)} → {e.sell.toFixed(2)} SOL · held {holdTime(e.holdHours)}
      </Text>
    </>
  );
  const soldTo = (
    <Text style={s.meta} numberOfLines={1}>sold to {traderName(e.buyer)}{e.buyer.tier === 'elite' ? ' (top flipper)' : ''} · {timeAgo(e.t)} ago</Text>
  );
  const see = (
    <Link href={collHref(e.collection.symbol)} asChild>
      <Pressable style={s.ghost}><Text style={s.ghostTxt}>See {e.collection.name} ›</Text></Pressable>
    </Link>
  );
  if (tile) {
    return (
      <Card tile>
        <Link href={collHref(e.collection.symbol)} asChild>
          <Pressable>
            <NftImage uri={e.image} name={e.collection.name}>
              <Pill text={`${win ? 'WIN' : 'LOSS'} ${pct(e.pnlPct)}`} tone={win ? 'up' : 'down'} style={{ top: 10, left: 10 }} />
              <Pill text={`${timeAgo(e.t)} ago`} style={{ top: 10, right: 10 }} />
            </NftImage>
          </Pressable>
        </Link>
        <View style={s.tileBody}>
          <TraderRow t={e.wallet} />
          <View style={{ gap: 2 }}>{detail}</View>
          {soldTo}
          <View style={{ flex: 1 }} />
          {see}
        </View>
      </Card>
    );
  }
  return (
    <Card>
      <Kicker text={win ? 'WIN' : 'LOSS'} color={color} />
      <TraderRow t={e.wallet} />
      <View style={s.trade}>
        <CollIcon name={e.collection.name} uri={e.image} size={96} radius={14} />
        <View style={{ flex: 1, gap: 2 }}>{detail}</View>
      </View>
      {soldTo}
      {see}
    </Card>
  );
}

// --- sweep -------------------------------------------------------------------

function SweepCard({ e, tile }: { e: SweepEvent; tile?: boolean }) {
  const below = e.vsFloorPct != null && e.vsFloorPct <= 0;
  const detail = (
    <View style={{ gap: 2 }}>
      <Text style={s.verb}>swept <Text style={s.coll}>{e.count} × {e.collection.name}</Text></Text>
      <Text style={s.big}>{sol(e.total, 2)}</Text>
      <Text style={s.meta}>
        avg {e.avg.toFixed(2)} SOL
        {e.vsFloorPct != null && <Text style={{ color: below ? C.up : C.dim }}> · {pct(e.vsFloorPct)} vs floor</Text>}
        {' '}· {timeAgo(e.t)} ago
      </Text>
    </View>
  );
  const art = (
    <Link href={collHref(e.collection.symbol)} asChild>
      <Pressable>
        <Mosaic images={e.images} name={e.collection.name} tile={tile}
          badge={tile ? <Pill text={`SWEEP ×${e.count}`} style={{ top: 10, left: 10 }} /> : undefined} />
      </Pressable>
    </Link>
  );
  if (tile) {
    return (
      <Card tile>
        {art}
        <View style={s.tileBody}>
          <TraderRow t={e.wallet} />
          {detail}
          <View style={{ flex: 1 }} />
          <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} />
        </View>
      </Card>
    );
  }
  return (
    <Card>
      <Kicker text={`SWEEP ×${e.count}`} color={C.accent} />
      <TraderRow t={e.wallet} />
      {detail}
      {art}
      <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} />
    </Card>
  );
}

// --- cluster (several wallets, one collection) -------------------------------

function ClusterCard({ e, tile }: { e: ClusterEvent; tile?: boolean }) {
  const top = e.wallets.filter((w) => w.tier === 'elite' || w.tier === 'pro').length;
  const hours = Math.max(1, Math.round((e.t - e.since) / 3600));
  const below = e.vsFloorPct != null && e.vsFloorPct <= 0;
  const named = e.wallets.slice(0, 2).map(traderName).join(', ');
  const more = e.count - Math.min(2, e.wallets.length);
  const body = (
    <View style={{ gap: 10 }}>
      <Link href={collHref(e.collection.symbol)} asChild>
        <Pressable style={{ gap: 4 }}>
          <Text style={s.headline}>
            {e.count} wallets bought <Text style={{ color: C.accent }}>{e.collection.name}</Text> in {hours}h
          </Text>
          {top > 0 && <Text style={s.meta}>including {top} {top === 1 ? 'proven flipper' : 'proven flippers'}</Text>}
        </Pressable>
      </Link>
      <View style={s.row}>
        <View style={s.stack}>
          {e.wallets.slice(0, 5).map((w, i) => (
            <View key={w.wallet} style={{ marginLeft: i ? -10 : 0, zIndex: 10 - i }}><Avatar t={w} size={30} ring /></View>
          ))}
        </View>
        <Text style={[s.meta, { flex: 1, marginLeft: 8 }]} numberOfLines={1}>
          {named}{more > 0 ? ` +${more}` : ''}
        </Text>
      </View>
      <Text style={s.meta}>
        {e.buys} buys · avg {e.avg.toFixed(2)} SOL
        {e.vsFloorPct != null && <Text style={{ color: below ? C.up : C.dim }}> · {pct(e.vsFloorPct)} vs floor</Text>}
        {' '}· {timeAgo(e.t)} ago
      </Text>
    </View>
  );
  const art = (
    <Link href={collHref(e.collection.symbol)} asChild>
      <Pressable>
        <Mosaic images={e.images} name={e.collection.name} tile={tile}
          badge={tile ? <Pill text="CLUSTER" style={{ top: 10, left: 10 }} /> : undefined} />
      </Pressable>
    </Link>
  );
  if (tile) {
    return (
      <Card tile accent={C.accent + '66'}>
        {art}
        <View style={s.tileBody}>
          {body}
          <View style={{ flex: 1 }} />
          <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} />
        </View>
      </Card>
    );
  }
  return (
    <Card accent={C.accent + '66'}>
      <Kicker text="CLUSTER" color={C.accent} />
      {body}
      {art}
      <CopyCta symbol={e.collection.symbol} floor={e.collection.floor} />
    </Card>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 18, padding: 14, gap: 12, borderWidth: 1, borderColor: C.border },
  tile: { flex: 1, padding: 0, gap: 0, overflow: 'hidden' },
  tileBody: { flex: 1, padding: 14, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { color: C.text, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarTxt: { color: C.text, fontWeight: '800' },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  badgeTxt: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
  meta: { color: C.dim, fontSize: 12.5 },
  follow: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: C.text },
  following: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  followTxt: { color: C.bg, fontWeight: '700', fontSize: 13 },
  trade: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  verb: { color: C.dim, fontSize: 13 },
  chev: { color: C.dim, fontSize: 26, fontWeight: '300', paddingHorizontal: 4 },
  coll: { color: C.text, fontWeight: '600' },
  big: { color: C.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  headline: { color: C.text, fontSize: 18, fontWeight: '800', lineHeight: 23 },
  kicker: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginBottom: -4 },
  take: { backgroundColor: '#A78BFA14', borderRadius: 12, padding: 10, gap: 4, borderLeftWidth: 3, borderLeftColor: C.ai },
  takeLabel: { color: C.ai, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  takeTxt: { color: C.text, fontSize: 13.5, lineHeight: 19 },
  cta: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  ctaTxt: { color: C.accentInk, fontWeight: '800', fontSize: 14.5 },
  ghost: { borderRadius: 12, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  ghostTxt: { color: C.text, fontWeight: '700', fontSize: 14 },
  mosaic: { width: '100%', aspectRatio: 1, flexDirection: 'row', flexWrap: 'wrap' },
  cellFull: { width: '100%', height: '100%' },
  cellHalf: { width: '50%', height: '100%' },
  cellQuarter: { width: '50%', height: '50%' },
  cellStack: { width: '100%', height: '50%' },
  banner: { flexDirection: 'row', height: 132, gap: 4, borderRadius: 14, overflow: 'hidden' },
  bannerCell: { flex: 1, height: '100%' },
  stack: { flexDirection: 'row' },
});
