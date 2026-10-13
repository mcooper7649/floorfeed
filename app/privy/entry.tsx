import {
  PrivyProvider, useCreateWallet, useFundWallet as useFundEvmWallet, usePrivy, useSendTransaction,
} from '@privy-io/react-auth';
import { useFundWallet } from '@privy-io/react-auth/solana';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { abstract, arbitrum, base, ink, mainnet } from 'viem/chains';

import type { EvmTx, PrivyMountOptions, PrivyState } from '../src/lib/auth-types';

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
        embeddedWallets: {
          solana: { createOnLogin: 'users-without-wallets' },
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        defaultChain: mainnet,
        supportedChains: [mainnet, base, abstract, ink, arbitrum],
      }}>
      <Bridge onState={onState} />
    </PrivyProvider>,
  );
}

function Bridge({ onState }: { onState: (s: PrivyState) => void }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { fundWallet } = useFundWallet();
  const { fundWallet: fundEvmWallet } = useFundEvmWallet();
  const { sendTransaction } = useSendTransaction();
  const { createWallet } = useCreateWallet();

  const userId = authenticated && user ? user.id : null;
  const label = user?.email?.address ?? user?.google?.email ?? null;
  const embedded = user?.linkedAccounts.find(
    (a) => a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy',
  );
  const embeddedAddress = embedded && 'address' in embedded ? embedded.address : null;
  const evmEmbedded = user?.linkedAccounts.find(
    (a) => a.type === 'wallet' && a.chainType === 'ethereum' && a.walletClientType === 'privy',
  );
  const evmAddress = evmEmbedded && 'address' in evmEmbedded ? evmEmbedded.address : null;

  // Accounts from before Ethereum support have only a Solana wallet: add an
  // Ethereum one once (createOnLogin skips users who already have a wallet).
  const creating = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || evmAddress || creating.current) return;
    creating.current = true;
    createWallet().catch(() => {});
  }, [ready, authenticated, evmAddress, createWallet]);

  const sendEvm = useCallback(async (tx: EvmTx) => {
    const { hash } = await sendTransaction(
      { to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId, ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}) },
      { address: evmAddress ?? undefined, uiOptions: { description: 'Buy this NFT on OpenSea. Check the price before confirming.' } },
    );
    return hash;
  }, [sendTransaction, evmAddress]);

  const fundEthImpl = useCallback(
    async (address: string, amountEth?: string, chainId?: number) => {
      await fundEvmWallet({
        address,
        options: {
          chain: chainId === base.id ? base : mainnet,
          amount: amountEth,
          uiConfig: { receiveFundsTitle: 'Deposit ETH', receiveFundsSubtitle: 'Send ETH on Ethereum to your FloorFeed wallet.' },
        },
      });
    },
    [fundEvmWallet],
  );

  const fundSol = useCallback(
    (address: string, amountSol?: string) => fundWallet({
      address,
      options: {
        amount: amountSol,
        uiConfig: { receiveFundsTitle: 'Deposit SOL', receiveFundsSubtitle: 'Send SOL on the Solana network to your FloorFeed wallet.' },
      },
    }),
    [fundWallet],
  );
  const fund = userId ? fundSol : null;
  const fundEth = userId ? fundEthImpl : null;
  const send = userId && evmAddress ? sendEvm : null;

  const state = useMemo<PrivyState>(
    () => ({
      ready, userId, label, embeddedAddress, login: () => login(), logout, getAccessToken, fund,
      evmAddress, sendEvm: send, fundEth,
    }),
    [ready, userId, label, embeddedAddress, login, logout, getAccessToken, fund, evmAddress, send, fundEth],
  );
  useEffect(() => onState(state), [state, onState]);
  return null;
}
