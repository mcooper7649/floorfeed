import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar, TierBadge } from '@/components/event-card';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type AiTake, type TakeItem, type UserTake } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { shortAddr, sol, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';

// The collection page's Takes tab (FOMO's "Thesis"): short posts by signed-in
// users. Signing with a connected wallet adds a holder badge when that wallet
// owns NFTs from the collection. FloorFeed's AI takes on notable buys appear
// in the same list, labelled.

const MAX = 280;

export function TakesTab({ symbol, name, currency, chain, onCount }: {
  symbol: string; name: string; currency: string; chain: string; onCount?: (n: number) => void;
}) {
  const { userId } = useSession();
  const [items, setItems] = useState<{ key: string; list: TakeItem[] } | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    api.takes(symbol, userId).then((list) => {
      if (!alive) return;
      setItems({ key: symbol, list });
      onCount?.(list.filter((t) => t.kind === 'user').length);
    }).catch(() => alive && setItems({ key: symbol, list: [] }));
    return () => { alive = false; };
  }, [symbol, userId, version, onCount]);
  const list = items?.key === symbol ? items.list : null;

  return (
    <View style={{ gap: 6 }}>
      <Composer symbol={symbol} name={name} chain={chain} onPosted={reload} />
      {!list ? <ActivityIndicator style={{ marginVertical: 24 }} color={C.accent} />
        : !list.length ? <Text style={s.none}>No takes on {name} yet. Be the first.</Text>
        : list.map((t) => t.kind === 'user'
          ? <UserTakeRow key={`u${t.id}`} t={t} currency={currency} onChange={reload} />
          : <AiTakeRow key={`a${t.id}`} t={t} symbol={symbol} currency={currency} />)}
    </View>
  );
}

// --- composer ----------------------------------------------------------------------

function Composer({ symbol, name, chain, onPosted }: { symbol: string; name: string; chain: string; onPosted: () => void }) {
  const auth = useAuth();
  const { signedIn } = useSession();
  const sw = useWallet();
  const ew = useEvmWallet();
  const evm = chain !== 'solana';
  const wallet = evm ? ew : sw;
  const canSign = !!wallet.signMessage && !!wallet.address;
  const [text, setText] = useState('');
  const [sign, setSign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <View style={s.composer}>
        <Text style={T.meta}>What do you think {name} does next? Sign in to post a take. Connect a wallet that holds one and your take shows a holder badge.</Text>
        {auth.supported && (
          <Pressable onPress={() => auth.login()} style={s.post}><Text style={s.postTxt}>Sign in to post</Text></Pressable>
        )}
      </View>
    );
  }

  const post = async () => {
    const body = text.trim();
    if (body.length < 3 || busy) return;
    setBusy(true); setMsg(null);
    try {
      let proof: { wallet?: string; signature?: string; ts?: number } = {};
      if (sign && canSign) {
        const ts = Math.floor(Date.now() / 1000);
        const { message } = await api.takeMessage(symbol, body, ts);
        const signature = await wallet.signMessage!(message);
        proof = { wallet: wallet.address!, signature, ts };
      }
      await api.postTake({ collection: symbol, text: body, ...proof });
      track('take_post', { signed: !!proof.signature });
      setText('');
      onPosted();
    } catch (e) {
      const m = (e as Error).message || 'Could not post.';
      setMsg(/reject|denied|cancel/i.test(m) ? 'You cancelled the signature. Untick "Sign with wallet" to post without a badge.' : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.composer}>
      <TextInput value={text} onChangeText={(v) => setText(v.slice(0, MAX))} multiline placeholder={`Your take on ${name}…`}
        placeholderTextColor={C.muted} style={s.input} accessibilityLabel="Your take" />
      <View style={s.composerRow}>
        {canSign ? (
          <Pressable onPress={() => setSign((v) => !v)} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: sign }}>
            <View style={[s.box, sign && { backgroundColor: C.accent, borderColor: C.accent }]}>{sign && <Text style={s.tick}>✓</Text>}</View>
            <Text style={s.checkTxt}>Sign with {shortAddr(wallet.address!)} for a holder badge</Text>
          </Pressable>
        ) : (
          <Text style={[s.checkTxt, { flex: 1 }]}>Connect a {evm ? 'browser wallet (MetaMask, Rabby…)' : 'Solana wallet (Phantom, Solflare…)'} to add a holder badge.</Text>
        )}
        <Text style={[s.count, text.length > MAX - 20 && { color: C.down }]}>{MAX - text.length}</Text>
        <Pressable onPress={post} disabled={busy || text.trim().length < 3} style={[s.post, (busy || text.trim().length < 3) && { opacity: 0.5 }]}>
          <Text style={s.postTxt}>{busy ? 'Posting…' : 'Post'}</Text>
        </Pressable>
      </View>
      {msg && <Text style={[T.caption, { color: C.down }]}>{msg}</Text>}
      <Text style={T.caption}>No links. Takes are public. Not financial advice.</Text>
    </View>
  );
}

// --- rows --------------------------------------------------------------------------

function HolderBadge({ t }: { t: UserTake }) {
  if (t.holder) {
    const p = t.holder.pnlPct;
    const color = p == null ? C.accent : p >= 0 ? C.up : C.down;
    return (
      <View style={[s.badge, { borderColor: color }]}>
        <Text style={[s.badgeTxt, { color }]}>
          Holder · {t.holder.items} NFT{t.holder.items === 1 ? '' : 's'}{p != null ? ` · ${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%` : ''}
        </Text>
      </View>
    );
  }
  if (t.verified) return <View style={s.badge}><Text style={s.badgeTxt}>Wallet verified · not holding</Text></View>;
  return null;
}

function UserTakeRow({ t, onChange }: { t: UserTake; currency: string; onChange: () => void }) {
  const { userId } = useSession();
  const [likes, setLikes] = useState({ n: t.likes, on: t.liked });
  const [armed, setArmed] = useState<'report' | 'delete' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const like = async () => {
    if (!userId) return;
    setLikes((l) => ({ n: l.n + (l.on ? -1 : 1), on: !l.on }));
    const r = await api.likeTake(t.id, userId).catch(() => null);
    if (r) setLikes({ n: r.likes, on: r.liked });
  };
  const confirm = async (what: 'report' | 'delete') => {
    if (armed !== what) { setArmed(what); return; }
    setArmed(null);
    if (what === 'report' && userId) { await api.reportTake(t.id, userId).catch(() => {}); setDone('Reported. Thanks.'); }
    if (what === 'delete') { await api.deleteTake(t.id).catch(() => {}); onChange(); }
  };

  return (
    <View style={s.row}>
      <Pressable disabled={!t.author.wallet} onPress={() => t.author.wallet && router.push({ pathname: '/wallet/[address]', params: { address: t.author.wallet } })}>
        <Avatar t={{ wallet: t.author.wallet ?? t.author.name, name: t.author.name, avatar: t.author.avatar }} size={34} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={s.head}>
          <Text style={s.name} numberOfLines={1}>{t.author.name}</Text>
          {t.author.tier === 'elite' || t.author.tier === 'pro' ? <TierBadge tier={t.author.tier} /> : null}
          <HolderBadge t={t} />
          <Text style={s.time}>{timeAgo(t.t)}</Text>
        </View>
        <Text style={s.text}>{t.text}</Text>
        <View style={s.actions}>
          <Pressable onPress={like} hitSlop={6} accessibilityLabel={likes.on ? 'Unlike' : 'Like'}>
            <Text style={[s.action, likes.on && { color: C.down }]}>{likes.on ? '♥' : '♡'} {likes.n}</Text>
          </Pressable>
          {done ? <Text style={s.action}>{done}</Text> : t.mine ? (
            <Pressable onPress={() => confirm('delete')} hitSlop={6}><Text style={[s.action, armed === 'delete' && { color: C.down }]}>{armed === 'delete' ? 'Tap again to delete' : 'Delete'}</Text></Pressable>
          ) : (
            <Pressable onPress={() => confirm('report')} hitSlop={6}><Text style={[s.action, armed === 'report' && { color: C.down }]}>{armed === 'report' ? 'Tap again to report' : 'Report'}</Text></Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function AiTakeRow({ t, symbol, currency }: { t: AiTake; symbol: string; currency: string }) {
  return (
    <View style={s.row}>
      <View style={s.aiMark}><Text style={s.aiMarkTxt}>AI</Text></View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={s.head}>
          <Text style={s.name} numberOfLines={1}>AI take</Text>
          <Pressable onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol, id: t.trade.mint } })}>
            <Text style={s.time} numberOfLines={1}>on {t.trade.buyerName ?? shortAddr(t.trade.buyer)}&apos;s buy at {sol(t.trade.price, 2, currency)}</Text>
          </Pressable>
          <Text style={s.time}>{timeAgo(t.t)}</Text>
        </View>
        <Text style={[s.text, { color: C.dim }]}>{t.text}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  composer: { gap: 10, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  input: {
    minHeight: 72, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text,
    fontSize: 15, lineHeight: 21, padding: 12, textAlignVertical: 'top',
  },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  check: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 200 },
  box: { width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  tick: { color: C.accentInk, fontSize: 11, fontWeight: '700', lineHeight: 13 },
  checkTxt: { ...T.caption, color: C.dim },
  count: { ...T.caption, fontVariant: ['tabular-nums'] },
  post: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, alignSelf: 'flex-start' },
  postTxt: { color: C.accentInk, fontSize: 14, fontWeight: '600' },
  none: { ...T.meta, textAlign: 'center', paddingVertical: 20 },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { color: C.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  time: { ...T.caption, color: C.dim },
  text: { ...T.body },
  actions: { flexDirection: 'row', gap: 18, marginTop: 2 },
  action: { ...T.caption, color: C.dim, fontWeight: '600' },
  badge: { borderWidth: 1, borderColor: C.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  badgeTxt: { fontSize: 11, fontWeight: '600', color: C.dim },
  aiMark: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.ai, alignItems: 'center', justifyContent: 'center' },
  aiMarkTxt: { color: C.ai, fontSize: 12, fontWeight: '700' },
});
