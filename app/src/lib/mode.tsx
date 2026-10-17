import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { useEvmWallet } from './evm-wallet';
import { useWallet } from './wallet';

// Practice (stored as 'paper') vs real trading. Real needs a wallet (Solana or
// Ethereum) or a sign-in; without one the app is always in practice. With one,
// Real is the default until the user picks Practice.
export type TradeMode = 'paper' | 'real';

type ModeState = {
  mode: TradeMode; // effective mode
  canReal: boolean;
  setMode: (m: TradeMode) => void;
};

const KEY = 'floorfeed.mode';
const Ctx = createContext<ModeState>({ mode: 'paper', canReal: false, setMode: () => {} });

export function TradeModeProvider({ children }: { children: ReactNode }) {
  const w = useWallet();
  const evm = useEvmWallet();
  const [chosen, setChosen] = useState<TradeMode | null>(null); // null: nothing picked yet

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => (v === 'real' || v === 'paper') && setChosen(v)).catch(() => {});
  }, []);

  const setMode = useCallback((m: TradeMode) => {
    setChosen(m);
    AsyncStorage.setItem(KEY, m).catch(() => {});
  }, []);

  const canReal = (w.supported && !!w.address) || (evm.supported && !!evm.address);
  return <Ctx value={{ mode: canReal ? chosen ?? 'real' : 'paper', canReal, setMode }}>{children}</Ctx>;
}

export const useTradeMode = () => use(Ctx);
