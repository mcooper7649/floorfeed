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
import { amt } from '@/lib/format';
import { useTradeMode } from '@/lib/mode';
import { useUsd } from '@/lib/prices';
import { useSession } from '@/lib/session';

const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

// The buy row itself, shared by feed cards and the collection Trade box. One
// bar, tinted in the mode's colour: the price and its dollars on the left in
// plain text on dark (readable in both modes), then Offer (EVM chains) and the
// filled Buy button. Only the short Buy label sits on the colour.
export function BuyOfferRow({ label, price, unit, busy, disabled, onBuy, onOffer }: {
  label: string;           // 'Buy floor', 'Buy 3', …
  price: number | null;    // what the button pays (in `unit`)
  unit: string;
  busy?: boolean;
  disabled?: boolean;
  onBuy: () => void;
  onOffer?: () => void;    // shown when given (EVM chains)
}) {
  const toUsd = useUsd();
  const { mode } = useTradeMode();
  const color = MODE_COLOR[mode];
  const dollars = price != null ? toUsd(price, unit) : null;
  // On very narrow bars (small phones) 'Buy floor' becomes 'Buy' so the price is never cut off.
  const [narrow, setNarrow] = useState(false);
  return (
    <View style={[s.bar, { borderColor: color + '59' }]} onLayout={(e) => setNarrow(e.nativeEvent.layout.width < 300)}>
      <View style={s.priceCol}>
        <Text style={[s.price, price == null && { color: C.dim }]} numberOfLines={1}>{price != null ? amt(price, unit) : 'No floor yet'}</Text>
        <View style={s.subRow}>
          {dollars && <Text style={s.usd} numberOfLines={1}>{dollars}</Text>}
          <View style={[s.dot, { backgroundColor: color }]} />
          <Text style={[s.modeTxt, { color }]}>{mode === 'real' ? 'Real' : 'Paper'}</Text>
        </View>
      </View>
      {onOffer && (
        <Pressable accessibilityRole="button" accessibilityLabel="Make an offer" onPress={onOffer}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.offer, (pressed || hovered) && { backgroundColor: C.cardHi }]}>
          <Text style={s.offerTxt}>Offer</Text>
        </Pressable>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}${price != null ? ` for ${amt(price, unit)}` : ''}, ${mode} mode`}
        onPress={onBuy} disabled={busy || disabled}
        style={({ pressed }) => [s.buy, { backgroundColor: color }, (pressed || busy) && { opacity: 0.85 }, disabled && !busy && { opacity: 0.45 }]}>
        <Text style={s.buyTxt} numberOfLines={1}>{busy ? 'Buying…' : narrow ? label.replace(/ floor$/, '') : label}</Text>
      </Pressable>
    </View>
  );
}

// The one buy control for a collection, the same on desktop tiles and phone
// cards: "Buy floor" with the floor price (and its dollars) in the mode's
// colour, and Offer beside it on Ethereum-family chains. Paper mode buys the
// floor on paper right away; Real opens the buy sheet. Offers are real, so
// Offer switches to Real first when it can.
export function BuyFloorButton({ coll, copiedFrom }: { coll: FeedEvent['collection']; copiedFrom?: string }) {
  const { symbol, floor, currency } = coll;
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
      setNote({ text: `Bought on paper at ${amt(r.entryPrice, currency)}. See Portfolio.`, ok: true });
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

  return (
    <View style={{ gap: 6 }}>
      <BuyOfferRow label="Buy floor" price={floor} unit={currency} busy={busy} onBuy={buy} onOffer={evm ? offer : undefined} />
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
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 60,
    paddingVertical: 6, paddingRight: 6, paddingLeft: 12, borderRadius: 14, borderWidth: 1, backgroundColor: C.bg,
  },
  priceCol: { flex: 1, minWidth: 0, gap: 1 },
  price: { fontSize: 17, lineHeight: 22, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  usd: { fontSize: 13, lineHeight: 17, color: C.dim, fontVariant: ['tabular-nums'], flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  modeTxt: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  offer: { minHeight: 46, paddingHorizontal: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  offerTxt: { ...T.button, color: C.text },
  buy: { minHeight: 46, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  buyTxt: { ...T.button, fontWeight: '700', color: C.accentInk },
});
