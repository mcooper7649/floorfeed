import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, RowAction } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { track } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import type { Login, LoginKind, MfaMethod } from '@/lib/auth-types';
import { shortAddr } from '@/lib/format';

const MFA_NAME: Record<MfaMethod, string> = { totp: 'Authenticator app', sms: 'Text message', passkey: 'Passkey' };
const KIND_NAME: Record<LoginKind, string> = { email: 'Email', google: 'Google', passkey: 'Passkey' };

// How protected the account is, in one line: 2-step on, and at least two
// ways in (so losing one inbox or Google account doesn't lose the wallet).
export function securityLevel(sec: { mfa: MfaMethod[]; logins: Login[] }) {
  const backups = sec.logins.length >= 2;
  const twoStep = sec.mfa.length > 0;
  if (twoStep && backups) return { tone: C.up, text: 'Well protected' } as const;
  if (twoStep || backups) return { tone: C.accent, text: 'Partly protected' } as const;
  return { tone: C.down, text: 'Add protection' } as const;
}

// 2-step verification: Privy asks for a code (or passkey) on sign-in on a new
// device and before your FloorFeed wallet signs. The methods on offer are the
// ones switched on in Privy's dashboard.
export function TwoStepCard({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { security: sec } = useAuth();
  if (!sec) return null;
  const on = sec.mfa.length > 0;
  const open = () => { onBeforeOpen?.(); track('mfa_open', { on }); sec.manageMfa(); };
  return (
    <Card>
      <View style={s.head}>
        <Text style={[T.bodyStrong, { flex: 1 }]}>2-step verification</Text>
        <Text style={[s.badge, on ? s.badgeOn : s.badgeOff]}>{on ? 'On' : 'Off'}</Text>
      </View>
      {on ? (
        <Text style={T.meta}>Using {sec.mfa.map((m) => MFA_NAME[m]).join(' and ')}. You’ll be asked for it before your FloorFeed wallet signs anything.</Text>
      ) : (
        <Text style={T.meta}>Add a second step, like a code from an authenticator app, so someone with your email alone can’t move your funds.</Text>
      )}
      {sec.mfaAvailable.length > 0 ? (
        <Button label={on ? 'Manage 2-step verification' : 'Set up 2-step verification'} tone={on ? 'secondary' : 'primary'} onPress={open} />
      ) : (
        <Text style={T.caption}>2-step verification isn’t switched on for FloorFeed yet. It’s coming soon.</Text>
      )}
    </Card>
  );
}

// Account recovery: the ways you can sign in. Each one is a way back in if you
// lose another, and your FloorFeed wallets come with the account.
export function RecoveryCard({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { security: sec } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!sec) return null;

  const has = (k: LoginKind) => sec.logins.some((l) => l.kind === k);
  // Privy keeps one email and one Google account per user; passkeys can be several.
  const canAdd: LoginKind[] = [
    ...(!has('email') ? ['email' as const] : []),
    ...(!has('google') ? ['google' as const] : []),
    ...(sec.passkeyLogin ? ['passkey' as const] : []),
  ];
  const add = (k: LoginKind) => { onBeforeOpen?.(); track('recovery_add', { kind: k }); sec.link(k); };
  const remove = async (l: Login) => {
    if (confirm !== l.id) { setConfirm(l.id); return; }
    setBusy(l.id); setError(null); setConfirm(null);
    try { await sec.unlink(l); track('recovery_remove', { kind: l.kind }); }
    catch (e) { setError((e as Error).message || 'Couldn’t remove that. Try again.'); }
    finally { setBusy(null); }
  };
  const only = sec.logins.length <= 1;

  return (
    <Card>
      <Text style={T.bodyStrong}>Sign-in and recovery</Text>
      <Text style={T.meta}>
        {only
          ? 'You have one way to sign in. Add a backup so a lost inbox or Google account never locks you out of your wallet.'
          : `You can sign in ${sec.logins.length} ways. Any one of them gets you back into your account and wallets.`}
      </Text>
      <View style={{ gap: 8 }}>
        {sec.logins.map((l) => (
          <View key={l.id} style={s.login}>
            <View style={s.kind}><Text style={s.kindTxt}>{KIND_NAME[l.kind][0]}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={T.bodyStrong} numberOfLines={1}>{l.kind === 'passkey' ? l.label : KIND_NAME[l.kind]}</Text>
              <Text style={T.caption} numberOfLines={1}>
                {l.kind === 'passkey' ? 'Face ID, fingerprint or security key' : l.label}
                {l.addedAt ? ` · added ${new Date(l.addedAt).toLocaleDateString()}` : ''}
              </Text>
            </View>
            {!only && (
              busy === l.id
                ? <Text style={T.caption}>Removing…</Text>
                : <Pressable onPress={() => remove(l)} hitSlop={8}>
                    <Text style={[T.caption, { color: confirm === l.id ? C.down : C.dim, fontWeight: '600' }]}>{confirm === l.id ? 'Tap again to remove' : 'Remove'}</Text>
                  </Pressable>
            )}
          </View>
        ))}
      </View>
      {canAdd.length > 0 && (
        <View style={s.adds}>
          {canAdd.map((k) => <RowAction key={k} label={`+ ${k === 'passkey' ? 'Add a passkey' : `Add ${KIND_NAME[k]}`}`} onPress={() => add(k)} />)}
        </View>
      )}
      {error && <Text style={[T.caption, { color: C.down }]}>{error}</Text>}
    </Card>
  );
}

// Your own copy of the wallet keys: the last-resort backup, independent of FloorFeed and Privy.
export function WalletBackupCard({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const auth = useAuth();
  if (!auth.exportSolana && !auth.exportEvm) return null;
  const run = (fn: () => Promise<void>, chain: string) => { onBeforeOpen?.(); track('wallet_export', { chain }); fn().catch(() => {}); };
  return (
    <Card>
      <Text style={T.bodyStrong}>Back up your wallet keys</Text>
      <Text style={T.meta}>
        Export a private key to import into Phantom or MetaMask. Privy shows it to you directly; FloorFeed never sees it. Anyone with the key controls the wallet, so never share it or paste it into a website.
      </Text>
      <View style={s.adds}>
        {auth.exportSolana && auth.embeddedAddress && <RowAction label={`Solana key (${shortAddr(auth.embeddedAddress)})`} onPress={() => run(auth.exportSolana!, 'solana')} />}
        {auth.exportEvm && auth.evmAddress && <RowAction label={`Ethereum key (${shortAddr(auth.evmAddress)})`} onPress={() => run(auth.exportEvm!, 'ethereum')} />}
      </View>
    </Card>
  );
}

// Profile and Settings when nobody is signed in (or the account is still loading).
export function SignInCard({ loading, what }: { loading?: boolean; what: string }) {
  const auth = useAuth();
  return (
    <Card>
      <Text style={T.title}>{loading ? 'Loading your account…' : `Sign in to see ${what}`}</Text>
      {!loading && (
        <>
          <Text style={T.meta}>Pick an account name, keep your follows and practice trades on every device, and get a free FloorFeed wallet.</Text>
          {auth.supported && <Button label={auth.ready ? 'Sign in' : 'Loading…'} disabled={!auth.ready} onPress={auth.login} />}
        </>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { ...T.caption, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  badgeOn: { color: C.accentInk, backgroundColor: C.up },
  badgeOff: { color: C.text, backgroundColor: C.cardHi },
  login: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  kind: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  kindTxt: { color: C.text, fontWeight: '700', fontSize: 13 },
  adds: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
