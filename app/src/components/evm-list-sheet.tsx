import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ModeChip } from '@/components/mode-toggle';
import { Chip } from '@/components/ui';
import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { track } from '@/lib/analytics';
import { api, type EvmListQuote } from '@/lib/api';
import { cancelEvmListing, daysLeft } from '@/lib/evm-listing';
import { useEvmWallet } from '@/lib/evm-wallet';
import { signedSol, signedUsd, sol, timeAgo, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';

// List an NFT for sale on OpenSea at your price. Nothing moves on chain to
// list: the wallet signs the listing (no gas) and FloorFeed posts it to
// OpenSea; the sale happens when a buyer fills it. The first listing from a
// collection needs the same one-time approval as selling into an offer.
// Changing the price lists the new one, then cancels the old (free).

type Step = { kind: 'idle' } | { kind: 'approving'; hash?: string } | { kind: 'signing' } | { kind: 'cancelOld' }
  | { kind: 'cancelling' } | { kind: 'listed'; price: number; days: number } | { kind: 'cancelled' } | { kind: 'error'; message: string };

const cancelledMsg = (m: string) => /reject|denied|cancel/i.test(m);
const trim = (n: number) => String(Number(n.toPrecision(4)));

export function EvmListSheet({ symbol, id, open, onClose, onDone }: {
  symbol: string;
  id: string; // contract:tokenId
  open: boolean;
  onClose: () => void;
  onDone?: () => void; // listed or cancelled: holdings changed
}) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [quote, setQuote] = useState<{ key: string; q?: EvmListQuote; error?: string } | null>(null);
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(7);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const key = `${symbol}:${id}:${w.address}:${nonce}`;
  useEffect(() => { if (open) track('list_open', { chain: 'evm' }); }, [open]);

  useEffect(() => {
    if (!open || !w.address) return;
    let alive = true;
    api.evmListQuote(symbol, id, w.address)
      .then((q) => alive && setQuote({ key, q }))
      .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [open, symbol, id, w.address, key]);

  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (polling.current) clearInterval(polling.current); }, []);

  const current = quote?.key === key ? quote : null;
  const q = current?.q ?? null;
  const unit = q?.unit ?? 'ETH';
  const value = Number(price);
  const feePct = q?.feePct ?? 0;
  const net = value > 0 ? value * (1 - feePct / 100) : null;
  const pnl = net != null && q?.boughtAt != null ? net - q.boughtAt : null;
  const both = (n: number) => { const d = toUsd(n, unit); return d != null ? `${sol(n, 4, unit)} · ${usd(d)}` : sol(n, 4, unit); };
  const busy = step.kind === 'approving' || step.kind === 'signing' || step.kind === 'cancelOld' || step.kind === 'cancelling';
  const old = q?.listing ?? null;
  const offerBeats = q?.bestOffer && net != null && q.bestOffer.net >= net;
  const underFloor = q?.floor && value > 0 ? 1 - value / q.floor : null;

  const close = () => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
    setStep({ kind: 'idle' });
    onClose();
  };
  const fail = (e: unknown, fallback: string) => {
    const m = (e as Error).message || fallback;
    setStep({ kind: 'error', message: cancelledMsg(m) ? 'You cancelled in your wallet. Nothing changed.' : m });
  };

  const approve = async () => {
    if (!q?.operator || !w.address || !w.send) return;
    setStep({ kind: 'approving' });
    try {
      const tx = await api.evmApproveTx({ chain: q.chain, contract: id.split(':')[0], owner: w.address, operator: q.operator });
      const hash = await w.send({ ...tx, description: `Step 1 of 2: let OpenSea move your ${q.collection.name} NFTs when they sell. This doesn't list or sell anything yet.` });
      recordTx({ hash, wallet: w.address, chain: q.chain, kind: 'approve', title: `Approved selling ${q.collection.name}`, symbol: q.collection.symbol });
      setStep({ kind: 'approving', hash });
      const address = w.address, started = Date.now();
      polling.current = setInterval(async () => {
        const fresh = await api.evmListQuote(symbol, id, address).catch(() => null);
        if (fresh?.approved) {
          clearInterval(polling.current!); polling.current = null;
          setNonce((n) => n + 1);
          setStep({ kind: 'idle' });
        } else if (Date.now() - started > 5 * 60_000) {
          clearInterval(polling.current!); polling.current = null;
          setStep({ kind: 'error', message: "The approval hasn't confirmed yet. Check Activity, then reopen this." });
        }
      }, 4_000);
    } catch (e) { fail(e, 'The approval did not go through.'); }
  };

  const cancelListing = async (orderHash: string) => {
    if (q) await cancelEvmListing(w, { chain: q.chain, orderHash, name: q.name });
  };

  const list = async () => {
    if (!q || !w.address || !w.signTypedData || !(value > 0)) return;
    setStep({ kind: 'signing' });
    try {
      const b = await api.evmListBuild({ symbol, id, seller: w.address, price: value, days });
      const signature = await w.signTypedData(b.typedData);
      await api.evmListSubmit({ chain: b.chain, parameters: b.parameters, signature });
      track('list_signed', { chain: q.chain, days });
      // Changing the price: the old listing would still sell at its price, so cancel it now.
      if (old) {
        setStep({ kind: 'cancelOld' });
        try { await cancelListing(old.orderHash); } catch (e) {
          setStep({ kind: 'error', message: `Your new listing is live, but the old one at ${sol(old.price, 4, unit)} is still up: ${(e as Error).message}. Cancel it from here.` });
          setNonce((n) => n + 1);
          onDone?.();
          return;
        }
      }
      setStep({ kind: 'listed', price: value, days });
      onDone?.();
    } catch (e) { fail(e, 'The listing did not go through.'); }
  };

  const cancel = async () => {
    if (!old) return;
    setStep({ kind: 'cancelling' });
    try {
      await cancelListing(old.orderHash);
      track('list_cancel', { chain: q?.chain ?? 'evm' });
      setStep({ kind: 'cancelled' });
      onDone?.();
    } catch (e) { fail(e, "The listing wasn't cancelled."); }
  };

  // Price ideas, in groups: what the collection sells for, a step above the
  // floor, and against what you paid.
  type Idea = { label: string; v: number };
  const ok = (x: Idea | null | false | 0 | undefined): x is Idea => !!x && x.v > 0;
  const m = q?.market;
  const floor = q?.floor ?? null;
  const ideas: { title: string; items: Idea[] }[] = [
    { title: 'Market', items: [
      floor && { label: 'Floor', v: floor },
      floor && { label: 'Just under floor', v: floor * 0.99 },
      m?.median && { label: 'Typical sale', v: m.median },
      m?.lastSale && { label: 'Last sale', v: m.lastSale.price },
      m?.high24h && { label: '24h high', v: m.high24h },
    ].filter(ok) },
    { title: 'Above floor', items: floor ? [5, 10, 25, 50].map((p) => ({ label: `+${p}%`, v: floor * (1 + p / 100) })) : [] },
    { title: 'From what you paid', items: q?.boughtAt ? [
      { label: 'Break even', v: q.boughtAt / (1 - feePct / 100) },
      { label: '+50%', v: (q.boughtAt * 1.5) / (1 - feePct / 100) },
      { label: '2×', v: (q.boughtAt * 2) / (1 - feePct / 100) },
    ] : [] },
  ].filter((g) => g.items.length);
  const vsFloor = floor && value > 0 ? value / floor - 1 : null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false}>
          <View style={s.head}>
            <Text style={s.title}>{old ? 'Your listing' : 'List for sale'}</Text>
            <ModeChip mode="real" />
          </View>

          {!w.address ? (
            <Text style={s.meta}>Connect the Ethereum wallet that holds this NFT to list it.</Text>
          ) : step.kind === 'listed' ? (
            <View style={{ gap: 10 }}>
              <Text style={s.ok}>✓ Listed on OpenSea</Text>
              <Text style={s.meta}>
                {q?.name} is for sale at {sol(step.price, 4, unit)} for {step.days} day{step.days === 1 ? '' : 's'}. When someone buys it, {net != null ? sol(net, 4, unit) : 'the payment'} goes straight to {w.walletName ?? 'your wallet'} on {chainName(q?.chain ?? 'ethereum')}. You can change the price or cancel here any time.
              </Text>
              {q?.marketUrl && (
                <Pressable accessibilityRole="link" onPress={() => Linking.openURL(q.marketUrl!)} style={s.secondary}>
                  <Text style={s.secondaryTxt}>See it on OpenSea ↗</Text>
                </Pressable>
              )}
            </View>
          ) : step.kind === 'cancelled' ? (
            <View style={{ gap: 10 }}>
              <Text style={s.ok}>✓ Listing cancelled</Text>
              <Text style={s.meta}>It&apos;s off OpenSea. The NFT stays in your wallet.</Text>
            </View>
          ) : !current ? (
            <View style={s.loading}><ActivityIndicator color={C.accent} /><Text style={s.meta}>Loading…</Text></View>
          ) : !q ? (
            <Text style={s.err}>Couldn&apos;t load this NFT: {current.error}</Text>
          ) : !q.executable ? (
            <View style={{ gap: 10 }}>
              <Text style={s.meta}>{q.reason}</Text>
              {q.marketUrl && <Pressable accessibilityRole="link" onPress={() => Linking.openURL(q.marketUrl!)}><Text style={s.link}>Open on OpenSea ↗</Text></Pressable>}
            </View>
          ) : (
            <>
              <View style={{ gap: 2 }}>
                <Text style={s.name}>{q.name}</Text>
                <Text style={s.meta}>{q.collection.name} · {chainName(q.chain)}</Text>
              </View>

              {old && (
                <View style={s.oldBox}>
                  <Text style={s.bodyStrong}>Listed at {sol(old.price, 4, unit)}{toUsd(old.price, unit) != null ? ` · ${usd(toUsd(old.price, unit)!)}` : ''}</Text>
                  <Text style={s.meta}>{daysLeft(old.expiresAt)}{old.cancelFree ? ' · cancelling is free' : ' · cancelling costs a network fee'}</Text>
                  <Pressable accessibilityRole="button" onPress={cancel} disabled={busy}>
                    <Text style={[s.link, { textAlign: 'left', color: C.down }]}>{step.kind === 'cancelling' ? 'Confirm in your wallet…' : 'Cancel listing'}</Text>
                  </Pressable>
                </View>
              )}

              <View style={{ gap: 6 }}>
                <Text style={s.label}>{old ? 'New price' : 'Price'}</Text>
                <View style={s.inputRow}>
                  <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.0"
                    placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
                  <Text style={s.unit}>{unit}</Text>
                </View>
                {vsFloor != null && (
                  <Text style={[s.meta, { color: vsFloor < -0.1 ? C.down : C.muted }]}>
                    {Math.abs(vsFloor) < 0.005 ? 'At the floor' : `${Math.abs(vsFloor * 100).toFixed(vsFloor > -0.1 && vsFloor < 0.1 ? 1 : 0)}% ${vsFloor > 0 ? 'above' : 'below'} the floor`}
                  </Text>
                )}
                {ideas.map((g) => (
                  <View key={g.title} style={{ gap: 4 }}>
                    <Text style={s.groupTitle}>{g.title}</Text>
                    <View style={s.chips}>
                      {g.items.map((x) => <Chip key={x.label} label={`${x.label} ${trim(x.v)}`} on={Number(price) === Number(trim(x.v))} onPress={() => setPrice(trim(x.v))} />)}
                    </View>
                  </View>
                ))}
                {!!m?.recent.length && (
                  <View style={s.recent}>
                    <Text style={s.groupTitle}>Recent sales{m.sales24h ? ` · ${m.sales24h} in 24h` : ''}</Text>
                    {m.recent.map((r, i) => (
                      <View key={`${r.id}:${r.at}:${i}`} style={s.recentRow}>
                        <Text style={s.meta}>#{r.id.length > 8 ? `${r.id.slice(0, 6)}…` : r.id} · {r.kind === 'offer' ? 'sold to an offer' : 'bought from a listing'}</Text>
                        <Text style={s.meta}>{sol(r.price, 4, unit)} · {timeAgo(r.at)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={{ gap: 6 }}>
                <Text style={s.label}>Listing lasts</Text>
                <View style={s.chips}>
                  {(q.days ?? [1, 7, 30]).map((d) => <Chip key={d} label={d === 1 ? '1 day' : `${d} days`} on={days === d} onPress={() => setDays(d)} />)}
                </View>
              </View>

              {net != null && (
                <View style={s.rows}>
                  <Row label="Listing price" value={sol(value, 4, unit)} />
                  <Row label={`OpenSea and creator fees (${trim(feePct)}%)`} value={`−${sol(value - net, 4, unit)}`} />
                  <Row label="You receive when it sells" value={both(net)} strong />
                  {q.floor != null && <Row label="Collection floor" value={sol(q.floor, 4, unit)} />}
                  {q.boughtAt != null && <Row label="You paid" value={sol(q.boughtAt, 4, unit)} />}
                  {pnl != null && <Row label="Profit if it sells" value={`${signedSol(pnl, 4, unit)}${toUsd(pnl, unit) != null ? ` (${signedUsd(toUsd(pnl, unit)!)})` : ''}`} color={pnl >= 0 ? C.up : C.down} />}
                </View>
              )}

              {offerBeats && (
                <Text style={s.warn}>
                  The best offer already pays {sol(q.bestOffer!.net, 4, q.bestOffer!.currency)} after fees, as much as this listing. Selling to it is instant.
                </Text>
              )}
              {underFloor != null && underFloor > 0.1 && (
                <Text style={s.warn}>That&apos;s {Math.round(underFloor * 100)}% under the floor. It will likely sell fast, for less than others are asking.</Text>
              )}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}

              {!q.approved ? (
                <View style={{ gap: 8 }}>
                  <Text style={s.meta}>Step 1 of 2: allow OpenSea to move NFTs from this collection when they sell. Once per collection; a small network fee.</Text>
                  <Pressable accessibilityRole="button" onPress={approve} disabled={busy} style={[s.primary, busy && { opacity: 0.7 }]}>
                    <Text style={s.primaryTxt}>{step.kind === 'approving' ? (step.hash ? 'Waiting for the approval to confirm…' : 'Confirm the approval in your wallet…') : 'Step 1: Approve listing'}</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable accessibilityRole="button" onPress={list} disabled={busy || !(value > 0) || !w.signTypedData}
                  style={[s.primary, (busy || !(value > 0)) && { opacity: 0.6 }]}>
                  <Text style={s.primaryTxt}>
                    {step.kind === 'signing' ? 'Sign the listing in your wallet…'
                      : step.kind === 'cancelOld' ? 'Now sign to cancel the old listing…'
                      : value > 0 ? `${old ? 'Change price to' : 'List for'} ${sol(value, 4, unit)}` : 'Enter a price'}
                  </Text>
                </Pressable>
              )}
              <Text style={s.fine}>
                Listing is a signature, not a transaction: no gas, and nothing leaves your wallet until someone buys. It shows on OpenSea right away.
              </Text>
            </>
          )}

          <Pressable accessibilityRole="button" onPress={close} style={s.secondary}>
            <Text style={s.secondaryTxt}>{step.kind === 'listed' || step.kind === 'cancelled' ? 'Done' : 'Close'}</Text>
          </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={strong ? s.strongLabel : s.meta}>{label}</Text>
      <Text style={[s.val, strong && s.strongVal, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, maxHeight: '100%', backgroundColor: C.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: T.title,
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  name: T.bodyStrong,
  bodyStrong: T.bodyStrong,
  label: T.label,
  meta: T.meta,
  fine: T.caption,
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  unit: { ...T.bodyStrong, minWidth: 44 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  groupTitle: { ...T.caption, color: C.muted, marginTop: 4 },
  recent: { gap: 3, marginTop: 4, padding: 10, borderRadius: 10, backgroundColor: C.cardHi },
  recentRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  oldBox: { gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
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
});
