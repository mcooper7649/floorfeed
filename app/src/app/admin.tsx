import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TopNav } from '@/components/top-nav';
import { Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import { T, display } from '@/constants/type';
import { useIsAdmin } from '@/lib/admin';
import {
  api, type AdminActivity, type AdminMarketing, type AdminModeration, type AdminRevenue, type AdminSystem, type AdminUsers,
} from '@/lib/api';
import { shortAddr, timeAgo, usd } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// The owner's admin panel: what FloorFeed earns and from where, who signs up,
// where visitors come from, what moves through the app, what needs
// moderating, and whether the data is fresh. Only admin accounts get data
// (server admin.ts); everyone else sees "Not found".

type Tab = 'revenue' | 'users' | 'marketing' | 'activity' | 'moderation' | 'system';
const TABS: { id: Tab; label: string }[] = [
  { id: 'revenue', label: 'Revenue' }, { id: 'users', label: 'Users' }, { id: 'marketing', label: 'Marketing' },
  { id: 'activity', label: 'Activity' }, { id: 'moderation', label: 'Moderation' }, { id: 'system', label: 'System' },
];
const RANGES = [7, 30, 90] as const;
const AMBER = '#F5B547';

const chainName = (c: string | null) => (c ? CHAINS[c as keyof typeof CHAINS]?.name ?? c : '—');
const money = (n: number | null | undefined) => (n == null ? '—' : n > 0 && n < 0.01 ? '< $0.01' : usd(n));
const num = (n: number) => n.toLocaleString('en-US');
const date = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function Admin() {
  useTitle('Admin | FloorFeed');
  const { pad, wide } = useLayout();
  const { signedIn } = useSession();
  const admin = useIsAdmin();
  const [tab, setTab] = useState<Tab>('revenue');
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [checked, setChecked] = useState(false);
  useEffect(() => { const t = setTimeout(() => setChecked(true), 4000); return () => clearTimeout(t); }, []);

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]}>
        <View style={s.head}>
          <Text {...display} style={[wide ? T.displayL : T.display, { flex: 1 }]}>Admin</Text>
          {admin && tab !== 'moderation' && tab !== 'system' && (
            <View style={s.seg}>
              {RANGES.map((d) => (
                <Pressable key={d} accessibilityRole="button" accessibilityState={{ selected: days === d }} onPress={() => setDays(d)}
                  style={[s.segBtn, days === d && s.segOn]}>
                  <Text style={[s.segTxt, days === d && { color: C.text }]}>{d}d</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
        {!admin ? (
          !signedIn || checked ? <Text style={T.meta}>Not found.</Text> : <ActivityIndicator color={C.accent} />
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabs}>
              {TABS.map((t) => (
                <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }} onPress={() => setTab(t.id)}
                  style={[s.tab, tab === t.id && s.tabOn]}>
                  <Text style={[s.tabTxt, tab === t.id && { color: C.text }]}>{t.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {tab === 'revenue' && <Load key={`r${days}`} get={() => api.adminRevenue(days)} render={(d) => <Revenue d={d} />} />}
            {tab === 'users' && <Load key={`u${days}`} get={() => api.adminUsers(days)} render={(d) => <Users d={d} />} />}
            {tab === 'marketing' && <Load key={`m${days}`} get={() => api.adminMarketing(days)} render={(d) => <Marketing d={d} />} />}
            {tab === 'activity' && <Load key={`a${days}`} get={() => api.adminActivity(days)} render={(d) => <Activity d={d} />} />}
            {tab === 'moderation' && <Load key="mod" get={api.adminModeration} render={(d, reload) => <Moderation d={d} reload={reload} />} />}
            {tab === 'system' && <Load key="sys" get={api.adminSystem} render={(d) => <System d={d} />} />}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// Fetches one tab's data; `reload` refetches after an action.
function Load<D>({ get, render }: { get: () => Promise<D>; render: (d: D, reload: () => void) => ReactNode }) {
  const [state, setState] = useState<{ data?: D; error?: string } | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let alive = true;
    get().then((data) => alive && setState({ data })).catch((e) => alive && setState({ error: (e as Error).message }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `get` is a fresh closure each render; the parent remounts on range change
  }, [n]);
  if (!state) return <ActivityIndicator color={C.accent} style={{ marginTop: 24 }} />;
  if (state.error) return <Text style={[T.meta, { color: C.down }]}>Couldn’t load: {state.error}</Text>;
  return <View style={{ gap: 16 }}>{render(state.data as D, reload)}</View>;
}

// --- building blocks ---

function Kpis({ items }: { items: { label: string; value: string; sub?: string; color?: string }[] }) {
  return (
    <View style={s.kpis}>
      {items.map((k) => (
        <View key={k.label} style={s.kpi}>
          <Text style={T.label} numberOfLines={1}>{k.label}</Text>
          <Text style={[T.value, k.color ? { color: k.color } : null]} numberOfLines={1}>{k.value}</Text>
          {k.sub ? <Text style={T.caption} numberOfLines={2}>{k.sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

// `half` sections sit two to a row (inside s.split) where there's room.
function Section({ title, note, right, half, children }: { title: string; note?: string; right?: ReactNode; half?: boolean; children: ReactNode }) {
  return (
    <Card style={half ? { gap: 10, flexGrow: 1, flexBasis: 320 } : { gap: 10 }}>
      <View style={s.secHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={T.bodyStrong}>{title}</Text>
          {note ? <Text style={T.caption}>{note}</Text> : null}
        </View>
        {right}
      </View>
      {children}
    </Card>
  );
}

// Daily bars; `parts` stack (bottom first) in the given colors.
function Bars({ rows, parts, format }: { rows: { day: string; values: number[] }[]; parts: { label: string; color: string }[]; format: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 0);
  if (!max) return <Text style={T.meta}>Nothing in this range yet.</Text>;
  return (
    <View style={{ gap: 6 }}>
      <View style={s.bars}>
        {rows.map((r) => {
          const total = r.values.reduce((a, b) => a + b, 0);
          return (
            <View key={r.day} style={s.barCol} {...({ title: `${r.day}: ${format(total)}` } as object)}>
              {r.values.map((v, i) => v > 0 && (
                <View key={i} style={{ height: `${(v / max) * 100}%`, backgroundColor: parts[i].color, borderRadius: 2 }} />
              )).reverse()}
            </View>
          );
        })}
      </View>
      <View style={s.legend}>
        <Text style={T.caption}>{rows[0]?.day}</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {parts.length > 1 && parts.map((p) => (
            <View key={p.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.color }} />
              <Text style={T.caption}>{p.label}</Text>
            </View>
          ))}
          <Text style={T.caption}>peak {format(max)}</Text>
        </View>
        <Text style={T.caption}>{rows[rows.length - 1]?.day}</Text>
      </View>
    </View>
  );
}

// A simple table: first column grows, the rest are right-aligned numbers.
function Table({ head, rows, empty = 'Nothing yet.' }: { head: string[]; rows: (string | ReactNode)[][]; empty?: string }) {
  if (!rows.length) return <Text style={T.meta}>{empty}</Text>;
  return (
    <View>
      <View style={[s.tr, s.thRow]}>
        {head.map((h, i) => <Text key={h} style={[s.th, i === 0 ? s.c0 : s.cn]} numberOfLines={1}>{h}</Text>)}
      </View>
      {rows.map((r, j) => (
        <View key={j} style={s.tr}>
          {r.map((c, i) => typeof c === 'string' || typeof c === 'number'
            ? <Text key={i} style={[i === 0 ? s.td0 : s.td, i === 0 ? s.c0 : s.cn]} numberOfLines={i === 0 ? 2 : 1}>{c}</Text>
            : <View key={i} style={i === 0 ? s.c0 : [s.cn, { alignItems: 'flex-end' }]}>{c}</View>)}
        </View>
      ))}
    </View>
  );
}

function Act({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setBusy(true); Promise.resolve(onPress()).finally(() => setBusy(false)); }}
      style={({ hovered }: { hovered?: boolean }) => [s.act, danger && { borderColor: '#FF5C7A55' }, hovered && { backgroundColor: C.cardHi }]}>
      <Text style={[s.actTxt, danger && { color: C.down }]}>{busy ? '…' : label}</Text>
    </Pressable>
  );
}

const Link = ({ label, url }: { label: string; url: string }) => (
  <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(url); }} hitSlop={6}>
    <Text style={[T.label, { color: C.accent }]}>{label}</Text>
  </Pressable>
);

// --- tabs ---

function Revenue({ d }: { d: AdminRevenue }) {
  const bridge = d.streams.find((x) => x.id === 'bridge');
  return (
    <>
      <Kpis items={[
        { label: `Earned, last ${d.days}d`, value: money(d.totalWindow), color: C.accent },
        { label: 'Earned, all time', value: money(d.totalAllTime) },
        { label: 'Waiting to claim', value: money(d.relay.claimableUsd), sub: d.relay.currency ? `Relay bridge fees · ${d.relay.currency}` : 'Relay bridge fees' },
        { label: 'Bridges', value: num(bridge?.count ?? 0), sub: `last ${d.days}d` },
      ]} />
      <Section title="Fees by day" note="Bridge fees are dated when the bridge landed. Launchpad fees count in the totals only.">
        <Bars rows={d.daily.map((x) => ({ day: x.day, values: [x.bridge, x.buy] }))}
          parts={[{ label: 'Bridges', color: C.accent }, { label: 'Buys', color: C.ai }]} format={money} />
      </Section>
      <Section title="Where it comes from">
        <Table head={['Source', `${d.days}d`, 'All time']} rows={d.streams.map((x) => [
          <View key={x.id} style={{ gap: 2 }}>
            <Text style={T.bodyStrong}>{x.label}</Text>
            <Text style={T.caption}>{x.setting}</Text>
            {x.pending > 0 && <Text style={[T.caption, { color: AMBER }]}>{x.pending} fee{x.pending === 1 ? '' : 's'} still being read from Relay</Text>}
          </View>,
          x.window == null ? '—' : money(x.window), money(x.allTime),
        ])} />
      </Section>
      <Section title="Bridge fees by route" note={`Last ${d.days} days. FloorFeed's Relay app fee on each bridge, read back from Relay once it lands.`}>
        <Table head={['Route', 'Bridges', 'Fees']} rows={d.routes.map((r) => [r.route, num(r.bridges), money(r.usd)])} empty="No bridges in this range." />
      </Section>
      <Section title="Claim bridge fees"
        note="Relay keeps bridge fees as a USDC balance for the fee wallet. Claim it on Relay with that wallet."
        right={<Link label="Claim on Relay ↗" url={d.relay.claimUrl} />}>
        <Text style={T.metaNum}>Fee wallet {d.relay.feeWallet ? shortAddr(d.relay.feeWallet) : 'not set'} · waiting {money(d.relay.claimableUsd)}</Text>
      </Section>
      <Section title="Launchpad mint fees" note="The per-token fee each collection locked in at launch, paid to the fee wallet on every mint.">
        <Table head={['Collection', 'Minted', 'Fee each', 'Earned']} rows={d.launches.map((l) => [
          `${l.name} · ${chainName(l.chain)}${l.status === 'hidden' ? ' (hidden)' : ''}`, `${l.minted}/${l.max}`,
          l.feeEach ? `${l.feeEach} ${l.unit}` : 'Free', money(l.usd),
        ])} empty="No collections launched yet." />
        {d.factory.length > 0 && (
          <Text style={T.caption}>New launches lock in: {d.factory.map((f) => `${chainName(f.chain)} ${Number.isNaN(f.mintFee) ? '?' : `${f.mintFee} ${f.unit}`}`).join(' · ')} per token</Text>
        )}
      </Section>
    </>
  );
}

function Users({ d }: { d: AdminUsers }) {
  return (
    <>
      <Kpis items={[
        { label: 'Accounts', value: num(d.total), sub: `${d.newInWindow} new in ${d.days}d` },
        { label: 'Picked a name', value: num(d.named) },
        { label: '2-step on', value: num(d.twoStep), color: d.twoStep < d.total ? AMBER : undefined },
        { label: 'Traded for real', value: num(d.traders) },
      ]} />
      <Section title="Sign-ups by day">
        <Bars rows={d.signups.map((x) => ({ day: x.day, values: [x.n] }))} parts={[{ label: 'Sign-ups', color: C.accent }]} format={(n) => `${n}`} />
      </Section>
      <Section title="Without an account" note="Devices using FloorFeed signed out.">
        <Text style={T.metaNum}>{d.anonymous.practice} practice traders · {d.anonymous.follows} following wallets · {d.anonymous.push} with push alerts</Text>
      </Section>
      <Section title="Accounts" note="Newest first.">
        <Table head={['Account', 'Joined', 'Practice', 'Follows', 'Theses', 'Real txs']} rows={d.rows.map((u) => [
          <View key={u.id} style={{ gap: 1 }}>
            <Text style={T.bodyStrong} numberOfLines={1}>{u.name ?? 'No name yet'}{u.twoStep ? '  🔒' : ''}</Text>
            <Text style={T.caption} numberOfLines={1}>{u.method}{u.contact ? ` · ${u.contact}` : ''} · {u.wallets} wallet{u.wallets === 1 ? '' : 's'}</Text>
          </View>,
          date(u.joinedAt), num(u.practiceTrades), num(u.follows), num(u.theses), num(u.realTxs),
        ])} />
      </Section>
    </>
  );
}

function Marketing({ d }: { d: AdminMarketing }) {
  const top = Math.max(...d.funnel.map((f) => f.visitors), 1);
  const STEP: Record<string, string> = { pageview: 'Visited', follow: 'Followed a wallet', alerts_on: 'Turned on alerts', paper_buy: 'Practice buy', sign_in: 'Signed in', buy_click: 'Tapped Buy' };
  const xPosted = d.x.posted.reduce((a, p) => a + p.n, 0);
  return (
    <>
      <Kpis items={[
        { label: 'Visitors', value: num(d.totals.visitors), sub: `last ${d.days}d` },
        { label: 'Page views', value: num(d.totals.pageviews) },
        { label: 'From X', value: num(d.x.fromX), sub: 'x.com, t.co or utm_source=x' },
        { label: 'X posts', value: num(xPosted), sub: d.x.lastPostedAt ? `last ${timeAgo(d.x.lastPostedAt / 1000)} ago` : 'none yet' },
      ]} />
      <Section title="Visitors by day">
        <Bars rows={d.daily.map((x) => ({ day: x.day, values: [x.visitors] }))} parts={[{ label: 'Visitors', color: C.accent }]} format={(n) => `${n}`} />
      </Section>
      <Section title="Sources that convert" note="Visitors by where they came from, and how many signed in or traded (practice or real) the same day.">
        <Table head={['Source', 'Visitors', 'Signed in', 'Traded']} rows={d.quality.map((q) => [q.source, num(q.visitors), num(q.signins), num(q.traders)])} />
      </Section>
      <Section title="Campaigns" note="Links tagged with utm_source / utm_medium / utm_campaign (or ?ref=).">
        <Table head={['Source / medium / campaign', 'Visitors', 'Signed in']} rows={d.campaigns.map((c) => [`${c.source} / ${c.medium} / ${c.campaign}`, num(c.visitors), num(c.signins)])}
          empty="No tagged links yet. Add ?utm_source=x&utm_campaign=launch to links you share." />
      </Section>
      <Section title="Activation funnel">
        {d.funnel.map((f) => (
          <View key={f.step} style={s.funnel}>
            <Text style={[T.meta, { width: 140 }]} numberOfLines={1}>{STEP[f.step] ?? f.step}</Text>
            <View style={s.funnelTrack}><View style={[s.funnelBar, { width: `${Math.max(1, (f.visitors / top) * 100)}%` }]} /></View>
            <Text style={[T.metaNum, { width: 44, textAlign: 'right' }]}>{f.visitors}</Text>
          </View>
        ))}
      </Section>
      <Section title="X auto-poster" note={`${d.x.queued} queued · ${d.x.failed} failed in ${d.days}d${d.x.posted.length ? ` · ${d.x.posted.map((p) => `${p.n} ${p.kind}`).join(', ')}` : ''}`}>
        {d.x.recent.length ? d.x.recent.map((p, i) => (
          <View key={i} style={s.post}>
            <Text style={[T.meta, { flex: 1 }]} numberOfLines={2}>{p.text}</Text>
            {p.url ? <Link label="Open ↗" url={p.url} /> : null}
          </View>
        )) : <Text style={T.meta}>Nothing posted yet.</Text>}
      </Section>
      <View style={s.split}>
        <Section half title="Top pages">
          <Table head={['Page', 'Views']} rows={d.pages.map((p) => [p.path, num(p.views)])} />
        </Section>
        <Section half title="Countries and devices">
          <Table head={['Where', 'Visitors']} rows={[...d.countries.map((c) => [c.country, num(c.visitors)]), ...d.devices.map((x) => [x.device, num(x.visitors)])]} />
        </Section>
      </View>
    </>
  );
}

function Activity({ d }: { d: AdminActivity }) {
  const n = (k: string) => d.byKind.find((x) => x.kind === k)?.n ?? 0;
  const vol = d.volume.reduce((a, v) => a + (v.usd ?? 0), 0);
  const problems = d.failed.filter((f) => f.status !== 'pending' && f.status !== 'delivering').reduce((a, f) => a + f.n, 0);
  return (
    <>
      <Kpis items={[
        { label: 'Volume through FloorFeed', value: money(vol), sub: `buys, sells, bridges, mints · ${d.days}d` },
        { label: 'Buys / sells', value: `${n('buy')} / ${n('sell')}` },
        { label: 'Bridges / mints', value: `${n('bridge')} / ${n('mint')}` },
        { label: 'Practice trades', value: num(d.practice.n), sub: `${d.practice.traders} traders` },
      ]} />
      <Section title="Volume" note="Confirmed transactions, at today's prices.">
        <Table head={['What', 'Count', 'Amount', 'USD']} rows={d.volume.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).map((v) => [
          v.kind[0].toUpperCase() + v.kind.slice(1), num(v.n), `${+v.amount.toFixed(4)} ${v.unit}`, money(v.usd),
        ])} />
      </Section>
      <View style={s.split}>
        <Section half title="By network">
          <Table head={['Network', 'Txs']} rows={d.byChain.map((c) => [chainName(c.chain), num(c.n)])} />
        </Section>
        <Section half title="Problems" note="Failed, dropped or refunded in this range.">
          <Table head={['Status', 'Count']} rows={d.failed.map((f) => [f.status, num(f.n)])} empty="None." />
          {problems > 0 && <Text style={[T.caption, { color: AMBER }]}>Check Support for reports from these users.</Text>}
        </Section>
      </View>
      <Section title="Latest transactions">
        <Table head={['Transaction', 'Network', 'When', 'Our fee']} rows={d.recent.map((r) => [
          <View key={`${r.createdAt}${r.title}`} style={{ gap: 1 }}>
            <Text style={T.body} numberOfLines={1}>{r.title}</Text>
            <Text style={[T.caption, r.status !== 'confirmed' && { color: AMBER }]}>{r.name ?? 'Unknown account'} · {r.status}</Text>
          </View>,
          chainName(r.chain), `${timeAgo(r.createdAt)} ago`, r.feeUsd ? money(r.feeUsd) : '—',
        ])} />
      </Section>
    </>
  );
}

function Moderation({ d, reload }: { d: AdminModeration; reload: () => void }) {
  const run = (p: Promise<unknown>) => p.then(reload).catch(() => reload());
  return (
    <>
      <Section title="Reported theses" note="Three reports hide a thesis until you restore it.">
        {d.takes.length ? d.takes.map((t) => (
          <View key={t.id} style={s.item}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={T.body}>{t.text}</Text>
              <Text style={[T.caption, t.hidden ? { color: C.down } : null]}>
                {t.name ?? 'Member'} on {t.collection} · {t.reports} report{t.reports === 1 ? '' : 's'}{t.hidden ? ' · hidden' : ''}
              </Text>
            </View>
            <View style={s.acts}>
              <Act label="Restore" onPress={() => run(api.adminRestoreTake(t.id))} />
              <Act label="Delete" danger onPress={() => run(api.adminDeleteTake(t.id))} />
            </View>
          </View>
        )) : <Text style={T.meta}>Nothing reported.</Text>}
      </Section>
      <Section title="Support inbox" note="Open reports from the Support page.">
        {d.support.length ? d.support.map((r) => (
          <View key={r.id} style={s.item}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={T.body}>{r.message}</Text>
              <Text style={T.caption}>
                #{r.id} · {r.topic} · {timeAgo(Math.floor(r.created_at / 1000))} ago{r.contact ? ` · ${r.contact}` : ''}{r.page ? ` · ${r.page}` : ''}
                {r.wallets.length ? ` · ${r.wallets.map(shortAddr).join(', ')}` : ''}
              </Text>
            </View>
            <View style={s.acts}><Act label="Close" onPress={() => run(api.adminSupport(r.id, 'close'))} /></View>
          </View>
        )) : <Text style={T.meta}>Inbox zero.</Text>}
      </Section>
      <Section title="Launchpad" note="Hidden collections drop off the Mint hub and their public page.">
        {d.launches.length ? d.launches.map((l) => (
          <View key={l.id} style={s.item}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={T.bodyStrong}>{l.name} <Text style={T.meta}>{l.symbol}</Text></Text>
              <Text style={[T.caption, l.status === 'hidden' ? { color: C.down } : l.status === 'live' ? { color: C.up } : null]}>
                {l.status} · {chainName(l.chain)} · {l.items} items · {l.owner ?? 'unknown creator'}{l.address ? ` · ${shortAddr(l.address)}` : ''}
              </Text>
            </View>
            <View style={s.acts}>
              {l.status === 'hidden'
                ? <Act label="Show" onPress={() => run(api.adminLaunch(l.id, 'show'))} />
                : <Act label="Hide" danger onPress={() => run(api.adminLaunch(l.id, 'hide'))} />}
            </View>
          </View>
        )) : <Text style={T.meta}>No launches yet.</Text>}
      </Section>
    </>
  );
}

function System({ d }: { d: AdminSystem }) {
  const [nowSec] = useState(() => Date.now() / 1000);
  const hours = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86_400 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86_400).toFixed(1)}d`);
  return (
    <>
      <Kpis items={[
        { label: 'Up for', value: hours(d.uptimeSec) },
        { label: 'Memory', value: `${d.memoryMb} MB` },
        { label: 'Database', value: d.dbBytes != null ? `${(d.dbBytes / 1e6).toFixed(0)} MB` : '—' },
        { label: 'Stuck txs', value: num(d.stuck), sub: 'pending over an hour', color: d.stuck ? AMBER : undefined },
      ]} />
      <Section title="Sales data, last 24h" note="Newest sale seen per network. Old means the poller for it is behind.">
        <Table head={['Network', 'Sales', 'Newest']} rows={d.tradesByChain24h.map((t) => {
          const age = nowSec - t.last;
          return [chainName(t.chain), num(t.n), <Text key={t.chain} style={[T.metaNum, { color: age > 6 * 3600 ? AMBER : C.dim }]}>{hours(age)} ago</Text>];
        })} empty="No sales in the last day: is ingest running?" />
      </Section>
      <View style={s.split}>
        <Section half title="Data">
          <Table head={['Table', 'Rows']} rows={Object.entries(d.tables).map(([k, v]) => [k, num(v)])} />
          {d.lastEventAt && <Text style={T.caption}>Last analytics hit {timeAgo(d.lastEventAt / 1000)} ago</Text>}
        </Section>
        <Section half title="Settings">
          <Table head={['Setting', 'Value']} rows={[
            ['Bridge fee', d.config.relayFeeBps ? `${d.config.relayFeeBps / 100}%` : 'Off'],
            ['Buy fee', d.config.buyFeeBps ? `${d.config.buyFeeBps / 100}%` : 'Off'],
            ['Launch networks', d.config.launchChains.map(chainName).join(', ') || '—'],
            ['Helius', d.config.helius ? 'On' : 'Off'],
            ['Privy', d.config.privy ? 'On' : 'Off'],
            ['Admins', num(d.config.adminUsers)],
          ]} />
        </Section>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 1040, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  seg: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  segBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 7 },
  segOn: { backgroundColor: C.cardHi },
  segTxt: { color: C.dim, fontSize: 13, fontWeight: '600' },
  tabs: { gap: 4, padding: 3, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 9 },
  tabOn: { backgroundColor: C.cardHi },
  tabTxt: { color: C.dim, fontSize: 14, fontWeight: '600' },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpi: { flexGrow: 1, flexBasis: 150, gap: 2, padding: 14, borderRadius: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  secHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  bars: { height: 120, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  barCol: { flex: 1, height: '100%', justifyContent: 'flex-end', gap: 1, minWidth: 2 },
  legend: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  thRow: { borderTopWidth: 0, paddingTop: 0 },
  th: { ...T.caption, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  td0: { ...T.body },
  td: { ...T.metaNum, color: C.text },
  c0: { flex: 3, minWidth: 0 },
  cn: { flex: 1, minWidth: 56, textAlign: 'right' },
  act: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.border },
  actTxt: { color: C.text, fontSize: 13, fontWeight: '600' },
  acts: { flexDirection: 'row', gap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, flexWrap: 'wrap' },
  funnel: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  funnelTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: C.cardHi, overflow: 'hidden' },
  funnelBar: { height: '100%', borderRadius: 5, backgroundColor: C.accent },
  post: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  split: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' },
});
