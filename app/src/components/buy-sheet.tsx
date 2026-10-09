import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { ModeChip } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { api, type BuyQuote } from '@/lib/api';
import { sol } from '@/lib/format';
import { useWallet } from '@/lib/wallet';

// Real-mode "buy floor": shows the live cheapest listing, what it costs and
// whether the wallet can cover it. Until FloorFeed can build marketplace
// transactions itself, the buy completes on Magic Eden.
export function BuySheet({ symbol, open, onClose, onPaper }: {
  symbol: string;
  open: boolean;
  onClose: () => void;
  onPaper?: () => void; // "Paper trade instead"
}) {
  const w = useWallet();
  const [quote, setQuote] = useState<{ key: string; q: BuyQuote } | { key: string; error: string } | null>(null);
  const key = `${symbol}:${w.address}`;

  useEffect(() => {
    if (!open || !w.address) return;
    let alive = true;
    api.quote(symbol, w.address)
      .then((q) => alive && setQuote({ key, q }))
      .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [open, symbol, w.address, key]);

  const current = quote?.key === key ? quote : null;
  const q = current && 'q' in current ? current.q : null;
  const price = q?.listing?.price ?? q?.collection.floor ?? null;
  const total = price != null && q ? price + q.networkFeeSol : null;
  const short = total != null && q?.balanceSol != null ? total - q.balanceSol : null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.head}>
            <Text style={s.title}>Buy floor</Text>
            <ModeChip mode="real" />
          </View>

          {!current ? (
            <View style={s.loading}>
              <ActivityIndicator color={C.accent} />
              <Text style={s.meta}>Finding the cheapest listing…</Text>
            </View>
          ) : !q ? (
            <Text style={s.err}>Couldn&apos;t get a quote: {'error' in current ? current.error : ''}</Text>
          ) : (
            <>
              <View style={s.item}>
                <NftImage uri={q.listing?.image ?? null} name={q.collection.name} ratio={1} radius={12} px={160} style={{ width: 72 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name}>{q.listing?.name ?? q.collection.name}</Text>
                  <Text style={s.meta}>
                    {q.collection.name}{q.listing?.rank ? ` · rank ${q.listing.rank.toLocaleString()}` : ''}
                  </Text>
                  <Text style={s.price}>{price != null ? sol(price, 3) : '—'}</Text>
                </View>
              </View>
              {!q.listing && <Text style={s.meta}>Live listings didn&apos;t load, so this uses the floor price.</Text>}

              <View style={s.rows}>
                <Row label="Listing price" value={price != null ? sol(price, 3) : '—'} />
                <Row label="Network fee" value={`~${q.networkFeeSol} SOL`} />
                <Row label="Marketplace fee and royalty" value="added at checkout" />
                <Row label="You pay (before fees)" value={total != null ? sol(total, 3) : '—'} strong />
                <Row label="Your wallet" value={q.balanceSol != null ? sol(q.balanceSol, 3) : '—'} />
              </View>
              {short != null && short > 0 && (
                <Text style={s.err}>Not enough SOL: you need about {sol(short, 3)} more.</Text>
              )}

              {q.reason && <Text style={s.meta}>{q.reason}</Text>}
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(q.marketUrl)} style={s.primary}>
                <Text style={s.primaryTxt}>Buy on Magic Eden ↗</Text>
              </Pressable>
            </>
          )}

          <View style={s.footer}>
            {onPaper && (
              <Pressable accessibilityRole="button" onPress={() => { onClose(); onPaper(); }} style={[s.secondary, { flex: 1 }]}>
                <Text style={s.secondaryTxt}>Paper trade instead</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" onPress={onClose} style={[s.secondary, { flex: 1 }]}>
              <Text style={s.secondaryTxt}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={[s.meta, strong && { color: C.text, fontWeight: '700' }]}>{label}</Text>
      <Text style={[s.val, strong && { fontWeight: '800' }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: C.card, borderRadius: 20, padding: 20, gap: 14, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: C.text, fontSize: 20, fontWeight: '800' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  name: { color: C.text, fontWeight: '800', fontSize: 16 },
  price: { color: C.text, fontWeight: '800', fontSize: 22, fontVariant: ['tabular-nums'], marginTop: 2 },
  meta: { color: C.dim, fontSize: 12.5, lineHeight: 18 },
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  val: { color: C.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  err: { color: C.down, fontSize: 13 },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { color: C.accentInk, fontWeight: '800', fontSize: 15 },
  footer: { flexDirection: 'row', gap: 10 },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { color: C.text, fontWeight: '800' },
});
