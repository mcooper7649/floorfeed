import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { Avatar } from '@/components/event-card';
import { SalePulse, useBump } from '@/components/flash';
import { NftImage } from '@/components/nft-image';
import { Empty, Screen } from '@/components/screen';
import { Card, Chip, ChipRow, SectionHeader } from '@/components/ui';
import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { useAlerts } from '@/lib/alerts';
import { api, type Chain, type HubDrop } from '@/lib/api';
import { columnsFor, useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// The Mint hub: live drops ranked by how fast they're minting (and whether
// proven flippers are in), upcoming stages with push reminders, and what just
// ended. Data: GET /mints (server mints.ts), refreshed every 30s while open.
// A card opens the drop page (/drop/[slug]), where the mint happens.

const REFRESH = 30_000;
type PriceFilter = 'any' | 'free' | 'cheap' | 'paid';
const PRICES: { key: PriceFilter; label: string }[] = [
  { key: 'any', label: 'Any price' }, { key: 'free', label: 'Free' }, { key: 'cheap', label: 'Under $10' }, { key: 'paid', label: 'Paid' },
];

const inWords = (sec: number) => {
  const d = Math.abs(sec);
  if (d >= 86_400) return `${Math.floor(d / 86_400)}d ${Math.floor((d % 86_400) / 3600)}h`;
  if (d >= 3600) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(d / 60))}m`;
};
const trimNum = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2)).replace(/\.?0+$/, '');
const priceText = (d: HubDrop) => (d.price == null ? '—' : d.price === 0 ? 'Free' : `${trimNum(d.price)} ${d.currency}`);
const usdText = (n: number | null) => (n ? `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}` : null);
const dayLabel = (t: number, now: number) => {
  const d = new Date(t * 1000), today = new Date(now * 1000);
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function MintScreen() {
  useTitle('Mint NFTs across chains | FloorFeed');
  const { pad, contentWidth, wide } = useLayout();
  const { userId } = useSession();
  const { mode, canReal, setMode } = useTradeMode();
  const { push, enablePush } = useAlerts();
  const [data, setData] = useState<{ drops: HubDrop[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [chain, setChain] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceFilter>('any');
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [reminders, setReminders] = useState<Set<string>>(new Set());
  const [remindNote, setRemindNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.mints()
      .then((r) => { setData({ drops: r.drops, now: Math.floor(Date.now() / 1000) }); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, []);
  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') load(); }, REFRESH);
    return () => clearInterval(t);
  }, [load]));
  useEffect(() => {
    if (!userId) return;
    api.mintReminders(userId).then((r) => setReminders(new Set(r.reminders.map((x) => x.slug)))).catch(() => {});
  }, [userId]);

  const toggleRemind = async (d: HubDrop) => {
    if (!userId) return;
    const on = !reminders.has(d.slug);
    setReminders((s) => { const n = new Set(s); if (on) n.add(d.slug); else n.delete(d.slug); return n; });
    try {
      await api.remind(userId, d.slug, on);
      if (on) {
        track('mint_remind', { chain: d.chain });
        if (push === 'off') await enablePush().catch(() => {});
        setRemindNote(push === 'blocked' || push === 'unsupported'
          ? 'Reminder saved, but notifications are off in this browser, so it can’t reach you. Allow notifications for FloorFeed to get it.'
          : null);
      }
    } catch (e) {
      setReminders((s) => { const n = new Set(s); if (on) n.delete(d.slug); else n.add(d.slug); return n; });
      setRemindNote((e as Error).message);
    }
  };

  const all = useMemo(() => data?.drops ?? [], [data]);
  const chains = useMemo(() => [...new Set(all.map((d) => d.chain))], [all]);
  const passes = (d: HubDrop) =>
    (!chain || d.chain === chain)
    && (price === 'any' || (price === 'free' ? d.price === 0 : price === 'paid' ? (d.price ?? 0) > 0 : d.price === 0 || (d.priceUsd != null && d.priceUsd < 10)));
  const filtered = all.filter(passes);
  // Collections launched on FloorFeed always show (their own section); the verified filter is for OpenSea drops.
  const launches = filtered.filter((d) => d.launched && d.section !== 'done');
  const shown = filtered.filter((d) => !d.launched && (!verifiedOnly || d.verified));
  const hiddenUnverified = filtered.filter((d) => !d.launched).length - shown.length;
  const live = shown.filter((d) => d.section === 'live');
  const upcoming = shown.filter((d) => d.section === 'upcoming');
  const done = shown.filter((d) => d.section === 'done').slice(0, 12);
  const now = data?.now ?? 0;
  const cols = wide ? columnsFor(contentWidth, 340, 12, 3) : 1;
  const cardW = cols > 1 ? Math.floor((contentWidth - 12 * (cols - 1)) / cols) : undefined;
  const grid = (items: ReactNode[]) => (
    <View style={s.grid}>
      {items.map((item, i) => <View key={i} style={cardW ? { width: cardW } : { width: '100%' }}>{item}</View>)}
    </View>
  );

  // Upcoming, grouped by day.
  const days: { label: string; drops: HubDrop[] }[] = [];
  for (const d of upcoming) {
    const label = dayLabel(d.startsAt!, now);
    const g = days.find((x) => x.label === label);
    if (g) g.drops.push(d); else days.push({ label, drops: [d] });
  }

  return (
    <Screen title="Mint" subtitle="Live and upcoming drops across chains. Mint them right here, or launch your own."
      right={<Pressable accessibilityRole="button" onPress={() => router.push('/create')} style={s.launch}><Text style={s.launchTxt}>+ Launch a collection</Text></Pressable>}>
      <ChipRow pad={pad} groups={[
        [<Chip key="all" label="All chains" on={!chain} onPress={() => setChain(null)} />,
          ...chains.map((c) => <Chip key={c} label={all.find((d) => d.chain === c)?.chainName ?? c} on={chain === c} onPress={() => setChain(chain === c ? null : c)} />)],
        PRICES.map((p) => <Chip key={p.key} label={p.label} on={price === p.key} onPress={() => setPrice(p.key)} />),
        <Chip key="v" label="Verified only" on={verifiedOnly} onPress={() => setVerifiedOnly((v) => !v)} />,
      ]} />
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.accent} />}>
        {mode === 'paper' && (
          <Card style={s.notice}>
            <Text style={T.bodyStrong}>Minting uses real money</Text>
            <Text style={T.meta}>Paper mode can’t mint: a mint creates a new NFT on chain and is paid in real coins. Browse here, then switch to Real to mint.</Text>
            {canReal
              ? <Pressable onPress={() => setMode('real')}><Text style={s.link}>Switch to Real ›</Text></Pressable>
              : <Text style={T.caption}>Connect a wallet or sign in to switch to Real.</Text>}
          </Card>
        )}

        {!data ? (
          error ? <Empty text={`Couldn’t load drops: ${error}`} /> : <ActivityIndicator color={C.accent} style={{ marginTop: 32 }} />
        ) : (
          <>
            {launches.length > 0 && (
              <>
                <SectionHeader title="Launched on FloorFeed" count={launches.length} />
                {grid(launches.map((d) => (d.section === 'upcoming'
                  ? <UpcomingCard key={d.slug} d={d} now={now} reminded={reminders.has(d.slug)} onRemind={() => toggleRemind(d)} />
                  : <LiveCard key={d.slug} d={d} now={now} />)))}
              </>
            )}
            <SectionHeader title="Live now" count={live.length || undefined} />
            {live.length ? grid(live.map((d) => <LiveCard key={d.slug} d={d} now={now} />))
              : <Text style={T.meta}>Nothing minting that matches these filters.</Text>}

            <SectionHeader title="Upcoming" count={upcoming.length || undefined} />
            {remindNote && <Text style={[T.meta, { color: C.down }]}>{remindNote}</Text>}
            {days.length ? days.map((g) => (
              <View key={g.label} style={{ gap: 8 }}>
                <Text style={s.day}>{g.label}</Text>
                {grid(g.drops.map((d) => (
                  <UpcomingCard key={d.slug} d={d} now={now} reminded={reminders.has(d.slug)} onRemind={() => toggleRemind(d)} />
                )))}
              </View>
            )) : <Text style={T.meta}>No upcoming stages announced that match these filters.</Text>}

            {done.length > 0 && (
              <>
                <SectionHeader title="Ended recently" />
                {grid(done.map((d) => <DoneRow key={d.slug} d={d} />))}
              </>
            )}

            {verifiedOnly && hiddenUnverified > 0 && (
              <Pressable onPress={() => setVerifiedOnly(false)} style={s.more}>
                <Text style={s.moreTxt}>Show {hiddenUnverified} unverified drop{hiddenUnverified === 1 ? '' : 's'}</Text>
              </Pressable>
            )}
            <Text style={T.caption}>
              Drops come from OpenSea. Mint speed and minters are read from each chain every 2 minutes. Verified means OpenSea
              has reviewed the collection; unverified drops can be copies. Most new NFTs lose value, so check before you mint.
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const open = (d: HubDrop) => {
  track('mint_open', { from: 'hub', chain: d.chain });
  if (d.launched && d.contract) router.push({ pathname: '/c/[chain]/[address]', params: { chain: d.chain, address: d.contract } });
  else router.push({ pathname: '/drop/[slug]', params: { slug: d.slug } });
};

function Head({ d, sub }: { d: HubDrop; sub: string }) {
  return (
    <View style={s.head}>
      <NftImage uri={d.image} name={d.name} ratio={1} radius={10} px={160} style={{ width: 64 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={s.row}>
          <Text style={[T.bodyStrong, { flexShrink: 1 }]} numberOfLines={1}>{d.name}</Text>
          {d.launched ? <Text style={s.ours}>FloorFeed</Text> : d.verified ? <Text style={s.check}>✓</Text> : d.verified === false ? <Text style={s.unverified}>Unverified</Text> : null}
        </View>
        <View style={s.row}>
          {d.chain in CHAINS ? <ChainBadge chain={d.chain as Chain} /> : <Text style={T.caption}>{d.chainName}</Text>}
          <Text style={[T.meta, { flexShrink: 1 }]} numberOfLines={1}>{sub}</Text>
        </View>
        <Text style={T.num}>
          {priceText(d)}
          {usdText(d.priceUsd) && <Text style={T.metaNum}> {usdText(d.priceUsd)}</Text>}
        </Text>
      </View>
    </View>
  );
}

function Progress({ d }: { d: HubDrop }) {
  if (d.max && d.minted != null) {
    const pct = Math.min(100, (d.minted / d.max) * 100);
    return (
      <View style={{ gap: 4 }}>
        <View style={s.bar}><View style={[s.fill, { width: `${pct}%` }]} /></View>
        <Text style={T.metaNum}>{d.minted.toLocaleString()} / {d.max.toLocaleString()} minted · {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%</Text>
      </View>
    );
  }
  if (d.minted != null) return <Text style={T.metaNum}>{d.openEdition ? 'Open edition · ' : ''}{d.minted.toLocaleString()} minted</Text>;
  return null;
}

function LiveCard({ d, now }: { d: HubDrop; now: number }) {
  const bump = useBump(d.minted);
  const hot = (d.mints10m ?? 0) > 0;
  return (
    <Pressable onPress={() => open(d)} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>
      <Head d={d} sub={`${d.stage ?? 'Minting'}${d.endsAt ? ` · ends in ${inWords(d.endsAt - now)}` : ''}`} />
      <Progress d={d} />
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        {d.mints10m != null || d.mints1h != null ? (
          <Text style={[s.speed, hot && { color: C.accent }]}>
            {hot ? '🔥 ' : ''}{d.mints10m ?? 0} in 10 min · {d.mints1h ?? 0} in 1h
          </Text>
        ) : <Text style={T.caption}>Measuring mint speed…</Text>}
        <SalePulse by={bump.by} at={bump.at} label="mint" />
      </View>
      {d.proven.count > 0 && (
        <View style={s.row}>
          <View style={{ flexDirection: 'row' }}>
            {d.proven.wallets.map((w, i) => <View key={w.wallet} style={i ? { marginLeft: -8 } : null}><Avatar t={w} size={22} ring /></View>)}
          </View>
          <Text style={[T.meta, { color: C.up, flexShrink: 1 }]} numberOfLines={1}>
            {d.proven.count} proven flipper{d.proven.count === 1 ? '' : 's'} minted
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function UpcomingCard({ d, now, reminded, onRemind }: { d: HubDrop; now: number; reminded: boolean; onRemind: () => void }) {
  return (
    <View style={s.card}>
      <Pressable onPress={() => open(d)}>
        <Head d={d} sub={`${d.stage ?? 'Next stage'} · ${clock(d.startsAt!)} · in ${inWords(d.startsAt! - now)}`} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onRemind} style={[s.remind, reminded && s.remindOn]}>
        <Text style={[T.label, { color: reminded ? C.accentInk : C.text }]}>{reminded ? 'Reminder set ✓' : 'Remind me 5 min before'}</Text>
      </Pressable>
    </View>
  );
}

function DoneRow({ d }: { d: HubDrop }) {
  const soldOut = d.max != null && d.minted != null && d.minted >= d.max;
  return (
    <Pressable onPress={() => open(d)} style={({ pressed }) => [s.card, s.doneRow, pressed && { opacity: 0.85 }]}>
      <NftImage uri={d.image} name={d.name} ratio={1} radius={8} px={96} style={{ width: 40 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={T.bodyStrong} numberOfLines={1}>{d.name}</Text>
        <Text style={T.meta} numberOfLines={1}>
          {d.chainName}{d.minted != null ? ` · ${d.minted.toLocaleString()}${d.max ? ` / ${d.max.toLocaleString()}` : ''} minted` : ''}
        </Text>
      </View>
      <Text style={[T.label, { color: soldOut ? C.accent : C.dim }]}>{soldOut ? 'Sold out' : 'Ended'}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: { paddingTop: 8, paddingBottom: 140, gap: 14 },
  notice: { gap: 6 },
  link: { ...T.label, color: C.accent },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 },
  head: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  check: { color: C.accent, fontSize: 13, fontWeight: '700' },
  unverified: { ...T.caption, color: C.down },
  ours: { ...T.caption, color: C.accent, fontWeight: '700' },
  bar: { height: 6, borderRadius: 3, backgroundColor: C.cardHi, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: C.accent },
  speed: { ...T.metaNum, fontWeight: '600' },
  day: { ...T.label, color: C.text, marginTop: 2 },
  remind: { alignItems: 'center', paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  remindOn: { backgroundColor: C.accent, borderColor: C.accent },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  more: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  moreTxt: { ...T.bodyStrong },
  launch: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.accent },
  launchTxt: { ...T.button, color: C.accentInk },
});
