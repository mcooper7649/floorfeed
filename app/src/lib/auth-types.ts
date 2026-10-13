// Shared shape of the sign-in context, implemented per platform: auth.web.tsx
// (Privy: email/Google login with an embedded Solana wallet) and auth.tsx
// (native, not wired yet). Signing in is optional; anonymous use keeps working.
export type AuthState = {
  supported: boolean;
  ready: boolean;
  userId: string | null; // Privy user id ("did:privy:…") once signed in
  label: string | null; // email or Google address, for display
  embeddedAddress: string | null; // the user's Privy Solana wallet
  login: () => void;
  logout: () => Promise<void>;
  // Opens Privy's funding flow (card / Apple Pay via MoonPay or Coinbase,
  // an exchange transfer, or another wallet) for any Solana address. Null
  // until signed in: Privy only funds for authenticated users.
  fund: ((address: string, amountSol?: string) => Promise<void>) | null;
  // Ethereum: the user's Privy wallet on Ethereum/Base, a way to send a
  // transaction from it (Privy shows it and asks to confirm; resolves to the
  // tx hash), and the same card/exchange funding flow for ETH.
  evmAddress: string | null;
  sendEvm: ((tx: EvmTx) => Promise<string>) | null;
  fundEth: ((address: string, amountEth?: string, chainId?: number) => Promise<void>) | null;
};

export type EvmTx = { to: string; data: string; value: string; chainId: number; gas?: string };

// What the separately built Privy bundle (privy/entry.tsx) reports back.
export type PrivyState = Omit<AuthState, 'supported'> & {
  getAccessToken: () => Promise<string | null>;
};

export type PrivyMountOptions = {
  appId: string;
  theme: `#${string}`;
  accent: `#${string}`;
  onState: (s: PrivyState) => void;
};
