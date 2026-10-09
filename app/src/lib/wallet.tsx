import { createContext, use, type ReactNode } from 'react';

import type { WalletState } from './wallet-types';

// Native builds: wallet connection ships on the web first. Android (Solana
// Mobile Wallet Adapter) and Privy embedded wallets follow; see
// docs/WALLET_AND_TRADING.md.
const NATIVE: WalletState = {
  supported: false,
  available: [],
  address: null,
  kind: null,
  walletName: null,
  walletIcon: null,
  connecting: false,
  error: null,
  connect: async () => {},
  disconnect: async () => {},
};

const Ctx = createContext<WalletState>(NATIVE);

export function WalletProvider({ children }: { children: ReactNode }) {
  return <Ctx value={NATIVE}>{children}</Ctx>;
}

export const useWallet = () => use(Ctx);
