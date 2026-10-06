import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { C } from '@/constants/brand';

export default function AppTabs() {
  return (
    <NativeTabs
      backgroundColor={C.bg}
      indicatorColor={C.cardHi}
      tintColor={C.accent}
      labelStyle={{ selected: { color: C.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bolt.fill" md="bolt" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="markets">
        <NativeTabs.Trigger.Label>Markets</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.xyaxis.line" md="monitoring" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="leaderboard">
        <NativeTabs.Trigger.Label>Leaders</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="trophy.fill" md="trophy" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="portfolio">
        <NativeTabs.Trigger.Label>Portfolio</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.pie.fill" md="pie_chart" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
