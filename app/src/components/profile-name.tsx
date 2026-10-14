import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

// Your display name on FloorFeed (signed-in accounts): shown on your theses
// instead of "Member ab12" or your wallet address.
export function ProfileName({ compact, onSaved }: { compact?: boolean; onSaved?: (name: string) => void }) {
  const { signedIn } = useSession();
  const [current, setCurrent] = useState<{ name: string | null; fallback: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    api.profile().then(setCurrent).catch(() => {});
  }, [signedIn]);
  if (!signedIn || !current) return null;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.setProfileName(value);
      setCurrent({ ...current, name: r.name });
      setEditing(false);
      onSaved?.(r.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <View style={s.row}>
        <Text style={[compact ? T.caption : T.meta, { flexShrink: 1 }]} numberOfLines={1}>
          {compact ? 'Posting as ' : 'Display name: '}<Text style={{ color: C.text, fontWeight: '600' }}>{current.name ?? current.fallback}</Text>
        </Text>
        <Pressable onPress={() => { setValue(current.name ?? ''); setEditing(true); }} hitSlop={8}>
          <Text style={s.link}>{current.name ? 'Change' : 'Pick a name'}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <View style={s.row}>
        <TextInput value={value} onChangeText={setValue} autoFocus autoCapitalize="none" autoCorrect={false} maxLength={20}
          placeholder="3–20 letters, numbers, . _ -" placeholderTextColor={C.muted} style={s.input} onSubmitEditing={save} />
        <Pressable onPress={save} disabled={busy} style={s.save}><Text style={s.saveTxt}>{busy ? '…' : 'Save'}</Text></Pressable>
        <Pressable onPress={() => setEditing(false)} hitSlop={8}><Text style={s.cancel}>Cancel</Text></Pressable>
      </View>
      {error && <Text style={[T.caption, { color: C.down }]}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  link: { ...T.caption, color: C.accent, fontWeight: '600' },
  input: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, color: C.text, fontSize: 14, paddingHorizontal: 10, paddingVertical: 7 },
  save: { backgroundColor: C.accent, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 },
  saveTxt: { color: C.accentInk, fontWeight: '600', fontSize: 13 },
  cancel: { ...T.caption, color: C.dim },
});
