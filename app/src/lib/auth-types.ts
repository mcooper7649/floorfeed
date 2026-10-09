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
};

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
