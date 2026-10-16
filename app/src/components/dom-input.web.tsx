import { useRef } from 'react';
import { Pressable, Text } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';

// Browser-only inputs the launchpad needs (file pickers, date-time). Native
// gets stubs (dom-input.tsx): creating a collection happens on the website.

export function FilePick({ label, onFiles, accept, multiple, folder, disabled }: {
  label: string; onFiles: (files: File[]) => void; accept?: string; multiple?: boolean; folder?: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
        {...(folder ? { webkitdirectory: '', directory: '' } as Record<string, string> : {})}
        onChange={(e) => { const f = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; if (f.length) onFiles(f); }} />
      <Pressable accessibilityRole="button" disabled={disabled} onPress={() => ref.current?.click()}
        style={({ pressed }) => ({ paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, alignItems: 'center', opacity: pressed || disabled ? 0.7 : 1 })}>
        <Text style={[T.button, { color: C.text }]}>{label}</Text>
      </Pressable>
    </>
  );
}

const toLocal = (t: number) => {
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Unix seconds in, unix seconds out (0 = empty), shown in the viewer's local time. */
export function DateTime({ value, onChange, label }: { value: number; onChange: (t: number) => void; label: string }) {
  return (
    <input type="datetime-local" aria-label={label} value={toLocal(value)}
      onChange={(e) => onChange(e.currentTarget.value ? Math.floor(new Date(e.currentTarget.value).getTime() / 1000) : 0)}
      style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 10px', fontSize: 14, colorScheme: 'dark', fontFamily: 'inherit', minWidth: 0 }} />
  );
}

export const objectUrl = (f: File) => URL.createObjectURL(f);
