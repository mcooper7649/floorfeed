import { createContext, use, type ReactNode } from 'react';

import type { AuthState } from './auth-types';

// Native builds: Privy sign-in ships on the web first (the Expo SDK needs a
// Privy client ID and a dev build); see docs/WALLET_AND_TRADING.md.
const NATIVE: AuthState = {
  supported: false,
  ready: true,
  userId: null,
  label: null,
  embeddedAddress: null,
  login: () => {},
  logout: async () => {},
};

const Ctx = createContext<AuthState>(NATIVE);

export function AuthProvider({ children }: { children: ReactNode }) {
  return <Ctx value={NATIVE}>{children}</Ctx>;
}

export const useAuth = () => use(Ctx);
