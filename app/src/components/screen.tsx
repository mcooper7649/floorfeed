import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { C } from '@/constants/brand';
import { MaxContentWidth } from '@/constants/theme';

export function Screen({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <SafeAreaView edges={['top']} style={s.safe}>
      <View style={s.inner}>
        <View style={s.head}>
          <Text style={s.title}>{title}</Text>
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
  inner: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  head: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 2 },
  title: { color: C.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: C.dim, fontSize: 13 },
  empty: { color: C.dim, textAlign: 'center', padding: 32, lineHeight: 20 },
});
