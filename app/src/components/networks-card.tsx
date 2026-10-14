import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { ChainBadge } from '@/components/chain-badge';
import { Card, RowAction } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { api, type EvmNetwork } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { amt, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';
import { track } from '@/lib/analytics';

// Every network the user has money on, one row each: the coin, any wrapped
// coin (offer sales pay WETH, which plain balances don't show), and what it's
// worth. Unwrap turns WETH back into ETH on the same network; Move bridges.

export type NetworkLine = { key: string; chain: string; name: string; parts: { amount: number; unit: string; label: string }[]; usd: number | null };

// Rows for the card and the portfolio total: Solana first, then EVM networks with any balance.
export function networkLines(sol: number | null, nets: EvmNetwork[] | null, toUsd: (n: number, u: string) => number | null): NetworkLine[] {
  const lines: NetworkLine[] = [];
  if (sol != null && sol > 0) lines.push({ key: 'solana', chain: 'solana', name: 'Solana', parts: [{ amount: sol, unit: 'SOL', label: 'SOL' }], usd: toUsd(sol, 'SOL') });
  for (const n of nets ?? []) {
    const parts = [
      ...(n.balance && n.balance > 0 ? [{ amount: n.balance, unit: n.native, label: n.native }] : []),
      ...n.tokens.filter((t) => (t.balance ?? 0) > 0).map((t) => ({ amount: t.balance!, unit: t.unit, label: t.symbol })),
    ];
    if (!parts.length) continue;
    const vals = parts.map((p) => toUsd(p.amount, p.unit));
    lines.push({ key: n.chain, chain: n.chain, name: n.name, parts, usd: vals.some((v) => v == null) ? null : vals.reduce((a, v) => a! + v!, 0) });
  }
  return lines.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

export function NetworksCard({ sol, networks, onChanged }: {
  sol: number | null;              // Solana wallet balance (null = no Solana wallet / loading)
  networks: EvmNetwork[] | null;   // null = loading
  onChanged: () => void;           // refetch after an unwrap or move
}) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [bridge, setBridge] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ chain: string; text: string; ok: boolean } | null>(null);
  const lines = networkLines(sol, networks, toUsd);

  const unwrap = async (n: EvmNetwork, token: EvmNetwork['tokens'][number]) => {
    if (!w.address || !w.send) return;
    setBusy(n.chain); setMsg(null);
    try {
      const tx = await api.evmUnwrapTx({ chain: n.chain, owner: w.address, token: token.address });
      const hash = await w.send({ ...tx, description: `Unwrap ${amt(tx.amount, tx.symbol)} to ${tx.unit} on ${n.name} (1:1)` });
      track('unwrap_signed', { chain: n.chain });
      recordTx({ hash, wallet: w.address, chain: n.chain, kind: 'unwrap', title: `Unwrapped ${amt(tx.amount, tx.symbol)} on ${n.name}`, amount: tx.amount, unit: tx.unit });
      setMsg({ chain: n.chain, ok: true, text: `Unwrapping ${amt(tx.amount, tx.symbol)}. It shows as ${tx.unit} once it confirms (seconds on most networks).` });
      setTimeout(onChanged, 8_000);
    } catch (e) {
      const m = (e as Error).message || 'The unwrap did not go through.';
      setMsg({ chain: n.chain, ok: false, text: /reject|denied|cancel/i.test(m) ? 'You cancelled. Nothing was sent.' : m });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ gap: 2, paddingVertical: 8 }}>
      <View style={s.head}>
        <Text style={[T.label, { flex: 1 }]}>Money by network</Text>
        {networks == null && <ActivityIndicator color={C.accent} size="small" />}
      </View>
      {networks != null && lines.length === 0 && <Text style={[T.meta, { paddingVertical: 8 }]}>No coins in your wallets yet. Use Deposit to add some.</Text>}
      {lines.map((l) => {
        const n = networks?.find((x) => x.chain === l.chain);
        const wrapped = n?.tokens.find((t) => t.unwrappable && (t.balance ?? 0) > 0);
        const canMove = l.chain !== 'solana' && !!n && (n.balance ?? 0) > 0 && !!w.send;
        return (
          <View key={l.key} style={s.rowWrap}>
            <View style={s.row}>
              <ChainBadge chain={l.chain as never} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={T.bodyStrong} numberOfLines={1}>{l.name}</Text>
                <Text style={T.metaNum} numberOfLines={2}>{l.parts.map((p) => amt(p.amount, p.label)).join(' + ')}</Text>
              </View>
              <Text style={[T.num, { color: C.text }]}>{l.usd != null ? usd(l.usd) : '—'}</Text>
              {wrapped && w.send && (
                <RowAction label={busy === l.chain ? '…' : 'Unwrap'} onPress={() => busy ? undefined : void unwrap(n!, wrapped)} />
              )}
              {canMove && <RowAction label="Move" onPress={() => setBridge(l.chain)} />}
            </View>
            {wrapped && (
              <Text style={s.hint}>
                {wrapped.symbol} is wrapped {wrapped.unit}, worth the same. Offer sales pay in it. Unwrap to use it for buys or gas.
              </Text>
            )}
            {msg?.chain === l.chain && <Text style={[s.hint, { color: msg.ok ? C.up : C.down }]}>{msg.text}</Text>}
          </View>
        );
      })}
      <BridgeSheet open={bridge != null} from={bridge ?? undefined} onClose={() => { setBridge(null); onChanged(); }} />
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  rowWrap: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: { ...T.caption, paddingLeft: 52 },
});
