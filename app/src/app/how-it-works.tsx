import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MODE_COLOR } from '@/components/mode-toggle';
import { Empty } from '@/components/screen';
import { TopNav } from '@/components/top-nav';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type Guide, type GuideBlock, type GuidePart } from '@/lib/api';
import { useLayout } from '@/lib/layout';
import { useTitle } from '@/lib/use-title';

// "How FloorFeed works". The text comes from the server (guide.ts), which also
// renders it as the indexable /how-it-works page. It's split into three parts
// (basics, paper, real), one tab each. `?part=paper|real` opens a part and
// `?s=<section id>` jumps to a section (opening its part).

// Paper and Real wear their mode colors, so the tabs match the rest of the app.
const PART_COLOR: Record<GuidePart, string> = { basics: C.text, paper: MODE_COLOR.paper, real: MODE_COLOR.real };
// Screenshots are site files; native builds load them from the live site.
const imgUri = (path: string) => (Platform.OS === 'web' ? path : `https://floorfeed.io${path}`);

export default function HowItWorks() {
  useTitle('How FloorFeed works: follow NFT traders who win');
  const { s: section, part: partParam } = useLocalSearchParams<{ s?: string; part?: string }>();
  const { pad, wide } = useLayout();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [part, setPart] = useState<GuidePart>(partParam === 'paper' || partParam === 'real' ? partParam : 'basics');
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    track('guide_open', section ? { section } : partParam ? { part: partParam } : undefined);
    api.guide().then((g) => {
      setGuide(g);
      const owner = section && g.sections.find((x) => x.id === section)?.part;
      if (owner) setPart(owner);
    }).catch((e: Error) => setError(e.message));
  }, [section, partParam]);

  const pick = (p: GuidePart) => {
    if (p === part) return;
    track('guide_part', { part: p });
    setPart(p);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const info = guide?.parts.find((p) => p.id === part);
  const sections = guide?.sections.filter((g) => g.part === part) ?? [];
  const nav = Platform.OS === 'web' && <TopNav back />;
  return (
    <View style={s.fill}>
      {nav}
      <ScrollView ref={scroll} contentContainerStyle={[s.page, { paddingHorizontal: pad }]}>
        <View style={{ gap: 6, marginBottom: 4 }}>
          <Text {...display} style={wide ? T.displayL : T.display}>How FloorFeed works</Text>
          <Text style={T.meta}>Start with the basics, practice with simulated money, then trade for real when you&apos;re ready.</Text>
        </View>

        <View style={s.tabs} accessibilityRole="tablist">
          {(guide?.parts ?? []).map((p) => {
            const on = p.id === part;
            return (
              <Pressable key={p.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => pick(p.id)}
                style={[s.tab, on && { backgroundColor: p.id === 'basics' ? C.cardHi : PART_COLOR[p.id] }]}>
                <Text style={[s.tabTxt, on && { color: p.id === 'basics' ? C.text : C.accentInk }]}>{p.title}</Text>
              </Pressable>
            );
          })}
        </View>
        {info && <Text style={[T.meta, { marginTop: -6 }]}>{info.blurb}</Text>}

        {error && <Empty text={error} />}
        {!guide && !error && <ActivityIndicator style={{ marginTop: 32 }} color={C.accent} />}
        {sections.map((g, i) => (
          <View key={g.id} style={s.section}
            onLayout={(e) => {
              if (g.id === section) scroll.current?.scrollTo({ y: e.nativeEvent.layout.y - 12, animated: false });
            }}>
            <Text style={[s.kicker, { color: part === 'basics' ? C.accent : PART_COLOR[part] }]}>{String(i + 1).padStart(2, '0')}</Text>
            <Text {...display} style={T.title}>{g.title}</Text>
            {g.blocks.map((b, j) => <Block key={j} b={b} color={part === 'basics' ? C.accent : PART_COLOR[part]} />)}
          </View>
        ))}

        {guide && part !== 'real' && (
          <Pressable accessibilityRole="button" onPress={() => pick(part === 'basics' ? 'paper' : 'real')} style={s.next}>
            <Text style={s.nextTxt}>Next: {guide.parts.find((p) => p.id === (part === 'basics' ? 'paper' : 'real'))?.title} ›</Text>
          </Pressable>
        )}
        {guide && (
          <Text style={[T.meta, { textAlign: 'center' }]}>
            Still stuck? <Text style={{ color: C.accent }} onPress={() => router.push({ pathname: '/support', params: { from: 'guide' } })}>Contact support</Text>
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function Block({ b, color }: { b: GuideBlock; color: string }) {
  if ('p' in b) return <Text style={s.p}>{b.p}</Text>;
  if ('tip' in b) {
    return (
      <View style={[s.tip, { borderLeftColor: color }]}>
        <Text style={[s.tipLabel, { color }]}>Tip</Text>
        <Text style={s.def}>{b.tip}</Text>
      </View>
    );
  }
  if ('steps' in b) {
    return (
      <View style={s.list}>
        {b.steps.map((t, i) => (
          <View key={i} style={s.step}>
            <View style={[s.stepNum, { borderColor: color }]}><Text style={[s.stepNumTxt, { color }]}>{i + 1}</Text></View>
            <Text style={[s.def, { flex: 1 }]}>{t}</Text>
          </View>
        ))}
      </View>
    );
  }
  if ('img' in b) {
    // Phone screenshots: shown at their natural (1x) width at most, centered.
    return (
      <View style={s.figure}>
        <View style={[s.shot, { maxWidth: b.w / 2, aspectRatio: b.w / b.h }]}>
          <Image source={imgUri(b.img)} accessibilityLabel={b.alt} alt={b.alt} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        </View>
        {b.caption && <Text style={s.caption}>{b.caption}</Text>}
      </View>
    );
  }
  return (
    <View style={s.list}>
      {b.list.map((item) => (
        <View key={item.term} style={s.item}>
          <Text style={s.term}>{item.term}</Text>
          <Text style={s.def}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 18 },
  tabs: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
  tabTxt: { ...T.bodyStrong, color: C.dim },
  section: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, gap: 10 },
  kicker: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  p: { ...T.body, color: C.dim },
  list: { gap: 10 },
  item: { gap: 2, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: C.border },
  term: { ...T.bodyStrong },
  def: { ...T.body, color: C.dim },
  step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  stepNum: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumTxt: { fontSize: 12, fontWeight: '700' },
  tip: { gap: 2, paddingLeft: 12, paddingVertical: 2, borderLeftWidth: 2 },
  tipLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  figure: { gap: 6, alignItems: 'center', marginVertical: 4 },
  shot: { width: '100%', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  caption: { ...T.caption, textAlign: 'center', maxWidth: 420 },
  next: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  nextTxt: { ...T.bodyStrong },
});
