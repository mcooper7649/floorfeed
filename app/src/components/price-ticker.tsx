import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { api, type CollectionSummary, type TickerPrice } from '@/lib/api';

// Thin bar along the bottom of wide web: native coin prices, then the
// collections whose floors moved most today (with real volume).
export function PriceTicker() {
  const [prices, setPrices] = useState<TickerPrice[]>([]);
  const [movers, setMovers] = useState<CollectionSummary[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.prices().then((p) => alive && setPrices(p)).catch(() => {});
      api.collections().then((rows) => alive && setMovers(rows
        .filter((r) => r.change24hPct != null && (r.volume24hUsd ?? 0) >= 2_000)
        .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
        .slice(0, 10))).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const pct = (p: number | null) => p == null ? null
    : <Text style={{ color: p >= 0 ? C.up : C.down }}> {p >= 0 ? '▲' : '▼'}{Math.abs(p).toFixed(2)}%</Text>;
  const money = (n: number) => `$${n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;

  return (
    <View style={s.bar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.items}>
        {prices.map((p) => (
          <Text key={p.symbol} style={s.item}><Text style={s.sym}>{p.symbol}</Text> {money(p.usd)}{pct(p.change24hPct)}</Text>
        ))}
        {movers.length > 0 && <View style={s.sep} />}
        {movers.map((m) => (
          <Pressable key={m.symbol} onPress={() => router.push({ pathname: '/collection/[symbol]', params: { symbol: m.symbol } })}>
            <Text style={s.item}><Text style={s.sym}>{m.name}</Text>{pct(m.change24hPct)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { height: 28, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, justifyContent: 'center' },
  items: { alignItems: 'center', gap: 18, paddingHorizontal: 16 },
  item: { color: C.text, fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
  sym: { color: C.dim },
  sep: { width: 1, height: 14, backgroundColor: C.border },
});
