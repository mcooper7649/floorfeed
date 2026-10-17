import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChainBadge } from '@/components/chain-badge';
import { CollIcon } from '@/components/coll-icon';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type CollectionSummary } from '@/lib/api';
import { amt, pct } from '@/lib/format';
import { useSession } from '@/lib/session';

const RECENT_KEY = 'floorfeed.recentSearches';
const MAX = 7;
const isWallet = (q: string) => /^0x[0-9a-fA-F]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);

// One collections fetch shared by every mount; refreshed when older than 5 min.
let cache: { at: number; rows: CollectionSummary[] } | null = null;
let inflight: Promise<CollectionSummary[]> | null = null;
function loadCollections() {
  if (cache && Date.now() - cache.at < 5 * 60_000) return Promise.resolve(cache.rows);
  inflight ??= api.collections()
    .then((rows) => { cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { inflight = null; });
  return inflight;
}

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}
function saveRecent(symbol: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([symbol, ...readRecent().filter((s) => s !== symbol)].slice(0, 5))); } catch {}
}

// Name prefix beats word prefix beats substring; ties go to 7d volume.
function score(c: CollectionSummary, q: string) {
  const name = c.name.toLowerCase();
  if (name === q || c.symbol === q) return 0;
  if (name.startsWith(q) || c.symbol.startsWith(q)) return 1;
  if (name.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 2;
  if (name.includes(q) || c.symbol.includes(q)) return 3;
  return -1;
}

type Item =
  | { kind: 'coll'; c: CollectionSummary }
  | { kind: 'wallet'; address: string }
  | { kind: 'all'; q: string };
type Section = { title: string | null; items: Item[] };

// Header search (wide web). Focusing it opens suggestions straight away:
// recent picks, the watchlist and today's most-traded collections; typing
// narrows to matching collections, a wallet address jumps to its profile,
// and Enter with nothing highlighted opens the full Markets search.
export function SearchBox() {
  const { watchlist } = useSession();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CollectionSummary[]>(cache?.rows ?? []);
  const [recent, setRecent] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<TextInput>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(blurTimer.current), []);

  const query = q.trim();
  const sections = useMemo<Section[]>(() => {
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    const coll = (c: CollectionSummary): Item => ({ kind: 'coll', c });
    if (!query) {
      const seen = new Set<string>();
      const take = (list: (CollectionSummary | undefined)[], n: number) =>
        list.filter((c): c is CollectionSummary => !!c && !seen.has(c.symbol) && !!seen.add(c.symbol)).slice(0, n).map(coll);
      return [
        { title: 'Recent', items: take(recent.map((s) => bySym.get(s)), 3) },
        { title: 'Watchlist', items: take([...watchlist].map((s) => bySym.get(s)), 3) },
        { title: 'Trending today', items: take([...rows].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)), 5) },
      ].filter((s) => s.items.length);
    }
    if (isWallet(query)) return [{ title: null, items: [{ kind: 'wallet', address: query }] }];
    const lq = query.toLowerCase();
    const hits = rows
      .map((c) => ({ c, sc: score(c, lq) }))
      .filter((h) => h.sc >= 0)
      .sort((a, b) => a.sc - b.sc || (b.c.volume7dUsd ?? 0) - (a.c.volume7dUsd ?? 0))
      .slice(0, MAX)
      .map((h) => coll(h.c));
    return [{ title: hits.length ? 'Collections' : null, items: [...hits, { kind: 'all', q: query }] }];
  }, [rows, query, recent, watchlist]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const onFocus = () => {
    clearTimeout(blurTimer.current);
    setRecent(readRecent());
    setOpen(true);
    loadCollections().then(setRows).catch(() => {});
  };
  // Let a click on a suggestion land before the list goes away.
  const onBlur = () => { blurTimer.current = setTimeout(() => setOpen(false), 150); };

  const choose = (item: Item | undefined) => {
    setOpen(false);
    setHi(-1);
    input.current?.blur();
    if (!item) {
      router.push({ pathname: '/markets', params: query ? { q: query } : {} });
    } else if (item.kind === 'coll') {
      saveRecent(item.c.symbol);
      setQ('');
      router.push({ pathname: '/collection/[symbol]', params: { symbol: item.c.symbol } });
    } else if (item.kind === 'wallet') {
      setQ('');
      router.push({ pathname: '/wallet/[address]', params: { address: item.address } });
    } else {
      router.push({ pathname: '/markets', params: { q: item.q } });
    }
  };

  const onKey = (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
    const k = e.nativeEvent.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault?.();
      if (!open) setOpen(true);
      const n = flat.length;
      if (n) setHi((h) => (k === 'ArrowDown' ? (h + 1) % n : (h <= 0 ? n - 1 : h - 1)));
    } else if (k === 'Escape') {
      setOpen(false);
      setHi(-1);
    }
  };

  let i = -1;
  return (
    <View style={s.wrap}>
      <TextInput
        ref={input}
        value={q}
        onChangeText={(t) => { setQ(t); setHi(-1); setOpen(true); }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyPress={onKey}
        onSubmitEditing={() => choose(hi >= 0 ? flat[hi] : undefined)}
        placeholder="Search collections or wallets"
        placeholderTextColor={C.dim}
        style={[s.input, open && s.inputOpen]}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search collections or wallets"
      />
      {open && (
        <View style={s.menu} accessibilityRole="menu">
          {!rows.length && !query && <Text style={s.note}>Loading collections…</Text>}
          {sections.map((sec, si) => (
            <View key={si}>
              {sec.title && <Text style={s.head}>{sec.title}</Text>}
              {sec.items.map((item) => {
                const idx = ++i;
                return (
                  <Pressable
                    key={idx}
                    onPress={() => choose(item)}
                    onHoverIn={() => setHi(idx)}
                    style={[s.row, hi === idx && s.rowOn]}
                    accessibilityRole="menuitem"
                  >
                    <Row item={item} />
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Row({ item }: { item: Item }) {
  if (item.kind === 'wallet') {
    return <Text style={s.action} numberOfLines={1}>View wallet {item.address.slice(0, 6)}…{item.address.slice(-4)} ›</Text>;
  }
  if (item.kind === 'all') {
    return <Text style={s.action} numberOfLines={1}>See all results for “{item.q}” in Markets ›</Text>;
  }
  const { c } = item;
  const ch = c.change24hPct;
  return (
    <>
      <CollIcon name={c.name} uri={c.image} size={32} radius={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={s.name} numberOfLines={1}>{c.name}</Text>
        <View style={s.sub}><ChainBadge chain={c.chain} /><Text style={T.caption}>{c.category}</Text></View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        {c.floor != null && <Text style={T.metaNum}>{amt(c.floor, c.currency)}</Text>}
        {ch != null && <Text style={[T.caption, { color: ch >= 0 ? C.up : C.down }]}>{pct(ch)}</Text>}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  wrap: { width: 320, minWidth: 150, flexShrink: 1, zIndex: 20 },
  input: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15,
  },
  inputOpen: { borderColor: C.dim },
  menu: {
    position: 'absolute', top: 46, left: 0, right: 0, minWidth: 340, maxHeight: 520, overflow: 'scroll',
    backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 6,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
  },
  head: { ...T.caption, textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  note: { ...T.meta, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  rowOn: { backgroundColor: C.cardHi },
  name: { ...T.bodyStrong, fontSize: 14, lineHeight: 18 },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  action: { ...T.meta, color: C.text, flex: 1 },
});
