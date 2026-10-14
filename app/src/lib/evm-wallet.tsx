import type { ReactNode } from 'react';

import type { EvmWalletState } from './wallet-types';

// Native: no Ethereum wallet integration yet (the website has it).
const OFF: EvmWalletState = {
  supported: false, available: [], address: null, kind: null, walletName: null, walletIcon: null,
  connecting: false, error: null, connect: async () => {}, disconnect: async () => {}, send: null, signMessage: null,
};

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  return children;
}

export const useEvmWallet = () => OFF;
