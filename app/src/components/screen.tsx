import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { C } from '@/constants/brand';
import { useLayout } from '@/lib/layout';

export function Screen({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { wide, maxWidth, pad } = useLayout();
  return (
    <SafeAreaView edges={['top']} style={s.safe}>
      <View style={[s.inner, { maxWidth }]}>
        <View style={[s.head, { paddingHorizontal: pad }, wide && s.headWide]}>
          <Text style={[s.title, wide && s.titleWide]}>{title}</Text>
          {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
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
  head: { paddingTop: 8, paddingBottom: 10, gap: 2 },
  headWide: { paddingTop: 28, paddingBottom: 16, gap: 6 },
  title: { color: C.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  titleWide: { fontSize: 38, letterSpacing: -1 },
  sub: { color: C.dim, fontSize: 13 },
  empty: { color: C.dim, textAlign: 'center', padding: 32, lineHeight: 20 },
});
