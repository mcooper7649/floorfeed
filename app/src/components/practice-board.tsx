import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { MODE_COLOR } from '@/components/mode-toggle';
import { Empty } from '@/components/screen';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type PracticeBoard as Board, type PracticeRow, type PracticeWindow } from '@/lib/api';
import { signedUsd } from '@/lib/format';
import { useSession } from '@/lib/session';

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
export const WINDOW_LABEL: Record<PracticeWindow, string> = { '7': 'this week', '30': 'in 30 days', all: 'all time' };

function useBoard(window: PracticeWindow) {
  const { userId } = useSession();
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loading until the board for this window/viewer has come back (the previous one stays, dimmed).
  const key = `${window}|${userId ?? ''}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const load = useCallback(() => {
    api.practiceBoard(window, userId)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadedKey(key));
  }, [window, userId, key]);
  useEffect(load, [load]);
  return { data, error, loading: loadedKey !== key, load };
}

// The viewer's standing in one line: their rank, or how many trades to go.
function standing(b: Board, window: PracticeWindow) {
  if ('rank' in b.you) return `You're #${b.you.rank} of ${b.traders} ${WINDOW_LABEL[window]}, ${pct(b.you.roiPct)}.`;
  return b.you.trades === 0
    ? `Make ${b.minTrades} practice trades to get ranked.`
    : `${b.you.needed} more practice trade${b.you.needed === 1 ? '' : 's'} to get ranked ${WINDOW_LABEL[window]}.`;
}

// Top practice traders, on the Leaders tab.
export function PracticeBoard({ window, pad, cols }: { window: PracticeWindow; pad: number; cols: number }) {
  const { data, error, loading, load } = useBoard(window);
  if (!data && loading) return <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />;
  return (
    <FlatList
      style={{ opacity: loading ? 0.5 : 1 }}
      key={cols}
      data={data?.rows ?? []}
      keyExtractor={(r) => `${r.rank}:${r.name}`}
      numColumns={cols}
      columnWrapperStyle={cols > 1 ? { gap: 16 } : undefined}
      contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 120 }}
      ItemSeparatorComponent={() => <View style={{ height: cols > 1 ? 16 : 12 }} />}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={C.accent} />}
      ListHeaderComponent={data ? (
        <Text style={[T.meta, s.summary]}>
          Ranked by return on what each trader put in, counted in dollars across coins. Open positions count at today&apos;s floor, after fees and the sale discount.
          {' '}<Text style={{ color: C.text }}>{standing(data, window)}</Text>
        </Text>
      ) : null}
      ListEmptyComponent={<Empty text={error ?? `Nobody has ${data?.minTrades ?? 3} practice trades ${WINDOW_LABEL[window]} yet. Be the first: tap Buy floor on any card.`} />}
      renderItem={({ item }) => <View style={{ flex: 1 / cols }}><Row r={item} /></View>}
    />
  );
}

function Row({ r }: { r: PracticeRow }) {
  const podium = r.rank <= 3;
  return (
    <View style={[s.row, r.you && { borderColor: MODE_COLOR.paper }]}>
      <View style={[s.rank, podium && { backgroundColor: MODE_COLOR.paper }]}>
        <Text style={[s.rankTxt, podium && { color: C.accentInk }]}>{r.rank}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={T.bodyStrong} numberOfLines={1}>{r.name}{r.you ? <Text style={{ color: MODE_COLOR.paper }}>  You</Text> : null}</Text>
        <Text style={T.meta} numberOfLines={1}>
          {r.trades} trades · {r.wins} in profit{r.best && r.best.pct > 0 ? ` · best ${r.best.collection} ${pct(r.best.pct)}` : ''}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[s.roi, { color: r.roiPct >= 0 ? C.up : C.down }]}>{pct(r.roiPct)}</Text>
        <Text style={T.metaNum}>{signedUsd(r.pnlUsd)}</Text>
      </View>
    </View>
  );
}

// Portfolio card: your rank this week, opening the board.
export function PracticeRank() {
  const { data } = useBoard('7');
  if (!data) return null;
  return (
    <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/leaderboard', params: { board: 'practice' } })}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.rankCard, (pressed || hovered) && { backgroundColor: C.cardHi }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={T.bodyStrong}>Top practice traders</Text>
        <Text style={T.meta}>{standing(data, '7')}</Text>
      </View>
      <Text style={[T.label, { color: C.accent }]}>See the board ›</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  summary: { paddingTop: 4, paddingBottom: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
  rank: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: C.cardHi },
  rankTxt: { fontSize: 13, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] },
  roi: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rankCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
});
