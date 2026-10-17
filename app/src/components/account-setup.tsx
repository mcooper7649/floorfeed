import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { RecoveryCard, TwoStepCard } from '@/components/account-security';
import { NameField, nameLooksValid } from '@/components/profile-name';
import { Button } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { useProfile } from '@/lib/profile';

// Onboarding after sign-in: every account picks an account name first (it's
// what others see on theses and the practice board), then gets a chance to
// protect the account with 2-step verification and a backup sign-in. The name
// step can't be skipped; it comes back on the next visit until a name is saved
// (signing out is the only other way out). Security can be skipped, and lives
// in Settings afterwards.
export function AccountSetup() {
  const auth = useAuth();
  const { profile, loaded, setName } = useProfile();
  const [step, setStep] = useState<'name' | 'secure' | 'done'>('name');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Privy draws its own modals; ours steps aside while one is open.
  const [away, setAway] = useState(false);

  const needsName = loaded && !!profile && !profile.name;
  const visible = !away && (step === 'secure' || (needsName && step === 'name'));
  if (!auth.userId || (!needsName && step !== 'secure')) return null;

  const save = async () => {
    if (!nameLooksValid(value) || busy) return;
    setBusy(true); setError(null);
    try {
      await setName(value);
      track('onboard_name');
      setStep(auth.security ? 'secure' : 'done');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finish = (how: 'skip' | 'done') => { track('onboard_secure', { how }); setStep('done'); };
  // Opening a Privy flow from the security step ends onboarding: their screen takes over.
  const handOff = () => { setAway(true); setStep('done'); };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => step === 'secure' && finish('skip')}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <ScrollView contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={s.steps}>Step {step === 'name' ? 1 : 2} of 2</Text>
            {step === 'name' ? (
              <>
                <Text {...display} style={T.title}>Choose your account name</Text>
                <Text style={T.meta}>
                  This is how you show up on FloorFeed: on your theses, the practice board and your profile. Your email stays private.
                </Text>
                <NameField value={value} onChange={setValue} onSubmit={save} autoFocus />
                {error && <Text style={[T.caption, { color: C.down }]}>{error}</Text>}
                <Button label={busy ? 'Saving…' : 'Continue'} onPress={save} disabled={busy || !nameLooksValid(value)} />
                <Pressable onPress={() => auth.logout()} hitSlop={8} style={{ alignSelf: 'center' }}>
                  <Text style={T.caption}>Not you? <Text style={{ color: C.accent }}>Sign out</Text></Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text {...display} style={T.title}>Protect your account</Text>
                <Text style={T.meta}>
                  Your account holds your FloorFeed wallets. Two minutes now means nobody gets in with just your email, and you can always get back in.
                </Text>
                <TwoStepCard onBeforeOpen={handOff} />
                <RecoveryCard onBeforeOpen={handOff} />
                <Text style={T.caption}>You can do this any time in Settings → Security.</Text>
                <Button label="Skip for now" tone="secondary" onPress={() => finish('skip')} />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '90%', backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 20 },
  steps: { ...T.caption, color: C.accent, fontWeight: '700' },
});
