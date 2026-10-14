import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';

// A tab left open keeps running the bundle it loaded. Every few minutes (and
// whenever the tab comes back into view) check which bundle the site serves
// now; if it changed, offer a refresh. Never reloads on its own: the user may
// be in the middle of a buy or a bridge.

const ENTRY_RE = /\/_expo\/static\/js\/web\/(entry-[0-9a-f]+\.js)/;
const CHECK_MS = 5 * 60_000;

function loadedEntry() {
  for (const s of Array.from(document.scripts)) {
    const m = s.src.match(ENTRY_RE);
    if (m) return m[1];
  }
  return null;
}

export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const mine = loadedEntry();
    if (!mine) return; // dev server: no hashed bundle to compare
    let last = 0;
    const check = async () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      try {
        const html = await (await fetch(`/?v=${Date.now()}`, { cache: 'no-store' })).text();
        const m = html.match(ENTRY_RE);
        if (m && m[1] !== mine) setLatest(m[1]);
      } catch { /* offline: try again later */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const t = setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!latest || dismissed === latest) return null;
  return (
    <View style={s.wrap} pointerEvents="box-none">
      <View style={s.pill} accessibilityRole="alert">
        <Text style={s.txt}>A new version of FloorFeed is available.</Text>
        <Pressable accessibilityRole="button" onPress={() => window.location.reload()} style={s.btn}>
          <Text style={s.btnTxt}>Refresh</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => setDismissed(latest)} hitSlop={8}>
          <Text style={s.x}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // Fixed above the price ticker on wide web, above the tab bar on phones.
  wrap: { position: 'fixed' as 'absolute', left: 0, right: 0, bottom: 56, alignItems: 'center', zIndex: 10000, paddingHorizontal: 16 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.cardHi, borderColor: C.border, borderWidth: 1, borderRadius: 999, paddingLeft: 16, paddingRight: 12, paddingVertical: 8, maxWidth: 520, boxShadow: '0 8px 24px rgba(0,0,0,.45)' },
  txt: { ...T.meta, color: C.text, flexShrink: 1 },
  btn: { backgroundColor: C.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  btnTxt: { ...T.button, color: C.accentInk, fontSize: 13 },
  x: { ...T.meta, paddingHorizontal: 4 },
});
