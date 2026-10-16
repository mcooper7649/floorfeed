import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { NftImage } from '@/components/nft-image';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { track } from '@/lib/analytics';
import { api, type LaunchedCollection, type LaunchedPhase } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, usd } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { usePrices } from '@/lib/prices';
import { useTitle } from '@/lib/use-title';

// Mint page for a collection launched on FloorFeed (server launch.ts): art,
// phases with eligibility for the connected wallet, quantity, and the mint
// itself (built and simulated by our server, signed in the wallet).

const inWords = (sec: number) => {
  const d = Math.abs(sec);
  if (d >= 86_400) return `${Math.floor(d / 86_400)}d ${Math.floor((d % 86_400) / 3600)}h`;
  if (d >= 3600) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(d / 60))}m`;
};
type Step = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'sent'; url: string; q: number } | { kind: 'error'; message: string };

export default function LaunchedMint() {
  const { chain, address } = useLocalSearchParams<{ chain: string; address: string }>();
  const w = useEvmWallet();
  const auth = useAuth();
  const { mode, canReal, setMode } = useTradeMode();
  const { toUsd } = usePrices();
  const { pad, wide } = useLayout();
  const [c, setC] = useState<LaunchedCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [pick, setPick] = useState<number | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [bridge, setBridge] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useTitle(c ? `Mint ${c.name} on ${c.chainName} | FloorFeed` : 'Mint | FloorFeed');

  const load = useCallback(() => {
    api.launched(chain, address, w.address ?? undefined).then((x) => { setC(x); setError(null); }).catch((e: Error) => setError(e.message));
  }, [chain, address, w.address]);
  useEffect(() => {
    load();
    const t = setInterval(() => { setNow(Math.floor(Date.now() / 1000)); load(); }, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const nav = Platform.OS === 'web' && <TopNav back />;
  if (error && !c) return <View style={s.fill}>{nav}<Empty text="This collection couldn’t be loaded." /></View>;
  if (!c) return <View style={s.fill}>{nav}<ActivityIndicator style={{ marginTop: 40 }} color={C.accent} /></View>;

  // Default phase: the open one this wallet can use, else the first open one, else the next.
  const open = c.phases.filter((p) => p.active);
  const auto = open.find((p) => p.eligible !== false) ?? open[0] ?? c.phases.find((p) => p.start > now) ?? null;
  const phase = (pick != null ? c.phases[pick] : null) ?? auto;
  const left = c.max - c.minted;
  const walletLeft = phase && phase.maxPerWallet ? Math.max(0, phase.maxPerWallet - (phase.mintedByWallet ?? 0)) : 50;
  const maxQty = Math.max(1, Math.min(50, left, walletLeft || 1));
  const q = Math.min(qty, maxQty);
  const each = phase ? phase.price + c.mintFee : 0;
  const total = each * q;
  const totalUsd = toUsd(total, c.native);
  const short = c.balance != null ? total - c.balance : null;
  const blocked = !phase ? 'No mint phase is set.' : c.soldOut ? 'Sold out.' : !phase.active ? (phase.start > now ? `Opens in ${inWords(phase.start - now)}.` : 'This phase has ended.')
    : phase.eligible === false ? 'This wallet isn’t on the list for this phase.' : walletLeft === 0 && phase.maxPerWallet ? 'You’ve minted the most this phase allows.' : null;

  const mint = async () => {
    if (!w.address || !w.send || !phase) return;
    setStep({ kind: 'busy', text: 'Checking the mint…' });
    try {
      const tx = await api.launchMintTx(c.chain, c.address, { minter: w.address, phase: phase.index, quantity: q });
      setStep({ kind: 'busy', text: 'Confirm in your wallet…' });
      const hash = await w.send({ ...tx, description: `Mint ${q} ${c.name} for ${amt(tx.total, tx.unit)} on ${c.chainName}` });
      track('launch_mint', { chain: c.chain, quantity: q });
      recordTx({ hash, wallet: w.address, chain: c.chain, kind: 'mint', title: `Minted ${q} ${c.name}`, amount: tx.total, unit: tx.unit });
      setStep({ kind: 'sent', url: `${tx.explorerTx}${hash}`, q });
      setTimeout(load, 6000);
    } catch (e) {
      const m = (e as Error).message || 'The mint didn’t go through.';
      setStep({ kind: 'error', message: /reject|denied|cancel/i.test(m) ? 'You cancelled in your wallet. Nothing was sent.' : m });
    }
  };

  const pct = c.max ? Math.min(100, (c.minted / c.max) * 100) : 0;
  const box = (
    <Card style={{ gap: 12 }}>
      <View style={s.bar}><View style={[s.barFill, { width: `${Math.max(1, pct)}%` }]} /></View>
      <Text style={T.metaNum}>{c.minted.toLocaleString()} / {c.max.toLocaleString()} minted ({pct.toFixed(pct < 10 ? 1 : 0)}%)</Text>

      {c.phases.length > 1 && (
        <View style={s.phases}>
          {c.phases.map((p) => <PhaseChip key={p.index} p={p} on={phase?.index === p.index} now={now} unit={c.native} onPress={() => setPick(p.index)} />)}
        </View>
      )}
      {phase && (
        <View style={{ gap: 2 }}>
          <Text style={T.meta}>{phase.name}{phase.allowlist ? ` · allowlist (${phase.allowlistSize?.toLocaleString() ?? '?'} wallets)` : /public/i.test(phase.name) ? '' : ' · public'}{phase.maxPerWallet ? ` · ${phase.maxPerWallet} per wallet` : ''}</Text>
          <Text {...display} style={[T.hero, { color: C.text }]}>{phase.price === 0 ? 'Free' : amt(phase.price, c.native)}</Text>
          {c.mintFee > 0 && <Text style={T.caption}>+ {amt(c.mintFee, c.native)} FloorFeed fee per NFT</Text>}
        </View>
      )}

      {step.kind === 'sent' ? (
        <View style={{ gap: 8 }}>
          <Text style={[T.title, { color: C.up }]}>✓ Mint submitted</Text>
          <Text style={T.meta}>It confirms in about a minute; your NFT{step.q > 1 ? 's' : ''} then show{step.q > 1 ? '' : 's'} in your Portfolio.</Text>
          <Pressable onPress={() => Linking.openURL(step.url)}><Text style={s.link}>View transaction ↗</Text></Pressable>
          <Pressable onPress={() => setStep({ kind: 'idle' })} style={s.secondary}><Text style={s.secondaryTxt}>Mint more</Text></Pressable>
        </View>
      ) : mode === 'paper' && canReal ? (
        <View style={{ gap: 8 }}>
          <Text style={T.meta}>Minting uses real money, so it isn’t part of paper trading.</Text>
          <Pressable onPress={() => setMode('real')} style={s.primary}><Text style={s.primaryTxt}>Switch to Real to mint</Text></Pressable>
        </View>
      ) : !w.address ? (
        <View style={{ gap: 8 }}>
          <Text style={T.meta}>Minting needs a wallet. Sign in for a free FloorFeed wallet, or connect one.</Text>
          {auth.supported && !auth.userId && <Pressable onPress={() => auth.login()} style={s.primary}><Text style={s.primaryTxt}>Sign in to mint</Text></Pressable>}
          {w.available.map((o) => <Pressable key={o.name} onPress={() => w.connect(o.name)} style={s.secondary}><Text style={s.secondaryTxt}>Connect {o.name}</Text></Pressable>)}
        </View>
      ) : blocked ? (
        <Text style={[T.body, { color: C.dim }]}>{blocked}</Text>
      ) : (
        <View style={{ gap: 10 }}>
          <View style={s.qtyRow}>
            <Text style={[T.meta, { flex: 1 }]}>Quantity</Text>
            <Pressable accessibilityLabel="Fewer" onPress={() => setQty(Math.max(1, q - 1))} style={s.qtyBtn}><Text style={s.qtyTxt}>−</Text></Pressable>
            <Text style={[T.num, { minWidth: 28, textAlign: 'center' }]}>{q}</Text>
            <Pressable accessibilityLabel="More" onPress={() => setQty(Math.min(maxQty, q + 1))} style={s.qtyBtn}><Text style={s.qtyTxt}>+</Text></Pressable>
          </View>
          <View style={s.rows}>
            <Row label="Total" value={`${amt(total, c.native)}${totalUsd != null ? ` · ${usd(totalUsd)}` : ''}`} strong />
            <Row label={`Your ${c.native} on ${c.chainName}`} value={c.balance != null ? amt(c.balance, c.native) : '—'} />
          </View>
          {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}
          {short != null && short > 0 ? (
            <>
              <Text style={s.err}>You need about {amt(short, c.native)} more {c.native} on {c.chainName}, plus gas.</Text>
              <Pressable onPress={() => setBridge(short + Math.max(total * 0.05, 0.0003))} style={s.primary}><Text style={s.primaryTxt}>Move {c.native} to {c.chainName}</Text></Pressable>
            </>
          ) : (
            <Pressable onPress={mint} disabled={step.kind === 'busy'} style={[s.primary, step.kind === 'busy' && { opacity: 0.7 }]}>
              <Text style={s.primaryTxt}>{step.kind === 'busy' ? step.text : `Mint ${q} for ${amt(total, c.native)}`}</Text>
            </Pressable>
          )}
        </View>
      )}
    </Card>
  );

  const info = (
    <View style={{ gap: 10 }}>
      {c.description ? <Text style={T.body}>{c.description}</Text> : null}
      <Text style={T.caption}>
        Launched on FloorFeed by {c.creator.slice(0, 6)}…{c.creator.slice(-4)} · {c.royaltyBps / 100}% creator earnings · {c.revealed ? 'revealed' : 'art revealed after the mint'}
      </Text>
      <View style={s.links}>
        {c.website && <Pressable onPress={() => Linking.openURL(c.website!)} style={s.chip}><Text style={T.label}>Website ↗</Text></Pressable>}
        {c.twitter && <Pressable onPress={() => Linking.openURL(`https://x.com/${c.twitter}`)} style={s.chip}><Text style={T.label}>X ↗</Text></Pressable>}
        <Pressable onPress={() => Linking.openURL(`${c.explorer}/address/${c.address}`)} style={s.chip}><Text style={T.label}>Contract ↗</Text></Pressable>
      </View>
      <Text style={T.caption}>New collections are risky; most lose value. FloorFeed checks every mint against the contract before your wallet signs.</Text>
    </View>
  );

  return (
    <View style={s.fill}>
      {nav}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]}>
        {c.banner && <Image source={c.banner} style={wide ? s.bannerWide : s.banner} contentFit="cover" />}
        <View style={wide ? s.cols : { gap: 16 }}>
          <View style={wide ? { flex: 1 } : null}><NftImage uri={c.image} name={c.name} ratio={1} radius={20} px={720} style={{ width: '100%' }} /></View>
          <View style={[{ gap: 16 }, wide && { flex: 1 }]}>
            <View style={{ gap: 4 }}>
              <Text style={T.meta}>{c.chainName} · launched on FloorFeed</Text>
              <Text {...display} style={T.display}>{c.name}</Text>
            </View>
            {box}
            {info}
          </View>
        </View>
      </ScrollView>
      <BridgeSheet open={bridge != null} to={c.chain} amount={bridge ?? undefined} note="Includes a small cushion for gas."
        onDone={load} onClose={() => { setBridge(null); load(); }} />
    </View>
  );
}

function PhaseChip({ p, on, now, unit, onPress }: { p: LaunchedPhase; on: boolean; now: number; unit: string; onPress: () => void }) {
  const status = p.active ? 'Live' : p.start > now ? `in ${inWords(p.start - now)}` : 'Ended';
  return (
    <Pressable onPress={onPress} style={[s.phase, on && { borderColor: C.accent }]}>
      <Text style={T.label}>{p.name}</Text>
      <Text style={T.caption}>{p.price === 0 ? 'Free' : amt(p.price, unit)} · {status}{p.eligible === false ? ' · not listed' : p.eligible ? ' · you’re listed' : ''}</Text>
    </Pressable>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={strong ? [T.meta, { color: C.text }] : T.meta}>{label}</Text>
      <Text style={[T.metaNum, { color: C.text }, strong && T.bodyStrong]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 1080, alignSelf: 'center', paddingTop: 20, paddingBottom: 120, gap: 16 },
  banner: { width: '100%', height: 120, borderRadius: 16 },
  bannerWide: { width: '100%', height: 220, borderRadius: 20 },
  cols: { flexDirection: 'row', gap: 28, alignItems: 'flex-start' },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.cardHi, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.accent },
  phases: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  phase: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, gap: 2 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  qtyTxt: { ...T.bodyStrong },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  err: { ...T.meta, color: C.down },
  link: { ...T.label, color: C.accent },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  links: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.cardHi },
});
