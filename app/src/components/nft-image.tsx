import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { C } from '@/constants/brand';
import { thumb } from '@/lib/img';

// Full-bleed NFT artwork (square by default) with an initial underneath for
// hosts that block cross-origin embedding. Children render as overlays.
export function NftImage({ uri, name, ratio = 1, radius = 0, px = 512, style, children }: {
  uri: string | null;
  name: string;
  ratio?: number | null; // null: fill the parent instead
  radius?: number;
  px?: number; // rendered size hint for the resized copy
  style?: ViewStyle;
  children?: ReactNode;
}) {
  return (
    <View style={[s.box, ratio ? { aspectRatio: ratio } : { height: '100%' }, { borderRadius: radius }, style]}>
      <Text style={s.letter}>{name.charAt(0)}</Text>
      {uri ? <Image source={thumb(uri, px)} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} recyclingKey={uri} /> : null}
      {children}
    </View>
  );
}

// Small label pinned over artwork.
export function Pill({ text, tone = 'dark', style }: { text: string; tone?: 'dark' | 'up' | 'down'; style?: ViewStyle }) {
  return (
    <View style={[s.pill, style]}>
      <Text style={[s.pillTxt, tone === 'up' && { color: C.up }, tone === 'down' && { color: C.down }]}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  box: { width: '100%', backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { color: C.dim, fontWeight: '800', fontSize: 40 },
  pill: { position: 'absolute', backgroundColor: '#0B0B10CC', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  pillTxt: { color: C.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
