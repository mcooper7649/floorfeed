import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { PushCard } from '@/components/push-card';
import { ThesisFeedRow } from '@/components/thesis';
import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import { useAlerts } from '@/lib/alerts';
import {
  api, type Alert, type Chain, type CollectionSummary, type Drop, type FeedEvent, type HolderRow, type LeaderWindow, type ThesisFeedItem, type Trader, type Unit,
} from '@/lib/api';
import { shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { thumb } from '@/lib/img';
import { PANEL_GAP, PANEL_WIDTH, usePanel } from '@/lib/panel';
import { useSession } from '@/lib/session';

// Desktop discovery panel, left of every page on wide web: Alerts,
// Collections (watchlist, blue chips, trending, smart money, breakouts,
// following), Leaders, and a live Feed. Dense rows: art with a chain badge,
// name and one fact on the left; floor and 24h change on the right.

type Tab = 'alerts' | 'collections' | 'thesis' | 'leaders' | 'feed';
type List = 'watch' | 'blue' | 'trending' | 'smart' | 'new' | 'minting' | 'breakouts' | 'following';

const TABS: { key: Tab; label: string }[] = [
  { key: 'alerts', label: 'Alerts' }, { key: 'collections', label: 'Discover' }, { key: 'thesis', label: 'Thesis' },
  { key: 'leaders', label: 'Leaders' }, { key: 'feed', label: 'Feed' },
];
const LISTS: { key: List; label: string }[] = [
  { key: 'watch', label: 'Watchlist' }, { key: 'blue', label: 'Blue chips' }, { key: 'trending', label: 'Trending' },
  { key: 'smart', label: 'Smart money' }, { key: 'new', label: 'New' }, { key: 'minting', label: 'Minting' },
  { key: 'breakouts', label: 'Breakouts' }, { key: 'following', label: 'Following' },
];

const ageDays = (date: string) => (Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
const usd = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const go = (href: Parameters<typeof router.push>[0]) => router.push(href);
const toColl = (symbol: string) => go({ pathname: '/collection/[symbol]', params: { symbol } });
const toWallet = (address: string) => go({ pathname: '/wallet/[address]', params: { address } });

export function DiscoveryPanel() {
  const { open, toggle } = usePanel();
  const [tab, setTab] = useState<Tab>('collections');
  const { unread } = useAlerts();

  if (!open) {
    return (
      <View style={s.rail}>
        <Pressable onPress={toggle} accessibilityLabel="Show discovery panel" style={s.railBtn} hitSlop={6}>
          <Text style={s.railTxt}>»</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={s.panel}>
      <View style={s.tabs}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 11, alignItems: 'center' }} style={{ flex: 1 }}>
          {TABS.map((t) => (
            <Pressable key={t.key} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
              <Text style={[s.tab, tab === t.key && s.tabOn]}>
                {t.label}{t.key === 'alerts' && unread > 0 ? <Text style={s.dot}> ●</Text> : null}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable onPress={toggle} accessibilityLabel="Collapse discovery panel" hitSlop={8}>
          <Text style={s.collapse}>«</Text>
        </Pressable>
      </View>
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'collections' && <CollectionsTab />}
      {tab === 'thesis' && <ThesisFeedTab />}
      {tab === 'leaders' && <LeadersTab />}
      {tab === 'feed' && <FeedTab />}
    </View>
  );
}

// --- Shared pieces -------------------------------------------------------------

function Chips<K extends string>({ items, value, onChange }: { items: { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    // Wraps onto more lines rather than scrolling sideways, so every list is visible.
    <View style={s.chips}>
      {items.map((c) => (
        <Pressable key={c.key} onPress={() => onChange(c.key)} style={[s.chip, value === c.key && s.chipOn]}
          accessibilityRole="button" accessibilityState={{ selected: value === c.key }}>
          <Text style={[s.chipTxt, value === c.key && { color: C.text }]}>{c.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Notice({ tone = 'info', title, text }: { tone?: 'info' | 'caution'; title: string; text: string }) {
  const caution = tone === 'caution';
  return (
    <View style={[s.notice, caution && s.noticeCaution]}>
      <Text style={[s.noticeTitle, caution && { color: '#F5B547' }]}>{caution ? '⚠ ' : 'ⓘ '}{title}</Text>
      <Text style={s.noticeTxt}>{text}</Text>
    </View>
  );
}

function Art({ uri, name, chain, round = true }: { uri: string | null; name: string; chain?: Chain; round?: boolean }) {
  return (
    <View style={{ width: 36, height: 36 }}>
      <CollIcon uri={uri} name={name} size={36} radius={round ? 18 : 8} />
      {chain && <View style={s.chainDot}><Text style={s.chainTxt}>{(CHAINS[chain]?.badge ?? chain).slice(0, 1)}</Text></View>}
    </View>
  );
}

function Row({ left, title, extra, sub, value, change, changeColor, onPress }: {
  left: ReactNode; title: string; extra?: ReactNode; sub?: string; value?: string; change?: string; changeColor?: string; onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [s.row, (hovered || pressed) && { backgroundColor: C.card }]}>
      {left}
      <View style={s.rowMid}>
        <View style={s.titleLine}>
          <Text style={s.name} numberOfLines={1}>{title}</Text>
          {extra}
        </View>
        {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {(value || change) ? (
        <View style={s.rowEnd}>
          {value ? <Text style={s.value} numberOfLines={1}>{value}</Text> : null}
          {change ? <Text style={[s.change, { color: changeColor ?? C.dim }]} numberOfLines={1}>{change}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const pctText = (p: number | null) => (p == null ? undefined : `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 1)}%`);
// Fewer decimals as amounts grow (0.007 ETH, 8.64 SOL, 6,999 APE).
const amount = (n: number, unit: string) => (n >= 100 ? `${Math.round(n).toLocaleString('en-US')} ${unit}` : sol(n, n >= 10 ? 1 : 2, unit));
const signedAmount = (n: number, unit: string) => (Math.abs(n) >= 100 ? `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n)).toLocaleString('en-US')} ${unit}` : signedSol(n, 2, unit));
const pctColor = (p: number | null) => (p == null ? C.dim : p >= 0 ? C.up : C.down);

function Faces({ wallets, total }: { wallets: { wallet: string; avatar: string | null }[]; total: number }) {
  return (
    <View style={s.faces}>
      {wallets.slice(0, 3).map((w, i) => (
        <View key={w.wallet} style={[s.face, { marginLeft: i ? -6 : 0 }]}>
          {w.avatar ? <Image source={thumb(w.avatar, 40)} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        </View>
      ))}
      <Text style={s.facesTxt}>{total}{total > 3 ? '+' : ''}</Text>
    </View>
  );
}

function Scroll({ children, loading, empty }: { children?: ReactNode; loading?: boolean; empty?: ReactNode }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.list}>
      {loading ? <ActivityIndicator style={{ marginTop: 24 }} color={C.accent} /> : children || empty}
    </ScrollView>
  );
}

const Empty = ({ text, cta, onPress }: { text: string; cta?: string; onPress?: () => void }) => (
  <View style={s.empty}>
    <Text style={s.emptyTxt}>{text}</Text>
    {cta && <Pressable onPress={onPress} style={s.emptyBtn}><Text style={s.emptyBtnTxt}>{cta}</Text></Pressable>}
  </View>
);

// --- Data, shared by tabs and refreshed every minute -------------------------------

function useCollections() {
  const [rows, setRows] = useState<CollectionSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.collections().then((r) => alive && setRows(r)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return rows;
}

// --- Collections -------------------------------------------------------------------

// Also the phone's Discover view (Markets tab).
export function CollectionsTab() {
  const [list, setList] = useState<List>('trending');
  const rows = useCollections();
  const { watchlist, userId } = useSession();
  const [holders, setHolders] = useState<{ smart: HolderRow[]; following: HolderRow[] } | null>(null);
  useEffect(() => {
    if (list !== 'smart' && list !== 'following') return;
    let alive = true;
    api.holders(userId).then((h) => alive && setHolders(h)).catch(() => alive && setHolders({ smart: [], following: [] }));
    return () => { alive = false; };
  }, [list, userId]);

  const bySymbol = useMemo(() => new Map((rows ?? []).map((r) => [r.symbol, r])), [rows]);

  const ranked = useMemo(() => {
    if (!rows) return [];
    const vol24 = (r: CollectionSummary) => r.volume24hUsd ?? 0;
    switch (list) {
      case 'watch': return rows.filter((r) => watchlist.has(r.symbol));
      case 'blue': return [...rows].sort((a, b) => (b.volume7dUsd ?? 0) - (a.volume7dUsd ?? 0)).slice(0, 40);
      // Today's volume against the 7-day daily average, among collections that really traded.
      case 'trending': return rows.filter((r) => vol24(r) >= 5_000 && (r.volume7dUsd ?? 0) > 0)
        .map((r) => ({ r, x: vol24(r) / ((r.volume7dUsd ?? 1) / 7) }))
        .sort((a, b) => b.x - a.x).slice(0, 40).map((v) => v.r);
      // New & hot: created in the last 30 days and already in a chain's top-volume list.
      case 'new': return rows.filter((r) => r.createdAt && ageDays(r.createdAt) <= 30)
        .sort((a, b) => (b.volume7dUsd ?? 0) - (a.volume7dUsd ?? 0)).slice(0, 40);
      case 'breakouts': return rows.filter((r) => (r.change24hPct ?? 0) > 0 && (vol24(r) >= 2_000 || (r.volume7dUsd ?? 0) >= 20_000))
        .sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0)).slice(0, 40);
      default: return [];
    }
  }, [rows, list, watchlist]);

  const collRow = (c: CollectionSummary, sub: string, extra?: ReactNode) => (
    <Row key={c.symbol} left={<Art uri={c.image} name={c.name} chain={c.chain} />} title={c.name} extra={extra} sub={sub}
      value={c.floor != null ? amount(c.floor, c.currency) : '—'}
      change={pctText(c.change24hPct)} changeColor={pctColor(c.change24hPct)} onPress={() => toColl(c.symbol)} />
  );
  const holderRows = (hs: HolderRow[], what: string) => hs.flatMap((h) => {
    const c = bySymbol.get(h.symbol);
    return c ? [collRow(c, `${h.holders} ${what}`, <Faces wallets={h.wallets} total={h.holders} />)] : [];
  });

  let body: ReactNode;
  if (list === 'minting') {
    body = <MintingList />;
  } else if (list === 'smart' || list === 'following') {
    const hs = holders?.[list] ?? [];
    body = (
      <Scroll loading={!holders || !rows} empty={list === 'following'
        ? <Empty text="Follow wallets and the collections they hold right now show up here." cta="Find traders to follow" onPress={() => go('/leaderboard')} />
        : <Empty text="No proven wallets are holding tracked collections right now." />}>
        {list === 'smart'
          ? <Notice title="Held by proven flippers" text="Collections that Top Flipper and Proven wallets bought in the last 30 days and still hold." />
          : null}
        {hs.length ? holderRows(hs, list === 'smart' ? 'proven holders' : 'you follow') : null}
      </Scroll>
    );
  } else {
    body = (
      <Scroll loading={!rows} empty={list === 'watch'
        ? <Empty text="Tap ☆ on any collection to keep it here." cta="Browse collections" onPress={() => go('/markets')} />
        : <Empty text="Nothing here right now." />}>
        {list === 'breakouts' && ranked.length
          ? <Notice tone="caution" title="Floors move fast" text="Biggest 24h floor gains among collections with real volume. Thin books can drop as quickly as they rise." />
          : null}
        {list === 'new' && ranked.length
          ? <Notice tone="caution" title="Young collections" text="Created in the last 30 days and already among the busiest on their chain. New projects are the riskiest kind." />
          : null}
        {ranked.length ? ranked.map((c) => collRow(c, list === 'new'
          ? `🌱 ${Math.max(1, Math.round(ageDays(c.createdAt!)))}d old · ${usd(c.volume7dUsd)} vol 7d`
          : list === 'trending' || list === 'breakouts'
          ? `${usd(c.volume24hUsd)} vol 24h`
          : `${usd(c.volume7dUsd)} vol 7d`)) : null}
      </Scroll>
    );
  }

  return (
    <>
      <Chips items={LISTS} value={list} onChange={setList} />
      {body}
    </>
  );
}

// --- Minting: live and upcoming OpenSea drops ---------------------------------------

function inWords(sec: number) {
  const d = Math.abs(sec);
  return d >= 86_400 ? `${Math.round(d / 86_400)}d` : d >= 3600 ? `${Math.round(d / 3600)}h` : `${Math.max(1, Math.round(d / 60))}m`;
}

function MintingList() {
  const [loaded, setLoaded] = useState<{ drops: Drop[]; now: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api.drops().then((d) => alive && setLoaded({ drops: d, now: Date.now() / 1000 }))
      .catch(() => alive && setLoaded({ drops: [], now: Date.now() / 1000 }));
    return () => { alive = false; };
  }, []);
  const drops = loaded?.drops ?? null;
  const now = loaded?.now ?? 0;
  return (
    <Scroll loading={!drops} empty={<Empty text="No live or upcoming mints right now." />}>
      {drops?.length ? (
        <>
          <Notice tone="caution" title="Mint here, carefully" text="Live and upcoming drops across chains. Open one to see its stages and mint in FloorFeed. Most new NFTs lose value, so check the collection first." />
          {drops.map((d) => {
            const soon = !d.minting && d.startsAt != null && d.startsAt > now;
            const when = d.minting
              ? d.endsAt ? `ends in ${inWords(d.endsAt - now)}` : 'minting now'
              : soon ? `starts in ${inWords(d.startsAt! - now)}` : 'minted';
            return (
              <Row key={d.slug} left={<Art uri={d.image} name={d.name} chain={(d.chain in CHAINS ? d.chain : undefined) as Chain | undefined} />}
                title={d.name}
                extra={d.minting ? <Badge text="Live" tone="buy" /> : soon ? <Badge text="Soon" tone="info" /> : null}
                sub={`${CHAINS[d.chain as Chain]?.name ?? d.chain} · ${d.stage ? `${d.stage} · ` : ''}${when}`}
                value={d.price == null ? '—' : d.price === 0 ? 'Free' : `${trimNum(d.price)} ${d.currency}`}
                change={d.priceUsd ? `$${d.priceUsd >= 100 ? d.priceUsd.toFixed(0) : d.priceUsd.toFixed(2)}` : undefined}
                onPress={() => go({ pathname: '/drop/[slug]', params: { slug: d.slug } })} />
            );
          })}
        </>
      ) : null}
    </Scroll>
  );
}
const trimNum = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2)).replace(/\.?0+$/, '');

// --- Alerts --------------------------------------------------------------------------

function AlertsTab() {
  const { userId, following } = useSession();
  const { unread } = useAlerts();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api.alerts(userId).then((r) => alive && setAlerts(r.alerts)).catch(() => alive && setAlerts([]));
    return () => { alive = false; };
  }, [userId, unread]);

  return (
    <Scroll loading={!alerts && !!userId} empty={following.size
      ? <Empty text="No trades from the wallets you follow yet. They show up here as they happen." />
      : <Empty text="Follow a wallet to get its buys and sales here, with a notification if you want one." cta="Find traders to follow" onPress={() => go('/leaderboard')} />}>
      {following.size ? <View style={{ marginBottom: 6 }}><PushCard compact /></View> : null}
      {alerts?.length ? (
        <>
          {alerts.slice(0, 30).map((a) => (
            <Row key={a.id} left={<Art uri={a.image} name={a.collection.name} round={false} />}
              title={`${a.name ?? shortAddr(a.wallet)} ${a.side === 'buy' ? 'bought' : a.pnl == null ? 'sold' : a.pnl >= 0 ? 'flipped' : 'sold'}`}
              sub={`${a.collection.name} · ${timeAgo(a.t)}`}
              value={amount(a.price, a.currency)}
              change={a.pnl != null ? signedAmount(a.pnl, a.currency) : a.read ? undefined : 'new'}
              changeColor={a.pnl == null ? C.accent : a.pnl >= 0 ? C.up : C.down}
              onPress={() => go({ pathname: '/item/[symbol]/[id]', params: { symbol: a.collection.symbol, id: a.mint } })} />
          ))}
          <Pressable onPress={() => go('/alerts')} style={s.more}><Text style={s.moreTxt}>All alerts →</Text></Pressable>
        </>
      ) : null}
    </Scroll>
  );
}

// --- Thesis: the live feed of theses across collections ---------------------------

export function useThesisFeed() {
  const { userId } = useSession();
  const [items, setItems] = useState<ThesisFeedItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.theses(userId).then((r) => alive && setItems(r)).catch(() => alive && setItems((x) => x ?? []));
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [userId]);
  return items;
}

function ThesisFeedTab() {
  const items = useThesisFeed();
  return (
    <Scroll loading={!items} empty={<Empty text="No theses yet. Open any collection and post the first one in its Thesis tab." />}>
      {items?.length ? (
        <>
          <Text style={s.caption}>Live: what holders and traders think, newest first</Text>
          {items.map((t) => <ThesisFeedRow key={`${t.kind}:${t.id}`} t={t} compact />)}
        </>
      ) : null}
    </Scroll>
  );
}

// --- Leaders -------------------------------------------------------------------------

const WINDOWS: { key: LeaderWindow; label: string }[] = [{ key: '7', label: '7D' }, { key: '30', label: '30D' }, { key: 'all', label: 'All' }];
const UNITS: { key: Unit; label: string }[] = [{ key: 'SOL', label: 'SOL' }, { key: 'ETH', label: 'ETH' }];

function LeadersTab() {
  const [win, setWin] = useState<LeaderWindow>('7');
  const [unit, setUnit] = useState<Unit>('SOL');
  const [rows, setRows] = useState<{ key: string; rows: (Trader & { roiPct?: number | null })[] } | null>(null);
  const key = `${win}:${unit}`;
  useEffect(() => {
    let alive = true;
    api.leaderboard({ window: win, sort: 'pnl', hideMM: true, unit })
      .then((b) => alive && setRows({ key, rows: b.rows as never }))
      .catch(() => alive && setRows({ key, rows: [] }));
    return () => { alive = false; };
  }, [win, unit, key]);
  const list = rows?.key === key ? rows.rows : null;

  return (
    <>
      <View style={s.chipPair}>
        <Chips items={WINDOWS} value={win} onChange={setWin} />
        <Chips items={UNITS} value={unit} onChange={setUnit} />
      </View>
      <Text style={s.caption}>Realized P&L after fees and royalties</Text>
      <Scroll loading={!list} empty={<Empty text="No ranked flippers in this window yet." />}>
        {list?.length ? (
          <>
            {list.slice(0, 40).map((t, i) => (
              <Row key={t.wallet}
                left={<View style={s.rank}><Text style={s.rankTxt}>{i + 1}</Text><Art uri={t.avatar} name={t.name ?? t.wallet} /></View>}
                title={t.name ?? shortAddr(t.wallet)}
                sub={`${t.flips} flips · ${t.winRate == null ? '—' : `${Math.round(t.winRate * 100)}% wins`}`}
                value={signedAmount(t.realizedSol, unit)} changeColor={(t.roiPct ?? 0) >= 0 ? C.up : C.down}
                change={t.roiPct != null ? `${t.roiPct >= 0 ? '+' : '−'}${Math.abs(t.roiPct).toFixed(0)}% ROI` : undefined}
                onPress={() => toWallet(t.wallet)} />
            ))}
            <Pressable onPress={() => go('/leaderboard')} style={s.more}><Text style={s.moreTxt}>Full leaderboard →</Text></Pressable>
          </>
        ) : null}
      </Scroll>
    </>
  );
}

// --- Feed: every trade as it lands, compact ----------------------------------------

function FeedTab() {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.events({ view: 'latest' }).then((r) => alive && setEvents(r.events)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <Scroll loading={!events} empty={<Empty text="No trades yet." />}>
      {events?.length ? events.map((e) => <FeedRow key={e.id} e={e} />) : null}
    </Scroll>
  );
}

function Badge({ text, tone }: { text: string; tone: 'buy' | 'sell' | 'info' }) {
  const color = tone === 'buy' ? C.up : tone === 'sell' ? C.down : C.ai;
  return <View style={[s.badge, { borderColor: color }]}><Text style={[s.badgeTxt, { color }]}>{text}</Text></View>;
}

function FeedRow({ e }: { e: FeedEvent }) {
  const cur = e.collection.currency;
  const t = timeAgo(e.t);
  switch (e.kind) {
    case 'buy':
      return <Row left={<Art uri={e.wallet.avatar} name={e.wallet.name ?? e.wallet.wallet} />} title={e.wallet.name ?? shortAddr(e.wallet.wallet)}
        extra={<Badge text="Buy" tone="buy" />} sub={`${e.collection.name} · ${t}`} value={amount(e.price, cur)}
        onPress={() => go({ pathname: '/item/[symbol]/[id]', params: { symbol: e.collection.symbol, id: e.mint } })} />;
    case 'flip':
      return <Row left={<Art uri={e.wallet.avatar} name={e.wallet.name ?? e.wallet.wallet} />} title={e.wallet.name ?? shortAddr(e.wallet.wallet)}
        extra={<Badge text={e.pnl >= 0 ? 'Flip' : 'Sell'} tone="sell" />} sub={`${e.collection.name} · ${t}`} value={amount(e.sell, cur)}
        change={signedAmount(e.pnl, cur)} changeColor={e.pnl >= 0 ? C.up : C.down}
        onPress={() => go({ pathname: '/item/[symbol]/[id]', params: { symbol: e.collection.symbol, id: e.mint } })} />;
    case 'sweep':
      return <Row left={<Art uri={e.wallet.avatar} name={e.wallet.name ?? e.wallet.wallet} />} title={e.wallet.name ?? shortAddr(e.wallet.wallet)}
        extra={<Badge text={`Swept ${e.count}`} tone="buy" />} sub={`${e.collection.name} · ${t}`} value={amount(e.total, cur)}
        onPress={() => toColl(e.collection.symbol)} />;
    case 'cluster':
      return <Row left={<Art uri={e.images[0] ?? null} name={e.collection.name} chain={e.collection.chain} round={false} />} title={e.collection.name}
        extra={<Badge text={`${e.count} wallets`} tone="info" />} sub={`${e.buys} buys · ${t}`} value={amount(e.avg, cur)} change="avg"
        onPress={() => toColl(e.collection.symbol)} />;
  }
}

const s = StyleSheet.create({
  panel: {
    width: PANEL_WIDTH, marginLeft: PANEL_GAP, marginVertical: 12, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, overflow: 'hidden', backgroundColor: C.bg,
  },
  rail: { width: 44, alignItems: 'center', paddingTop: 16 },
  railBtn: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  railTxt: { color: C.dim, fontSize: 16, lineHeight: 18 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 },
  tab: { color: C.dim, fontSize: 13, fontWeight: '500' },
  tabOn: { color: C.text },
  dot: { color: C.accent, fontSize: 10 },
  collapse: { color: C.dim, fontSize: 18, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chipPair: { gap: 0 },
  chip: { height: 24, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: C.card, justifyContent: 'center' },
  chipOn: { backgroundColor: C.card },
  chipTxt: { color: C.dim, fontSize: 12, fontWeight: '700' },
  list: { paddingHorizontal: 6, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8 },
  rowMid: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  name: { color: C.text, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  sub: { color: C.dim, fontSize: 12, fontWeight: '500' },
  rowEnd: { alignItems: 'flex-end', gap: 2, maxWidth: 110 },
  value: { color: C.text, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
  chainDot: {
    position: 'absolute', right: -3, bottom: -3, width: 16, height: 16, borderRadius: 8, backgroundColor: C.cardHi,
    borderWidth: 2, borderColor: C.bg, alignItems: 'center', justifyContent: 'center',
  },
  chainTxt: { color: C.text, fontSize: 8, fontWeight: '700', lineHeight: 10 },
  faces: { flexDirection: 'row', alignItems: 'center' },
  face: { width: 16, height: 16, borderRadius: 8, overflow: 'hidden', backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.bg },
  facesTxt: { color: C.dim, fontSize: 11, fontWeight: '600', marginLeft: 3 },
  notice: { backgroundColor: C.card, borderRadius: 10, padding: 10, margin: 6, gap: 3 },
  noticeCaution: { backgroundColor: '#211A10' },
  noticeTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  noticeTxt: { color: C.dim, fontSize: 12, lineHeight: 16 },
  empty: { padding: 20, gap: 12, alignItems: 'center' },
  emptyTxt: { color: C.dim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  emptyBtn: { borderRadius: 8, backgroundColor: C.accent, paddingHorizontal: 12, paddingVertical: 8 },
  emptyBtnTxt: { color: C.accentInk, fontSize: 13, fontWeight: '600' },
  more: { padding: 10, alignItems: 'center' },
  moreTxt: { color: C.accent, fontSize: 13, fontWeight: '600' },
  caption: { color: C.muted, fontSize: 11, paddingHorizontal: 14, paddingBottom: 4 },
  rank: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rankTxt: { color: C.dim, fontSize: 12, fontWeight: '600', width: 16, textAlign: 'right', fontVariant: ['tabular-nums'] },
  badge: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 4, paddingVertical: 0 },
  badgeTxt: { fontSize: 10, fontWeight: '700' },
});
