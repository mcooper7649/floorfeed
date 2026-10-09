import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useBalance, useCapabilities, WalletSheet } from '@/components/wallet-button';
import { C } from '@/constants/brand';
import { useAuth } from '@/lib/auth';
import { shortAddr } from '@/lib/format';
import { useWallet } from '@/lib/wallet';

// Portfolio header: real wallet status next to the paper P&L. Buying stays
// off (and says why) until the server has a marketplace key.
export function WalletCard() {
  const w = useWallet();
  const auth = useAuth();
  const caps = useCapabilities();
  const balance = useBalance(w.address);
  const [open, setOpen] = useState(false);

  return (
    <View style={s.card}>
      <View style={s.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.label}>WALLET</Text>
          {!w.supported ? (
            <Text style={s.meta}>Wallet connection is on the website first; the mobile app is next.</Text>
          ) : w.address ? (
            <Text style={s.val}>
              {shortAddr(w.address)}
              <Text style={s.meta}>  {balance != null ? `${balance.toFixed(3)} SOL` : '…'}</Text>
            </Text>
          ) : (
            <Text style={s.meta}>
              {auth.supported
                ? 'Sign in with email or Google for a free wallet, or connect Phantom, Solflare or Backpack.'
                : 'Connect Phantom, Solflare or Backpack to see your balance.'}
            </Text>
          )}
        </View>
        {w.supported && (
          <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={w.address ? s.secondary : s.primary}>
            <Text style={w.address ? s.secondaryTxt : s.primaryTxt}>{w.address ? 'Manage' : auth.supported ? 'Sign in' : 'Connect wallet'}</Text>
          </Pressable>
        )}
      </View>
      {caps && (
        <Text style={s.meta}>
          {caps.buy.enabled
            ? `Real buys enabled via ${[caps.buy.magiceden && 'Magic Eden', caps.buy.tensor && 'Tensor'].filter(Boolean).join(' and ')}.`
            : 'Real buys are coming: they turn on once FloorFeed has marketplace API access. Until then, trades here are paper only.'}
        </Text>
      )}
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 16, marginBottom: 8, padding: 16, borderRadius: 18, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  val: { color: C.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  meta: { color: C.dim, fontSize: 12.5, lineHeight: 18, fontWeight: '400' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  primaryTxt: { color: C.accentInk, fontWeight: '800' },
  secondary: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { color: C.text, fontWeight: '800' },
});
