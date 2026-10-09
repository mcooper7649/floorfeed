import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

import type { PrivyMountOptions, PrivyState } from '../src/lib/auth-types';

// Privy's SDK is several MB, so it is built on its own (scripts/build-privy.mjs)
// and only fetched when someone signs in, or is already signed in. It runs in
// its own React root next to the app and reports its state through onState.
export function mount({ appId, theme, accent, onState }: PrivyMountOptions) {
  const el = document.createElement('div');
  el.id = 'privy-root';
  document.body.appendChild(el);
  createRoot(el).render(
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google'],
        appearance: { theme, accentColor: accent, landingHeader: 'Sign in to FloorFeed' },
        embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
      }}>
      <Bridge onState={onState} />
    </PrivyProvider>,
  );
}

function Bridge({ onState }: { onState: (s: PrivyState) => void }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();

  const userId = authenticated && user ? user.id : null;
  const label = user?.email?.address ?? user?.google?.email ?? null;
  const embedded = user?.linkedAccounts.find(
    (a) => a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy',
  );
  const embeddedAddress = embedded && 'address' in embedded ? embedded.address : null;

  const state = useMemo<PrivyState>(
    () => ({ ready, userId, label, embeddedAddress, login: () => login(), logout, getAccessToken }),
    [ready, userId, label, embeddedAddress, login, logout, getAccessToken],
  );
  useEffect(() => onState(state), [state, onState]);
  return null;
}
