import { Tabs, TabList, TabTrigger, TabSlot, type TabTriggerSlotProps, type TabListProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { MaxContentWidth } from '@/constants/theme';

// Web gets a floating pill tab bar at the bottom, like the native bar.
export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={{ height: '100%' }} />
      <TabList asChild>
        <PillBar>
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

function PillBar(props: TabListProps) {
  return (
    <View {...props} style={s.wrap}>
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
