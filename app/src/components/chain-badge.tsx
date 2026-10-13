import { StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { CHAINS } from '@/constants/chains';
import type { Chain } from '@/lib/api';

// Text label (never color alone) identifies the chain.

export function ChainBadge({ chain }: { chain: Chain }) {
  return (
    <View style={s.badge}>
      <Text style={s.txt}>{CHAINS[chain]?.badge ?? chain.toUpperCase()}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { borderRadius: 5, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, paddingHorizontal: 5, paddingVertical: 1 },
  txt: { color: C.dim, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
});
