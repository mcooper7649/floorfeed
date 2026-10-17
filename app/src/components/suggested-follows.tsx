import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/event-card';
import { FollowButton } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type TraderProfile } from '@/lib/api';
import { shortAddr, signedSol } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useWithUsd } from '@/lib/prices';

type Pick = TraderProfile & { unit: 'SOL' | 'ETH' };

// The best flippers of the last 30 days (Solana and Ethereum, market makers
// excluded), each one tap from being followed. Used wherever a new visitor
// would otherwise see an empty list.
export function SuggestedFollows({ count = 4, from }: { count?: number; from: string }) {
  const withUsd = useWithUsd();
  const { following, toggleFollow } = useSession();
  const [picks, setPicks] = useState<Pick[] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all((['SOL', 'ETH'] as const).map((unit) =>
      api.leaderboard({ window: '30', sort: 'pnl', hideMM: true, unit })
        .then((b) => b.rows.filter((r) => r.realizedSol > 0 && r.flips >= 5).map((r) => ({ ...r, unit })))
        .catch(() => [] as Pick[])))
      .then(([sol, eth]) => {
        // Mostly Solana (the deepest history), a couple from Ethereum.
        const mixed = [...sol.slice(0, 6), ...eth.slice(0, 3)];
        if (alive) setPicks(mixed);
      });
    return () => { alive = false; };
  }, []);

  // Keep wallets just followed on screen (they flip to "Following"), fill the rest.
  const [shown, setShown] = useState<string[]>([]);
  const list = (picks ?? []).filter((p) => shown.includes(p.wallet) || !following.has(p.wallet));
  const visible = list.slice(0, count);
  if (!picks?.length) return null;

  return (
    <View style={{ gap: 2 }}>
      {visible.map((t) => (
        <View key={t.wallet} style={s.row}>
          <Pressable style={s.who} onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: t.wallet } })}>
            <Avatar t={t} size={36} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={T.bodyStrong} numberOfLines={1}>{t.name ?? shortAddr(t.wallet)}</Text>
              <Text style={T.metaNum} numberOfLines={1}>
                <Text style={{ color: C.up }}>{withUsd(signedSol(t.realizedSol, 1, t.unit), t.realizedSol, t.unit, true)}</Text>
                {` · ${t.flips} flips · ${t.winRate == null ? '—' : `${Math.round(t.winRate * 100)}% wins`} · 30d`}
              </Text>
            </View>
          </Pressable>
          <FollowButton on={following.has(t.wallet)} onPress={() => {
            if (!following.has(t.wallet)) { setShown((xs) => [...xs, t.wallet]); track('suggested_follow', { from }); }
            void toggleFollow(t.wallet);
          }} />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
});
