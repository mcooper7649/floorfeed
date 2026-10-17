import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { RecoveryCard, SignInCard, TwoStepCard, WalletBackupCard, securityLevel } from '@/components/account-security';
import { ModeToggle } from '@/components/mode-toggle';
import { ProfileName } from '@/components/profile-name';
import { PushCard } from '@/components/push-card';
import { TopNav } from '@/components/top-nav';
import { Button, Card, ListRow } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { useAuth } from '@/lib/auth';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

type Section = 'account' | 'security' | 'trading' | 'notifications' | 'help';

// Settings: account, security (2-step, sign-in methods for recovery, wallet
// key backup), trading mode, notifications and help. `?s=<section>` scrolls
// to a section (Profile links to ?s=security).
export default function Settings() {
  useTitle('Settings | FloorFeed');
  const { s: jump } = useLocalSearchParams<{ s?: Section }>();
  const { pad, wide } = useLayout();
  const auth = useAuth();
  const { signedIn } = useSession();
  const scroll = useRef<ScrollView>(null);
  const jumped = useRef(false);
  const [introReset, setIntroReset] = useState(false);

  // Scroll to ?s= once that section has been laid out.
  const placed = (id: Section, y: number) => {
    if (jump !== id || jumped.current) return;
    jumped.current = true;
    scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: false });
  };

  const showIntro = () => {
    AsyncStorage.removeItem('floorfeed.welcomed').catch(() => {});
    setIntroReset(true);
  };

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      <ScrollView ref={scroll} contentContainerStyle={[s.page, { paddingHorizontal: pad }]} keyboardShouldPersistTaps="handled">
        <Text {...display} style={wide ? T.displayL : T.display}>Settings</Text>

        <View style={s.section} onLayout={(e) => placed('account', e.nativeEvent.layout.y)}>
          <Text style={s.h}>Account</Text>
          {signedIn ? (
            <Card>
              <ProfileName />
              {auth.label && <Text style={T.meta}>Signed in as {auth.label}</Text>}
              <View style={s.row}>
                <Button label="View profile" tone="secondary" onPress={() => router.push('/profile')} />
                <Button label="Sign out" tone="secondary" onPress={() => { auth.logout().then(() => router.replace('/')); }} />
              </View>
            </Card>
          ) : (
            <SignInCard loading={!!auth.userId} what="your account settings" />
          )}
        </View>

        {signedIn && auth.security && (
          <View style={s.section} onLayout={(e) => placed('security', e.nativeEvent.layout.y)}>
            <View style={s.row}>
              <Text style={[s.h, { flex: 1 }]}>Security</Text>
              <Text style={[T.label, { color: securityLevel(auth.security).tone }]}>{securityLevel(auth.security).text}</Text>
            </View>
            <TwoStepCard />
            <RecoveryCard />
            <WalletBackupCard />
          </View>
        )}

        <View style={s.section} onLayout={(e) => placed('trading', e.nativeEvent.layout.y)}>
          <Text style={s.h}>Trading</Text>
          <Card>
            <Text style={T.bodyStrong}>Default mode</Text>
            <ModeToggle />
          </Card>
        </View>

        <View style={s.section} onLayout={(e) => placed('notifications', e.nativeEvent.layout.y)}>
          <Text style={s.h}>Notifications</Text>
          <PushCard />
          <Card style={{ padding: 0, gap: 0 }}>
            <ListRow title="Alerts inbox" meta="Trades from wallets you follow" onPress={() => router.push('/alerts')} />
          </Card>
        </View>

        <View style={s.section} onLayout={(e) => placed('help', e.nativeEvent.layout.y)}>
          <Text style={s.h}>Help</Text>
          <Card style={{ padding: 0, gap: 0 }}>
            <ListRow title="How FloorFeed works" onPress={() => router.push('/how-it-works')} />
            <ListRow title="Contact support" meta="Report a problem or send an idea" onPress={() => router.push({ pathname: '/support', params: { from: 'settings' } })} />
            <ListRow title={introReset ? 'The intro will show on the feed' : 'Show the welcome intro again'} onPress={showIntro} />
          </Card>
          <Text style={T.caption}>
            FloorFeed never holds your funds and will never ask for your seed phrase or private key. To delete your account, contact support.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 24 },
  section: { gap: 10 },
  h: { ...T.title },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
});
