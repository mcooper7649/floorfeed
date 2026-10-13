import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { chainById } from '@/constants/chains';

import { useAuth } from './auth';
import type { EvmTx } from './auth-types';
import type { EvmWalletState } from './wallet-types';

// Ethereum browser wallets announce themselves with EIP-6963 events, so
// MetaMask, Rabby, Coinbase Wallet and others work without per-wallet SDKs.
// FloorFeed only learns the address and asks the wallet to send specific,
// already-simulated transactions, which the wallet shows for confirmation.
type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 };

const LAST_KEY = 'floorfeed.evmWallet';
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

const Ctx = createContext<EvmWalletState | null>(null);

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [wallets, setWallets] = useState<Announced[]>([]);
  const [wallet, setWallet] = useState<Announced | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wallets can announce at any time; ask once on mount.
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Announced>).detail;
      if (!d?.info?.rdns || !d.provider) return;
      setWallets((ws) => (ws.some((w) => w.info.rdns === d.info.rdns) ? ws : [...ws, d]));
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  const adoptAccounts = useCallback((w: Announced, accounts: unknown) => {
    const a = Array.isArray(accounts) && typeof accounts[0] === 'string' ? (accounts[0] as string).toLowerCase() : null;
    if (!a) throw new Error('The wallet returned no account.');
    setWallet(w);
    setAddress(a);
    AsyncStorage.setItem(LAST_KEY, w.info.rdns).catch(() => {});
  }, []);

  // Quietly restore the last wallet if the site is still approved (no popup).
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(LAST_KEY).then(async (rdns) => {
      const w = rdns ? wallets.find((x) => x.info.rdns === rdns) : undefined;
      if (!w || !alive || address) return;
      const accounts = await w.provider.request({ method: 'eth_accounts' }).catch(() => []);
      if (alive && Array.isArray(accounts) && accounts.length) adoptAccounts(w, accounts);
    }).catch(() => {});
    return () => { alive = false; };
  }, [wallets, address, adoptAccounts]);

  const connect = useCallback(async (name: string) => {
    const w = wallets.find((x) => x.info.name === name);
    if (!w) { setError(`${name} isn't available in this browser.`); return; }
    setConnecting(true);
    setError(null);
    try {
      adoptAccounts(w, await w.provider.request({ method: 'eth_requestAccounts' }));
    } catch (e) {
      setError((e as Error).message || 'Connection was rejected.');
    } finally {
      setConnecting(false);
    }
  }, [wallets, adoptAccounts]);

  const disconnect = useCallback(async () => {
    setWallet(null);
    setAddress(null);
    await AsyncStorage.removeItem(LAST_KEY).catch(() => {});
  }, []);

  const sendExtension = useCallback(async (tx: EvmTx) => {
    if (!wallet || !address) throw new Error('No wallet connected.');
    const p = wallet.provider;
    const want = hex(tx.chainId);
    const current = await p.request({ method: 'eth_chainId' }).catch(() => null);
    if (current !== want) {
      try {
        await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
      } catch (e) {
        // 4902: the wallet doesn't know this network yet (common for Abstract, Ink). Add it, which also switches.
        const info = chainById(tx.chainId)?.[1];
        if ((e as { code?: number }).code !== 4902 || !info?.rpc) throw e;
        await p.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: want, chainName: info.name, rpcUrls: [info.rpc],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: info.explorer ? [info.explorer] : undefined,
        }] });
      }
    }
    const hash = await p.request({
      method: 'eth_sendTransaction',
      params: [{ from: address, to: tx.to, data: tx.data, value: hex(BigInt(tx.value)), ...(tx.gas ? { gas: hex(BigInt(tx.gas)) } : {}) }],
    });
    return String(hash);
  }, [wallet, address]);

  // A connected extension wins; otherwise the signed-in user's Privy wallet.
  const embedded = !address && auth.evmAddress ? auth.evmAddress.toLowerCase() : null;
  const value: EvmWalletState = {
    supported: true,
    available: wallets.map((w) => ({ name: w.info.name, icon: w.info.icon })),
    address: address ?? embedded,
    kind: address ? 'extension' : embedded ? 'embedded' : null,
    walletName: address ? wallet?.info.name ?? null : embedded ? 'FloorFeed wallet' : null,
    walletIcon: address ? wallet?.info.icon ?? null : null,
    connecting,
    error,
    connect,
    disconnect,
    send: address ? sendExtension : embedded ? auth.sendEvm : null,
  };
  return <Ctx value={value}>{children}</Ctx>;
}

export function useEvmWallet() {
  const v = use(Ctx);
  if (!v) throw new Error('useEvmWallet outside EvmWalletProvider');
  return v;
}
