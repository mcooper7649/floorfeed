import { useEffect, useRef, useState } from 'react';
import type { View } from 'react-native';
import { ColorType, createChart, CrosshairMode, TickMarkType, type DeepPartial, type ChartOptions, type IChartApi, type Time } from 'lightweight-charts';

import { C } from '@/constants/brand';
import { fmtSol } from '@/lib/scale';

// Shared TradingView Lightweight Charts setup for the web charts. Only the
// *.web.tsx components import this (the native builds keep the SVG charts).
export const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

const base: DeepPartial<ChartOptions> = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: C.dim,
    fontFamily: FONT,
    fontSize: 11,
    // TradingView's license asks for attribution: the in-chart logo covers
    // data, so the charts link to TradingView in their caption instead.
    attributionLogo: false,
    panes: { separatorColor: C.border, separatorHoverColor: C.border, enableResize: false },
  },
  grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
  rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.06 } },
  timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, rightOffset: 0 },
  crosshair: {
    mode: CrosshairMode.Magnet,
    vertLine: { color: C.dim, width: 1, style: 3, labelBackgroundColor: C.cardHi },
    // No horizontal line: it reads as a second reference next to the floor.
    horzLine: { visible: false, labelBackgroundColor: C.cardHi },
  },
  // Vertical swipes scroll the page on touch screens instead of the chart.
  handleScroll: { vertTouchDrag: false },
  localization: { priceFormatter: fmtSol },
};

// Creates the chart once, on the DOM node behind a react-native-web View.
export function useLwChart(options: DeepPartial<ChartOptions> = {}) {
  const host = useRef<View>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  useEffect(() => {
    const el = host.current as unknown as HTMLElement | null;
    if (!el) return;
    const c = createChart(el, base);
    c.applyOptions(options);
    setChart(c);
    return () => { setChart(null); c.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { host, chart };
}

// Axis labels: dates at day boundaries, local hours in between. Daily
// buckets are UTC days, so they're labeled in UTC.
export const tickFormatter = (intraday: boolean) => (time: Time, type: TickMarkType) => {
  const d = new Date((time as number) * 1000);
  if (!intraday || type < TickMarkType.Time) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: intraday ? undefined : 'UTC' });
  }
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
};

export const TV_URL = 'https://www.tradingview.com/';

export const alpha = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
