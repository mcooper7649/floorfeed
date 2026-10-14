import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { NftImage } from '@/components/nft-image';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { PushCard } from '@/components/push-card';
import { SuggestedFollows } from '@/components/suggested-follows';
import { ListRow } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { useAlerts } from '@/lib/alerts';
import { api, type Alert } from '@/lib/api';
import { shortAddr, signedSol, sol, timeAgo } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// Trades by wallets the user follows, newest first. Opening the page marks
// them read.
export default function AlertsScreen() {
  useTitle('Alerts | FloorFeed');
  const { userId, following } = useSession();
  const { markAllRead } = useAlerts();
  const { pad, maxWidth } = useLayout();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (!userId) return;
    api.alerts(userId)
      .then((r) => { setAlerts(r.alerts); if (r.unread) void markAllRead(); })
      .catch(() => setAlerts([]))
      .finally(() => setRefreshing(false));
  }, [userId, markAllRead]);
  useFocusEffect(load);

  const header = (
    <View style={{ gap: 16, paddingBottom: 8 }}>
      <View style={{ gap: 4 }}>
        <Text {...display} style={T.display}>Alerts</Text>
        <Text style={T.meta}>Every buy and sale by the wallets you follow{following.size ? ` (${following.size})` : ''}.</Text>
      </View>
      <PushCard />
    </View>
  );

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      {!alerts ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.accent} />
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={(a) => String(a.id)}
          style={{ width: '100%', maxWidth, alignSelf: 'center' }}
          contentContainerStyle={{ paddingHorizontal: pad, paddingTop: 20, paddingBottom: 40 }}
          ListHeaderComponent={header}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={C.accent} />}
          ListEmptyComponent={following.size
            ? <Empty text="No trades from the wallets you follow yet. New ones show up here as they happen." />
            : (
              <View style={{ gap: 8, paddingTop: 8 }}>
                <Text style={T.meta}>Follow a wallet to get alerts when it trades. Start with the best flippers of the last 30 days:</Text>
                <SuggestedFollows count={5} from="alerts-empty" />
              </View>
            )}
          renderItem={({ item: a }) => <AlertRow a={a} />}
        />
      )}
    </View>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const who = a.name ?? shortAddr(a.wallet);
  const verb = a.side === 'buy' ? 'bought' : a.pnl == null ? 'sold' : a.pnl >= 0 ? 'flipped' : 'sold at a loss';
  return (
    <ListRow
      art={<View style={s.art}><NftImage uri={a.image} name={a.collection.name} radius={10} px={96} /></View>}
      title={`${who} ${verb} ${a.collection.name}`}
      meta={`${timeAgo(a.t)} ago${a.read ? '' : ' · new'}`}
      value={sol(a.price, 2, a.currency)}
      sub={a.pnl != null ? `${signedSol(a.pnl, 2, a.currency)} after fees` : a.side === 'buy' ? 'paid' : 'sold for'}
      subColor={a.pnl == null ? undefined : a.pnl >= 0 ? C.up : C.down}
      onPress={() => router.push({ pathname: '/item/[symbol]/[id]', params: { symbol: a.collection.symbol, id: a.mint } })}
    />
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  art: { width: 44, height: 44 },
});
