import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api } from '@/lib/api';
import { useProfile } from '@/lib/profile';

const NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;

// Account name input with a live "is it free?" check (server: /profile/name-check).
// Used by onboarding (account-setup.tsx), Profile, and the inline editor below.
export function NameField({ value, onChange, onSubmit, current, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  current?: string | null; // the name they have now (always "available" to them)
  autoFocus?: boolean;
}) {
  const [check, setCheck] = useState<{ name: string; ok: boolean; error?: string } | null>(null);
  const name = value.trim();
  useEffect(() => {
    if (!NAME_RE.test(name) || name.toLowerCase() === current?.toLowerCase()) return;
    let alive = true;
    const t = setTimeout(() => {
      api.checkProfileName(name).then((r) => alive && setCheck({ name, ...r })).catch(() => {});
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [name, current]);

  const hint = !name
    ? null
    : !NAME_RE.test(name)
      ? { ok: false, text: name.length < 3 ? 'At least 3 characters.' : 'Letters, numbers, dots, dashes and underscores only.' }
      : name.toLowerCase() === current?.toLowerCase()
        ? null
        : check?.name === name
          ? { ok: check.ok, text: check.ok ? `${name} is available` : check.error ?? 'Not available' }
          : { ok: true, text: 'Checking…', pending: true };

  return (
    <View style={{ gap: 6 }}>
      <TextInput value={value} onChangeText={onChange} autoFocus={autoFocus} autoCapitalize="none" autoCorrect={false} maxLength={20}
        placeholder="your_name" placeholderTextColor={C.muted} style={s.input} onSubmitEditing={onSubmit}
        accessibilityLabel="Account name" />
      {hint
        ? <Text style={[T.caption, { color: 'pending' in hint ? C.dim : hint.ok ? C.up : C.down }]}>{hint.text}</Text>
        : <Text style={T.caption}>3–20 letters, numbers, dots, dashes or underscores. You can change it later.</Text>}
    </View>
  );
}

// True when NameField's value can be saved (valid shape; the server has the final say).
export const nameLooksValid = (v: string) => NAME_RE.test(v.trim());

// Your account name on FloorFeed (signed-in accounts): shown on your theses
// and the practice board instead of "Member ab12" or your wallet address.
export function ProfileName({ compact, onSaved }: { compact?: boolean; onSaved?: (name: string) => void }) {
  const { profile, setName } = useProfile();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!profile) return null;

  const save = async () => {
    if (!nameLooksValid(value)) return;
    setBusy(true); setError(null);
    try {
      const name = await setName(value);
      setEditing(false);
      onSaved?.(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <View style={s.row}>
        <Pressable style={{ flexShrink: 1 }} onPress={compact ? undefined : () => router.push('/profile')} disabled={compact}>
          <Text style={[compact ? T.caption : T.meta, { flexShrink: 1 }]} numberOfLines={1}>
            {compact ? 'Posting as ' : 'Account name: '}<Text style={{ color: C.text, fontWeight: '600' }}>{profile.name ?? profile.fallback}</Text>
          </Text>
        </Pressable>
        <Pressable onPress={() => { setValue(profile.name ?? ''); setEditing(true); }} hitSlop={8}>
          <Text style={s.link}>{profile.name ? 'Change' : 'Pick a name'}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <NameField value={value} onChange={setValue} onSubmit={save} current={profile.name} autoFocus />
      <View style={s.row}>
        <Pressable onPress={save} disabled={busy || !nameLooksValid(value)} style={[s.save, !nameLooksValid(value) && { opacity: 0.5 }]}>
          <Text style={s.saveTxt}>{busy ? '…' : 'Save'}</Text>
        </Pressable>
        <Pressable onPress={() => { setEditing(false); setError(null); }} hitSlop={8}><Text style={s.cancel}>Cancel</Text></Pressable>
      </View>
      {error && <Text style={[T.caption, { color: C.down }]}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  link: { ...T.caption, color: C.accent, fontWeight: '600' },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 10 },
  save: { backgroundColor: C.accent, borderRadius: 9, paddingHorizontal: 14, paddingVertical: 8 },
  saveTxt: { color: C.accentInk, fontWeight: '600', fontSize: 13 },
  cancel: { ...T.caption, color: C.dim },
});
