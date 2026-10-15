import { createContext, use, useCallback, useState, type ReactNode } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

// The desktop side panels: discovery on the left (components/discovery-panel.tsx)
// and the portfolio glance on the right (components/portfolio-panel.tsx). Shown
// on wide web windows, collapsible, and remembered per browser. Pages size
// themselves to what's left (lib/layout.ts reads `space`).
export const PANEL_WIDTH = 300;
export const PANEL_GAP = 16;          // outer margin on the panel's left and right
export const PANEL_MIN_WINDOW = 1100; // narrower windows don't get the panel
export const RIGHT_MIN_WINDOW = 1440; // the right panel needs room for both
const RAIL = 44;                      // the collapsed strip with the expand button
const KEY = 'floorfeed.panel';
const RIGHT_KEY = 'floorfeed.panel.right';

type Side = { available: boolean; open: boolean; toggle: () => void };
type Panel = Side & { space: number; right: Side };
const Ctx = createContext<Panel | null>(null);

function saved(key: string) {
  try { return window.localStorage.getItem(key) !== 'closed'; } catch { return true; }
}
function useSide(key: string, available: boolean): Side {
  const [open, setOpen] = useState(() => Platform.OS === 'web' && saved(key));
  const toggle = useCallback(() => setOpen((o) => {
    try { window.localStorage.setItem(key, o ? 'closed' : 'open'); } catch { /* private mode */ }
    return !o;
  }), [key]);
  return { available, open, toggle };
}
const sideSpace = (s: Side) => (!s.available ? 0 : s.open ? PANEL_WIDTH + PANEL_GAP : RAIL);

export function PanelProvider({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const left = useSide(KEY, Platform.OS === 'web' && width >= PANEL_MIN_WINDOW);
  const right = useSide(RIGHT_KEY, Platform.OS === 'web' && width >= RIGHT_MIN_WINDOW);
  return <Ctx value={{ ...left, right, space: sideSpace(left) + sideSpace(right) }}>{children}</Ctx>;
}

const OFF: Side = { available: false, open: false, toggle: () => {} };
export const usePanel = (): Panel => use(Ctx) ?? { ...OFF, space: 0, right: OFF };
