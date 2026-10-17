import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SuggestedFollows } from '@/components/suggested-follows';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { useLayout } from '@/lib/layout';

const KEY = 'floorfeed.welcomed';

const STEPS = [
  { n: '1', title: 'Watch', text: 'Every buy, flip and sweep from wallets we can score on real results.' },
  { n: '2', title: 'Follow', text: 'Follow the traders who keep winning and get an alert when they move.' },
  { n: '3', title: 'Buy', text: 'Tap Buy floor to practice first with simulated money, or make an offer. Go real when you trust it.' },
];

// First-visit intro at the top of the feed: what FloorFeed is, the three-step
// loop, and a few proven traders to follow right away. Dismissed for good.
export function WelcomeCard() {
  const { wide } = useLayout();
  const [show, setShow] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v) return;
      setShow(true);
      track('welcome_shown');
    }).catch(() => {});
  }, []);
  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    track('welcome_dismiss');
    AsyncStorage.setItem(KEY, '1').catch(() => {});
  };

  return (
    <View style={s.card}>
      <View style={s.head}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text {...display} style={T.title}>Follow the NFT traders who actually win</Text>
          <Text style={T.meta}>FloorFeed tracks who bought what, how it played out, and which wallets keep getting it right.</Text>
        </View>
        <Pressable onPress={dismiss} hitSlop={10} accessibilityLabel="Dismiss introduction">
          <Text style={s.close}>✕</Text>
        </Pressable>
      </View>

      <View style={[s.steps, wide && { flexDirection: 'row' }]}>
        {STEPS.map((st) => (
          <View key={st.n} style={[s.step, wide && { flex: 1 }]}>
            <View style={s.num}><Text style={s.numTxt}>{st.n}</Text></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={T.bodyStrong}>{st.title}</Text>
              <Text style={T.meta}>{st.text}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={{ gap: 4 }}>
        <Text style={T.label}>Start with these top flippers from the last 30 days</Text>
        <SuggestedFollows count={wide ? 4 : 3} from="welcome" />
      </View>

      <View style={s.actions}>
        <Pressable onPress={() => { track('welcome_cta', { to: 'guide' }); router.push('/how-it-works'); }} style={s.primary}>
          <Text style={s.primaryTxt}>How FloorFeed works</Text>
        </Pressable>
        <Pressable onPress={dismiss} style={s.secondary}><Text style={s.secondaryTxt}>Got it</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, gap: 16, marginBottom: 16 },
  head: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  close: { color: C.dim, fontSize: 16, padding: 2 },
  steps: { gap: 12 },
  step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  numTxt: { color: C.accentInk, fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  primaryTxt: { color: C.accentInk, fontSize: 15, fontWeight: '600' },
  secondary: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, paddingHorizontal: 16, paddingVertical: 10 },
  secondaryTxt: { color: C.text, fontSize: 15, fontWeight: '600' },
});
