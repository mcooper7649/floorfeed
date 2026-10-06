// FloorFeed is dark-only: trading UIs read better on dark, and it keeps the
// accent/P&L colors consistent across platforms.
export const C = {
  bg: '#0B0B10',
  card: '#15151C',
  cardHi: '#1E1E28',
  grid: '#23232D',
  muted: '#6E6E80', // de-emphasis marks (validated >= 3:1 on card)
  barFill: '#76A322', // single-series bars: in-band lime step (validated)
  border: '#262631',
  text: '#F4F4F6',
  dim: '#9797A6',
  accent: '#B8FF3C',
  accentInk: '#0B0B10',
  up: '#3DDC97',
  down: '#FF5C7A',
  ai: '#A78BFA',
} as const;
