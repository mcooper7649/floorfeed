import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/event-card';
import { Sparkline } from '@/components/sparkline';
import { FollowButton, Stat } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import type { TraderProfile } from '@/lib/api';
import { holdTime, pct, shortAddr, signedSol, timeAgo, unitFor } from '@/lib/format';

export function TraderCard({ t, rank, following, onToggleFollow }: {
  t: TraderProfile;
  rank: number;
  following: boolean;
  onToggleFollow: () => void;
}) {
  const up = t.realizedSol >= 0;
  const u = t.unit ?? unitFor(t.wallet);
  const notes = [
    t.bestFlip && `Best flip ${signedSol(t.bestFlip.pnlSol, 2, u)} on ${t.bestFlip.collection}.`,
    t.worstFlipSol != null && t.worstFlipSol < 0 && `Worst ${signedSol(t.worstFlipSol, 2, u)}.`,
    u === 'SOL'
      ? `${Math.round(t.poolShare * 100)}% of trades through AMM pools.`
      : `${Math.round((t.bidBuyShare ?? 0) * 100)}% of buys filled by accepted bids.`,
  ].filter(Boolean).join(' ');
  return (
    // Plain Pressable + router.push (not <Link>): on web a Link renders an <a>,
    // and the nested Follow button would trigger navigation too.
    <Pressable style={s.card} onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: t.wallet } })}>
      <View style={s.row}>
        <Text style={[T.title, s.rank, rank <= 3 && { color: C.accent }]}>{rank}</Text>
        <Avatar t={t} size={40} />
        <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
          <Text style={T.bodyStrong} numberOfLines={1}>{t.name ?? shortAddr(t.wallet)}</Text>
          <View style={s.badges}>
            {t.streak >= 3 && <Badge text={`${t.streak} wins in a row`} tone="up" />}
            {t.likelyMarketMaker && <Badge text="Likely market maker" tone="dim" />}
            {t.lastActive != null && <Text style={T.caption}>Active {timeAgo(t.lastActive)} ago</Text>}
          </View>
        </View>
        <FollowButton on={following} onPress={onToggleFollow} />
      </View>

      <View style={[s.row, { alignItems: 'flex-end' }]}>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text style={T.label}>Realized profit</Text>
          <Text numberOfLines={1} style={[T.value, { color: up ? C.up : C.down }]}>{signedSol(t.realizedSol, 2, u)}</Text>
        </View>
        {t.roiPct != null && (
          <View style={[s.roi, { backgroundColor: (t.roiPct >= 0 ? C.up : C.down) + '22' }]}>
            <Text style={[T.label, { color: t.roiPct >= 0 ? C.up : C.down }]}>{pct(t.roiPct)} ROI</Text>
          </View>
        )}
        <Sparkline values={t.series} width={84} height={34} />
      </View>

      <View style={s.grid}>
        <Stat tone="inset" style={s.stat} label="Win rate" value={t.winRate == null ? '—' : `${Math.round(t.winRate * 100)}%`} sub={`${t.wins} of ${t.flips}`} />
        <Stat tone="inset" style={s.stat} label="Per flip" value={t.avgPnlSol == null ? '—' : signedSol(t.avgPnlSol, 2, u)} />
        <Stat tone="inset" style={s.stat} label="Avg hold" value={t.avgHoldHours == null ? '—' : holdTime(t.avgHoldHours)} />
        <Stat tone="inset" style={s.stat} label="Holding" value={String(t.openPositions)} sub={t.openPositions ? signedSol(t.unrealizedSol, 2, u) : undefined} />
      </View>

      {t.collections.length > 0 && (
        <View style={s.chips}>
          {t.collections.map((c) => (
            <View key={c.symbol} style={s.chip}>
              <Text style={[T.label, { color: C.text, flexShrink: 1 }]} numberOfLines={1}>{c.name}</Text>
              <Text style={T.metaNum}>×{c.flips} <Text style={{ color: c.pnlSol >= 0 ? C.up : C.down }}>{signedSol(c.pnlSol, 1, u)}</Text></Text>
            </View>
          ))}
        </View>
      )}

      <Text style={T.caption}>{notes}</Text>
    </Pressable>
  );
}

const Badge = ({ text, tone }: { text: string; tone: 'up' | 'dim' }) => (
  <View style={[s.badge, tone === 'up' && { backgroundColor: C.up + '22', borderColor: C.up + '55' }]}>
    <Text style={[T.caption, { color: tone === 'up' ? C.up : C.dim }]}>{text}</Text>
  </View>
);

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 16, padding: 16, gap: 14, borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rank: { width: 22, color: C.dim },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  roi: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  // Four across on wide cards, two by two on phones.
  stat: { flexBasis: 0, flexGrow: 1, minWidth: 128 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 4, maxWidth: '100%' },
});
