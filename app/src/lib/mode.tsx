import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { useWallet } from './wallet';

// Paper vs real trading. Real needs a connected wallet; without one the app
// is always in paper mode, whatever was chosen before.
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
  const [chosen, setChosen] = useState<TradeMode>('paper');

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => v === 'real' && setChosen('real')).catch(() => {});
  }, []);

  const setMode = useCallback((m: TradeMode) => {
    setChosen(m);
    AsyncStorage.setItem(KEY, m).catch(() => {});
  }, []);

  const canReal = w.supported && !!w.address;
  return <Ctx value={{ mode: canReal ? chosen : 'paper', canReal, setMode }}>{children}</Ctx>;
}

export const useTradeMode = () => use(Ctx);
