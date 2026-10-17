import { useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { BuySheet } from '@/components/buy-sheet';
import { EvmBuySheet } from '@/components/evm-buy-sheet';
import { EvmOfferSheet } from '@/components/evm-offer-sheet';
import { MODE_COLOR } from '@/components/mode-toggle';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type FeedEvent } from '@/lib/api';
import { amt, sol } from '@/lib/format';
import { useTradeMode } from '@/lib/mode';
import { useUsd } from '@/lib/prices';
import { useSession } from '@/lib/session';

const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

// The one buy control for a collection, the same on desktop tiles and phone
// cards: "Buy floor" with the floor price (and its dollars) in the mode's
// colour, and Offer beside it on Ethereum-family chains. Paper mode buys the
// floor on paper right away; Real opens the buy sheet. Offers are real, so
// Offer switches to Real first when it can.
export function BuyFloorButton({ coll, copiedFrom }: { coll: FeedEvent['collection']; copiedFrom?: string }) {
  const { symbol, floor, currency } = coll;
  const toUsd = useUsd();
  const { userId, bumpPortfolio } = useSession();
  const { mode, canReal, setMode } = useTradeMode();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [sheet, setSheet] = useState<'buy' | 'offer' | null>(null);
  const evm = coll.chain !== 'solana';
  const paper = mode === 'paper';

  const paperBuy = async () => {
    if (!userId || busy) return;
    tap();
    setBusy(true);
    setNote(null);
    try {
      const r = await api.buyFloor(userId, symbol, copiedFrom);
      track('paper_buy', { from: 'feed' });
      setNote({ text: `Bought on paper at ${sol(r.entryPrice, 2, currency)}. See Portfolio.`, ok: true });
      bumpPortfolio();
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };
  const buy = () => {
    track('copy_tap', { mode });
    if (paper) void paperBuy();
    else { tap(); setSheet('buy'); }
  };
  const offer = () => {
    tap();
    if (paper && canReal) setMode('real');
    setSheet('offer');
  };

  const dollars = floor != null ? toUsd(floor, currency) : null;
  return (
    <View style={{ gap: 6 }}>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Buy floor${floor != null ? ` for ${amt(floor, currency)}` : ''}`}
          onPress={buy} disabled={busy}
          style={({ pressed }) => [s.buy, { backgroundColor: MODE_COLOR[mode] }, (pressed || busy) && { opacity: 0.85 }]}>
          <View style={s.buyLeft}>
            <Text style={s.buyTxt} numberOfLines={1}>{busy ? 'Buying…' : 'Buy floor'}</Text>
            {paper && !busy && <Text style={s.tag}>PAPER</Text>}
          </View>
          {floor != null && (
            <View style={s.priceCol}>
              <Text style={s.price} numberOfLines={1}>{amt(floor, currency)}</Text>
              {dollars && <Text style={s.priceUsd} numberOfLines={1}>{dollars}</Text>}
            </View>
          )}
        </Pressable>
        {evm && (
          <Pressable accessibilityRole="button" accessibilityLabel="Make a collection offer" onPress={offer}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.offer, (pressed || hovered) && { backgroundColor: C.cardHi }]}>
            <Text style={s.offerTxt}>Offer</Text>
          </Pressable>
        )}
      </View>
      {note && <Text style={[T.caption, { color: note.ok ? C.up : C.down }]} numberOfLines={2}>{note.text}</Text>}
      {sheet === 'buy' && (coll.chain === 'solana'
        ? <BuySheet symbol={symbol} open onClose={() => setSheet(null)} onPaper={paperBuy} />
        : <EvmBuySheet symbol={symbol} open onClose={() => setSheet(null)} onPaper={paperBuy} />)}
      {sheet === 'offer' && (
        <EvmOfferSheet symbol={symbol} listedAt={floor} open onClose={() => setSheet(null)} onBuy={() => setSheet('buy')} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  buy: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14, minHeight: 48,
  },
  buyLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  buyTxt: { ...T.button, color: C.accentInk },
  tag: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6, color: C.accentInk, opacity: 0.7, borderWidth: 1, borderColor: C.accentInk, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  priceCol: { alignItems: 'flex-end', flexShrink: 1, minWidth: 0 },
  price: { ...T.button, color: C.accentInk, fontVariant: ['tabular-nums'], lineHeight: 18 },
  priceUsd: { fontSize: 11, lineHeight: 13, fontWeight: '600', color: C.accentInk, opacity: 0.7, fontVariant: ['tabular-nums'] },
  offer: { borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  offerTxt: { ...T.button, color: C.text },
});
