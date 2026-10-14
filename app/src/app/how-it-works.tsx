import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type GuideSection } from '@/lib/api';
import { useLayout } from '@/lib/layout';
import { useTitle } from '@/lib/use-title';

// "How FloorFeed works". The text comes from the server (guide.ts), which also
// renders it as the indexable /how-it-works page. `?s=<section id>` jumps to a section.
export default function HowItWorks() {
  useTitle('How FloorFeed works: follow NFT traders who win');
  const { s: section } = useLocalSearchParams<{ s?: string }>();
  const { pad, wide } = useLayout();
  const [guide, setGuide] = useState<GuideSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});

  useEffect(() => {
    track('guide_open', section ? { section } : undefined);
    api.guide().then(setGuide).catch((e: Error) => setError(e.message));
  }, [section]);

  const nav = Platform.OS === 'web' && <TopNav back />;
  return (
    <View style={s.fill}>
      {nav}
      <ScrollView ref={scroll} contentContainerStyle={[s.page, { paddingHorizontal: pad }]}>
        <View style={{ gap: 6, marginBottom: 8 }}>
          <Text {...display} style={wide ? T.displayL : T.display}>How FloorFeed works</Text>
          <Text style={T.meta}>The feed, the badges, profit after fees, alerts, and trading on paper or for real.</Text>
        </View>
        {error && <Empty text={error} />}
        {!guide && !error && <ActivityIndicator style={{ marginTop: 32 }} color={C.accent} />}
        {guide?.map((g, i) => (
          <View key={g.id} style={s.section}
            onLayout={(e) => {
              offsets.current[g.id] = e.nativeEvent.layout.y;
              if (g.id === section) scroll.current?.scrollTo({ y: e.nativeEvent.layout.y - 12, animated: false });
            }}>
            <Text style={s.kicker}>{String(i + 1).padStart(2, '0')}</Text>
            <Text {...display} style={T.title}>{g.title}</Text>
            {g.blocks.map((b, j) => 'p' in b
              ? <Text key={j} style={s.p}>{b.p}</Text>
              : (
                <View key={j} style={s.list}>
                  {b.list.map((item) => (
                    <View key={item.term} style={s.item}>
                      <Text style={s.term}>{item.term}</Text>
                      <Text style={s.def}>{item.text}</Text>
                    </View>
                  ))}
                </View>
              ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 18 },
  section: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, gap: 10 },
  kicker: { color: C.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  p: { ...T.body, color: C.dim },
  list: { gap: 10 },
  item: { gap: 2, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: C.border },
  term: { ...T.bodyStrong },
  def: { ...T.body, color: C.dim },
});
