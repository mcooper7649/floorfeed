import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { BuySheet } from '@/components/buy-sheet';
import { EvmBuySheet } from '@/components/evm-buy-sheet';
import { EvmOfferSheet } from '@/components/evm-offer-sheet';
import { MODE_COLOR, ModeToggle } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type CollectionAbout, type CollectionDetail, type Holding, type PaperPosition } from '@/lib/api';
import { amt, shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useWallet } from '@/lib/wallet';

// The collection page's right column (FOMO-style): a trade box, About, and
// the viewer's own positions in this collection.

const pct = (p: number | null | undefined) => (p == null ? '—' : `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 2)}%`);
const tone = (p: number | null | undefined) => (p == null ? C.dim : p >= 0 ? C.up : C.down);

export function Panel({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={s.panel}>
      {(title || right) && (
        <View style={s.panelHead}>
          {title ? <Text style={T.bodyStrong}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

// --- Trade box -------------------------------------------------------------------

const COUNTS = [1, 3, 5, 10];

export function TradeBox({ data }: { data: CollectionDetail }) {
  const { mode, canReal, setMode } = useTradeMode();
  const { userId, bumpPortfolio } = useSession();
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [offering, setOffering] = useState(false);
  const cur = data.currency;
  const floor = data.stats.floor;
  const evm = data.chain !== 'solana';
  // Paper and real both run on collections priced in a chain's own coin (server UNITS); others (USDC...) are browse-only.
  const tradable = (['SOL', 'ETH', 'HYPE', 'RON', 'APE', 'MON'] as string[]).includes(cur);
  const real = mode === 'real';
  const n = real ? 1 : count; // real buys are one NFT at a time for now

  // What N items would cost: the floor, then up the cheapest listings, plus
  // the fees a buyer pays on top (Solana taker fee + royalty).
  const ladder = [...data.listings].map((l) => l.price).sort((a, b) => a - b);
  const prices = floor == null ? [] : Array.from({ length: n }, (_, i) => Math.max(floor, ladder[i] ?? ladder.at(-1) ?? floor));
  const subtotal = prices.reduce((a, p) => a + p, 0);
  const feeRate = data.about?.fees.buyTaker ?? 0;
  const fees = subtotal * feeRate;
  const short = n > 1 && ladder.length < n;

  const paper = async () => {
    if (!userId || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.buyFloor(userId, data.symbol, undefined, n);
      track('paper_buy', { from: 'collection', count: n });
      setMsg(`Bought ${n} on paper for ${amt(r.total ?? r.entryPrice, cur)}. See Portfolio.`);
      bumpPortfolio();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!tradable) {
    return (
      <Panel title="Trade">
        <Text style={T.meta}>This collection trades in {cur}. FloorFeed tracks its floor and sales, but buys here run on collections priced in a network&apos;s own coin (SOL, ETH, HYPE, RON, APE, MON).</Text>
        <Pressable onPress={() => Linking.openURL(data.externalUrl)} style={s.secondary}><Text style={s.secondaryTxt}>Open on OpenSea ↗</Text></Pressable>
      </Panel>
    );
  }

  return (
    <Panel>
      <ModeToggle describe={false} />
      <View style={s.counts}>
        {COUNTS.map((c) => {
          const disabled = real && c > 1;
          return (
            <Pressable key={c} disabled={disabled} onPress={() => setCount(c)}
              style={[s.count, n === c && { borderColor: MODE_COLOR[mode], backgroundColor: C.cardHi }, disabled && { opacity: 0.35 }]}>
              <Text style={[s.countTxt, n === c && { color: C.text }]}>{c === 1 ? 'Floor' : `×${c}`}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ gap: 6 }}>
        <Line label={n === 1 ? 'Floor price' : `${n} cheapest listings`} value={floor == null ? '—' : amt(subtotal, cur)} />
        {feeRate > 0 && <Line label={`Fees and royalty (${(feeRate * 100).toFixed(1)}%)`} value={amt(fees, cur)} />}
        <Line label="Total" value={floor == null ? '—' : amt(subtotal + fees, cur)} strong />
        {short && <Text style={T.caption}>Only {ladder.length} listings loaded; the rest are priced at the highest of them.</Text>}
        {real && <Text style={T.caption}>Real buys are one NFT at a time. Sweeps are paper-only for now.</Text>}
      </View>
      <Pressable disabled={busy || floor == null || !userId} onPress={() => (real ? setSheet(true) : paper())}
        style={({ pressed }) => [s.cta, { backgroundColor: MODE_COLOR[mode] }, (pressed || busy) && { opacity: 0.8 }]}>
        <Text style={s.ctaTxt}>
          {busy ? 'Buying…' : real ? `Buy floor${floor != null ? ` · ${sol(floor, 3, cur)}` : ''}` : `Paper buy ${n === 1 ? 'floor' : `×${n}`}`}
        </Text>
      </Pressable>
      {evm && (
        <Pressable accessibilityRole="button" onPress={() => { if (!real && canReal) setMode('real'); setOffering(true); }}
          style={({ pressed }) => [s.offerBtn, pressed && { opacity: 0.8 }]}>
          <Text style={s.offerTxt}>Make a collection offer</Text>
        </Pressable>
      )}
      {msg && <Text style={T.meta}>{msg}</Text>}
      {evm && offering && (
        <EvmOfferSheet symbol={data.symbol} listedAt={floor} open onClose={() => setOffering(false)}
          onBuy={() => { setOffering(false); setSheet(true); }} />
      )}
      {!evm && <BuySheet symbol={data.symbol} open={sheet} onClose={() => setSheet(false)} onPaper={paper} />}
      {evm && <EvmBuySheet symbol={data.symbol} open={sheet} onClose={() => setSheet(false)} onPaper={paper} />}
    </Panel>
  );
}

const Line = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <View style={s.line}>
    <Text style={strong ? T.bodyStrong : T.meta}>{label}</Text>
    <Text style={[strong ? T.num : T.metaNum, strong && { fontWeight: '600' }]}>{value}</Text>
  </View>
);

// --- About -------------------------------------------------------------------------

function Bar({ left, right, leftLabel, rightLabel }: { left: number; right: number; leftLabel: string; rightLabel: string }) {
  const total = left + right || 1;
  return (
    <View style={{ gap: 4 }}>
      <View style={s.line}>
        <Text style={T.metaNum}><Text style={{ color: C.text, fontWeight: '600' }}>{left.toLocaleString()}</Text> {leftLabel}</Text>
        <Text style={T.metaNum}><Text style={{ color: C.text, fontWeight: '600' }}>{right.toLocaleString()}</Text> {rightLabel}</Text>
      </View>
      <View style={s.bar}>
        <View style={{ flex: left / total, backgroundColor: C.up, borderRadius: 3, minWidth: left ? 4 : 0 }} />
        <View style={{ flex: right / total, backgroundColor: C.down, borderRadius: 3, minWidth: right ? 4 : 0 }} />
      </View>
    </View>
  );
}

function copy(text: string) {
  if (Platform.OS === 'web') navigator.clipboard?.writeText(text).catch(() => {});
}

export function AboutPanel({ data, about }: { data: CollectionDetail; about: CollectionAbout }) {
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const cur = data.currency;
  const a = about.activity24h;
  const i = about.info;
  const market = data.source === 'opensea' ? 'OpenSea' : 'Magic Eden';
  const explorer = i.address
    ? i.chain === 'solana' ? `https://solscan.io/account/${i.address}` : `${CHAINS[i.chain]?.explorer ?? 'https://etherscan.io'}/address/${i.address}`
    : null;
  const links = [
    i.website && { label: 'Website', url: i.website },
    i.twitter && { label: 'X', url: `https://x.com/${i.twitter}` },
    i.discord && { label: 'Discord', url: i.discord },
    { label: market, url: data.externalUrl },
    explorer && { label: 'Explorer', url: explorer },
  ].filter(Boolean) as { label: string; url: string }[];
  const f = about.fees;
  const feeText = f.sellerFeesPct != null
    ? `${f.sellerFeesPct.toFixed(1)}% paid by the seller`
    : `${(f.marketplacePct ?? 0).toFixed(0)}% marketplace + ${(f.royaltyPct ?? 0).toFixed(1)}% royalty, paid by the buyer`;

  return (
    <Panel title={`About ${data.name}`}>
      {data.description ? <Text style={T.meta} numberOfLines={more ? undefined : 3}>{data.description}</Text> : null}

      <View style={s.tiles}>
        {about.changes.map((c) => (
          <View key={c.label} style={s.tile}>
            <Text style={s.tileLabel}>{c.label}</Text>
            <Text style={[s.tileVal, { color: tone(c.pct) }]}>{pct(c.pct)}</Text>
          </View>
        ))}
      </View>
      <Text style={T.caption}>Floor change</Text>

      <View style={{ gap: 12 }}>
        <View style={s.line}>
          <Text style={T.meta}>24h</Text>
          <Text style={T.metaNum}><Text style={{ color: C.text, fontWeight: '600' }}>{a.sales.toLocaleString()}</Text> sales · {amt(a.volume, cur, a.volume >= 10 ? 0 : 2)}</Text>
        </View>
        <Bar left={a.buyers} right={a.sellers} leftLabel="buyers" rightLabel="sellers" />
        <Bar left={a.provenBuys} right={a.provenSells} leftLabel="proven buys" rightLabel="proven sells" />
      </View>

      <View style={s.links}>
        {links.map((l) => (
          <Pressable key={l.label} onPress={() => Linking.openURL(l.url)} style={s.linkBtn}>
            <Text style={s.linkTxt}>{l.label} ↗</Text>
          </Pressable>
        ))}
      </View>

      {more && (
        <View style={{ gap: 8 }}>
          <Fact label="Network" value={CHAINS[i.chain]?.name ?? i.chain} />
          {i.supply != null && <Fact label="Supply" value={i.supply.toLocaleString()} />}
          {i.owners != null && <Fact label="Owners" value={i.owners.toLocaleString()} />}
          {i.listed != null && <Fact label="Listed" value={i.listed.toLocaleString()} />}
          <Fact label="Holders we track" value={i.holdersTracked.toLocaleString()} />
          <Fact label="Fees" value={feeText} />
          {i.trackedSince && <Fact label="Tracked since" value={`${timeAgo(i.trackedSince)} ago`} />}
          {i.address && (
            <Pressable onPress={() => { copy(i.address!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              <Fact label={i.chain === 'solana' ? 'Collection address' : 'Contract'} value={copied ? 'Copied' : `${shortAddr(i.address)} ⧉`} />
            </Pressable>
          )}
        </View>
      )}
      <Pressable onPress={() => setMore((m) => !m)} style={s.more}>
        <Text style={s.moreTxt}>{more ? 'View less' : 'View more'}</Text>
      </Pressable>
    </Panel>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <View style={s.fact}>
    <Text style={T.meta}>{label}</Text>
    <View style={s.dots} />
    <Text style={[T.metaNum, { color: C.text, flexShrink: 1, textAlign: 'right' }]}>{value}</Text>
  </View>
);

// --- Your positions --------------------------------------------------------------------

export function PositionsPanel({ data }: { data: CollectionDetail }) {
  const { userId, portfolioVersion } = useSession();
  const sw = useWallet();
  const ew = useEvmWallet();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [paper, setPaper] = useState<PaperPosition[] | null>(null);
  const [held, setHeld] = useState<Holding[]>([]);
  const evm = data.chain !== 'solana';
  const address = evm ? ew.address : sw.address;
  const cur = data.currency;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api.paper(userId).then((r) => alive && setPaper(r.positions.filter((p) => p.collection.symbol === data.symbol))).catch(() => alive && setPaper([]));
    return () => { alive = false; };
  }, [userId, data.symbol, portfolioVersion]);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    (evm ? api.evmHoldings(address) : api.holdings(address))
      .then((h) => alive && setHeld(h.nfts.filter((n) => n.collection.symbol === data.symbol)))
      .catch(() => {});
    return () => { alive = false; };
  }, [address, evm, data.symbol]);

  const list = (paper ?? []).filter((p) => (tab === 'open' ? p.open : !p.open));
  return (
    <Panel title="Your positions" right={
      <View style={s.seg}>
        {(['open', 'closed'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.segBtn, tab === t && s.segOn]}>
            <Text style={[s.segTxt, tab === t && { color: C.text }]}>{t === 'open' ? 'Open' : 'Closed'}</Text>
          </Pressable>
        ))}
      </View>
    }>
      {tab === 'open' && held.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={T.label}>In your wallet</Text>
          {held.map((h) => (
            <Pressable key={h.mint} style={s.pos} onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: data.symbol, id: h.mint } })}>
              <View style={s.posArt}><NftImage uri={h.image} name={h.name ?? data.name} radius={8} px={80} /></View>
              <Text style={[T.body, { flex: 1 }]} numberOfLines={1}>{h.name ?? shortAddr(h.mint)}</Text>
              <Text style={T.metaNum}>{h.boughtAt != null ? `bought ${sol(h.boughtAt, 2, cur)}` : 'held'}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {list.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={T.label}>Paper</Text>
          {list.map((p) => (
            <View key={p.id} style={s.pos}>
              <Text style={[T.metaNum, { flex: 1 }]}>
                {sol(p.entryPrice, 3, cur)}{p.exitPrice != null ? ` → ${sol(p.exitPrice, 3, cur)}` : ''} · {timeAgo(Math.floor(p.openedAt / 1000))} ago
              </Text>
              <Text style={[T.num, { color: p.pnlSol >= 0 ? C.up : C.down }]}>{signedSol(p.pnlSol, 3, cur)}</Text>
            </View>
          ))}
          <Pressable onPress={() => router.push('/portfolio')}><Text style={s.moreTxt}>Manage in Portfolio →</Text></Pressable>
        </View>
      ) : (tab === 'closed' || held.length === 0) && (
        <Text style={[T.meta, { textAlign: 'center', paddingVertical: 8 }]}>
          {tab === 'open' ? 'No open positions in this collection.' : 'No closed positions yet.'}
        </Text>
      )}
    </Panel>
  );
}

const s = StyleSheet.create({
  panel: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 16, gap: 14 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  counts: { flexDirection: 'row', gap: 8 },
  count: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingVertical: 9, alignItems: 'center' },
  countTxt: { ...T.label, fontWeight: '600' },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cta: { borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  ctaTxt: { ...T.button, color: C.accentInk },
  offerBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  offerTxt: { ...T.button, color: C.text },
  secondary: { borderRadius: 12, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  tiles: { flexDirection: 'row', gap: 6 },
  tile: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, paddingVertical: 8, alignItems: 'center', gap: 2 },
  tileLabel: { ...T.caption, color: C.dim },
  tileVal: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bar: { flexDirection: 'row', gap: 3, height: 6 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  linkBtn: { borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, paddingHorizontal: 10, paddingVertical: 6 },
  linkTxt: { ...T.label, color: C.text },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dots: { flex: 1, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed', marginTop: 6 },
  more: { alignSelf: 'center', borderRadius: 8, backgroundColor: C.cardHi, paddingHorizontal: 10, paddingVertical: 4 },
  moreTxt: { ...T.label, color: C.accent },
  seg: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 2 },
  segBtn: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6 },
  segOn: { backgroundColor: C.cardHi },
  segTxt: { ...T.caption, color: C.dim, fontWeight: '600' },
  pos: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  posArt: { width: 32, height: 32 },
});
