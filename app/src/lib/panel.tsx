import { createContext, use, useCallback, useState, type ReactNode } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

// The desktop discovery panel (components/discovery-panel.tsx): shown on wide
// web windows, collapsible, and remembered per browser. Pages size themselves
// to what's left (lib/layout.ts reads `panelSpace`).
export const PANEL_WIDTH = 300;
export const PANEL_GAP = 16;          // outer margin on the panel's left and right
export const PANEL_MIN_WINDOW = 1100; // narrower windows don't get the panel
const RAIL = 44;                      // the collapsed strip with the expand button
const KEY = 'floorfeed.panel';

type Panel = { available: boolean; open: boolean; toggle: () => void; space: number };
const Ctx = createContext<Panel | null>(null);

function saved() {
  try { return window.localStorage.getItem(KEY) !== 'closed'; } catch { return true; }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const available = Platform.OS === 'web' && width >= PANEL_MIN_WINDOW;
  const [open, setOpen] = useState(() => Platform.OS === 'web' && saved());
  const toggle = useCallback(() => setOpen((o) => {
    try { window.localStorage.setItem(KEY, o ? 'closed' : 'open'); } catch { /* private mode */ }
    return !o;
  }), []);
  const space = !available ? 0 : open ? PANEL_WIDTH + PANEL_GAP : RAIL;
  return <Ctx value={{ available, open, toggle, space }}>{children}</Ctx>;
}

export const usePanel = () => use(Ctx) ?? { available: false, open: false, toggle: () => {}, space: 0 };
