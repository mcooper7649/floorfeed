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
  signTypedEvm: ((td: TypedData, description?: string) => Promise<string>) | null; // EIP-712 with the Privy EVM wallet
  fundEth: ((address: string, amountEth?: string, chainId?: number) => Promise<void>) | null;
  // Withdrawals from the Privy wallets: send SOL (resolves to the signature),
  // and Privy's own key-export screens (the key never reaches FloorFeed).
  sendSol: ((t: SolTransfer) => Promise<string>) | null;
  // Any prepared Solana transaction (unsigned, base64 wire format) from the
  // Privy wallet; Privy shows it, signs and sends. Resolves to the signature.
  sendSolTx: ((base64: string) => Promise<string>) | null;
  exportSolana: (() => Promise<void>) | null;
  exportEvm: (() => Promise<void>) | null;
  // Sign-in methods and 2-step verification (Settings → Security). Null until signed in.
  security: Security | null;
};

// A way to sign in to the account. More than one means a lost inbox or Google
// account doesn't lock you out (and your wallet with it).
export type LoginKind = 'email' | 'google' | 'passkey';
export type Login = { kind: LoginKind; id: string; label: string; addedAt: number | null };
export type MfaMethod = 'totp' | 'sms' | 'passkey';
export type Security = {
  createdAt: number | null; // when the account was created (ms)
  logins: Login[];
  mfa: MfaMethod[];          // 2-step methods this user has set up
  mfaAvailable: MfaMethod[]; // methods switched on for FloorFeed in Privy's dashboard
  passkeyLogin: boolean;     // passkeys can be used to sign in
  link: (kind: LoginKind) => void; // opens Privy's flow to add one
  unlink: (l: Login) => Promise<void>;
  manageMfa: () => void;     // Privy's 2-step setup screen (add, remove, change)
};

// EIP-712 typed data as our API builds it (EIP712Domain is added when signing).
export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};
export const EIP712_DOMAIN = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
] as const;

// `description` is shown in Privy's confirmation screen.
export type EvmTx = { to: string; data: string; value: string; chainId: number; gas?: string; description?: string };
// What our API fills in before the Privy wallet signs (/chain/evm/prepare).
export type PreparedEvm = { nonce: number; gas: string; type: number; maxFeePerGas?: string; maxPriorityFeePerGas?: string; gasPrice?: string };
export type SolTransfer = { to: string; lamports: string; blockhash: string; lastValidBlockHeight: string };

// What the separately built Privy bundle (privy/entry.tsx) reports back.
// Solana: Privy only signs (its "sign and send" needs Solana RPCs configured
// inside Privy and hung without them); the app broadcasts the signed
// transaction through our API (auth.web.tsx), so sendSol/sendSolTx are built there.
export type PrivyState = Omit<AuthState, 'supported' | 'sendSol' | 'sendSolTx' | 'sendEvm'> & {
  getAccessToken: () => Promise<string | null>;
  // EVM likewise: Privy's own send broadcast transactions that never reached
  // the chain. The app gets nonce/gas/fees from our API, Privy shows and signs
  // exactly that, and our API broadcasts it.
  signEvm: ((tx: EvmTx & PreparedEvm) => Promise<string>) | null; // signed tx (or signature), hex
  signSol: ((t: SolTransfer) => Promise<string>) | null;     // signed tx, base64
  signSolTx: ((base64: string) => Promise<string>) | null;   // signed tx, base64
};

export type PrivyMountOptions = {
  appId: string;
  solanaRpcUrl: string; // our API's Solana RPC proxy: Privy's Solana confirm screen reads balances and simulates through it
  theme: `#${string}`;
  accent: `#${string}`;
  onState: (s: PrivyState) => void;
};
