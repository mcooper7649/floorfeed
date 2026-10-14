import {
  PrivyProvider, useCreateWallet, useExportWallet as useExportEvmWallet, useFundWallet as useFundEvmWallet, usePrivy, useSendTransaction,
} from '@privy-io/react-auth';
import {
  useExportWallet as useExportSolanaWallet, useFundWallet, useSignAndSendTransaction, useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  address as solAddress, appendTransactionMessageInstruction, blockhash as solBlockhash, compileTransaction, createNoopSigner,
  createTransactionMessage, getBase58Decoder, getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { abstract, apeChain, arbitrum, base, hyperEvm, ink, mainnet, monad, ronin } from 'viem/chains';

import type { EvmTx, PrivyMountOptions, PrivyState, SolTransfer } from '../src/lib/auth-types';

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
        supportedChains: [mainnet, base, abstract, ink, arbitrum, hyperEvm, ronin, apeChain, monad],
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
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { wallets: solWallets } = useSolanaWallets();
  const { exportWallet: exportSol } = useExportSolanaWallet();
  const { exportWallet: exportEth } = useExportEvmWallet();

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
      { address: evmAddress ?? undefined, uiOptions: { description: tx.description ?? 'Buy this NFT on OpenSea. Check the price before confirming.' } },
    );
    return hash;
  }, [sendTransaction, evmAddress]);

  // A plain SOL transfer from the Privy wallet. The app passes a recent
  // blockhash (from our API, which has the RPC); Privy shows it and signs.
  const sendSolImpl = useCallback(async (t: SolTransfer) => {
    const w = solWallets.find((x) => x.address === embeddedAddress);
    if (!w) throw new Error("Your FloorFeed Solana wallet isn't ready yet. Try again in a moment.");
    const signer = createNoopSigner(solAddress(w.address));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: solBlockhash(t.blockhash), lastValidBlockHeight: BigInt(t.lastValidBlockHeight) }, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: solAddress(t.to), amount: BigInt(t.lamports) }), m),
    );
    const bytes = getTransactionEncoder().encode(compileTransaction(message));
    const { signature } = await signAndSendTransaction({ transaction: new Uint8Array(bytes), wallet: w });
    return getBase58Decoder().decode(signature);
  }, [solWallets, embeddedAddress, signAndSendTransaction]);

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
  const sendSol = userId && embeddedAddress ? sendSolImpl : null;
  const exportSolana = useMemo(() => (userId && embeddedAddress ? () => exportSol({ address: embeddedAddress }) : null), [userId, embeddedAddress, exportSol]);
  const exportEvm = useMemo(() => (userId && evmAddress ? () => exportEth({ address: evmAddress }) : null), [userId, evmAddress, exportEth]);

  const state = useMemo<PrivyState>(
    () => ({
      ready, userId, label, embeddedAddress, login: () => login(), logout, getAccessToken, fund,
      evmAddress, sendEvm: send, fundEth, sendSol, exportSolana, exportEvm,
    }),
    [ready, userId, label, embeddedAddress, login, logout, getAccessToken, fund, evmAddress, send, fundEth, sendSol, exportSolana, exportEvm],
  );
  useEffect(() => onState(state), [state, onState]);
  return null;
}
