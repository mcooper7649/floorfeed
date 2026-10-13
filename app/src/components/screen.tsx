import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { useLayout } from '@/lib/layout';

// Page header: display title, one line of context, and an optional control
// (beside the title on wide screens, under it on phones).
export function Screen({ title, subtitle, right, children }: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { wide, maxWidth, pad } = useLayout();
  return (
    <SafeAreaView edges={['top']} style={s.safe}>
      <View style={[s.inner, { maxWidth }]}>
        <View style={[s.head, { paddingHorizontal: pad }, wide && s.headWide]}>
          <View style={{ flex: wide ? 1 : undefined, gap: 4 }}>
            <Text {...display} style={wide ? T.displayL : T.display}>{title}</Text>
            {subtitle ? <Text style={T.meta}>{subtitle}</Text> : null}
          </View>
          {right ? <View style={wide ? null : s.rightNarrow}>{right}</View> : null}
        </View>
        {children}
      </View>
    </SafeAreaView>
  );
}

export const Empty = ({ text }: { text: string }) => <Text style={s.empty}>{text}</Text>;

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  inner: { flex: 1, width: '100%', alignSelf: 'center' },
  head: { paddingTop: 8, paddingBottom: 14, gap: 12 },
  headWide: { paddingTop: 28, paddingBottom: 20, flexDirection: 'row', alignItems: 'flex-end', gap: 24 },
  rightNarrow: { alignSelf: 'stretch' },
  empty: { ...T.meta, textAlign: 'center', padding: 32, lineHeight: 20 },
});
