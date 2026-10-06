import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Sparkline } from '@/components/sparkline';
import { C } from '@/constants/brand';
import type { TraderProfile } from '@/lib/api';
import { holdTime, pct, shortAddr, signedSol, timeAgo } from '@/lib/format';

export function TraderCard({ t, rank, following, onToggleFollow }: {
  t: TraderProfile;
  rank: number;
  following: boolean;
  onToggleFollow: () => void;
}) {
  const up = t.realizedSol >= 0;
  return (
    // Plain Pressable + router.push (not <Link>): on web a Link renders an <a>,
    // and the nested Follow button would trigger navigation too.
    <Pressable style={s.card} onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: t.wallet } })}>
        <View style={s.row}>
          <Text style={[s.rank, rank <= 3 && { color: C.accent }]}>{rank}</Text>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.addr}>{shortAddr(t.wallet)}</Text>
            <View style={s.badges}>
              {t.streak >= 3 && <Badge text={`${t.streak} win streak`} tone="up" />}
              {t.likelyMarketMaker && <Badge text="Likely market maker" tone="dim" />}
              {t.lastActive != null && <Badge text={`active ${timeAgo(t.lastActive)} ago`} tone="dim" />}
            </View>
          </View>
          <Pressable hitSlop={10} onPress={onToggleFollow} style={[s.follow, following && s.following]}>
            <Text style={[s.followTxt, following && { color: C.dim }]}>{following ? 'Following' : 'Follow'}</Text>
          </Pressable>
        </View>

        <View style={[s.row, { alignItems: 'flex-end' }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>Realized P&L</Text>
            <Text style={[s.pnl, { color: up ? C.up : C.down }]}>{signedSol(t.realizedSol)}</Text>
          </View>
          {t.roiPct != null && (
            <View style={[s.roi, { backgroundColor: (t.roiPct >= 0 ? C.up : C.down) + '22' }]}>
              <Text style={[s.roiTxt, { color: t.roiPct >= 0 ? C.up : C.down }]}>{pct(t.roiPct)} ROI</Text>
            </View>
          )}
          <Sparkline values={t.series} width={84} height={34} />
        </View>

        <View style={s.grid}>
          <Stat label="Win rate" value={t.winRate == null ? '—' : `${Math.round(t.winRate * 100)}%`} sub={`${t.wins}/${t.flips} flips`} />
          <Stat label="Avg / flip" value={t.avgPnlSol == null ? '—' : signedSol(t.avgPnlSol).replace(' SOL', '')} sub="SOL" />
          <Stat label="Avg hold" value={t.avgHoldHours == null ? '—' : holdTime(t.avgHoldHours)} />
          <Stat label="Holding" value={String(t.openPositions)} sub={t.openPositions ? `${signedSol(t.unrealizedSol)} open` : undefined} />
        </View>

        {t.collections.length > 0 && (
          <View style={s.chips}>
            {t.collections.map((c) => (
              <View key={c.symbol} style={s.chip}>
                <Text style={s.chipTxt} numberOfLines={1}>{c.name}</Text>
                <Text style={s.chipMeta}>×{c.flips} · <Text style={{ color: c.pnlSol >= 0 ? C.up : C.down }}>{signedSol(c.pnlSol, 1)}</Text></Text>
              </View>
            ))}
          </View>
        )}

        <Text style={s.foot}>
          {t.bestFlip ? <>Best flip <Text style={{ color: C.up }}>{signedSol(t.bestFlip.pnlSol)}</Text> on {t.bestFlip.collection}</> : null}
          {t.worstFlipSol != null && t.worstFlipSol < 0 ? <> · worst <Text style={{ color: C.down }}>{signedSol(t.worstFlipSol)}</Text></> : null}
          {` · ${Math.round(t.poolShare * 100)}% of trades via AMM pools`}
        </Text>
    </Pressable>
  );
}

const Badge = ({ text, tone }: { text: string; tone: 'up' | 'dim' }) => (
  <View style={[s.badge, tone === 'up' && { backgroundColor: C.up + '22', borderColor: C.up + '55' }]}>
    <Text style={[s.badgeTxt, tone === 'up' && { color: C.up }]}>{text}</Text>
  </View>
);

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <View style={s.stat}>
    <Text style={s.label}>{label}</Text>
    <Text style={s.statVal}>{value}</Text>
    {sub ? <Text style={s.statSub}>{sub}</Text> : null}
  </View>
);

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 18, padding: 14, gap: 12, borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rank: { color: C.dim, width: 22, fontWeight: '800', fontSize: 17 },
  addr: { color: C.text, fontWeight: '700', fontSize: 15 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  badgeTxt: { color: C.dim, fontSize: 11, fontWeight: '700' },
  follow: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.text },
  following: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.border },
  followTxt: { color: C.bg, fontWeight: '700', fontSize: 12.5 },
  label: { color: C.dim, fontSize: 11.5, fontWeight: '600' },
  pnl: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  roi: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4 },
  roiTxt: { fontWeight: '800', fontSize: 12.5 },
  grid: { flexDirection: 'row', gap: 6 },
  stat: { flex: 1, backgroundColor: C.cardHi, borderRadius: 10, padding: 8, gap: 1 },
  statVal: { color: C.text, fontWeight: '800', fontSize: 14.5 },
  statSub: { color: C.dim, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 4, maxWidth: '100%' },
  chipTxt: { color: C.text, fontWeight: '600', fontSize: 12.5, flexShrink: 1 },
  chipMeta: { color: C.dim, fontSize: 12 },
  foot: { color: C.dim, fontSize: 12, lineHeight: 17 },
});
