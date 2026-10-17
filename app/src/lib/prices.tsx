import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { api, type TickerPrice } from './api';
import { usdGlance } from './format';

// Live USD prices for the native coins (SOL, ETH, HYPE, APE, RON, MON),
// refreshed every minute, so amounts can show a dollar value next to the coin.
// Wrapped tokens count as their coin (WETH = ETH, Blur's BETH = ETH).

type Prices = { list: TickerPrice[]; toUsd: (amount: number, unit: string) => number | null };
const Ctx = createContext<Prices>({ list: [], toUsd: () => null });

const coinOf = (unit: string) => {
  const u = unit.toUpperCase();
  if (u === 'BETH') return 'ETH';
  return u.length > 3 && u.startsWith('W') ? u.slice(1) : u;
};

export function PricesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<TickerPrice[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.prices().then((p) => alive && setList(p)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const toUsd = useCallback((amount: number, unit: string) => {
    const p = list.find((x) => x.symbol === coinOf(unit))?.usd;
    return p != null && Number.isFinite(amount) ? amount * p : null;
  }, [list]);
  return <Ctx value={{ list, toUsd }}>{children}</Ctx>;
}

export const usePrices = () => use(Ctx);

// Dollar-pegged coins already read as dollars: no second figure for them.
const PEGGED = /^(USD|USDC|USDT|DAI|USDB|USDE|PYUSD)$/i;
// "$35" for 0.438 HYPE, or null when there's no price (or the coin is a dollar already).
export function useUsd() {
  const { toUsd } = usePrices();
  return useCallback((n: number | null | undefined, unit: string | null | undefined) => {
    if (n == null || !unit || PEGGED.test(unit)) return null;
    const v = toUsd(n, unit);
    return v == null ? null : usdGlance(v);
  }, [toUsd]);
}

// "0.438 HYPE · $35": a coin amount's text with its dollar figure appended
// (left as is without a price). `signed` gives "+$240" / "−$12" for P&L.
export function useWithUsd() {
  const u = useUsd();
  return useCallback((text: string, n: number | null | undefined, unit: string | null | undefined, signed = false) => {
    const d = u(n, unit);
    if (!d) return text;
    return `${text} · ${signed && !d.startsWith('−') ? `+${d}` : d}`;
  }, [u]);
}

// "+$290" / "−$12" for a P&L in a coin; null without a price.
export function useSignedUsd() {
  const u = useUsd();
  return useCallback((n: number | null | undefined, unit: string | null | undefined) => {
    const d = u(n, unit);
    return d == null ? null : d.startsWith('−') ? d : `+${d}`;
  }, [u]);
}
