import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { FlashBg, TickArrow, useTick } from '@/components/flash';
import { MODE_COLOR } from '@/components/mode-toggle';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type PaperPosition } from '@/lib/api';
import { amt, pct, signedSol, signedUsd, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';
import { useSession } from '@/lib/session';

// Practice NFTs for the Your NFTs panel and phone sheet: what you bought with
// simulated money, valued at today's floor after fees (what selling now would
// get), with a one-tap Sell. Each practice buy is one floor NFT, so several
// buys of one collection show as one row with a count.

const EVERY = 30_000; // the server marks open positions at the latest floor
const PURPLE = MODE_COLOR.paper;
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export type PracticeGroup = {
  symbol: string; name: string; image: string | null; unit: string;
  positions: PaperPosition[]; // open ones, oldest first (Sell sells the oldest)
  cost: number; value: number; pnl: number; pnlPct: number;
  usd: number | null; pnlUsd: number | null;
};

export function usePracticeNfts() {
  const { userId, portfolioVersion, bumpPortfolio } = useSession();
  const { toUsd } = usePrices();
  const [book, setBook] = useState<{ userId: string; positions: PaperPosition[] } | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!userId || !visible()) return;
    api.paper(userId).then((b) => { setBook({ userId, positions: b.positions }); setCheckedAt(Date.now()); }).catch(() => {});
  }, [userId]);
  useEffect(() => {
    load();
    const t = setInterval(load, EVERY);
    document.addEventListener?.('visibilitychange', load);
    return () => { clearInterval(t); document.removeEventListener?.('visibilitychange', load); };
  }, [load, portfolioVersion]);

  const positions = useMemo(() => (book?.userId === userId ? book.positions : null), [book, userId]);

  const groups = useMemo(() => {
    const by = new Map<string, PaperPosition[]>();
    for (const p of positions ?? []) if (p.open) by.set(p.collection.symbol, [...(by.get(p.collection.symbol) ?? []), p]);
    return [...by.values()].map((ps): PracticeGroup => {
      const sorted = [...ps].sort((a, b) => a.openedAt - b.openedAt);
      const c = sorted[0].collection;
      const unit = sorted[0].currency ?? 'SOL';
      const cost = sorted.reduce((a, p) => a + p.entryPrice, 0);
      const pnl = sorted.reduce((a, p) => a + p.pnlSol, 0);
      const value = cost + pnl;
      return {
        symbol: c.symbol, name: c.name, image: c.image ?? null, unit, positions: sorted,
        cost, value, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0, usd: toUsd(value, unit), pnlUsd: toUsd(pnl, unit),
      };
    }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  }, [positions, toUsd]);

  const closed = useMemo(() => (positions ?? []).filter((p) => !p.open).sort((a, b) => b.openedAt - a.openedAt), [positions]);

  // Totals in dollars across coins.
  const valueUsd = groups.reduce((a, g) => a + (g.usd ?? 0), 0);
  const costUsd = groups.reduce((a, g) => a + (toUsd(g.cost, g.unit) ?? 0), 0);
  const openPnlUsd = groups.reduce((a, g) => a + (g.pnlUsd ?? 0), 0);
  const realizedUsd = closed.reduce((a, p) => a + (toUsd(p.pnlSol, p.currency ?? 'SOL') ?? 0), 0);
  const count = groups.reduce((a, g) => a + g.positions.length, 0);

  const sell = useCallback(async (id: number) => {
    if (!userId) return;
    await api.sell(userId, id);
    track('paper_sell');
    bumpPortfolio();
  }, [userId, bumpPortfolio]);

  // Every open position, one sell at a time; `onProgress` gets how many are done.
  // Stops at the first failure (what sold stays sold) and refreshes either way.
  const sellAll = useCallback(async (onProgress?: (done: number) => void) => {
    if (!userId) return;
    const ids = groups.flatMap((g) => g.positions.map((p) => p.id));
    try {
      for (const [i, id] of ids.entries()) {
        await api.sell(userId, id);
        onProgress?.(i + 1);
      }
      track('paper_sell', { all: ids.length });
    } finally {
      bumpPortfolio();
    }
  }, [userId, groups, bumpPortfolio]);

  return {
    loaded: positions != null, checkedAt, groups, closed, count, sell, sellAll,
    valueUsd, openPnlUsd, openPnlPct: costUsd > 0 ? (openPnlUsd / costUsd) * 100 : null, realizedUsd,
  };
}

export type PracticeNfts = ReturnType<typeof usePracticeNfts>;

export function PracticeNftsBody({ nfts, onOpen }: { nfts: PracticeNfts; onOpen?: () => void }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  if (!nfts.loaded) return <ActivityIndicator color={PURPLE} style={{ marginTop: 24 }} />;
  const { groups, closed, count, valueUsd, openPnlUsd, openPnlPct, realizedUsd } = nfts;
  const browse = () => { onOpen?.(); router.push('/markets'); };

  if (!groups.length && !closed.length) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}><Text style={s.emptyGlyph}>◇</Text></View>
        <Text style={T.bodyStrong}>No practice NFTs yet</Text>
        <Text style={[T.meta, { textAlign: 'center' }]}>Buy any collection’s floor with simulated money and watch it here at live prices.</Text>
        <Pressable onPress={browse} style={s.cta}><Text style={s.ctaTxt}>Browse collections</Text></Pressable>
      </View>
    );
  }

  return (
    <>
      <View style={s.summary}>
        <Text style={s.kicker}>Practice value</Text>
        <Text style={s.big}>{usd(valueUsd)}</Text>
        <View style={s.chips}>
          {openPnlPct != null && count > 0 && (
            <Text style={[s.chip, { color: openPnlUsd >= 0 ? C.up : C.down }]}>{signedUsd(openPnlUsd)} ({pct(openPnlPct)}) open</Text>
          )}
          {closed.length > 0 && <Text style={[s.chip, { color: realizedUsd >= 0 ? C.up : C.down }]}>{signedUsd(realizedUsd)} sold</Text>}
        </View>
      </View>

      <View style={s.tabs} accessibilityRole="tablist">
        {(['open', 'closed'] as const).map((k) => {
          const on = tab === k;
          const n = k === 'open' ? count : closed.length;
          return (
            <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(k)} style={[s.tab, on && s.tabOn]}>
              <Text style={[s.tabTxt, on && { color: C.text }]}>{k === 'open' ? 'Holding' : 'Sold'}</Text>
              {n > 0 && <Text style={[s.tabCount, on && { color: PURPLE }]}>{n}</Text>}
            </Pressable>
          );
        })}
      </View>

      {tab === 'open' && count > 1 && <SellAll nfts={nfts} />}

      <ScrollView contentContainerStyle={s.list}>
        {tab === 'open'
          ? groups.length
            ? groups.map((g) => <HoldingRow key={g.symbol} g={g} onOpen={onOpen} sell={nfts.sell} />)
            : <Text style={[T.meta, s.note]}>Nothing open. Everything you bought has been sold.</Text>
          : closed.length
            ? closed.slice(0, 50).map((p) => <SoldRow key={p.id} p={p} onOpen={onOpen} />)
            : <Text style={[T.meta, s.note]}>Nothing sold yet.</Text>}
      </ScrollView>

      <Text style={s.foot}>Simulated money at live floors. Values are what selling now would get, after fees.</Text>
    </>
  );
}

// Sell every practice holding at today's estimated bid. Two taps (no blocking
// confirm dialogs on web); the first one arms it for a few seconds.
function SellAll({ nfts }: { nfts: PracticeNfts }) {
  const [state, setState] = useState<{ kind: 'idle' | 'armed' | 'error' } | { kind: 'selling'; done: number }>({ kind: 'idle' });
  useEffect(() => {
    if (state.kind !== 'armed' && state.kind !== 'error') return;
    const t = setTimeout(() => setState({ kind: 'idle' }), 4000);
    return () => clearTimeout(t);
  }, [state.kind]);
  const total = nfts.count;
  const press = () => {
    if (state.kind === 'selling') return;
    if (state.kind !== 'armed') return setState({ kind: 'armed' });
    setState({ kind: 'selling', done: 0 });
    nfts.sellAll((done) => setState({ kind: 'selling', done }))
      .then(() => setState({ kind: 'idle' }))
      .catch(() => setState({ kind: 'error' }));
  };
  const label = state.kind === 'selling' ? `Selling ${state.done}/${total}…`
    : state.kind === 'armed' ? `Tap again to sell all ${total}`
    : state.kind === 'error' ? 'Some didn’t sell. Tap to retry'
    : 'Sell all';
  const hot = state.kind === 'armed' || state.kind === 'error';
  return (
    <View style={s.allRow}>
      <Text style={[s.sub, { flex: 1 }]} numberOfLines={1}>
        {hot ? `≈ ${usd(nfts.valueUsd)} after fees` : `${total} NFTs across ${nfts.groups.length} collection${nfts.groups.length === 1 ? '' : 's'}`}
      </Text>
      <Pressable onPress={press} disabled={state.kind === 'selling'} accessibilityRole="button" accessibilityLabel="Sell all practice NFTs"
        style={({ hovered }: { hovered?: boolean }) => [s.all, hot && s.allHot, hovered && !hot && s.sellHot]}>
        <Text style={[s.allTxt, hot && { color: C.down }]}>{label}</Text>
      </Pressable>
    </View>
  );
}

function HoldingRow({ g, onOpen, sell }: { g: PracticeGroup; onOpen?: () => void; sell: (id: number) => Promise<void> }) {
  const { tick, at } = useTick(g.value);
  const [state, setState] = useState<'idle' | 'selling' | 'error'>('idle');
  const view = () => { onOpen?.(); router.push({ pathname: '/collection/[symbol]', params: { symbol: g.symbol } }); };
  const n = g.positions.length;
  const doSell = () => {
    setState('selling');
    sell(g.positions[0].id).then(() => setState('idle')).catch(() => setState('error'));
  };
  const up = g.pnl >= 0;
  return (
    <Pressable onPress={view} style={({ hovered }: { hovered?: boolean }) => [s.row, hovered && { backgroundColor: C.card }]}>
      <FlashBg tick={tick} at={at} />
      <View>
        <CollIcon uri={g.image} name={g.name} size={44} radius={10} />
        {n > 1 && <View style={s.count}><Text style={s.countTxt}>×{n}</Text></View>}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={s.name} numberOfLines={1}>{g.name}</Text>
        <Text style={s.sub} numberOfLines={1}>{n > 1 ? `${n} · avg ` : 'Paid '}{amt(g.cost / n, g.unit)}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Text style={[s.value, tick === 'up' && { color: C.up }, tick === 'down' && { color: C.down }]}>
          <TickArrow tick={tick} />{g.usd != null ? usd(g.usd) : amt(g.value, g.unit, 3)}
        </Text>
        <View style={[s.pill, { backgroundColor: up ? '#3DDC971F' : '#FF5C7A1F' }]}>
          <Text style={[s.pillTxt, { color: up ? C.up : C.down }]}>{pct(g.pnlPct)}</Text>
        </View>
      </View>
      <Pressable onPress={doSell} disabled={state === 'selling'} hitSlop={6} accessibilityRole="button"
        accessibilityLabel={`Sell ${n > 1 ? 'one ' : ''}${g.name}`}
        style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [s.sell, (hovered || pressed) && s.sellHot]}>
        <Text style={[s.sellTxt, state === 'error' && { color: C.down }]}>{state === 'selling' ? '…' : state === 'error' ? 'Retry' : 'Sell'}</Text>
      </Pressable>
    </Pressable>
  );
}

function SoldRow({ p, onOpen }: { p: PaperPosition; onOpen?: () => void }) {
  const { toUsd } = usePrices();
  const unit = p.currency ?? 'SOL';
  const pnlUsd = toUsd(p.pnlSol, unit);
  const up = p.pnlSol >= 0;
  const view = () => { onOpen?.(); router.push({ pathname: '/collection/[symbol]', params: { symbol: p.collection.symbol } }); };
  return (
    <Pressable onPress={view} style={({ hovered }: { hovered?: boolean }) => [s.row, hovered && { backgroundColor: C.card }]}>
      <CollIcon uri={p.collection.image ?? null} name={p.collection.name} size={36} radius={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={s.name} numberOfLines={1}>{p.collection.name}</Text>
        <Text style={s.sub} numberOfLines={1}>{amt(p.entryPrice, unit, 3)} → {amt(p.exitPrice ?? 0, unit, 3)}</Text>
      </View>
      <Text style={[s.value, { color: up ? C.up : C.down }]}>{pnlUsd != null ? signedUsd(pnlUsd) : signedSol(p.pnlSol, 3, unit)}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  summary: {
    marginHorizontal: 12, marginBottom: 10, padding: 14, borderRadius: 14, gap: 4,
    backgroundColor: '#A78BFA14', borderWidth: 1, borderColor: '#A78BFA40',
  },
  kicker: { color: PURPLE, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  big: { ...T.title, fontSize: 26, lineHeight: 30, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tabs: { flexDirection: 'row', gap: 4, marginHorizontal: 12, marginBottom: 6, padding: 3, borderRadius: 10, backgroundColor: C.card },
  tab: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, paddingVertical: 6, borderRadius: 8 },
  tabOn: { backgroundColor: C.cardHi },
  tabTxt: { color: C.dim, fontSize: 13, fontWeight: '600' },
  tabCount: { color: C.muted, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  list: { paddingHorizontal: 6, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 8, borderRadius: 10 },
  count: {
    position: 'absolute', right: -4, bottom: -4, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999,
    backgroundColor: PURPLE, borderWidth: 2, borderColor: C.bg,
  },
  countTxt: { color: C.accentInk, fontSize: 10, fontWeight: '800' },
  name: { color: C.text, fontSize: 14, fontWeight: '600' },
  sub: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  value: { color: C.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999 },
  pillTxt: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sell: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.border, minWidth: 46, alignItems: 'center' },
  sellHot: { borderColor: PURPLE, backgroundColor: '#A78BFA1A' },
  sellTxt: { color: C.text, fontSize: 12, fontWeight: '700' },
  note: { paddingHorizontal: 6, paddingVertical: 10 },
  allRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 4 },
  all: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: C.border },
  allHot: { borderColor: C.down, backgroundColor: '#FF5C7A14' },
  allTxt: { color: C.text, fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 28 },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#A78BFA1F' },
  emptyGlyph: { color: PURPLE, fontSize: 20 },
  cta: { marginTop: 6, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: PURPLE },
  ctaTxt: { color: C.accentInk, fontSize: 14, fontWeight: '700' },
  foot: { color: C.muted, fontSize: 11, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
