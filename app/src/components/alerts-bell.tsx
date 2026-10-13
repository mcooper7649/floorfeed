import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { useAlerts } from '@/lib/alerts';

// Bell with the unread count; opens the alerts page.
export function AlertsBell() {
  const { unread } = useAlerts();
  return (
    <Link href="/alerts" asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={unread ? `Alerts, ${unread} unread` : 'Alerts'} hitSlop={8}
        style={s.btn}>
        <Text style={s.bell}>🔔</Text>
        {unread > 0 && (
          <View style={s.badge}><Text style={s.badgeTxt}>{unread > 99 ? '99+' : unread}</Text></View>
        )}
      </Pressable>
    </Link>
  );
}

const s = StyleSheet.create({
  btn: {
    width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    alignItems: 'center', justifyContent: 'center',
  },
  bell: { fontSize: 17 },
  badge: {
    position: 'absolute', top: -5, right: -5, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
  },
  badgeTxt: { color: C.accentInk, fontSize: 11, fontWeight: '700' },
});
