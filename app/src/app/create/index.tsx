import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NftImage } from '@/components/nft-image';
import { TopNav } from '@/components/top-nav';
import { Button, Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { api, type LaunchConfig, type LaunchDraft } from '@/lib/api';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// The launchpad's front door: what launching on FloorFeed means, and the
// creator's own collections (drafts and live ones).

export default function CreateHome() {
  useTitle('Launch an NFT collection | FloorFeed');
  const { pad, wide } = useLayout();
  const { userId } = useSession();
  const [config, setConfig] = useState<LaunchConfig | null>(null);
  const [mine, setMine] = useState<LaunchDraft[] | null>(null);

  useFocusEffect(useCallback(() => {
    api.launchConfig().then(setConfig).catch(() => setConfig(null));
    if (userId) api.myLaunches(userId).then((r) => setMine(r.launches)).catch(() => setMine([]));
  }, [userId]));

  const web = Platform.OS === 'web';
  return (
    <View style={s.fill}>
      {web && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]}>
        <View style={{ gap: 6 }}>
          <Text {...display} style={wide ? T.displayL : T.display}>Launch a collection</Text>
          <Text style={T.meta}>Upload your art, set prices and mint phases, and launch from your own wallet. Collectors mint on FloorFeed, and it trades on OpenSea and here once it’s out.</Text>
        </View>

        <Card style={{ gap: 10 }}>
          <Step n={1} title="Your art" text="Upload a folder of images, with traits from your generator’s JSON files or a CSV." />
          <Step n={2} title="Mint phases" text="Allowlist and public phases, each with its own price, dates and per-wallet limit." />
          <Step n={3} title="Launch" text="Your wallet deploys the contract and owns it. FloorFeed never holds your keys or your mint money." />
          <Step n={4} title="Reveal and get paid" text="Reveal when you’re ready (art is shuffled fairly) and withdraw what you’ve earned any time." />
          <Text style={T.caption}>
            FloorFeed adds a small fee per NFT minted, paid by the collector. You pay only the network fee to launch.
          </Text>
        </Card>

        {!web ? (
          <Card><Text style={T.body}>Creating a collection works on the website for now: open floorfeed.io/create on a computer.</Text></Card>
        ) : !config ? (
          <ActivityIndicator color={C.accent} />
        ) : !config.enabled ? (
          <Card style={{ gap: 6 }}>
            <Text style={T.bodyStrong}>Launching opens soon</Text>
            <Text style={T.meta}>The launch contracts are being deployed. You can explore what it’ll look like below.</Text>
          </Card>
        ) : (
          <Button label="Create a collection" onPress={() => router.push({ pathname: '/create/[id]', params: { id: 'new' } })} />
        )}

        {mine && mine.length > 0 && (
          <View style={{ gap: 10 }}>
            <Text style={T.title}>Your collections</Text>
            {mine.map((l) => (
              <Pressable key={l.id} onPress={() => router.push({ pathname: '/create/[id]', params: { id: l.id } })} style={({ pressed }) => [s.row, pressed && { opacity: 0.85 }]}>
                <NftImage uri={l.coverCid && config ? `${config.gateway}${l.coverCid}` : null} name={l.name} ratio={1} radius={10} px={120} style={{ width: 52 }} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={T.bodyStrong} numberOfLines={1}>{l.name}</Text>
                  <Text style={T.meta} numberOfLines={1}>{l.items.toLocaleString()} artworks · {config?.chains.find((c) => c.id === l.chain)?.name ?? l.chain}</Text>
                </View>
                <Text style={[T.label, { color: l.status === 'live' ? C.up : C.dim }]}>{l.status === 'live' ? 'Live' : 'Draft'}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <View style={s.step}>
      <View style={s.num}><Text style={s.numTxt}>{n}</Text></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={T.bodyStrong}>{title}</Text>
        <Text style={T.meta}>{text}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingTop: 28, paddingBottom: 120, gap: 18 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: C.accent, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  numTxt: { color: C.accent, fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
});
