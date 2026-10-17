import { useCallback, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { C } from '@/constants/brand';

// A small context menu: right-click on desktop, long-press on phones. Opens at
// the pointer, kept inside the window; Esc, a click outside or another
// right-click closes it.

export type MenuItem = { label: string; onPress: () => void; danger?: boolean } | 'sep';
type Point = { x: number; y: number };
type PointerEvent = { preventDefault?: () => void; nativeEvent?: { pageX?: number; pageY?: number; clientX?: number; clientY?: number } };

const WIDTH = 210;
const ROW = 36;

export function useQuickMenu() {
  const [menu, setMenu] = useState<{ at: Point; title?: string; items: MenuItem[] } | null>(null);
  const { width, height } = useWindowDimensions();
  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((e: PointerEvent | undefined, items: MenuItem[], title?: string) => {
    e?.preventDefault?.();
    const ne = e?.nativeEvent ?? {};
    const x = ne.clientX ?? ne.pageX ?? width / 2;
    const y = ne.clientY ?? ne.pageY ?? height / 2;
    setMenu({ at: { x, y }, title, items });
  }, [width, height]);

  let node: ReactNode = null;
  if (menu) {
    const h = menu.items.reduce((a, i) => a + (i === 'sep' ? 9 : ROW), 0) + (menu.title ? 30 : 0) + 10;
    const left = Math.max(8, Math.min(menu.at.x, width - WIDTH - 8));
    const top = Math.max(8, Math.min(menu.at.y, height - h - 8));
    node = (
      <Modal visible transparent animationType="none" onRequestClose={close}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close}
          {...({ onContextMenu: (e: PointerEvent) => { e.preventDefault?.(); close(); } } as object)} />
        <View style={[s.menu, { left, top }]} accessibilityRole="menu">
          {menu.title && <Text style={s.title} numberOfLines={1}>{menu.title}</Text>}
          {menu.items.map((it, i) => it === 'sep' ? <View key={`sep${i}`} style={s.sep} /> : (
            <Pressable key={it.label} accessibilityRole="menuitem" onPress={() => { close(); it.onPress(); }}
              style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [s.item, (hovered || pressed) && s.itemOn]}>
              <Text style={[s.label, it.danger && { color: C.down }]}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    );
  }
  return { open, close, node };
}

// Props that open the menu on right-click (web) and long-press (touch).
export const menuProps = (open: (e: PointerEvent) => void) => ({
  onLongPress: open,
  ...({ onContextMenu: open } as object),
});

const s = StyleSheet.create({
  menu: {
    position: 'absolute', width: WIDTH, paddingVertical: 5, borderRadius: 10, backgroundColor: C.cardHi,
    borderWidth: 1, borderColor: C.border, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  title: { color: C.muted, fontSize: 11, fontWeight: '700', paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  item: { height: ROW, justifyContent: 'center', paddingHorizontal: 12, marginHorizontal: 4, borderRadius: 6 },
  itemOn: { backgroundColor: C.card },
  label: { color: C.text, fontSize: 14, fontWeight: '500' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 4 },
});
