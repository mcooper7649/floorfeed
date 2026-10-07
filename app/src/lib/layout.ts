import { useWindowDimensions } from 'react-native';

import { MaxContentWidth, WideContentWidth } from '@/constants/theme';

// One breakpoint: below it the app is the phone layout (also on narrow web
// windows); above it screens switch to multi-column desktop layouts.
export const WIDE_MIN = 960;

export function useLayout() {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  const pad = wide ? 32 : 16;
  const contentWidth = Math.min(width, wide ? WideContentWidth : MaxContentWidth) - pad * 2;
  return { wide, width, pad, contentWidth, maxWidth: wide ? WideContentWidth : MaxContentWidth };
}

// Columns for a grid of cards at least `min` px wide.
export const columnsFor = (contentWidth: number, min: number, gap: number, max = 6) =>
  Math.max(1, Math.min(max, Math.floor((contentWidth + gap) / (min + gap))));
