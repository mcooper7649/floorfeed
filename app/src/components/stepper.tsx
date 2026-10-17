import { StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';

// A multi-step flow (approve, then sign...) drawn as one tracker: done ✓,
// the current step ringed, the rest dimmed. Shown with a line saying which
// steps are only setup, so they don't read as separate purchases.
export function Stepper({ steps, current, busy, note }: {
  steps: { title: string; sub: string }[];
  current: number; // index of the step the user is on; steps.length = all done
  busy: boolean;   // the current step is waiting on the wallet or the chain
  note?: string;
}) {
  return (
    <View style={{ gap: 8 }}>
      {note && <Text style={T.meta}>{note}</Text>}
      <View style={s.stepper}>
        {steps.map((st, i) => {
          const done = i < current, now = i === current;
          return (
            <View key={st.title} style={s.stepCol}>
              <View style={[s.stepBar, (done || now) && { backgroundColor: C.accent }, now && busy && { opacity: 0.6 }]} />
              <View style={s.stepHead}>
                <View style={[s.dot, done && s.dotDone, now && s.dotNow]}>
                  <Text style={[s.dotTxt, done && { color: C.accentInk }, now && { color: C.accent }]}>{done ? '✓' : i + 1}</Text>
                </View>
                <Text style={[s.stepTitle, !done && !now && { color: C.muted }]} numberOfLines={1}>{st.title}</Text>
              </View>
              <Text style={s.stepSub} numberOfLines={2}>{now && busy ? 'In progress…' : st.sub}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// "Step 2 of 3 · " for a button label.
export const stepLabel = (i: number, n: number) => `Step ${i + 1} of ${n} · `;

const s = StyleSheet.create({
  stepper: { flexDirection: 'row', gap: 8 },
  stepCol: { flex: 1, gap: 6 },
  stepBar: { height: 4, borderRadius: 2, backgroundColor: C.border },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  dotDone: { backgroundColor: C.accent, borderColor: C.accent },
  dotNow: { borderColor: C.accent, borderWidth: 2 },
  dotTxt: { ...T.caption, color: C.muted, fontWeight: '700' },
  stepTitle: { ...T.label, color: C.text, flexShrink: 1 },
  stepSub: { ...T.caption, color: C.muted },
});
