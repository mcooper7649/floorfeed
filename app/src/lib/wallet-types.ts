// Shared shape of the wallet context, implemented per platform:
// wallet.web.tsx (browser wallets via Wallet Standard) and wallet.tsx (native,
// not wired yet). Keys never leave the user's wallet: FloorFeed only learns the
// public address and asks the wallet to sign specific transactions.
export type WalletOption = { name: string; icon: string };

export type WalletState = {
  supported: boolean; // false where no wallet integration exists yet
  available: WalletOption[]; // wallets detected in this browser
  address: string | null;
  walletName: string | null;
  walletIcon: string | null;
  connecting: boolean;
  error: string | null;
  connect: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
};
