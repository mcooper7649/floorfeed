import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { api, type TickerPrice } from './api';

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
