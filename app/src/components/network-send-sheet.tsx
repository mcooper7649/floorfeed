import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { C } from '@/constants/brand';
import { chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { api, type EvmNetwork, type SendTx } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, shortAddr, usd } from '@/lib/format';
import { useWalletName } from '@/lib/names';
import { usePrices } from '@/lib/prices';
import { useWallet } from '@/lib/wallet';

// Send from one network row of "Money by network" to any address: another
// wallet, a deployer, an exchange. Works with whichever wallet holds the money
// (Phantom/MetaMask or the FloorFeed wallet). The API builds the transfer,
// checks the balance and fee, and simulates it; the wallet shows and signs it.

type Asset = { key: string; label: string; balance: number; token?: string; unit: string };
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const RECENT_KEY = 'floorfeed.recipients';
const rejected = (m: string) => /reject|denied|cancel|closed/i.test(m);
const trim = (n: number, d: number) => n.toFixed(d).replace(/\.?0+$/, '');

// Addresses this browser sent to before, newest first, so a deployer or an
// exchange deposit address is one tap the next time.
type Recent = { address: string; family: 'sol' | 'evm' };
function loadRecent(family: Recent['family']) {
  try { return (JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[]).filter((r) => r.family === family).slice(0, 4); } catch { return []; }
}
function saveRecent(r: Recent) {
  try {
    const all = (JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[]).filter((x) => x.address.toLowerCase() !== r.address.toLowerCase());
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([r, ...all].slice(0, 12)));
  } catch { /* private mode */ }
}

export function NetworkSendSheet({ chain, sol, network, onClose }: {
  chain: string | null;          // the row's network; null = closed
  sol: number | null;            // Solana balance, for the Solana row
  network: EvmNetwork | null;    // the row's EVM network (balances + wrapped tokens)
  onClose: (sent: boolean) => void;
}) {
  if (!chain) return null;
  return <Sheet chain={chain} sol={sol} network={network} onClose={onClose} />;
}

function Sheet({ chain, sol, network, onClose }: { chain: string; sol: number | null; network: EvmNetwork | null; onClose: (sent: boolean) => void }) {
  const w = useEvmWallet();
  const sw = useWallet();
  const { toUsd } = usePrices();
  const solana = chain === 'solana';
  const from = solana ? sw.address : w.address;
  const name = chainName(chain);
  const assets: Asset[] = solana
    ? [{ key: 'SOL', label: 'SOL', balance: sol ?? 0, unit: 'SOL' }]
    : [
        ...(network && (network.balance ?? 0) > 0 ? [{ key: network.native, label: network.native, balance: network.balance!, unit: network.native }] : []),
        ...(network?.tokens ?? []).filter((t) => (t.balance ?? 0) > 0).map((t) => ({ key: t.address, label: t.symbol, balance: t.balance!, token: t.address, unit: t.unit })),
      ];
  const [assetKey, setAssetKey] = useState(assets[0]?.key ?? '');
  const asset = assets.find((a) => a.key === assetKey) ?? assets[0];
  const [to, setTo] = useState('');
  const toName = useWalletName(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(to.trim()) ? to.trim() : null);
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState(false);
  const [quote, setQuote] = useState<SendTx | null>(null);
  const [step, setStep] = useState<'edit' | 'checking' | 'review' | 'sending'>('edit');
  const [hiding, setHiding] = useState(false); // the wallet's prompt is up
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ url: string; text: string } | null>(null);
  const [recent] = useState(() => loadRecent(solana ? 'sol' : 'evm'));

  const request = () => api.sendTx({
    chain, from: from!, to: to.trim(), token: asset?.token,
    ...(max ? { max: true } : { amount: amount.trim() }),
  });

  const review = async () => {
    setError(null);
    const dest = to.trim();
    if (!(solana ? SOL_RE : EVM_RE).test(dest)) return setError(solana ? "That isn't a Solana address." : "That isn't an Ethereum-style address (0x…).");
    if (!max && !(Number(amount) > 0)) return setError('Enter an amount.');
    setStep('checking');
    try {
      setQuote(await request());
      setStep('review');
    } catch (e) {
      setError((e as Error).message || 'Could not check this transfer.');
      setStep('edit');
    }
  };

  const send = async () => {
    if (!from || !quote) return;
    setStep('sending'); setError(null);
    try {
      // Built fresh: a Solana blockhash lasts about a minute, and Max follows the current fee.
      const q = await request();
      setHiding(true);
      let hash: string;
      if (q.solTx) {
        if (!sw.sendTransaction) throw new Error("This Solana wallet can't send from FloorFeed.");
        hash = await sw.sendTransaction(q.solTx.transaction);
      } else {
        if (!w.send || !q.to || q.chainId == null) throw new Error("This wallet can't send from FloorFeed.");
        hash = await w.send({ chainId: q.chainId, to: q.to, data: q.data ?? '0x', value: q.value ?? '0', gas: q.gas, description: `Send ${amt(q.amount, q.symbol)} on ${name} to ${shortAddr(to.trim())}.` });
      }
      const title = `Sent ${amt(q.amount, q.symbol)} to ${shortAddr(to.trim())}`;
      recordTx({ hash, wallet: from, chain, kind: 'send', title, amount: q.amount, unit: q.unit });
      saveRecent({ address: to.trim(), family: solana ? 'sol' : 'evm' });
      track('network_send', { chain, max });
      setSent({ text: `${title}. ${solana ? 'It lands in a few seconds.' : 'It shows once the network confirms it.'}`, url: `${q.solTx?.explorerTx ?? q.explorerTx ?? ''}${hash}` });
    } catch (e) {
      const m = (e as Error).message || 'The transfer did not go through.';
      setError(rejected(m) ? 'You cancelled. Nothing was sent.' : m);
      setStep('review');
    } finally {
      setHiding(false);
    }
  };

  const amountUsd = asset && Number(amount) > 0 ? toUsd(Number(amount), asset.unit) : null;
  return (
    <Modal visible={!hiding} transparent animationType="fade" onRequestClose={() => onClose(!!sent)}>
      <Pressable style={s.backdrop} onPress={() => onClose(!!sent)}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={{ gap: 14 }}>
            <View style={s.head}>
              <Text style={T.title}>Send on {name}</Text>
              <Pressable onPress={() => onClose(!!sent)} hitSlop={10} accessibilityLabel="Close"><Text style={s.close}>✕</Text></Pressable>
            </View>
            {sent ? (
              <View style={s.done}>
                <Text style={[T.bodyStrong, { color: C.up, textAlign: 'center' }]}>{sent.text}</Text>
                {!!sent.url && <Pressable onPress={() => Linking.openURL(sent.url)}><Text style={s.link}>View the transaction ↗</Text></Pressable>}
                <Pressable onPress={() => onClose(true)} style={[s.secondary, { alignSelf: 'stretch' }]}><Text style={s.secondaryTxt}>Done</Text></Pressable>
              </View>
            ) : !from || !asset ? (
              <Text style={T.meta}>Nothing to send on {name} from this wallet yet.</Text>
            ) : step === 'review' || step === 'sending' ? (
              <>
                <View style={s.review}>
                  <Row label="Send" value={amt(quote!.amount, quote!.symbol)} strong />
                  {toUsd(quote!.amount, quote!.unit) != null && <Row label="Worth" value={usd(toUsd(quote!.amount, quote!.unit)!)} />}
                  <Row label="Network" value={name} />
                  <Row label="From" value={shortAddr(from)} />
                  <View style={{ gap: 2 }}>
                    <Text style={T.meta}>To{toName ? <Text style={{ color: C.text, fontWeight: '600' }}> · {toName}</Text> : null}</Text>
                    <Text style={[T.metaNum, { color: C.text }]} selectable>{to.trim()}</Text>
                  </View>
                  <Row label="Network fee" value={`~${trim(quote!.fee, 8)} ${quote!.native}`} />
                </View>
                <Text style={T.caption}>
                  Check every character of the address: transfers can’t be reversed. {solana ? '' : `The receiving wallet or exchange must support ${name}.`}
                </Text>
                <Pressable onPress={send} disabled={step === 'sending'} style={s.primary}>
                  <Text style={s.primaryTxt}>{step === 'sending' ? 'Confirm in your wallet…' : 'Send'}</Text>
                </Pressable>
                <Pressable onPress={() => { setStep('edit'); setError(null); }} style={s.secondary}><Text style={s.secondaryTxt}>Back</Text></Pressable>
              </>
            ) : (
              <>
                <Text style={T.meta}>From {(solana ? sw.walletName : w.walletName) ?? 'your wallet'} {shortAddr(from)}</Text>
                {assets.length > 1 && (
                  <View style={s.chips}>
                    {assets.map((a) => (
                      <Pressable key={a.key} onPress={() => { setAssetKey(a.key); setMax(false); setAmount(''); }} style={[s.chip, asset.key === a.key && s.chipOn]}>
                        <Text style={[s.chipTxt, asset.key === a.key && { color: C.text }]}>{amt(a.balance, a.label)}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                <View style={{ gap: 6 }}>
                  <Text style={T.label}>To ({solana ? 'Solana address' : '0x address'})</Text>
                  <TextInput value={to} onChangeText={setTo} placeholder={solana ? 'e.g. a Phantom or deployer address' : 'e.g. your deployer or MetaMask address'}
                    placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={s.input} />
                  {recent.length > 0 && (
                    <View style={s.chips}>
                      {recent.map((r) => (
                        <Pressable key={r.address} onPress={() => setTo(r.address)} style={[s.chip, to.trim() === r.address && s.chipOn]}>
                          <Text style={s.chipTxt}>{shortAddr(r.address)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
                <View style={{ gap: 6 }}>
                  <Text style={T.label}>Amount ({asset.label}) · you have {amt(asset.balance, asset.label)}</Text>
                  <View style={s.amountRow}>
                    <TextInput value={max ? 'Max' : amount} onChangeText={(v) => { setMax(false); setAmount(v.replace(',', '.')); }} onFocus={() => max && (setMax(false), setAmount(''))}
                      keyboardType="decimal-pad" placeholder="0.0" placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
                    <Pressable onPress={() => setMax(true)} style={[s.max, max && s.chipOn]}><Text style={s.maxTxt}>Max</Text></Pressable>
                  </View>
                  <Text style={T.caption}>
                    {max ? (asset.token ? `All of your ${asset.label}. The fee is paid in ${solana ? 'SOL' : network?.native}.` : 'Everything except the network fee.') : amountUsd != null ? `≈ ${usd(amountUsd)}` : ' '}
                  </Text>
                </View>
                <Pressable onPress={review} disabled={step === 'checking'} style={s.primary}>
                  <Text style={s.primaryTxt}>{step === 'checking' ? 'Checking…' : 'Review'}</Text>
                </Pressable>
              </>
            )}
            {error && <Text style={s.error}>{error}</Text>}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <View style={s.row}>
    <Text style={T.meta}>{label}</Text>
    <Text style={[strong ? T.num : T.metaNum, strong && { fontWeight: '600' }]}>{value}</Text>
  </View>
);

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '90%', backgroundColor: C.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { color: C.dim, fontSize: 16 },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  amountRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  max: { borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 10 },
  maxTxt: { color: C.accent, fontWeight: '600' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  review: { borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  error: { ...T.meta, color: C.down },
  done: { gap: 12, alignItems: 'center', paddingVertical: 8 },
  link: { ...T.label, color: C.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { backgroundColor: C.cardHi, borderColor: C.accent },
  chipTxt: { ...T.caption, color: C.dim, fontWeight: '600' },
});
