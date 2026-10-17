import { router } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SignInCard, securityLevel } from '@/components/account-security';
import { ProfileName } from '@/components/profile-name';
import { TopNav } from '@/components/top-nav';
import { Button, Card, ListRow, RowAction, Stat } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { useAuth } from '@/lib/auth';
import { shortAddr } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useProfile } from '@/lib/profile';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// Your own profile (signed in): account name, what you've done on FloorFeed,
// your FloorFeed wallets, and how well the account is protected.
export default function Profile() {
  useTitle('Profile | FloorFeed');
  const { pad, wide } = useLayout();
  const auth = useAuth();
  const { signedIn } = useSession();
  const { profile } = useProfile();

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]} keyboardShouldPersistTaps="handled">
        {!signedIn || !profile ? (
          <SignInCard loading={signedIn} what="your profile" />
        ) : (
          <>
            <View style={s.hero}>
              <View style={s.avatar}><Text {...display} style={s.avatarTxt}>{(profile.name ?? profile.fallback).replace(/^Member /, '')[0]?.toUpperCase()}</Text></View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text {...display} style={wide ? T.displayL : T.display} numberOfLines={1}>{profile.name ?? profile.fallback}</Text>
                <Text style={T.meta} numberOfLines={1}>
                  {auth.security?.createdAt ? `Member since ${new Date(auth.security.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : 'FloorFeed member'}
                  {auth.label ? ` · ${auth.label}` : ''}
                </Text>
              </View>
            </View>

            <Card>
              <Text style={T.bodyStrong}>Account name</Text>
              <Text style={T.meta}>Shown on your theses and the practice board. Your email is never shown.</Text>
              <ProfileName />
            </Card>

            <View style={s.stats}>
              <Stat label="Theses" value={String(profile.stats.theses)} style={s.stat} />
              <Stat label="Likes received" value={String(profile.stats.likes)} style={s.stat} />
              <Stat label="Following" value={String(profile.stats.following)} style={s.stat} />
              <Stat label="Practice trades" value={String(profile.stats.practiceTrades)} style={s.stat} />
            </View>

            {(auth.embeddedAddress || auth.evmAddress) && (
              <Card>
                <Text style={T.bodyStrong}>Your FloorFeed wallets</Text>
                {auth.embeddedAddress && (
                  <ListRow title="Solana" meta={shortAddr(auth.embeddedAddress)}
                    onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: auth.embeddedAddress! } })} />
                )}
                {auth.evmAddress && (
                  <ListRow title="Ethereum and other EVM networks" meta={shortAddr(auth.evmAddress)}
                    onPress={() => router.push({ pathname: '/wallet/[address]', params: { address: auth.evmAddress! } })} />
                )}
              </Card>
            )}

            {auth.security && (
              <Card>
                <View style={s.row}>
                  <Text style={[T.bodyStrong, { flex: 1 }]}>Security</Text>
                  <Text style={[T.label, { color: securityLevel(auth.security).tone }]}>{securityLevel(auth.security).text}</Text>
                </View>
                <Text style={T.meta}>
                  2-step verification is {auth.security.mfa.length ? 'on' : 'off'} · {auth.security.logins.length} way{auth.security.logins.length === 1 ? '' : 's'} to sign in
                </Text>
                <View style={s.row}><RowAction label="Open security settings" onPress={() => router.push({ pathname: '/settings', params: { s: 'security' } })} /></View>
              </Card>
            )}

            <Button label="Settings" tone="secondary" onPress={() => router.push('/settings')} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 16 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: C.accentInk, fontSize: 28, fontWeight: '700' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { flexGrow: 1, flexBasis: 130 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
