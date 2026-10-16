import { Tabs, TabList, TabTrigger, TabSlot, type TabTriggerSlotProps, type TabListProps } from 'expo-router/ui';
import { usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { YourNftsPill } from '@/components/your-nfts-sheet';
import { C } from '@/constants/brand';
import { MaxContentWidth } from '@/constants/theme';
import { useLayout } from '@/lib/layout';

// Narrow web gets a floating pill tab bar at the bottom, like the native bar.
// Wide web gets the header from the root layout instead; the tab list stays
// mounted (it registers the routes) but hidden.
export default function AppTabs() {
  const { wide } = useLayout();
  const path = usePathname();
  return (
    <Tabs style={{ flex: 1 }}>
      <TabSlot style={{ flex: 1 }} />
      <TabList asChild>
        <PillBar hidden={wide}>
          <TabTrigger name="index" href="/" asChild><TabButton>Feed</TabButton></TabTrigger>
          <TabTrigger name="markets" href="/markets" asChild><TabButton>Markets</TabButton></TabTrigger>
          <TabTrigger name="mint" href="/mint" asChild><TabButton>Mint</TabButton></TabTrigger>
          <TabTrigger name="leaderboard" href="/leaderboard" asChild><TabButton>Leaders</TabButton></TabTrigger>
          <TabTrigger name="portfolio" href="/portfolio" asChild><TabButton>Portfolio</TabButton></TabTrigger>
        </PillBar>
      </TabList>
      {/* Phones' stand-in for the desktop Your NFTs panel (not on Portfolio, which lists them). */}
      {!wide && !path.startsWith('/portfolio') && <YourNftsPill bottom={80} />}
    </Tabs>
  );
}

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  // Five tabs: the smallest phones get a tighter fit.
  const tight = useWindowDimensions().width < 400;
  return (
    <Pressable {...props} style={[s.btn, tight && { paddingHorizontal: 10 }, isFocused && s.btnOn]}>
      <Text style={[s.txt, tight && { fontSize: 13 }, isFocused && { color: C.accentInk }]}>{children}</Text>
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
  wrap: { position: 'absolute', bottom: 16, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 12 },
  bar: {
    flexDirection: 'row', gap: 2, padding: 4, borderRadius: 999, backgroundColor: '#15151CEE',
    borderWidth: 1, borderColor: C.border, maxWidth: MaxContentWidth,
  },
  btn: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999 },
  btnOn: { backgroundColor: C.accent },
  txt: { color: C.dim, fontWeight: '600', fontSize: 14 },
});
