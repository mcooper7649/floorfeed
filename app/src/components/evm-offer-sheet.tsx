import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ModeChip } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { ReportLink } from '@/components/report-link';
import { Chip } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { track } from '@/lib/analytics';
import { api, type EvmOfferQuote } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cancelEvmListing, daysLeft } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { sol, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// Make an offer on OpenSea: on one NFT (`id`), or on any NFT in the collection.
// An offer is a signature, not a transaction: nothing leaves the wallet until a
// holder accepts it. It's made in wrapped coin (WETH), so the wallet may first
// need to wrap some ETH and, once per token, let OpenSea use it. FloorFeed
// builds those two transactions; the wallet confirms each.

type Step = { kind: 'idle' } | { kind: 'wrapping'; hash?: string } | { kind: 'approving'; hash?: string } | { kind: 'signing' }
  | { kind: 'cancelling'; hash: string } | { kind: 'placed'; price: number; days: number } | { kind: 'error'; message: string };

const cancelledMsg = (m: string) => /reject|denied|cancel/i.test(m) && !/didn't cancel|can't cancel/i.test(m);
const trim = (n: number) => String(Number(n.toPrecision(3)));
// OpenSea takes bids in steps of 0.0001: suggestions snap to that (up when beating an offer).
const snap = (n: number, up = false) => String((up ? Math.ceil(n * 1e4 - 1e-6) : Math.floor(n * 1e4 + 1e-6)) / 1e4);
const offStep = (n: number) => n > 0 && Math.abs(Math.round(n * 1e4) - n * 1e4) > 1e-6;
export const announceOffer = () => globalThis.dispatchEvent?.(new CustomEvent('floorfeed:offer'));

export function EvmOfferSheet({ symbol, id, listedAt, open, onClose, onBuy }: {
  symbol: string;
  id?: string | null; // contract:tokenId; none = a collection offer
  listedAt?: number | null; // this NFT's (or the floor's) listing price, to compare
  open: boolean;
  onClose: () => void;
  onBuy?: () => void; // the offer reaches the listing: buy instead
}) {
  const w = useEvmWallet();
  const auth = useAuth();
  const { toUsd } = usePrices();
  const [quote, setQuote] = useState<{ key: string; q?: EvmOfferQuote; error?: string } | null>(null);
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(7);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const key = `${symbol}:${id ?? ''}:${w.address}:${nonce}`;
  useEffect(() => { if (open) track('offer_open', { kind: id ? 'item' : 'collection' }); }, [open, id]);

  useEffect(() => {
    if (!open || !w.address) return;
    let alive = true;
    api.evmOfferQuote(symbol, w.address, id)
      .then((q) => alive && setQuote({ key, q }))
      .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [open, symbol, id, w.address, key]);

  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (polling.current) clearInterval(polling.current); }, []);

  const current = quote?.key === key ? quote : null;
  const q = current?.q ?? null;
  const token = q?.token?.symbol ?? 'WETH';
  const native = q?.native ?? 'ETH';
  const value = Number(price);
  const wrapped = q?.wrapped ?? 0;
  const needWrap = value > 0 ? Math.max(0, value - wrapped) : 0;
  const canWrap = !!q?.wrappable && needWrap > 0 && (q?.nativeBalance ?? 0) > needWrap;
  const needApprove = value > 0 && q?.allowance != null && q.allowance < value;
  const cur = needWrap > 0 ? 0 : needApprove ? 1 : 2; // the step the user is on
  const floor = q?.collection.floor ?? null;
  const best = q?.bestOffer ?? null;
  const mine = q?.mine ?? [];
  const busy = step.kind === 'wrapping' || step.kind === 'approving' || step.kind === 'signing' || step.kind === 'cancelling';
  const both = (n: number, u: string) => { const d = toUsd(n, u); return d != null ? `${sol(n, 4, u)} · ${usd(d)}` : sol(n, 4, u); };

  const close = () => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
    setStep({ kind: 'idle' });
    onClose();
  };
  const fail = (e: unknown, fallback: string) => {
    const m = (e as Error).message || fallback;
    setStep({ kind: 'error', message: cancelledMsg(m) ? 'You cancelled in your wallet. Nothing changed.' : m });
  };
  // After a wrap or approval is sent, re-quote until the chain shows it.
  const waitFor = (done: (fresh: EvmOfferQuote) => boolean) => {
    if (polling.current) clearInterval(polling.current);
    const address = w.address!, started = Date.now();
    polling.current = setInterval(async () => {
      const fresh = await api.evmOfferQuote(symbol, address, id).catch(() => null);
      if (fresh && done(fresh)) {
        clearInterval(polling.current!); polling.current = null;
        setNonce((n) => n + 1);
        setStep({ kind: 'idle' });
      } else if (Date.now() - started > 5 * 60_000) {
        clearInterval(polling.current!); polling.current = null;
        setStep({ kind: 'error', message: "It hasn't confirmed yet. Check Activity, then reopen this." });
      }
    }, 4_000);
  };

  const wrap = async () => {
    if (!q || !w.address || !w.send || !(needWrap > 0)) return;
    setStep({ kind: 'wrapping' });
    try {
      // A hair extra so rounding never leaves the offer a wei short.
      const amount = Number((needWrap * 1.001).toPrecision(6));
      const tx = await api.evmWrapTx({ symbol, owner: w.address, amount });
      const hash = await w.send({ ...tx, description: `Wrap ${sol(amount, 5, native)} into ${token} for your offer. You can unwrap it back any time.` });
      track('wrap_signed', { chain: q.chain });
      recordTx({ hash, wallet: w.address, chain: q.chain, kind: 'approve', title: `Wrapped ${sol(amount, 5, native)} into ${token}`, amount, unit: native });
      setStep({ kind: 'wrapping', hash });
      waitFor((f) => (f.wrapped ?? 0) >= value);
    } catch (e) { fail(e, 'The wrap did not go through.'); }
  };

  const approve = async () => {
    if (!q?.operator || !w.address || !w.send) return;
    setStep({ kind: 'approving' });
    try {
      const tx = await api.evmOfferApproveTx({ symbol, owner: w.address, operator: q.operator });
      const hash = await w.send({ ...tx, description: `Let OpenSea use your ${token} when someone accepts one of your offers. Once per network; nothing is spent now.` });
      recordTx({ hash, wallet: w.address, chain: q.chain, kind: 'approve', title: `Allowed OpenSea to use ${token}`, symbol });
      setStep({ kind: 'approving', hash });
      waitFor((f) => f.allowance == null || f.allowance >= value);
    } catch (e) { fail(e, 'The approval did not go through.'); }
  };

  const place = async () => {
    if (!q || !w.address || !w.signTypedData || !(value > 0)) return;
    setStep({ kind: 'signing' });
    try {
      const b = await api.evmOfferBuild({ symbol, id, buyer: w.address, price: value, days });
      const signature = await w.signTypedData(b.typedData);
      await api.evmOfferSubmit({ chain: b.chain, kind: b.kind, parameters: b.parameters, signature, criteria: b.criteria });
      track('offer_signed', { chain: q.chain, kind: b.kind, days });
      announceOffer();
      setStep({ kind: 'placed', price: value, days });
    } catch (e) { fail(e, 'The offer did not go through.'); }
  };

  const cancel = async (orderHash: string) => {
    if (!q) return;
    setStep({ kind: 'cancelling', hash: orderHash });
    try {
      await cancelEvmListing(w, { chain: q.chain, orderHash, name: q.name });
      track('offer_cancel', { chain: q.chain, from: 'sheet' });
      announceOffer();
      setNonce((n) => n + 1);
      setStep({ kind: 'idle' });
    } catch (e) {
      const m = (e as Error).message;
      if (/isn't live anymore/i.test(m)) { setNonce((n) => n + 1); setStep({ kind: 'idle' }); return; }
      setStep({ kind: 'error', message: cancelledMsg(m) ? 'You cancelled in your wallet. The offer is still up.' : m });
    }
  };

  // Price ideas: under the floor (where offers usually sit) and against the best offer.
  type Idea = { label: string; v: number };
  const ideas: Idea[] = [
    best && { label: 'Top best offer', v: best.price * 1.02 },
    best && { label: 'Match best', v: best.price },
    floor && { label: '5% under floor', v: floor * 0.95 },
    floor && { label: '10% under', v: floor * 0.9 },
    floor && { label: '20% under', v: floor * 0.8 },
  ].filter((x): x is Idea => !!x && x.v >= 0.0001);
  const vsFloor = floor && value > 0 ? value / floor - 1 : null;
  const reachesListing = listedAt != null && value >= listedAt;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false}>
          <View style={s.head}>
            <Text style={s.title}>{id ? 'Make an offer' : 'Collection offer'}</Text>
            <ModeChip mode="real" />
          </View>

          {!w.address ? (
            <View style={{ gap: 10 }}>
              <Text style={s.meta}>Offers need an Ethereum wallet. Sign in for a free FloorFeed wallet, or connect one you have.</Text>
              {auth.supported && !auth.userId && (
                <Pressable accessibilityRole="button" onPress={() => { close(); auth.login(); }} style={s.primary}>
                  <Text style={s.primaryTxt}>Sign in</Text>
                </Pressable>
              )}
              {w.available.map((o) => (
                <Pressable accessibilityRole="button" key={o.name} onPress={() => w.connect(o.name)} style={s.option}>
                  <Image source={{ uri: o.icon }} style={s.icon} />
                  <Text style={s.optionTxt}>{o.name}</Text>
                  <Text style={s.meta}>{w.connecting ? 'Check your wallet…' : 'Connect'}</Text>
                </Pressable>
              ))}
              {auth.userId && !w.available.length && <Text style={s.meta}>Your FloorFeed Ethereum wallet is being set up. Try again in a moment.</Text>}
            </View>
          ) : step.kind === 'placed' ? (
            <View style={{ gap: 10 }}>
              <Text style={s.ok}>✓ Offer placed on OpenSea</Text>
              <Text style={s.meta}>
                You offered {sol(step.price, 4, token)} for {id ? q?.name : `any ${q?.collection.name}`}, good for {step.days} day{step.days === 1 ? '' : 's'}.
                If {id ? 'the owner accepts' : 'a holder accepts'}, the {token} leaves your wallet and the NFT arrives in it. Until then nothing moves, and you can cancel for free under Your offers on Portfolio.
              </Text>
              {q?.marketUrl && (
                <Pressable accessibilityRole="link" onPress={() => Linking.openURL(q.marketUrl!)} style={s.secondary}>
                  <Text style={s.secondaryTxt}>See it on OpenSea ↗</Text>
                </Pressable>
              )}
            </View>
          ) : !current ? (
            <View style={s.loading}><ActivityIndicator color={C.accent} /><Text style={s.meta}>Loading…</Text></View>
          ) : !q ? (
            <Text style={s.err}>Couldn&apos;t set up an offer: {current.error}</Text>
          ) : !q.executable ? (
            <Text style={s.meta}>{q.reason}</Text>
          ) : (
            <>
              <View style={s.item}>
                <NftImage uri={q.image} name={q.name} ratio={1} radius={12} px={160} style={{ width: 56 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name}>{id ? q.name : `Any ${q.collection.name}`}</Text>
                  <Text style={s.meta}>
                    {q.collection.name} · {chainName(q.chain)}{floor != null ? ` · floor ${sol(floor, 4, native)}` : ''}
                  </Text>
                  {!id && <Text style={s.meta}>Whoever accepts first sells you one of theirs.</Text>}
                </View>
              </View>

              {mine.length > 0 && (
                <View style={s.oldBox}>
                  {mine.map((m) => (
                    <View key={m.orderHash} style={s.row}>
                      <Text style={s.meta}>Your offer: {sol(m.price, 4, token)} · {daysLeft(m.expiresAt)}</Text>
                      <Pressable accessibilityRole="button" onPress={() => cancel(m.orderHash)} disabled={busy}>
                        <Text style={[T.label, { color: C.down }]}>
                          {step.kind === 'cancelling' && step.hash === m.orderHash ? 'Sign to cancel…' : 'Cancel'}
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              <View style={{ gap: 6 }}>
                <Text style={s.label}>Your offer{id ? '' : ', per NFT'}</Text>
                <View style={s.inputRow}>
                  <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.0"
                    placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
                  <Text style={s.unit}>{token}</Text>
                </View>
                {vsFloor != null && (
                  <Text style={s.meta}>
                    {Math.abs(vsFloor) < 0.005 ? 'At the floor' : `${Math.abs(vsFloor * 100).toFixed(0)}% ${vsFloor > 0 ? 'above' : 'below'} the floor`}
                    {best ? ` · best offer now ${sol(best.price, 4, token)}` : ' · no offers yet'}
                  </Text>
                )}
                {ideas.length > 0 && (
                  <View style={s.chips}>
                    {ideas.map((x) => { const v = snap(x.v, x.label === 'Top best offer'); return <Chip key={x.label} label={`${x.label} ${v}`} on={value === Number(v)} onPress={() => setPrice(v)} />; })}
                  </View>
                )}
              </View>

              <View style={{ gap: 6 }}>
                <Text style={s.label}>Offer lasts</Text>
                <View style={s.chips}>
                  {q.days.map((d) => <Chip key={d} label={d === 1 ? '1 day' : `${d} days`} on={days === d} onPress={() => setDays(d)} />)}
                </View>
              </View>

              {value > 0 && (
                <View style={s.rows}>
                  <Row label="You pay if accepted" value={both(value, token)} strong />
                  <Row label={`Seller's fees (${trim(q.feePct ?? 0)}%)`} value="come out of your offer" />
                  <Row label={`Your ${token}`} value={sol(wrapped, 4, token)} />
                  {needWrap > 0 && <Row label={`Your ${native}`} value={sol(q.nativeBalance ?? 0, 4, native)} />}
                </View>
              )}

              {reachesListing && (
                <View style={{ gap: 6 }}>
                  <Text style={s.warn}>
                    {id ? 'This NFT is listed' : 'The floor is listed'} at {sol(listedAt!, 4, native)}, no more than your offer. Buying it now is instant.
                  </Text>
                  {onBuy && (
                    <Pressable accessibilityRole="button" onPress={() => { setStep({ kind: 'idle' }); onBuy(); }}>
                      <Text style={[s.link, { textAlign: 'left' }]}>Buy for {sol(listedAt!, 4, native)} instead</Text>
                    </Pressable>
                  )}
                </View>
              )}
              {!id && vsFloor != null && vsFloor >= 0 && !reachesListing && (
                <Text style={s.warn}>That&apos;s at or above the floor: buying the cheapest listing is likely cheaper and instant.</Text>
              )}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}
              {step.kind === 'error' && <ReportLink topic="trade" detail={step.message} from="evm-offer" onLeave={onClose} />}

              {value > 0 && !offStep(value) && (needWrap === 0 || canWrap) && (
                <View style={{ gap: 8 }}>
                  <Text style={s.meta}>One offer, three steps. Steps 1 and 2 only set up your wallet; nothing is bought until someone accepts.</Text>
                  <Stepper current={cur} busy={busy} steps={[
                    { title: `Get ${token}`, sub: cur > 0 ? `You have ${sol(wrapped, 4, token)}` : `Wrap ${sol(needWrap, 4, native)}` },
                    { title: `Allow ${token}`, sub: cur > 1 ? 'Allowed' : 'Once per network' },
                    { title: 'Sign offer', sub: 'Free, no gas' },
                  ]} />
                </View>
              )}

              {!(value > 0) ? (
                <View style={[s.primary, { opacity: 0.6 }]}><Text style={s.primaryTxt}>Enter an offer</Text></View>
              ) : offStep(value) ? (
                <Text style={s.err}>OpenSea takes offers in steps of 0.0001. Try {snap(value)} or {snap(value, true)}.</Text>
              ) : needWrap > 0 ? (
                canWrap ? (
                  <View style={{ gap: 8 }}>
                    <Text style={s.meta}>
                      Offers are made in {token}, wrapped {native}, worth exactly the same. You can unwrap it back any time.
                    </Text>
                    <Pressable accessibilityRole="button" onPress={wrap} disabled={busy} style={[s.primary, busy && { opacity: 0.7 }]}>
                      <Text style={s.primaryTxt}>
                        {step.kind === 'wrapping' ? (step.hash ? 'Waiting for the wrap to confirm…' : 'Confirm in your wallet…') : `Step 1 of 3 · Wrap ${sol(needWrap, 4, native)} into ${token}`}
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={s.err}>
                    {q.wrappable
                      ? `Not enough ${native} on ${chainName(q.chain)}: the offer needs ${sol(needWrap, 4, native)} more to wrap into ${token}, plus a little for network fees.`
                      : `This offer needs ${sol(needWrap, 4, token)} more ${token} on ${chainName(q.chain)}.`}
                  </Text>
                )
              ) : needApprove ? (
                <View style={{ gap: 8 }}>
                  <Text style={s.meta}>Lets OpenSea take the {token} only if someone accepts your offer. Once on {chainName(q.chain)}, small network fee, nothing is spent now.</Text>
                  <Pressable accessibilityRole="button" onPress={approve} disabled={busy} style={[s.primary, busy && { opacity: 0.7 }]}>
                    <Text style={s.primaryTxt}>{step.kind === 'approving' ? (step.hash ? 'Waiting for the approval to confirm…' : 'Confirm in your wallet…') : `Step 2 of 3 · Allow ${token}`}</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable accessibilityRole="button" onPress={place} disabled={busy || !w.signTypedData}
                  style={[s.primary, busy && { opacity: 0.7 }]}>
                  <Text style={s.primaryTxt}>{step.kind === 'signing' ? 'Sign the offer in your wallet…' : `Step 3 of 3 · Sign offer for ${sol(value, 4, token)}`}</Text>
                </Pressable>
              )}
              <Text style={s.fine}>
                An offer is a signature, not a payment: no gas, and your {token} stays in your wallet until {id ? 'the owner accepts' : 'someone accepts'}. Cancelling is free.
              </Text>
            </>
          )}

          <Pressable accessibilityRole="button" onPress={close} style={s.secondary}>
            <Text style={s.secondaryTxt}>{step.kind === 'placed' ? 'Done' : 'Close'}</Text>
          </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// The three steps of an offer, done ✓ / current / next, so it reads as one flow.
function Stepper({ steps, current, busy }: { steps: { title: string; sub: string }[]; current: number; busy: boolean }) {
  return (
    <View style={s.stepper}>
      {steps.map((st, i) => {
        const done = i < current, now = i === current;
        return (
          <View key={st.title} style={s.stepCol}>
            <View style={[s.stepBar, (done || now) && { backgroundColor: C.accent }, now && busy && { opacity: 0.6 }]} />
            <View style={s.stepHead}>
              <View style={[s.dot, done && s.dotDone, now && s.dotNow]}>
                <Text style={[s.dotTxt, done && { color: C.accentInk }, now && { color: C.accent }]}>{done ? '✓' : i + 1}</Text>
              </View>
              <Text style={[s.stepTitle, !done && !now && { color: C.muted }]} numberOfLines={1}>{st.title}</Text>
            </View>
            <Text style={s.stepSub} numberOfLines={2}>{now && busy ? 'In progress…' : st.sub}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={strong ? s.strongLabel : s.meta}>{label}</Text>
      <Text style={[s.val, strong && s.strongVal]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, maxHeight: '100%', backgroundColor: C.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: T.title,
  item: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  name: T.bodyStrong,
  label: T.label,
  meta: T.meta,
  fine: T.caption,
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  unit: { ...T.bodyStrong, minWidth: 56 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  oldBox: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  val: { ...T.metaNum, color: C.text },
  strongLabel: { ...T.meta, color: C.text },
  strongVal: { ...T.bodyStrong },
  err: { ...T.meta, color: C.down },
  warn: { ...T.meta, color: C.down },
  ok: { ...T.title, color: C.up },
  link: { ...T.label, textAlign: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  stepper: { flexDirection: 'row', gap: 8 },
  stepCol: { flex: 1, gap: 6 },
  stepBar: { height: 4, borderRadius: 2, backgroundColor: C.border },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  dotDone: { backgroundColor: C.accent, borderColor: C.accent },
  dotNow: { borderColor: C.accent, borderWidth: 2 },
  dotTxt: { ...T.caption, color: C.muted, fontWeight: '700' },
  stepTitle: { ...T.label, color: C.text, flexShrink: 1 },
  stepSub: { ...T.caption, color: C.muted },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  icon: { width: 28, height: 28, borderRadius: 6 },
  optionTxt: { ...T.bodyStrong, flex: 1 },
});
