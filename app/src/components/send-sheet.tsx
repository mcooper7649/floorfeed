import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type Chain, type Holding } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { shortAddr } from '@/lib/format';

// Withdrawals from the FloorFeed (Privy) wallets: send SOL, send ETH (or a
// chain's native coin), send an NFT on Ethereum chains, or export the wallet's
// key to Phantom/MetaMask through Privy's own screen. Every send is shown and
// confirmed in Privy's prompt; FloorFeed only builds the transaction.

type Tab = 'sol' | 'evm' | 'nft' | 'export';
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_FEE = 0.000005;
const RENT_MIN = 0.00089088; // a Solana account must keep at least this, or be emptied

// Decimal string → integer units (lamports / wei) without float rounding.
function toUnits(amount: string, decimals: number) {
  const [w, f = ''] = amount.trim().split('.');
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f) || (!w && !f)) return null;
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
const trim = (n: number, d: number) => n.toFixed(d).replace(/\.?0+$/, '');

export function SendSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false); // Privy's prompt is up: hide this sheet
  const tabs: { key: Tab; label: string; on: boolean }[] = [
    { key: 'sol', label: 'SOL', on: !!auth.sendSol },
    { key: 'evm', label: 'ETH', on: !!auth.sendEvm },
    { key: 'nft', label: 'NFT', on: !!auth.embeddedAddress || !!auth.evmAddress },
    { key: 'export', label: 'Export', on: !!auth.exportSolana || !!auth.exportEvm },
  ];
  const [tab, setTab] = useState<Tab>('sol');
  const current = tabs.find((t) => t.key === tab && t.on) ? tab : tabs.find((t) => t.on)?.key ?? 'export';
  return (
    <Modal visible={open && !busy} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={{ gap: 14 }}>
            <View style={s.head}>
              <Text style={T.title}>Send or withdraw</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close"><Text style={s.close}>✕</Text></Pressable>
            </View>
            <View style={s.tabs}>
              {tabs.filter((t) => t.on).map((t) => (
                <Pressable key={t.key} onPress={() => setTab(t.key)} style={[s.tab, current === t.key && s.tabOn]}>
                  <Text style={[s.tabTxt, current === t.key && { color: C.text }]}>{t.label}</Text>
                </Pressable>
              ))}
            </View>
            {open && current === 'sol' && <SendSol setBusy={setBusy} />}
            {open && current === 'evm' && <SendEvm setBusy={setBusy} />}
            {open && current === 'nft' && <SendNft setBusy={setBusy} onExport={() => setTab('export')} />}
            {open && current === 'export' && <Export setBusy={setBusy} />}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

type Busy = { setBusy: (b: boolean) => void };

function Done({ text, url }: { text: string; url: string }) {
  return (
    <View style={s.done}>
      <Text style={[T.bodyStrong, { color: C.up }]}>{text}</Text>
      <Pressable onPress={() => Linking.openURL(url)}><Text style={s.link}>View the transaction ↗</Text></Pressable>
    </View>
  );
}

const Field = ({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) => (
  <View style={{ gap: 6 }}>
    <Text style={T.label}>{label}</Text>
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.muted}
      autoCapitalize="none" autoCorrect={false} style={[s.input, mono && { fontVariant: ['tabular-nums'] }]} />
  </View>
);

const rejected = (m: string) => /reject|denied|cancel|closed/i.test(m);

// --- SOL -----------------------------------------------------------------------------

function SendSol({ setBusy }: Busy) {
  const auth = useAuth();
  const from = auth.embeddedAddress!;
  const [balance, setBalance] = useState<number | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'edit' | 'review' | 'sending'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => { api.balance(from).then((b) => setBalance(b.sol)).catch(() => setBalance(null)); }, [from, sent]);

  const max = balance != null ? Math.max(0, balance - SOL_FEE) : 0;
  const review = async () => {
    setError(null);
    const dest = to.trim();
    const amt = Number(amount);
    if (!SOL_RE.test(dest)) return setError("That isn't a Solana address.");
    if (dest === from) return setError("That's this wallet's own address.");
    if (!(amt > 0)) return setError('Enter an amount.');
    if (balance == null || amt > max + 1e-12) return setError(`You can send up to ${trim(max, 6)} SOL (the network fee is about 0.000005 SOL).`);
    const left = balance - amt - SOL_FEE;
    if (left > 1e-9 && left < RENT_MIN) return setError(`Solana needs at least ${RENT_MIN} SOL left in the wallet, or send the Max to empty it.`);
    // A brand-new address only accepts the rent minimum or more.
    const destBal = await api.balance(dest).catch(() => null);
    if (destBal && destBal.lamports === 0 && amt < RENT_MIN) return setError(`That address is new on Solana: send at least ${RENT_MIN} SOL to it.`);
    setStep('review');
  };
  const send = async () => {
    setStep('sending'); setError(null);
    try {
      const lamports = toUnits(amount, 9);
      if (lamports == null) throw new Error('Enter a valid amount.');
      const bh = await api.blockhash();
      setBusy(true);
      const sig = await auth.sendSol!({ to: to.trim(), lamports: lamports.toString(), ...bh });
      setSent(sig); setAmount(''); setTo('');
    } catch (e) {
      const m = (e as Error).message || 'The transfer did not go through.';
      setError(rejected(m) ? 'You cancelled. Nothing was sent.' : m);
    } finally {
      setBusy(false); setStep('edit');
    }
  };

  if (sent) return <Done text="Sent. It lands in a few seconds." url={`https://solscan.io/tx/${sent}`} />;
  return (
    <View style={{ gap: 12 }}>
      <Text style={T.meta}>From your FloorFeed Solana wallet {shortAddr(from)} · {balance == null ? '…' : `${trim(balance, 6)} SOL`}</Text>
      {step === 'edit' ? (
        <>
          <Field label="To (Solana address)" value={to} onChange={setTo} placeholder="e.g. your Phantom address" />
          <View style={{ gap: 6 }}>
            <Text style={T.label}>Amount (SOL)</Text>
            <View style={s.amountRow}>
              <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.0" placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
              <Pressable onPress={() => setAmount(trim(max, 9))} style={s.max}><Text style={s.maxTxt}>Max</Text></Pressable>
            </View>
          </View>
          <Pressable onPress={review} style={s.primary}><Text style={s.primaryTxt}>Review</Text></Pressable>
        </>
      ) : (
        <>
          <View style={s.review}>
            <Row label="Send" value={`${amount} SOL`} strong />
            <Row label="To" value={shortAddr(to.trim())} />
            <Row label="Network fee" value="~0.000005 SOL" />
          </View>
          <Text style={T.caption}>Solana transfers can’t be reversed. Double-check the address.</Text>
          <Pressable onPress={send} disabled={step === 'sending'} style={s.primary}>
            <Text style={s.primaryTxt}>{step === 'sending' ? 'Waiting for confirmation…' : 'Send'}</Text>
          </Pressable>
          <Pressable onPress={() => setStep('edit')} style={s.secondary}><Text style={s.secondaryTxt}>Back</Text></Pressable>
        </>
      )}
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

// --- ETH / native coin on an EVM chain --------------------------------------------

function SendEvm({ setBusy }: Busy) {
  const auth = useAuth();
  const from = auth.evmAddress!;
  const [balances, setBalances] = useState<Record<string, number> | null>(null);
  const [chain, setChain] = useState<Chain>('ethereum');
  const [fee, setFee] = useState<{ key: string; fee: number; chainId: number; native: string } | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'edit' | 'review' | 'sending'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; chain: Chain } | null>(null);

  useEffect(() => {
    api.evmBalance(from).then((b) => {
      const { eth: _total, ...per } = b;
      setBalances(per);
      const top = Object.entries(per).sort((x, y) => y[1] - x[1])[0];
      if (top && top[1] > 0) setChain(top[0] as Chain);
    }).catch(() => setBalances({}));
  }, [from, sent]);
  useEffect(() => {
    let alive = true;
    api.evmTransferFee(chain).then((f) => alive && setFee({ key: chain, ...f })).catch(() => {});
    return () => { alive = false; };
  }, [chain]);

  const native = CHAINS[chain]?.symbol ?? 'ETH';
  const bal = balances?.[chain] ?? 0;
  const feeNow = fee?.key === chain ? fee.fee : null;
  const max = feeNow != null ? Math.max(0, bal - feeNow) : 0;
  const withFunds = Object.entries(balances ?? {}).filter(([, v]) => v > 0);

  const review = () => {
    setError(null);
    const amt = Number(amount);
    if (!EVM_RE.test(to.trim())) return setError("That isn't an Ethereum-style address (0x…).");
    if (to.trim().toLowerCase() === from.toLowerCase()) return setError("That's this wallet's own address.");
    if (!(amt > 0)) return setError('Enter an amount.');
    if (feeNow == null) return setError('Still checking the network fee. Try again in a moment.');
    if (amt > max + 1e-12) return setError(`You can send up to ${trim(max, 8)} ${native} on ${CHAINS[chain].name} (after the network fee).`);
    setStep('review');
  };
  const send = async () => {
    setStep('sending'); setError(null);
    try {
      const wei = toUnits(amount, 18);
      if (wei == null || !fee) throw new Error('Enter a valid amount.');
      setBusy(true);
      const hash = await auth.sendEvm!({
        chainId: fee.chainId, to: to.trim(), data: '0x', value: wei.toString(),
        description: `Send ${amount} ${native} to ${shortAddr(to.trim())}.`,
      });
      setSent({ hash, chain }); setAmount(''); setTo('');
    } catch (e) {
      const m = (e as Error).message || 'The transfer did not go through.';
      setError(rejected(m) ? 'You cancelled. Nothing was sent.' : m);
    } finally {
      setBusy(false); setStep('edit');
    }
  };

  if (sent) return <Done text="Sent." url={`${CHAINS[sent.chain]?.explorer ?? 'https://etherscan.io'}/tx/${sent.hash}`} />;
  if (!balances) return <ActivityIndicator color={C.accent} />;
  return (
    <View style={{ gap: 12 }}>
      <Text style={T.meta}>From your FloorFeed Ethereum wallet {shortAddr(from)}</Text>
      {withFunds.length === 0 ? <Text style={T.meta}>This wallet has no ETH (or other native coin) on any chain yet.</Text> : (
        <View style={s.chips}>
          {withFunds.map(([c, v]) => (
            <Pressable key={c} onPress={() => setChain(c as Chain)} style={[s.chip, chain === c && s.chipOn]}>
              <Text style={[s.chipTxt, chain === c && { color: C.text }]}>{CHAINS[c as Chain]?.name ?? c} · {trim(v, 5)} {CHAINS[c as Chain]?.symbol ?? 'ETH'}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {step === 'edit' ? (
        <>
          <Field label="To (0x address)" value={to} onChange={setTo} placeholder="e.g. your MetaMask address" />
          <View style={{ gap: 6 }}>
            <Text style={T.label}>Amount ({native} on {CHAINS[chain]?.name})</Text>
            <View style={s.amountRow}>
              <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.0" placeholderTextColor={C.muted} style={[s.input, { flex: 1 }]} />
              <Pressable onPress={() => setAmount(trim(max, 12))} style={s.max}><Text style={s.maxTxt}>Max</Text></Pressable>
            </View>
          </View>
          <Pressable onPress={review} style={s.primary}><Text style={s.primaryTxt}>Review</Text></Pressable>
        </>
      ) : (
        <>
          <View style={s.review}>
            <Row label="Send" value={`${amount} ${native}`} strong />
            <Row label="Network" value={CHAINS[chain]?.name ?? chain} />
            <Row label="To" value={shortAddr(to.trim())} />
            <Row label="Network fee" value={feeNow != null ? `~${trim(feeNow, 8)} ${native}` : '…'} />
          </View>
          <Text style={T.caption}>Make sure the receiving wallet supports {CHAINS[chain]?.name}. Transfers can’t be reversed.</Text>
          <Pressable onPress={send} disabled={step === 'sending'} style={s.primary}>
            <Text style={s.primaryTxt}>{step === 'sending' ? 'Waiting for confirmation…' : 'Send'}</Text>
          </Pressable>
          <Pressable onPress={() => setStep('edit')} style={s.secondary}><Text style={s.secondaryTxt}>Back</Text></Pressable>
        </>
      )}
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

// --- NFTs ----------------------------------------------------------------------------

function SendNft({ setBusy, onExport }: Busy & { onExport: () => void }) {
  const auth = useAuth();
  const [evmNfts, setEvmNfts] = useState<Holding[] | null>(null);
  const [solCount, setSolCount] = useState<number | null>(null);
  const [pick, setPick] = useState<Holding | null>(null);
  const [to, setTo] = useState('');
  const [busyHere, setBusyHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; chain: string } | null>(null);

  useEffect(() => {
    (auth.evmAddress ? api.evmHoldings(auth.evmAddress).then((h) => h.nfts) : Promise.resolve([] as Holding[]))
      .then(setEvmNfts).catch(() => setEvmNfts([]));
    if (auth.embeddedAddress) api.holdings(auth.embeddedAddress).then((h) => setSolCount(h.nfts.length + h.untracked)).catch(() => setSolCount(0));
  }, [auth.evmAddress, auth.embeddedAddress, sent]);

  const send = async () => {
    if (!pick || !auth.evmAddress || !auth.sendEvm) return;
    setError(null);
    if (!EVM_RE.test(to.trim())) { setError("That isn't an Ethereum-style address (0x…)."); return; }
    const [contract, tokenId] = pick.mint.split(':');
    setBusyHere(true);
    try {
      const tx = await api.evmNftTransfer({ chain: pick.chain ?? 'ethereum', contract, tokenId, from: auth.evmAddress, to: to.trim() });
      setBusy(true);
      const hash = await auth.sendEvm({ ...tx, description: `Send ${pick.name ?? 'this NFT'} to ${shortAddr(to.trim())}.` });
      setSent({ hash, chain: pick.chain ?? 'ethereum' }); setPick(null); setTo('');
    } catch (e) {
      const m = (e as Error).message || 'The transfer did not go through.';
      setError(rejected(m) ? 'You cancelled. Nothing was sent.' : m);
    } finally {
      setBusy(false); setBusyHere(false);
    }
  };

  if (sent) return <Done text="NFT sent." url={`${CHAINS[sent.chain as Chain]?.explorer ?? 'https://etherscan.io'}/tx/${sent.hash}`} />;
  return (
    <View style={{ gap: 12 }}>
      {solCount != null && solCount > 0 && (
        <View style={s.notice}>
          <Text style={T.bodyStrong}>Solana NFTs ({solCount})</Text>
          <Text style={T.meta}>Most Solana collections use programmable or Core NFTs, which need their own transfer. To move them, export this wallet to Phantom: everything in it comes along.</Text>
          <Pressable onPress={onExport}><Text style={s.link}>Export the wallet →</Text></Pressable>
        </View>
      )}
      {evmNfts == null ? <ActivityIndicator color={C.accent} /> : evmNfts.length === 0 ? (
        <Text style={T.meta}>No NFTs from tracked Ethereum-chain collections in your FloorFeed wallet.</Text>
      ) : !pick ? (
        <View style={{ gap: 8 }}>
          <Text style={T.label}>Pick an NFT to send</Text>
          {evmNfts.map((n) => (
            <Pressable key={n.mint} onPress={() => setPick(n)} style={s.nft}>
              <View style={{ width: 40, height: 40 }}><NftImage uri={n.image} name={n.name ?? n.collection.name} radius={8} px={80} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={T.bodyStrong} numberOfLines={1}>{n.name ?? n.collection.name}</Text>
                <Text style={T.metaNum}>{n.collection.name} · {CHAINS[(n.chain ?? 'ethereum') as Chain]?.name}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <>
          <View style={s.nft}>
            <View style={{ width: 40, height: 40 }}><NftImage uri={pick.image} name={pick.name ?? pick.collection.name} radius={8} px={80} /></View>
            <Text style={[T.bodyStrong, { flex: 1 }]} numberOfLines={1}>{pick.name ?? pick.collection.name}</Text>
            <Pressable onPress={() => setPick(null)}><Text style={s.link}>Change</Text></Pressable>
          </View>
          <Field label="To (0x address)" value={to} onChange={setTo} placeholder="e.g. your MetaMask address" />
          <Text style={T.caption}>FloorFeed checks you own it and simulates the transfer before you sign. Gas is paid in {CHAINS[(pick.chain ?? 'ethereum') as Chain]?.symbol ?? 'ETH'}.</Text>
          <Pressable onPress={send} disabled={busyHere} style={s.primary}>
            <Text style={s.primaryTxt}>{busyHere ? 'Preparing…' : 'Send NFT'}</Text>
          </Pressable>
        </>
      )}
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

// --- Export -------------------------------------------------------------------------

function Export({ setBusy }: Busy) {
  const auth = useAuth();
  const run = async (fn: (() => Promise<void>) | null) => {
    if (!fn) return;
    setBusy(true);
    try { await fn(); } catch { /* closed */ } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={T.meta}>
        Take full control of your FloorFeed wallet in Phantom, Backpack or MetaMask. Privy shows the private key on its own secure screen; FloorFeed never sees it. Import it into the other wallet and everything comes with it: coins, tokens and NFTs.
      </Text>
      <Text style={[T.caption, { color: C.down }]}>Anyone with this key controls the wallet. Never paste it into a website or share it with anyone, including us.</Text>
      {auth.exportSolana && (
        <Pressable onPress={() => run(auth.exportSolana)} style={s.primary}><Text style={s.primaryTxt}>Export Solana wallet</Text></Pressable>
      )}
      {auth.exportEvm && (
        <Pressable onPress={() => run(auth.exportEvm)} style={s.secondary}><Text style={s.secondaryTxt}>Export Ethereum wallet</Text></Pressable>
      )}
    </View>
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
  tabs: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: C.border },
  tab: { flex: 1, borderRadius: 9, paddingVertical: 8, alignItems: 'center' },
  tabOn: { backgroundColor: C.cardHi },
  tabTxt: { color: C.dim, fontSize: 14, fontWeight: '600' },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  amountRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  max: { borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 10 },
  maxTxt: { color: C.accent, fontWeight: '600' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  review: { borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  error: { ...T.meta, color: C.down },
  done: { gap: 8, alignItems: 'center', paddingVertical: 12 },
  link: { ...T.label, color: C.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { backgroundColor: C.cardHi, borderColor: C.accent },
  chipTxt: { ...T.caption, color: C.dim, fontWeight: '600' },
  nft: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  notice: { backgroundColor: C.bg, borderRadius: 12, padding: 12, gap: 6, borderWidth: 1, borderColor: C.border },
});
