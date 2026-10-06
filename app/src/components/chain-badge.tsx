import { StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import type { Chain } from '@/lib/api';

// Text label (never color alone) identifies the chain.
const LABEL: Record<Chain, string> = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', polygon: 'POL' };

export function ChainBadge({ chain }: { chain: Chain }) {
  return (
    <View style={s.badge}>
      <Text style={s.txt}>{LABEL[chain]}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { borderRadius: 5, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, paddingHorizontal: 5, paddingVertical: 1 },
  txt: { color: C.dim, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.5 },
});
