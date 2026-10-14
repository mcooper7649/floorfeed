import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { ChainBadge } from '@/components/chain-badge';
import { DepositSheet } from '@/components/deposit-sheet';
import { SendSheet } from '@/components/send-sheet';
import { Card, RowAction } from '@/components/ui';
import { useBalance, useCapabilities, useEvmBalance, WalletSheet } from '@/components/wallet-button';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { useEvmWallet } from '@/lib/evm-wallet';
import { shortAddr } from '@/lib/format';
import { useWallet } from '@/lib/wallet';

// Real mode: the user's wallets, one row each (Solana, Ethereum) with the
// balance and what you do with a wallet here: deposit, send, move between
// networks (Ethereum), manage.
export function WalletsCard() {
  const w = useWallet();
  const ew = useEvmWallet();
  const sol = useBalance(w.address);
  const eth = useEvmBalance(ew.address);
  const caps = useCapabilities();
  const [manage, setManage] = useState(false);
  const [deposit, setDeposit] = useState<'solana' | 'ethereum' | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  // Withdrawals are for the FloorFeed (Privy) wallets; extensions send from their own app.
  const embedded = (chain: 'solana' | 'ethereum') => (chain === 'solana' ? w.kind : ew.kind) === 'embedded';

  const row = (chain: 'solana' | 'ethereum', address: string, name: string | null, balance: string) => (
    <View style={s.row} key={chain}>
      <ChainBadge chain={chain} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={T.num} numberOfLines={1}>{balance}</Text>
        <Text style={T.metaNum} numberOfLines={1}>{shortAddr(address)}{name ? ` · ${name}` : ''}</Text>
      </View>
      {embedded(chain) && <RowAction label="Send" onPress={() => setSendOpen(true)} />}
      {chain === 'ethereum' && <RowAction label="Move" onPress={() => setBridgeOpen(true)} />}
      <RowAction label="Deposit" onPress={() => setDeposit(chain)} />
    </View>
  );

  return (
    <Card style={{ gap: 4, paddingVertical: 8 }}>
      {w.address && row('solana', w.address, w.walletName, sol != null ? `${sol.toFixed(3)} SOL` : '…')}
      {w.address && ew.address && <View style={s.divider} />}
      {ew.address && row('ethereum', ew.address, ew.walletName, eth != null ? `${eth.toFixed(4)} ETH` : '…')}
      <View style={s.foot}>
        <Text style={[T.caption, { flex: 1 }]}>
          {caps && !caps.buy.enabled && w.address
            ? 'Solana buys finish on Magic Eden for now. Ethereum buys complete here.'
            : 'Your wallet asks before anything is signed.'}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => setManage(true)} hitSlop={8}>
          <Text style={[T.label, { color: C.text }]}>Manage wallets</Text>
        </Pressable>
      </View>
      <WalletSheet open={manage} onClose={() => setManage(false)} />
      <DepositSheet open={deposit === 'solana'} onClose={() => setDeposit(null)} />
      <DepositSheet chain="ethereum" open={deposit === 'ethereum'} onClose={() => setDeposit(null)} />
      <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} />
      <BridgeSheet open={bridgeOpen} onClose={() => setBridgeOpen(false)} />
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
