import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { C } from '@/constants/brand';
import { CHAINS, chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type BridgeQuote } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { sol } from '@/lib/format';
import { track } from '@/lib/analytics';

// Move funds between EVM chains without leaving FloorFeed. Relay quotes the
// route, the wallet signs one deposit on the origin chain, and Relay pays out
// on the destination (usually seconds). `amount` is what should arrive.

const EVM = ['ethereum', 'base', 'abstract', 'ink', 'arbitrum', 'hyperevm', 'ronin', 'apechain', 'monad'] as const;
const unitOf = (c: string) => CHAINS[c as keyof typeof CHAINS]?.symbol ?? 'ETH';
const usd = (n: number | null) => (n == null ? '—' : n < 0.01 ? '< $0.01' : `$${n.toFixed(2)}`);

type Step = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'moving'; hash: string; url: string; status: string }
  | { kind: 'done'; url: string } | { kind: 'error'; message: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  to?: string;      // destination chain; the user picks one when omitted
  amount?: number;  // suggested amount to arrive, in the destination's token
  note?: string;    // why that amount (shown under the input)
};

// Mounted only while open, so every opening starts from fresh state.
export function BridgeSheet(props: Props) {
  return props.open ? <Sheet {...props} /> : null;
}

function Sheet({ open, onClose, onDone, to: toProp, amount: amountProp, note }: Props) {
  const w = useEvmWallet();
  const [to, setTo] = useState(toProp ?? 'ink');
  const [from, setFrom] = useState<string | null>(null);
  const [amount, setAmount] = useState(amountProp ? String(Math.ceil(amountProp * 1e4) / 1e4) : '');
  const [balances, setBalances] = useState<{ address: string; b: Record<string, number> } | null>(null);
  const [quote, setQuote] = useState<{ key: string; q?: BridgeQuote; error?: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { track('bridge_open', { to: toProp ?? 'any' }); }, [toProp]);
  useEffect(() => {
    if (!w.address) return;
    const address = w.address;
    api.evmBalance(address).then((b) => setBalances({ address, b })).catch(() => setBalances({ address, b: {} }));
  }, [w.address]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);
  const bal = balances?.address === w.address ? balances.b : null;

  // Origins: chains where the wallet has a balance, same token as the destination first.
  const origins = EVM.filter((c) => c !== to && (bal?.[c] ?? 0) > 0)
    .sort((a, b) => Number(unitOf(b) === unitOf(to)) - Number(unitOf(a) === unitOf(to)) || (bal![b] - bal![a]));
  const origin = from && origins.includes(from as (typeof EVM)[number]) ? from : origins[0] ?? null;

  const value = Number(amount);
  const key = `${origin}:${to}:${amount}:${w.address}`;
  useEffect(() => {
    if (!open || !origin || !w.address || !(value > 0)) return;
    let alive = true;
    const t = setTimeout(() => {
      api.bridgeQuote({ user: w.address!, from: origin, to, amount: value })
        .then((q) => alive && setQuote({ key, q }))
        .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [open, origin, to, value, w.address, key]);
  const current = quote?.key === key ? quote : null;
  const q = current?.q ?? null;

  const close = () => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
    onClose();
  };

  const bridge = async () => {
    if (!q?.tx || !w.send) return;
    setStep({ kind: 'confirm' });
    try {
      const hash = await w.send({ ...q.tx, description: `Bridge ${sol(q.send, 5, q.sendUnit)} from ${chainName(q.from)} to ${chainName(q.to)}` });
      track('bridge_signed', { from: q.from, to: q.to });
      const url = `${q.tx.explorerTx ?? 'https://etherscan.io/tx/'}${hash}`;
      setStep({ kind: 'moving', hash, url, status: 'waiting' });
      if (!q.requestId) return;
      const started = Date.now();
      poll.current = setInterval(async () => {
        const r = await api.bridgeStatus(q.requestId!).catch(() => null);
        if (r?.status === 'success') {
          clearInterval(poll.current!); poll.current = null;
          setStep({ kind: 'done', url });
          onDone?.();
        } else if (r?.status === 'failure' || r?.status === 'refund') {
          clearInterval(poll.current!); poll.current = null;
          setStep({ kind: 'error', message: r.status === 'refund' ? `The bridge was refunded to your wallet on ${chainName(q.from)}.` : 'The bridge failed. Check the transaction for details.' });
        } else if (r) {
          setStep((s) => (s.kind === 'moving' ? { ...s, status: r.status } : s));
        }
        if (Date.now() - started > 10 * 60_000 && poll.current) { clearInterval(poll.current); poll.current = null; }
      }, 3_000);
    } catch (e) {
      const msg = (e as Error).message || 'The bridge did not go through.';
      setStep({ kind: 'error', message: /reject|denied|cancel/i.test(msg) ? 'You cancelled in your wallet. Nothing was sent.' : msg });
    }
  };

  const toUnit = unitOf(to);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <Text style={s.title}>{toProp ? `Move funds to ${chainName(to)}` : 'Move funds between networks'}</Text>

          {!w.address ? (
            <Text style={s.meta}>Sign in or connect an Ethereum wallet first.</Text>
          ) : step.kind === 'moving' || step.kind === 'done' ? (
            <View style={{ gap: 10 }}>
              {step.kind === 'done' ? (
                <Text style={s.ok}>✓ Arrived on {chainName(to)}</Text>
              ) : (
                <View style={s.loadingRow}>
                  <ActivityIndicator color={C.accent} />
                  <Text style={s.bodyStrong}>{step.status === 'pending' ? `Delivering on ${chainName(to)}…` : 'Waiting for your deposit to land…'}</Text>
                </View>
              )}
              <Text style={s.meta}>
                {step.kind === 'done'
                  ? `${q ? sol(q.receive, 5, q.receiveUnit) : 'Your funds'} ${q ? 'is' : 'are'} in your wallet on ${chainName(to)}.`
                  : 'This usually takes a few seconds once your transaction confirms. You can close this; the funds still arrive.'}
              </Text>
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(step.url)}>
                <Text style={s.link}>View deposit transaction ↗</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {!toProp && (
                <View style={{ gap: 6 }}>
                  <Text style={s.label}>To</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                    {EVM.map((c) => <Chip key={c} label={chainName(c)} on={to === c} onPress={() => setTo(c)} />)}
                  </ScrollView>
                </View>
              )}

              <View style={{ gap: 6 }}>
                <Text style={s.label}>From</Text>
                {bal == null ? <ActivityIndicator color={C.accent} style={{ alignSelf: 'flex-start' }} />
                  : origins.length === 0 ? (
                    <Text style={s.meta}>Your wallet has no funds on another network to move. Deposit first.</Text>
                  ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                      {origins.map((c) => (
                        <Chip key={c} label={`${chainName(c)} · ${sol(bal[c], 4, unitOf(c))}`} on={origin === c} onPress={() => setFrom(c)} />
                      ))}
                    </ScrollView>
                  )}
              </View>

              {origin && (
                <View style={{ gap: 6 }}>
                  <Text style={s.label}>Amount to receive on {chainName(to)}</Text>
                  <View style={s.inputRow}>
                    <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.0"
                      placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
                    <Text style={s.unit}>{toUnit}</Text>
                  </View>
                  {note && <Text style={s.fine}>{note}</Text>}
                </View>
              )}

              {origin && value > 0 && (
                !current ? (
                  <View style={s.loadingRow}><ActivityIndicator color={C.accent} /><Text style={s.meta}>Finding a route…</Text></View>
                ) : current.error ? (
                  <Text style={s.err}>{current.error}</Text>
                ) : q && (
                  <View style={s.rows}>
                    <Row label="You send" value={`${sol(q.send, 5, q.sendUnit)} on ${chainName(q.from)}`} />
                    <Row label="You receive" value={`${sol(q.receive, 5, q.receiveUnit)} on ${chainName(q.to)}`} strong />
                    <Row label="Bridge fee" value={usd(q.feeUsd)} />
                    <Row label="Network fee" value={`≈ ${usd(q.gasUsd)}`} />
                    <Row label="Time" value={q.seconds != null && q.seconds <= 60 ? 'Seconds' : q.seconds != null ? `About ${Math.ceil(q.seconds / 60)} min` : '—'} />
                  </View>
                )
              )}
              {q?.problem && <Text style={s.err}>{q.problem}</Text>}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}

              {q?.tx && w.send && (
                <Pressable accessibilityRole="button" onPress={bridge} disabled={step.kind === 'confirm'}
                  style={[s.primary, step.kind === 'confirm' && { opacity: 0.7 }]}>
                  <Text style={s.primaryTxt}>{step.kind === 'confirm' ? 'Confirm in your wallet…' : `Move ${sol(q.receive, 4, q.receiveUnit)} to ${chainName(q.to)}`}</Text>
                </Pressable>
              )}
              <Text style={s.fine}>Routed by Relay. Your wallet signs one deposit; FloorFeed never holds your funds.</Text>
            </>
          )}

          <Pressable accessibilityRole="button" onPress={close} style={s.secondary}>
            <Text style={s.secondaryTxt}>{step.kind === 'done' ? (onDone ? 'Continue' : 'Done') : step.kind === 'moving' ? 'Close' : 'Cancel'}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={strong ? s.strongLabel : s.meta}>{label}</Text>
      <Text style={[s.val, strong && s.bodyStrong]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: C.card, borderRadius: 20, padding: 20, gap: 14, borderWidth: 1, borderColor: C.border },
  title: T.title,
  label: T.label,
  meta: T.meta,
  fine: T.caption,
  bodyStrong: T.bodyStrong,
  chips: { gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  unit: { ...T.bodyStrong, minWidth: 44 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  val: { ...T.metaNum, color: C.text, flexShrink: 1, textAlign: 'right' },
  strongLabel: { ...T.meta, color: C.text },
  err: { ...T.meta, color: C.down },
  ok: { ...T.title, color: C.up },
  link: { ...T.label, textAlign: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
});
