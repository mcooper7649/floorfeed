import {
  PrivyProvider, useCreateWallet, useExportWallet as useExportEvmWallet, useFundWallet as useFundEvmWallet, usePrivy, useSignTransaction as useSignEvmTransaction,
} from '@privy-io/react-auth';
import {
  useExportWallet as useExportSolanaWallet, useFundWallet, useSignTransaction, useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  address as solAddress, appendTransactionMessageInstruction, blockhash as solBlockhash, compileTransaction, createNoopSigner,
  createSolanaRpc, createSolanaRpcSubscriptions,
  createTransactionMessage, getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { abstract, apeChain, arbitrum, base, hyperEvm, ink, mainnet, monad, robinhood, ronin } from 'viem/chains';

import type { EvmTx, PreparedEvm, PrivyMountOptions, PrivyState, SolTransfer } from '../src/lib/auth-types';

// Privy's SDK is several MB, so it is built on its own (scripts/build-privy.mjs)
// and only fetched when someone signs in, or is already signed in. It runs in
// its own React root next to the app and reports its state through onState.
export function mount({ appId, solanaRpcUrl, theme, accent, onState }: PrivyMountOptions) {
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
        // Privy's Solana confirm screen reads the balance and simulates the
        // transaction itself; without RPCs here it failed and spun forever.
        // Ours is a proxy on our API (method allowlist, key stays server-side).
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc(solanaRpcUrl),
              rpcSubscriptions: createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com'),
              blockExplorerUrl: 'https://solscan.io',
            },
          },
        },
        defaultChain: mainnet,
        supportedChains: [mainnet, base, abstract, ink, arbitrum, hyperEvm, ronin, apeChain, monad, robinhood],
      }}>
      <Bridge onState={onState} />
    </PrivyProvider>,
  );
}

function Bridge({ onState }: { onState: (s: PrivyState) => void }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { fundWallet } = useFundWallet();
  const { fundWallet: fundEvmWallet } = useFundEvmWallet();
  const { signTransaction: signEvmTransaction } = useSignEvmTransaction();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
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

  // Sign only: nonce, gas and fees come prepared from our API, which also broadcasts.
  const signEvm = useCallback(async (tx: EvmTx & PreparedEvm) => {
    const { signature } = await signEvmTransaction({
      to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId, nonce: tx.nonce, gasLimit: BigInt(tx.gas), type: tx.type,
      ...(tx.type === 2
        ? { maxFeePerGas: BigInt(tx.maxFeePerGas!), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas!) }
        : { gasPrice: BigInt(tx.gasPrice!) }),
    }, { address: evmAddress ?? undefined, uiOptions: { description: tx.description ?? 'Check the details before confirming.' } });
    return signature;
  }, [signEvmTransaction, evmAddress]);

  // Solana from the Privy wallet: Privy shows the transaction and signs it; the
  // app broadcasts it through our API (see PrivyState). Returns base64.
  const signBytes = useCallback(async (bytes: Uint8Array) => {
    const w = solWallets.find((x) => x.address === embeddedAddress);
    if (!w) throw new Error("Your FloorFeed Solana wallet isn't ready yet. Try again in a moment.");
    const { signedTransaction } = await signTransaction({ transaction: bytes, wallet: w, chain: 'solana:mainnet' });
    let bin = '';
    for (const b of signedTransaction) bin += String.fromCharCode(b);
    return btoa(bin);
  }, [solWallets, embeddedAddress, signTransaction]);

  // A plain SOL transfer. The app passes a recent blockhash (from our API, which has the RPC).
  const signSolImpl = useCallback(async (t: SolTransfer) => {
    const signer = createNoopSigner(solAddress(embeddedAddress ?? ''));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: solBlockhash(t.blockhash), lastValidBlockHeight: BigInt(t.lastValidBlockHeight) }, m),
      (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: solAddress(t.to), amount: BigInt(t.lamports) }), m),
    );
    return signBytes(new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))));
  }, [embeddedAddress, signBytes]);

  // A transaction our API prepared (e.g. a Relay bridge deposit), unsigned.
  const signSolTxImpl = useCallback((base64: string) => signBytes(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), [signBytes]);

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
  const signEvmOrNull = userId && evmAddress ? signEvm : null;
  const signSol = userId && embeddedAddress ? signSolImpl : null;
  const signSolTx = userId && embeddedAddress ? signSolTxImpl : null;
  const exportSolana = useMemo(() => (userId && embeddedAddress ? () => exportSol({ address: embeddedAddress }) : null), [userId, embeddedAddress, exportSol]);
  const exportEvm = useMemo(() => (userId && evmAddress ? () => exportEth({ address: evmAddress }) : null), [userId, evmAddress, exportEth]);

  const state = useMemo<PrivyState>(
    () => ({
      ready, userId, label, embeddedAddress, login: () => login(), logout, getAccessToken, fund,
      evmAddress, signEvm: signEvmOrNull, fundEth, signSol, signSolTx, exportSolana, exportEvm,
    }),
    [ready, userId, label, embeddedAddress, login, logout, getAccessToken, fund, evmAddress, signEvmOrNull, fundEth, signSol, signSolTx, exportSolana, exportEvm],
  );
  useEffect(() => onState(state), [state, onState]);
  return null;
}
