import { Image } from 'expo-image';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useWallet } from '@/lib/wallet';

// "Deposit": get SOL (or ETH) into the active wallet, two ways. Buy with a card or
// Apple Pay through Privy's funding flow (MoonPay / Coinbase do the payment
// and any ID checks), or send SOL from an exchange or another wallet to the
// address / QR. The balance polls while the sheet is open, so a deposit shows
// up here as soon as it lands.
const AMOUNTS = { solana: [0.25, 0.5, 1, 2], ethereum: [0.01, 0.05, 0.1, 0.25] };
const UNIT = { solana: 'SOL', ethereum: 'ETH' } as const;
type DepositChain = keyof typeof UNIT;
const POLL_MS = 5000;

export function DepositSheet({ open, onClose, suggest, chain = 'solana' }: {
  open: boolean;
  onClose: () => void;
  suggest?: number; // amount the user is short by, preselected when given
  chain?: DepositChain; // SOL to the Solana wallet, or ETH to the Ethereum one
}) {
  // Privy draws its own modal; hide ours while it's up so they don't stack.
  const [funding, setFunding] = useState(false);
  return (
    <Modal visible={open && !funding} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          {open && <Body onClose={onClose} suggest={suggest} setFunding={setFunding} chain={chain} />}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Body({ onClose, suggest, setFunding, chain }: {
  onClose: () => void;
  suggest?: number;
  setFunding: (v: boolean) => void;
  chain: DepositChain;
}) {
  const sw = useWallet();
  const ew = useEvmWallet();
  const w = chain === 'ethereum' ? ew : sw;
  const auth = useAuth();
  const address = w.address;
  const unit = UNIT[chain];
  const base = AMOUNTS[chain];
  const step = chain === 'ethereum' ? 1000 : 100;
  const amounts = suggest && suggest > 0
    ? [...new Set([Math.ceil(suggest * step) / step, ...base])].sort((a, b) => a - b).slice(0, 4)
    : base;
  const [amount, setAmount] = useState(suggest && suggest > 0 ? amounts.find((a) => a >= suggest)! : base[1]);
  const fundFn = chain === 'ethereum' ? auth.fundEth : auth.fund;
  const [qr, setQr] = useState<string | null>(null);
  const [bal, setBal] = useState<number | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    QRCode.toString(address, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B0B10', light: '#FFFFFF' } })
      .then((svg) => alive && setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    const tick = () => (chain === 'ethereum' ? api.evmBalance(address).then((b) => b.ethereum) : api.balance(address).then((b) => b.sol)).then((v) => {
      if (!alive) return;
      setBal(v);
      setStart((s0) => s0 ?? v);
    }).catch(() => {});
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [address, chain]);

  const received = bal != null && start != null && bal - start > 0.000001 ? bal - start : null;

  const copy = () => {
    if (!address || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const buy = async () => {
    if (!address) return;
    if (!fundFn) { onClose(); auth.login(); return; }
    setError(null);
    setFunding(true);
    try {
      await fundFn(address, String(amount));
    } catch (e) {
      setError((e as Error).message || 'The card flow could not open.');
    } finally {
      setFunding(false);
    }
  };

  if (!address) {
    return (
      <>
        <Text style={s.title}>Deposit {unit}</Text>
        <Text style={s.note}>Sign in or connect a wallet first, then come back here to add {unit}.</Text>
        <Pressable accessibilityRole="button" onPress={() => { onClose(); auth.login(); }} style={s.primary}>
          <Text style={s.primaryTxt}>{auth.supported ? 'Sign in' : 'Close'}</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      <View style={s.head}>
        <Text style={s.title}>Deposit {unit}</Text>
        <Text style={s.balance}>{bal != null ? `${bal.toFixed(4)} ${unit}` : '…'}</Text>
      </View>
      <Text style={s.meta}>To {w.walletName ?? 'your wallet'} · {address.slice(0, 4)}…{address.slice(-4)}</Text>

      {received != null && (
        <View style={s.received}>
          <Text style={s.receivedTxt}>✓ Received +{received.toFixed(4)} {unit}</Text>
          <Text style={s.meta}>You can buy now.</Text>
        </View>
      )}

      <Text style={s.label}>Buy with card or Apple Pay</Text>
      <View style={s.chips}>
        {amounts.map((a) => (
          <Pressable key={a} accessibilityRole="button" onPress={() => setAmount(a)} style={[s.chip, amount === a && s.chipOn]}>
            <Text style={[s.chipTxt, amount === a && { color: C.accentInk }]}>{a} {unit}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={buy} style={s.primary}>
        <Text style={s.primaryTxt}>{fundFn ? `Buy ${amount} ${unit}` : 'Sign in to buy with card'}</Text>
      </Pressable>
      <Text style={s.fine}>
        Payment is handled by MoonPay, who may ask for ID the first time. FloorFeed never sees your card. You can change the amount there.
      </Text>
      {error && <Text style={s.err}>{error}</Text>}

      <Text style={s.label}>Or send from an exchange or wallet</Text>
      <View style={s.recv}>
        <View style={s.qrBox}>
          {qr ? <Image source={qr} style={s.qr} contentFit="contain" accessibilityLabel="QR code of your wallet address" /> : null}
        </View>
        <View style={{ flex: 1, gap: 8 }}>
          <Text style={s.addr} selectable>{address}</Text>
          <Pressable accessibilityRole="button" onPress={copy} style={s.secondary}>
            <Text style={s.secondaryTxt}>{copied ? 'Copied ✓' : 'Copy address'}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={s.fine}>
        {chain === 'ethereum'
          ? 'Send ETH on Ethereum mainnet. This address also works on Base, but FloorFeed shows the Ethereum balance here.'
          : 'Send SOL on the Solana network only. Tokens sent on other networks can be lost.'}
      </Text>
      <Text style={s.meta}>{received == null ? 'Watching for your deposit…' : 'Balance updated.'}</Text>

      <Pressable accessibilityRole="button" onPress={onClose} style={s.secondary}>
        <Text style={s.secondaryTxt}>Done</Text>
      </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: C.card, borderRadius: 20, padding: 20, gap: 12, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  title: T.title,
  balance: T.num,
  note: T.meta,
  meta: T.meta,
  fine: T.caption,
  err: { ...T.meta, color: C.down },
  label: { ...T.label, marginTop: 6 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipTxt: { ...T.label, color: C.text },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  recv: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  qrBox: { width: 116, height: 116, borderRadius: 12, backgroundColor: '#FFFFFF', padding: 6 },
  qr: { width: '100%', height: '100%' },
  addr: { ...T.bodyStrong, fontVariant: ['tabular-nums'] },
  received: { padding: 12, borderRadius: 12, backgroundColor: '#3DDC9722', borderWidth: 1, borderColor: C.up, gap: 2 },
  receivedTxt: { ...T.bodyStrong, color: C.up },
});
