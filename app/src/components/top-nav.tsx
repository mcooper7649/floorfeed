import { Link, router, usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { WalletButton } from '@/components/wallet-button';
import { C } from '@/constants/brand';
import { useLayout } from '@/lib/layout';

const LINKS = [
  { href: '/', label: 'Feed' },
  { href: '/markets', label: 'Markets' },
  { href: '/leaderboard', label: 'Leaders' },
  { href: '/portfolio', label: 'Portfolio' },
] as const;

// Web header. Wide windows get the full bar (brand, sections, collection
// search); narrow windows only see it on pushed pages, as a back bar.
export function TopNav({ back }: { back?: boolean }) {
  const { wide, maxWidth, pad } = useLayout();
  const path = usePathname();
  const [q, setQ] = useState('');

  const search = () => {
    const query = q.trim();
    router.push({ pathname: '/markets', params: query ? { q: query } : {} });
  };

  return (
    <View style={s.bar}>
      <View style={[s.inner, { maxWidth, paddingHorizontal: pad }]}>
        {back && !wide && (
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} hitSlop={10} style={s.back}
            accessibilityLabel="Back">
            <Text style={s.backTxt}>‹</Text>
          </Pressable>
        )}
        <Link href="/" asChild>
          <Pressable style={s.brand} accessibilityLabel="FloorFeed home">
            <View style={s.mark}><Text style={s.markTxt}>F</Text></View>
            <Text style={s.brandTxt}>FloorFeed</Text>
          </Pressable>
        </Link>

        {wide && (
          <>
            <View style={s.links}>
              {LINKS.map((l) => {
                const on = l.href === '/' ? path === '/' : path.startsWith(l.href);
                return (
                  <Link key={l.href} href={l.href} asChild>
                    {/* Link asChild spreads the child's style on web: pass a flat object */}
                    <Pressable style={StyleSheet.flatten([s.link, on && s.linkOn])}>
                      <Text style={[s.linkTxt, on && { color: C.text }]}>{l.label}</Text>
                    </Pressable>
                  </Link>
                );
              })}
            </View>
            <TextInput
              value={q}
              onChangeText={setQ}
              onSubmitEditing={search}
              placeholder="Search collections"
              placeholderTextColor={C.dim}
              style={s.search}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Search collections"
            />
            <WalletButton />
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { backgroundColor: '#0B0B10F2', borderBottomWidth: 1, borderBottomColor: C.border, zIndex: 10 },
  inner: { width: '100%', alignSelf: 'center', height: 64, flexDirection: 'row', alignItems: 'center', gap: 20 },
  back: { marginRight: -14, paddingRight: 4 },
  backTxt: { color: C.text, fontSize: 34, fontWeight: '300', lineHeight: 36 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 30, height: 30, borderRadius: 9, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  markTxt: { color: C.accentInk, fontWeight: '900', fontSize: 17 },
  brandTxt: { color: C.text, fontWeight: '800', fontSize: 19, letterSpacing: -0.3 },
  links: { flexDirection: 'row', gap: 4, flex: 1 },
  link: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  linkOn: { backgroundColor: C.cardHi },
  linkTxt: { color: C.dim, fontWeight: '700', fontSize: 15 },
  search: {
    width: 280, backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14,
  },
});
