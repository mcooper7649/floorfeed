import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { NftImage } from '@/components/nft-image';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { Card, Stat } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { api, type DropActivity, type DropDetail, type DropStage } from '@/lib/api';
import { useAlerts } from '@/lib/alerts';
import { useSession } from '@/lib/session';
import { Avatar } from '@/components/event-card';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, usd } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { usePrices } from '@/lib/prices';
import { track } from '@/lib/analytics';
import { useTitle } from '@/lib/use-title';

// FloorFeed's page for a mint: art, stages with times and prices, supply, and
// minting in-app on the chains FloorFeed sends on (OpenSea builds the SeaDrop
// mint; FloorFeed simulates it; the wallet confirms). Other chains get the same
// page with the final step on OpenSea.

const inWords = (sec: number) => {
  const d = Math.abs(sec);
  if (d >= 86_400) return `${Math.floor(d / 86_400)}d ${Math.floor((d % 86_400) / 3600)}h`;
  if (d >= 3600) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(d / 60))}m`;
};
// The year shows when it isn't this year (stages can run a year or more).
const when = (t: number) => {
  const d = new Date(t * 1000);
  const year = d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined;
  return d.toLocaleString(undefined, { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

type Step = { kind: 'idle' } | { kind: 'preparing' } | { kind: 'confirm' } | { kind: 'sent'; url: string; quantity: number } | { kind: 'error'; message: string };

export default function DropScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const w = useEvmWallet();
  const auth = useAuth();
  const { mode, canReal, setMode } = useTradeMode();
  const { toUsd } = usePrices();
  const { wide, pad, maxWidth } = useLayout();
  const [loaded, setLoaded] = useState<{ key: string; d?: DropDetail; error?: string } | null>(null);
  const [qty, setQty] = useState(1);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [bridge, setBridge] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = `${slug}:${w.address}:${nonce}`;

  useEffect(() => {
    let alive = true;
    api.drop(slug, w.address ?? undefined)
      .then((d) => alive && setLoaded({ key, d }))
      .catch((e) => alive && setLoaded({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [slug, w.address, key]);
  // Show the last loaded copy of this drop while a refetch runs, so the page doesn't flash.
  const d = loaded?.d?.slug === slug ? loaded.d : null;
  const error = loaded?.key === key ? loaded.error ?? null : null;

  const [now, setNow] = useState(() => Date.now() / 1000);
  // Mint speed and proven minters (server mints.ts), refreshed every minute.
  const [activity, setActivity] = useState<{ slug: string; a: DropActivity } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.dropActivity(slug).then((a) => alive && setActivity({ slug, a })).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [slug]);
  const act = activity?.slug === slug ? activity.a : null;
  // "Remind me" before the next stage opens (push).
  const { userId } = useSession();
  const { push, enablePush } = useAlerts();
  const [reminded, setReminded] = useState<{ slug: string; on: boolean } | null>(null);
  const [remindErr, setRemindErr] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api.mintReminders(userId).then((r) => alive && setReminded({ slug, on: r.reminders.some((x) => x.slug === slug) })).catch(() => {});
    return () => { alive = false; };
  }, [userId, slug]);
  const isReminded = reminded?.slug === slug && reminded.on;
  const toggleRemind = async () => {
    if (!userId) return;
    const on = !isReminded;
    setReminded({ slug, on });
    setRemindErr(null);
    try {
      await api.remind(userId, slug, on);
      if (on) {
        track('mint_remind', { from: 'drop' });
        if (push === 'off') await enablePush().catch(() => {});
        if (push === 'blocked' || push === 'unsupported') setRemindErr('Saved, but notifications are off in this browser, so the reminder can’t reach you.');
      }
    } catch (e) {
      setReminded({ slug, on: !on });
      setRemindErr((e as Error).message);
    }
  };
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 30_000); return () => clearInterval(t); }, []);

  useTitle(d && `${d.name}: mint on ${d.chainName} | FloorFeed`);
  const nav = Platform.OS === 'web' && <TopNav back />;
  if (error && !d) return <View style={s.fill}>{nav}<Empty text="This drop couldn't be loaded." /></View>;
  if (!d) return <View style={s.fill}>{nav}<ActivityIndicator style={{ marginTop: 40 }} color={C.accent} /></View>;

  const stage = d.active ?? d.next;
  const price = stage?.price ?? null;
  const maxQty = Math.max(1, Math.min(stage?.maxPerWallet ?? 10, 10, d.max != null && d.minted != null ? Math.max(1, d.max - d.minted) : 10));
  const q = Math.min(qty, maxQty);
  const total = price != null ? price * q : null;
  const totalUsd = total != null ? toUsd(total, d.native) : null;
  const short = total != null && d.balance != null ? total - d.balance : null;
  const canMintHere = d.supported && d.minting && !d.soldOut && !!stage?.nativePriced;
  const pct = d.minted != null && d.max ? Math.min(100, (d.minted / d.max) * 100) : null;

  const mint = async () => {
    if (!w.address || !w.send) return;
    setStep({ kind: 'preparing' });
    try {
      const tx = await api.dropMintTx(d.slug, { minter: w.address, quantity: q });
      setStep({ kind: 'confirm' });
      const hash = await w.send({ ...tx, description: `Mint ${q} ${d.name} for ${amt(tx.total, tx.unit)} on ${d.chainName}` });
      track('mint_signed', { chain: d.chain, quantity: q });
      recordTx({ hash, wallet: w.address, chain: d.chain, kind: 'mint', title: `Minted ${q} ${d.name}`, amount: tx.total, unit: tx.unit, symbol: d.slug });
      setStep({ kind: 'sent', url: `${tx.explorerTx ?? 'https://etherscan.io/tx/'}${hash}`, quantity: q });
    } catch (e) {
      const m = (e as Error).message || 'The mint did not go through.';
      setStep({ kind: 'error', message: /reject|denied|cancel/i.test(m) ? 'You cancelled in your wallet. Nothing was sent.' : m });
      setNonce((n) => n + 1);
    }
  };

  const status = d.soldOut ? { text: 'Sold out', color: C.dim }
    : d.minting ? { text: 'Minting now', color: C.up }
    : d.next?.startsAt && d.next.startsAt > now ? { text: `Starts in ${inWords(d.next.startsAt - now)}`, color: C.accent }
    : { text: 'Mint ended', color: C.dim };

  const art = (
    <View style={{ gap: 12 }}>
      {d.banner && !wide && <Image source={{ uri: d.banner }} style={s.banner} resizeMode="cover" />}
      <NftImage uri={d.image} name={d.name} ratio={1} radius={20} px={720} style={{ width: '100%' }} />
    </View>
  );

  const box = (
    <Card style={{ gap: 12 }}>
      <View style={s.statusRow}>
        <View style={[s.dot, { backgroundColor: status.color }]} />
        <Text style={[T.bodyStrong, { color: status.color, flex: 1 }]}>{status.text}</Text>
        {d.minting && d.active?.endsAt && <Text style={T.metaNum}>ends in {inWords(d.active.endsAt - now)}</Text>}
      </View>
      {stage && (
        <View style={{ gap: 2 }}>
          <Text style={T.meta}>{stage.label}{stage.allowlist ? ' · allowlist' : ''}</Text>
          <Text {...display} style={[T.hero, { color: C.text }]}>
            {price == null ? 'Price on OpenSea' : price === 0 ? 'Free' : amt(price, d.native)}
          </Text>
          {price != null && price > 0 && toUsd(price, d.native) != null && <Text style={T.metaNum}>≈ {usd(toUsd(price, d.native)!)} each</Text>}
        </View>
      )}

      {pct != null && (
        <View style={{ gap: 6 }}>
          <View style={s.bar}><View style={[s.barFill, { width: `${Math.max(2, pct)}%` }]} /></View>
          <Text style={T.metaNum}>{d.minted!.toLocaleString()} of {d.max!.toLocaleString()} minted ({pct.toFixed(0)}%)</Text>
        </View>
      )}
      {d.minting && act && (act.mints10m != null || act.mints1h != null) && (
        <Text style={[T.metaNum, { fontWeight: '600' }, (act.mints10m ?? 0) > 0 && { color: C.accent }]}>
          {(act.mints10m ?? 0) > 0 ? '🔥 ' : ''}{act.mints10m ?? 0} minted in the last 10 min · {act.mints1h ?? 0} in the last hour
        </Text>
      )}
      {act && act.proven.count > 0 && (
        <View style={s.statusRow}>
          <View style={{ flexDirection: 'row' }}>
            {act.proven.wallets.map((pw, i) => <View key={pw.wallet} style={i ? { marginLeft: -8 } : null}><Avatar t={pw} size={22} ring /></View>)}
          </View>
          <Text style={[T.meta, { color: C.up, flex: 1 }]}>
            {act.proven.count} proven flipper{act.proven.count === 1 ? '' : 's'} minted{act.minters ? ` (of ${act.minters.toLocaleString()} minters)` : ''}
          </Text>
        </View>
      )}
      {!d.minting && !d.soldOut && d.next?.startsAt != null && d.next.startsAt > now && (
        <View style={{ gap: 6 }}>
          <Pressable accessibilityRole="button" onPress={toggleRemind} style={[s.secondary, isReminded && { backgroundColor: C.accent, borderColor: C.accent }]}>
            <Text style={[s.secondaryTxt, isReminded && { color: C.accentInk }]}>{isReminded ? 'Reminder set ✓' : 'Remind me 5 min before'}</Text>
          </Pressable>
          {remindErr && <Text style={[T.meta, { color: C.down }]}>{remindErr}</Text>}
        </View>
      )}

      {step.kind === 'sent' ? (
        <View style={{ gap: 8 }}>
          <Text style={[T.title, { color: C.up }]}>✓ Mint submitted</Text>
          <Text style={T.meta}>It usually confirms within a minute. The NFT{step.quantity > 1 ? 's' : ''} then show{step.quantity > 1 ? '' : 's'} up in your Real portfolio, and Activity there shows when it confirms.</Text>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(step.url)}><Text style={s.link}>View transaction ↗</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => setStep({ kind: 'idle' })} style={s.secondary}><Text style={s.secondaryTxt}>Mint more</Text></Pressable>
        </View>
      ) : canMintHere && mode === 'paper' && canReal ? (
        // Paper trading has no mints: a mint is a real, on-chain purchase.
        <View style={s.paperBox}>
          <Text style={T.bodyStrong}>You&apos;re in Practice mode</Text>
          <Text style={T.meta}>Minting uses real money, so it isn&apos;t part of practice trading. Switch to Real to mint this one with your wallet, or keep practicing on the collections that already trade.</Text>
          <Pressable accessibilityRole="button" onPress={() => setMode('real')} style={s.primary}><Text style={s.primaryTxt}>Switch to Real to mint</Text></Pressable>
        </View>
      ) : canMintHere ? (
        !w.address ? (
          <View style={{ gap: 8 }}>
            <Text style={T.meta}>Minting needs an Ethereum wallet. Sign in for a free FloorFeed wallet, or connect one you have.</Text>
            {auth.supported && !auth.userId && (
              <Pressable accessibilityRole="button" onPress={() => auth.login()} style={s.primary}><Text style={s.primaryTxt}>Sign in to mint</Text></Pressable>
            )}
            {w.available.map((o) => (
              <Pressable key={o.name} accessibilityRole="button" onPress={() => w.connect(o.name)} style={s.secondary}>
                <Text style={s.secondaryTxt}>Connect {o.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <View style={s.qtyRow}>
              <Text style={[T.meta, { flex: 1 }]}>Quantity</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Fewer" onPress={() => setQty(Math.max(1, q - 1))} style={s.qtyBtn}><Text style={s.qtyTxt}>−</Text></Pressable>
              <Text style={[T.num, { minWidth: 28, textAlign: 'center' }]}>{q}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="More" onPress={() => setQty(Math.min(maxQty, q + 1))} style={s.qtyBtn}><Text style={s.qtyTxt}>+</Text></Pressable>
            </View>
            <View style={s.rows}>
              <Row label="Total" value={total != null ? `${amt(total, d.native)}${totalUsd != null ? ` · ${usd(totalUsd)}` : ''}` : '—'} strong />
              <Row label={`Your ${d.native} on ${d.chainName}`} value={d.balance != null ? amt(d.balance, d.native) : '—'} />
              <Row label="Network fee" value="shown in your wallet" />
            </View>
            {stage?.allowlist && <Text style={T.caption}>This stage is for a list of wallets. OpenSea checks yours when you mint.</Text>}
            {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}
            {short != null && short > 0 ? (
              <>
                <Text style={s.err}>You need about {amt(short, d.native)} more {d.native} on {d.chainName}, plus gas.</Text>
                <Pressable accessibilityRole="button" onPress={() => setBridge(short + Math.max((total ?? 0) * 0.05, 0.0003))} style={s.primary}>
                  <Text style={s.primaryTxt}>Move {d.native} to {d.chainName}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable accessibilityRole="button" onPress={mint} disabled={step.kind === 'preparing' || step.kind === 'confirm' || !w.send}
                style={[s.primary, (step.kind === 'preparing' || step.kind === 'confirm') && { opacity: 0.7 }]}>
                <Text style={s.primaryTxt}>
                  {step.kind === 'preparing' ? 'Checking the mint…' : step.kind === 'confirm' ? 'Confirm in your wallet…'
                    : `Mint ${q} for ${total != null ? (total === 0 ? 'free' : amt(total, d.native)) : ''}`}
                </Text>
              </Pressable>
            )}
            <Text style={T.caption}>FloorFeed checks the mint against the chain first. Your wallet shows it and asks you to confirm.</Text>
          </View>
        )
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={T.meta}>
            {d.soldOut ? 'Everything has been minted. Buy one from holders on the collection page.'
              : !d.minting ? 'Not minting right now. Check the stages below for when it opens.'
              : !d.supported ? `FloorFeed can't mint on ${d.chainName} yet, so this last step happens on OpenSea.`
              : 'This stage is priced in a token FloorFeed can\'t pay with yet. Mint on OpenSea.'}
          </Text>
          {d.minting && !d.soldOut && (
            <Pressable accessibilityRole="link" onPress={() => { track('mint_out', { chain: d.chain }); void Linking.openURL(d.url); }} style={s.secondary}>
              <Text style={s.secondaryTxt}>Mint on OpenSea ↗</Text>
            </Pressable>
          )}
        </View>
      )}
    </Card>
  );

  const facts = (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text style={T.meta}>{d.chainName}{d.verified ? ' · Verified on OpenSea' : ' · Not verified'}</Text>
        <Text {...display} style={T.display}>{d.name}</Text>
      </View>
      {box}
      {!d.verified && <Text style={T.caption}>New mints are risky: most lose value, and unverified collections can be copies. Check the contract and links before minting.</Text>}
    </View>
  );

  const stages = d.stages.length > 0 && (
    <View style={{ gap: 8 }}>
      <Text style={s.section}>Mint stages</Text>
      {d.stages.map((st) => <StageRow key={st.id ?? st.label} st={st} unit={d.native} now={now} activeId={d.active?.id ?? null} />)}
    </View>
  );

  const about = (
    <View style={{ gap: 8 }}>
      <Text style={s.section}>About</Text>
      {d.description && <Text style={T.body}>{d.description}</Text>}
      <View style={s.statRow}>
        {d.max != null && <Stat label="Supply" value={d.max.toLocaleString()} />}
        {d.creatorFeeBps != null && <Stat label="Creator fee" value={`${(d.creatorFeeBps / 100).toFixed(1)}%`} />}
      </View>
      <View style={s.links}>
        {d.website && <LinkOut label="Website" url={d.website} />}
        {d.twitter && <LinkOut label="X" url={`https://x.com/${d.twitter}`} />}
        {d.discord && <LinkOut label="Discord" url={d.discord} />}
        <LinkOut label="Contract" url={`${chainExplorer(d.chain)}/address/${d.contract}`} />
      </View>
    </View>
  );

  return (
    <View style={s.fill}>
      <Stack.Screen options={{ title: d.name }} />
      {nav}
      <ScrollView contentContainerStyle={{ padding: pad, paddingBottom: 60, width: '100%', maxWidth, alignSelf: 'center', gap: 24 }}>
        {wide && d.banner && <Image source={{ uri: d.banner }} style={s.bannerWide} resizeMode="cover" />}
        {wide ? (
          <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>{art}</View>
            <View style={{ flex: 1, gap: 24 }}>{facts}{stages}</View>
          </View>
        ) : (
          <>{art}{facts}{stages}</>
        )}
        {about}
      </ScrollView>
      <BridgeSheet open={bridge != null} to={d.chain} amount={bridge ?? undefined}
        note="Includes a small cushion for gas. Anything left over stays in your wallet."
        onDone={() => setNonce((n) => n + 1)} onClose={() => { setBridge(null); setNonce((n) => n + 1); }} />
    </View>
  );
}

const EXPLORERS: Record<string, string> = {
  ethereum: 'https://etherscan.io', base: 'https://basescan.org', abstract: 'https://abscan.org', ink: 'https://explorer.inkonchain.com',
  arbitrum: 'https://arbiscan.io', hyperevm: 'https://hyperevmscan.io', ronin: 'https://app.roninchain.com', apechain: 'https://apescan.io',
  monad: 'https://monadscan.com', polygon: 'https://polygonscan.com', robinhood: 'https://robinhoodchain.blockscout.com',
};
const chainExplorer = (c: string) => EXPLORERS[c] ?? 'https://etherscan.io';

function StageRow({ st, unit, now, activeId }: { st: DropStage; unit: string; now: number; activeId: string | null }) {
  const live = st.id != null && st.id === activeId;
  const past = st.endsAt != null && st.endsAt < now;
  return (
    <View style={[s.stage, live && { borderColor: C.up }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[T.bodyStrong, past && { color: C.dim }]}>{st.label}{live ? ' · live' : past ? ' · ended' : ''}</Text>
        <Text style={T.metaNum}>
          {st.startsAt ? when(st.startsAt) : 'TBA'}{st.endsAt ? ` → ${when(st.endsAt)}` : ''}
          {st.maxPerWallet ? ` · up to ${st.maxPerWallet} per wallet` : ''}{st.allowlist ? ' · allowlist' : ''}
        </Text>
      </View>
      <Text style={[T.num, { color: past ? C.dim : C.text }]}>{st.price == null ? '—' : st.price === 0 ? 'Free' : amt(st.price, unit)}</Text>
    </View>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={strong ? [T.meta, { color: C.text }] : T.meta}>{label}</Text>
      <Text style={[T.metaNum, { color: C.text }, strong && T.bodyStrong]}>{value}</Text>
    </View>
  );
}

function LinkOut({ label, url }: { label: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => Linking.openURL(url)} style={s.linkChip}>
      <Text style={T.label}>{label} ↗</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  paperBox: { gap: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: C.ai, backgroundColor: C.cardHi },
  fill: { flex: 1, backgroundColor: C.bg },
  banner: { width: '100%', height: 120, borderRadius: 16 },
  bannerWide: { width: '100%', height: 200, borderRadius: 20 },
  section: { ...T.title },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.cardHi, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.accent },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  qtyTxt: { ...T.bodyStrong, color: C.text },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  err: { ...T.meta, color: C.down },
  link: { ...T.label, textAlign: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  statRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  links: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  linkChip: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.cardHi },
});
