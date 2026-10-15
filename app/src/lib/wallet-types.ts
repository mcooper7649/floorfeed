// Shared shape of the wallet context, implemented per platform:
// wallet.web.tsx (browser wallets via Wallet Standard) and wallet.tsx (native,
// not wired yet). Keys never leave the user's wallet: FloorFeed only learns the
// public address and asks the wallet to sign specific transactions.
export type WalletOption = { name: string; icon: string };

export type WalletState = {
  supported: boolean; // false where no wallet integration exists yet
  available: WalletOption[]; // wallets detected in this browser
  address: string | null;
  // 'extension' = a browser wallet the user connected; 'embedded' = the Privy
  // wallet that comes with signing in (used when no extension is connected).
  kind: 'extension' | 'embedded' | null;
  walletName: string | null;
  walletIcon: string | null;
  connecting: boolean;
  error: string | null;
  connect: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  // Signs a text message with the connected extension (base64 signature), to
  // prove the address is the user's. null when the wallet can't.
  signMessage: ((message: string) => Promise<string>) | null;
  // Signs and sends a prepared transaction (unsigned, base64 wire format; built
  // and simulated by our API), resolving to its signature. Uses the connected
  // extension, else the Privy wallet. null when neither can.
  sendTransaction: ((base64: string) => Promise<string>) | null;
};

// Ethereum/Base side: a browser wallet found through EIP-6963 (MetaMask,
// Rabby, Coinbase Wallet, …) or, when none is connected, the signed-in user's
// Privy wallet. `send` asks the wallet to confirm a transaction and resolves
// to its hash.
export type EvmWalletState = {
  supported: boolean;
  available: WalletOption[];
  address: string | null;
  kind: 'extension' | 'embedded' | null;
  walletName: string | null;
  walletIcon: string | null;
  connecting: boolean;
  error: string | null;
  connect: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  send: ((tx: import('./auth-types').EvmTx) => Promise<string>) | null;
  signMessage: ((message: string) => Promise<string>) | null; // personal_sign, hex signature
};
