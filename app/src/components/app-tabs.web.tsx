import { Tabs, TabList, TabTrigger, TabSlot, type TabTriggerSlotProps, type TabListProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TopNav } from '@/components/top-nav';
import { C } from '@/constants/brand';
import { MaxContentWidth } from '@/constants/theme';
import { useLayout } from '@/lib/layout';

// Narrow web gets a floating pill tab bar at the bottom, like the native bar.
// Wide web gets a top header instead; the tab list stays mounted (it
// registers the routes) but hidden.
export default function AppTabs() {
  const { wide } = useLayout();
  return (
    <Tabs style={{ flex: 1 }}>
      {wide && <TopNav />}
      <TabSlot style={{ flex: 1 }} />
      <TabList asChild>
        <PillBar hidden={wide}>
          <TabTrigger name="index" href="/" asChild><TabButton>Feed</TabButton></TabTrigger>
          <TabTrigger name="markets" href="/markets" asChild><TabButton>Markets</TabButton></TabTrigger>
          <TabTrigger name="leaderboard" href="/leaderboard" asChild><TabButton>Leaders</TabButton></TabTrigger>
          <TabTrigger name="portfolio" href="/portfolio" asChild><TabButton>Portfolio</TabButton></TabTrigger>
        </PillBar>
      </TabList>
    </Tabs>
  );
}

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable {...props} style={[s.btn, isFocused && s.btnOn]}>
      <Text style={[s.txt, isFocused && { color: C.accentInk }]}>{children}</Text>
    </Pressable>
  );
}

function PillBar({ hidden, ...props }: TabListProps & { hidden?: boolean }) {
  return (
    <View {...props} style={StyleSheet.flatten([s.wrap, hidden && { display: 'none' }])}>
      <View style={s.bar}>{props.children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', bottom: 16, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16 },
  bar: {
    flexDirection: 'row', gap: 4, padding: 5, borderRadius: 999, backgroundColor: '#15151CEE',
    borderWidth: 1, borderColor: C.border, maxWidth: MaxContentWidth,
  },
  btn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999 },
  btnOn: { backgroundColor: C.accent },
  txt: { color: C.dim, fontWeight: '700', fontSize: 14 },
});
