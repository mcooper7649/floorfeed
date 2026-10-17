import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { CollIcon } from '@/components/coll-icon';
import { FlashBg, TickArrow, useTick } from '@/components/flash';
import { MODE_COLOR } from '@/components/mode-toggle';
import { Live, NftsKindSwitch, YourNftsBody, useNftsKind, useYourNfts } from '@/components/portfolio-panel';
import { PracticeNftsBody, usePracticeNfts } from '@/components/practice-nfts';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { pct, usd } from '@/lib/format';

// Phones' version of the desktop "Your NFTs" panel: a pill floating above the
// tab bar with the live total (it flashes when the value moves), opening the
// same live list in a bottom sheet, Real or Practice. Shown once either has NFTs;
// the pill shows the current mode's (or the other's, if the current one is empty).
export function YourNftsPill({ bottom }: { bottom: number }) {
  const nfts = useYourNfts();
  const practice = usePracticeNfts();
  const { kind, setKind } = useNftsKind();
  const [open, setOpen] = useState(false);
  const hasReal = !!nfts.wallets && nfts.rows.length > 0;
  const hasPractice = practice.count > 0;
  const pillKind = kind === 'real' ? (hasReal || !hasPractice ? 'real' : 'paper') : (hasPractice || !hasReal ? 'paper' : 'real');
  const total = pillKind === 'real' ? (nfts.priced ? nfts.totalUsd : null) : practice.valueUsd;
  const { tick, at } = useTick(total);
  if (!hasReal && !hasPractice) return null;

  const thumbs = pillKind === 'real'
    ? nfts.rows.slice(0, 3).map((r) => ({ key: r.n.mint, uri: r.n.image, name: r.n.name ?? r.n.collection.name }))
    : practice.groups.slice(0, 3).map((g) => ({ key: g.symbol, uri: g.image, name: g.name }));
  const change = pillKind === 'real' ? nfts.plPct ?? nfts.totalChange : practice.openPnlPct;
  const close = () => setOpen(false);
  const openSheet = () => { setKind(pillKind); setOpen(true); };
  return (
    <>
      <View pointerEvents="box-none" style={[s.wrap, { bottom }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Your NFTs" onPress={openSheet} style={s.pill}>
          <FlashBg tick={tick} at={at} style={{ borderRadius: 999 }} />
          <View style={s.stack}>
            {thumbs.map((t, i) => (
              <View key={t.key} style={[s.thumb, i > 0 && { marginLeft: -10 }]}>
                <CollIcon uri={t.uri} name={t.name} size={22} radius={6} />
              </View>
            ))}
          </View>
          {pillKind === 'paper' && <View style={[s.dot, { backgroundColor: MODE_COLOR.paper }]} />}
          <Text style={s.total}><TickArrow tick={tick} />{total != null ? usd(total) : `${nfts.rows.length} NFT${nfts.rows.length === 1 ? '' : 's'}`}</Text>
          {change != null && <Text style={[s.change, { color: change >= 0 ? C.up : C.down }]}>{pct(change)}</Text>}
        </Pressable>
      </View>

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={s.backdrop} onPress={close}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <View style={s.grab} />
            <View style={s.head}>
              <Text style={[T.title, { flex: 1 }]}>Your NFTs</Text>
              {(kind === 'real' ? nfts.checkedAt : practice.checkedAt) && <Live at={(kind === 'real' ? nfts.checkedAt : practice.checkedAt)!} />}
              <Pressable onPress={close} accessibilityLabel="Close" hitSlop={10}><Text style={s.x}>✕</Text></Pressable>
            </View>
            <NftsKindSwitch kind={kind} onKind={setKind} counts={{ real: nfts.wallets ? nfts.rows.length : null, paper: practice.count }} />
            {kind === 'real' ? (
              <>
                <YourNftsBody nfts={nfts} onOpen={close} />
                <Pressable onPress={() => { close(); router.push('/portfolio'); }} style={s.more}>
                  <Text style={s.moreTxt}>Sell, list and see activity in Portfolio ›</Text>
                </Pressable>
              </>
            ) : (
              <PracticeNftsBody nfts={practice} onOpen={close} />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', right: 16, alignItems: 'flex-end' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 6, paddingRight: 12, paddingVertical: 6,
    borderRadius: 999, backgroundColor: '#15151CEE', borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  stack: { flexDirection: 'row' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  thumb: { borderRadius: 7, borderWidth: 1.5, borderColor: '#15151C', overflow: 'hidden' },
  total: { color: C.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  backdrop: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' },
  sheet: {
    width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '82%', backgroundColor: C.bg,
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: C.border, paddingBottom: 16, overflow: 'hidden',
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  x: { color: C.dim, fontSize: 16 },
  more: { marginHorizontal: 16, marginTop: 4, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  moreTxt: { ...T.bodyStrong },
});
