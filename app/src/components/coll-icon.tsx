import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { C } from '@/constants/brand';

// Collection avatar with an initial underneath: some NFT hosts refuse
// cross-origin embedding on web, and the letter shows through when they do.
export function CollIcon({ name, uri, size = 40, radius = 10 }: { name: string; uri: string | null; size?: number; radius?: number }) {
  return (
    <View style={[s.box, { width: size, height: size, borderRadius: radius }]}>
      <Text style={[s.letter, { fontSize: size * 0.42 }]}>{name.charAt(0)}</Text>
      {uri ? <Image source={uri} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { color: C.dim, fontWeight: '800' },
});
