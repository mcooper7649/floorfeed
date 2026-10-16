import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { ChainBadge } from '@/components/chain-badge';
import { NetworkSendSheet } from '@/components/network-send-sheet';
import { Card, RowAction } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { api, type EvmNetwork } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useWallet } from '@/lib/wallet';
import { amt, usd } from '@/lib/format';
import { usePrices } from '@/lib/prices';
import { track } from '@/lib/analytics';

// Every network the user has money on, one row each: the coin, any wrapped
// coin (offer sales pay WETH, which plain balances don't show), and what it's
// worth. Unwrap turns WETH back into ETH on the same network; Move bridges;
// Send pays any address. Networks with nothing on them are listed too (Add
// bridges money in), so every network FloorFeed supports is one tap away.

export type NetworkLine = { key: string; chain: string; name: string; parts: { amount: number; unit: string; label: string }[]; usd: number | null };

// Rows for the card and the portfolio total: networks with any balance, most
// money first. `all` also keeps the empty ones (the card lists every network).
export function networkLines(sol: number | null, nets: EvmNetwork[] | null, toUsd: (n: number, u: string) => number | null, all = false): NetworkLine[] {
  const lines: NetworkLine[] = [];
  if (sol != null && (sol > 0 || all)) lines.push({ key: 'solana', chain: 'solana', name: 'Solana', parts: [{ amount: sol, unit: 'SOL', label: 'SOL' }], usd: toUsd(sol, 'SOL') });
  for (const n of nets ?? []) {
    const parts = [
      ...(n.balance && n.balance > 0 ? [{ amount: n.balance, unit: n.native, label: n.native }] : []),
      ...n.tokens.filter((t) => (t.balance ?? 0) > 0).map((t) => ({ amount: t.balance!, unit: t.unit, label: t.symbol })),
    ];
    if (!parts.length) {
      if (all) lines.push({ key: n.chain, chain: n.chain, name: n.name, parts: [], usd: 0 });
      continue;
    }
    const vals = parts.map((p) => toUsd(p.amount, p.unit));
    lines.push({ key: n.chain, chain: n.chain, name: n.name, parts, usd: vals.some((v) => v == null) ? null : vals.reduce((a, v) => a! + v!, 0) });
  }
  return lines.sort((a, b) => Number(b.parts.length > 0) - Number(a.parts.length > 0) || (b.usd ?? 0) - (a.usd ?? 0));
}

export function NetworksCard({ sol, networks, onChanged }: {
  sol: number | null;              // Solana wallet balance (null = no Solana wallet / loading)
  networks: EvmNetwork[] | null;   // null = loading
  onChanged: () => void;           // refetch after an unwrap or move
}) {
  const w = useEvmWallet();
  const sw = useWallet();
  const { toUsd } = usePrices();
  const [bridge, setBridge] = useState<{ from?: string; to?: string } | null>(null);
  const [sendOn, setSendOn] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ chain: string; text: string; ok: boolean } | null>(null);
  const lines = networkLines(sol, networks, toUsd, true);
  const funded = lines.filter((l) => l.parts.length > 0);
  const canSign = (chain: string) => (chain === 'solana' ? !!sw.sendTransaction : !!w.send);
  // Add (bridge in) needs coins on some other network this wallet can sign for.
  const canAdd = (chain: string) => funded.some((l) => l.chain !== chain && canSign(l.chain));

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
      {networks != null && funded.length === 0 && <Text style={[T.meta, { paddingVertical: 8 }]}>No coins in your wallets yet. Use Deposit to add some.</Text>}
      {lines.map((l, i) => {
        if (!l.parts.length) {
          return (
            <View key={l.key}>
              {i === funded.length && i > 0 && <Text style={[T.caption, s.sub]}>Other networks</Text>}
              <View style={[s.row, s.empty]}>
                <ChainBadge chain={l.chain as never} />
                <Text style={[T.body, { flex: 1, color: C.dim }]} numberOfLines={1}>{l.name}</Text>
                <Text style={[T.metaNum, { color: C.muted }]}>0 {l.chain === 'solana' ? 'SOL' : networks?.find((x) => x.chain === l.chain)?.native}</Text>
                {canAdd(l.chain) && <RowAction label="Add" onPress={() => setBridge({ to: l.chain })} />}
              </View>
            </View>
          );
        }
        const n = networks?.find((x) => x.chain === l.chain);
        const wrapped = n?.tokens.find((t) => t.unwrappable && (t.balance ?? 0) > 0);
        const canMove = l.chain === 'solana' ? (sol ?? 0) > 0 && !!sw.sendTransaction : !!n && (n.balance ?? 0) > 0 && !!w.send;
        const canSend = canSign(l.chain);
        return (
          <View key={l.key} style={s.rowWrap}>
            <View style={s.row}>
              <ChainBadge chain={l.chain as never} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={T.bodyStrong} numberOfLines={1}>{l.name}</Text>
                <Text style={T.metaNum} numberOfLines={2}>{l.parts.map((p) => amt(p.amount, p.label)).join(' + ')}</Text>
              </View>
              <Text style={[T.num, { color: C.text }]}>{l.usd != null ? usd(l.usd) : '—'}</Text>
            </View>
            {(wrapped && w.send) || canMove || canSend ? (
              <View style={s.actions}>
                {wrapped && w.send && (
                  <RowAction label={busy === l.chain ? '…' : 'Unwrap'} onPress={() => busy ? undefined : void unwrap(n!, wrapped)} />
                )}
                {canMove && <RowAction label="Move" onPress={() => setBridge({ from: l.chain })} />}
                {canSend && <RowAction label="Send" onPress={() => { track('network_send_open', { chain: l.chain }); setSendOn(l.chain); }} />}
              </View>
            ) : null}
            {wrapped && (
              <Text style={s.hint}>
                {wrapped.symbol} is wrapped {wrapped.unit}, worth the same. Offer sales pay in it. Unwrap to use it for buys or gas.
              </Text>
            )}
            {msg?.chain === l.chain && <Text style={[s.hint, { color: msg.ok ? C.up : C.down }]}>{msg.text}</Text>}
          </View>
        );
      })}
      <BridgeSheet open={bridge != null} from={bridge?.from} to={bridge?.to} onClose={() => { setBridge(null); onChanged(); }} />
      <NetworkSendSheet chain={sendOn} sol={sol} network={networks?.find((x) => x.chain === sendOn) ?? null}
        onClose={(sent) => { setSendOn(null); if (sent) setTimeout(onChanged, 4_000); }} />
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  rowWrap: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: { ...T.caption, paddingLeft: 52 },
  sub: { paddingTop: 10, paddingBottom: 2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  empty: { paddingVertical: 5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 52 },
});
