import type { TextStyle } from 'react-native';

import { C } from './brand';

// FloorFeed type scale. Families are applied on web by src/global.css (Geist
// for everything, Bricolage Grotesque for text marked as display); these
// tokens set size, weight, line height and color, so every screen uses the
// same seven sizes instead of picking its own.
//
//   36 / 28  display: page titles (wide / phone) and the hero number
//   21       large values (stat tiles)
//   18       section titles
//   15       body, list titles, buttons
//   13       secondary text, meta lines
//   12       captions, fine print, small labels
//
// Weights: 400 body, 500 values and labels, 600 titles and emphasis,
// 700 display only.
const tab: TextStyle['fontVariant'] = ['tabular-nums'];

export const T = {
  displayL: { fontSize: 36, lineHeight: 40, fontWeight: '700', letterSpacing: -0.9, color: C.text },
  display: { fontSize: 28, lineHeight: 32, fontWeight: '700', letterSpacing: -0.6, color: C.text },
  hero: { fontSize: 36, lineHeight: 40, fontWeight: '700', letterSpacing: -0.6, fontVariant: tab },
  value: { fontSize: 21, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2, color: C.text, fontVariant: tab },
  title: { fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: -0.2, color: C.text },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400', color: C.text },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: C.text },
  num: { fontSize: 15, lineHeight: 22, fontWeight: '500', color: C.text, fontVariant: tab },
  meta: { fontSize: 13, lineHeight: 18, fontWeight: '400', color: C.dim },
  metaNum: { fontSize: 13, lineHeight: 18, fontWeight: '400', color: C.dim, fontVariant: tab },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: C.dim },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', color: C.muted },
  button: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
} satisfies Record<string, TextStyle>;

// Marks a Text as display type (Bricolage Grotesque on web). React Native's
// types don't include dataSet, which react-native-web renders as data-*.
export const display = { dataSet: { font: 'display' } } as object;
