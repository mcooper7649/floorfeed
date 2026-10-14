import AsyncStorage from '@react-native-async-storage/async-storage';
import { SolanaSignAndSendTransaction, SolanaSignMessage, SolanaSignTransaction, type SolanaSignMessageFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect, StandardDisconnect, StandardEvents,
  type StandardConnectFeature, type StandardDisconnectFeature, type StandardEventsFeature,
} from '@wallet-standard/features';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { useAuth } from './auth';
import type { WalletOption, WalletState } from './wallet-types';

// Browser wallets (Phantom, Solflare, Backpack, …) announce themselves through
// the Wallet Standard registry; no per-wallet SDKs needed.
const LAST_KEY = 'floorfeed.wallet';
const registry = getWallets();

// Usable = can connect, is on Solana mainnet, and can sign transactions.
const usable = (w: Wallet) =>
  StandardConnect in w.features &&
  w.chains.some((c) => c === 'solana:mainnet') &&
  (SolanaSignTransaction in w.features || SolanaSignAndSendTransaction in w.features);

const solanaWallets = () => registry.get().filter(usable);
const option = (w: Wallet): WalletOption => ({ name: w.name, icon: w.icon });
const mainnetAccount = (accounts: readonly WalletAccount[]) =>
  accounts.find((a) => a.chains.includes('solana:mainnet')) ?? accounts[0] ?? null;

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [wallets, setWallets] = useState<Wallet[]>(solanaWallets);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const address = account?.address ?? null;
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extensions can register after page load.
  useEffect(() => {
    const refresh = () => setWallets(solanaWallets());
    const offRegister = registry.on('register', refresh);
    const offUnregister = registry.on('unregister', refresh);
    return () => { offRegister(); offUnregister(); };
  }, []);

  const doConnect = useCallback(async (w: Wallet, silent: boolean) => {
    const { accounts } = await (w.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect])
      .connect(silent ? { silent: true } : undefined);
    const acct = mainnetAccount(accounts);
    if (!acct) throw new Error('The wallet returned no Solana account.');
    setWallet(w);
    setAccount(acct);
    await AsyncStorage.setItem(LAST_KEY, w.name).catch(() => {});
  }, []);

  // Reconnect silently to the last wallet (no popup if the site is already approved).
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(LAST_KEY).then((name) => {
      const w = name ? solanaWallets().find((x) => x.name === name) : undefined;
      if (w && alive) doConnect(w, true).catch(() => {});
    }).catch(() => {});
    return () => { alive = false; };
  }, [doConnect, wallets.length]);

  // Follow account switches / disconnects made inside the wallet.
  useEffect(() => {
    if (!wallet || !(StandardEvents in wallet.features)) return;
    return (wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents])
      .on('change', ({ accounts }) => {
        if (!accounts) return;
        setAccount(mainnetAccount(accounts));
      });
  }, [wallet]);

  const connect = useCallback(async (name: string) => {
    const w = solanaWallets().find((x) => x.name === name);
    if (!w) { setError(`${name} isn't available in this browser.`); return; }
    setConnecting(true);
    setError(null);
    try {
      await doConnect(w, false);
    } catch (e) {
      setError((e as Error).message || 'Connection was rejected.');
    } finally {
      setConnecting(false);
    }
  }, [doConnect]);

  const disconnect = useCallback(async () => {
    if (wallet && StandardDisconnect in wallet.features) {
      await (wallet.features[StandardDisconnect] as StandardDisconnectFeature[typeof StandardDisconnect])
        .disconnect().catch(() => {});
    }
    setWallet(null);
    setAccount(null);
    await AsyncStorage.removeItem(LAST_KEY).catch(() => {});
  }, [wallet]);

  const signMessage = useCallback(async (message: string) => {
    if (!wallet || !account || !(SolanaSignMessage in wallet.features)) throw new Error('This wallet can’t sign messages.');
    const [out] = await (wallet.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage])
      .signMessage({ account, message: new TextEncoder().encode(message) });
    let bin = '';
    for (const b of out.signature) bin += String.fromCharCode(b);
    return btoa(bin);
  }, [wallet, account]);

  // A connected extension wins; otherwise the signed-in user's Privy wallet.
  const embedded = !address && auth.embeddedAddress ? auth.embeddedAddress : null;
  const value: WalletState = {
    supported: true,
    available: wallets.map(option),
    address: address ?? embedded,
    kind: address ? 'extension' : embedded ? 'embedded' : null,
    walletName: embedded ? 'FloorFeed wallet' : wallet?.name ?? null,
    walletIcon: embedded ? null : wallet?.icon ?? null,
    connecting,
    error,
    connect,
    disconnect,
    signMessage: address && wallet && SolanaSignMessage in wallet.features ? signMessage : null,
  };
  return <Ctx value={value}>{children}</Ctx>;
}

export function useWallet() {
  const v = use(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}
