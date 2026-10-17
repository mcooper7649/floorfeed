import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MODE_COLOR } from '@/components/mode-toggle';
import { WalletSheet } from '@/components/wallet-button';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { useAuth } from '@/lib/auth';

// For visitors with no wallet and no sign-in: buys are practice, and one tap
// opens the sign-in sheet to trade for real. Stands in for the Practice | Real
// switch, whose Real side they couldn't use yet.
export function SignInNudge() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <View style={s.box}>
      <View style={[s.dot, { backgroundColor: MODE_COLOR.paper }]} />
      <Text style={s.txt}>
        Practice with simulated money at live prices.{' '}
        <Text accessibilityRole="link" onPress={() => setOpen(true)} style={s.link}>
          {auth.supported ? 'Sign in to buy for real' : 'Connect a wallet to buy for real'}
        </Text>
      </Text>
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  txt: { ...T.meta, flex: 1 },
  link: { color: C.accent, fontWeight: '600' },
});
