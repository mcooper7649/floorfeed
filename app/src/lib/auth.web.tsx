import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { C } from '@/constants/brand';

import { api, setTokenGetter } from './api';
import type { AuthState, PrivyMountOptions, PrivyState } from './auth-types';
import { track } from '@/lib/analytics';

// Privy sign-in (email or Google). New users get an embedded Solana wallet:
// Privy holds the key in split shares, FloorFeed only learns the address.
//
// Privy's SDK is built separately (privy/entry.tsx → public/privy/) and only
// fetched when someone taps Sign in, or on load for a returning signed-in
// user, so visitors who never sign in don't download it.
const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const ENTRY = process.env.EXPO_PUBLIC_PRIVY_ENTRY ?? '';
const SIGNED_IN_KEY = 'floorfeed.signedIn';

type PrivyBundle = { mount: (o: PrivyMountOptions) => void };
// A runtime URL import that Metro leaves alone (it would try to bundle a plain import()).
const importUrl = new Function('u', 'return import(u)') as (u: string) => Promise<PrivyBundle>;

const OFF: AuthState = {
  supported: false,
  ready: true,
  userId: null,
  label: null,
  embeddedAddress: null,
  login: () => {},
  logout: async () => {},
  fund: null,
  evmAddress: null,
  sendEvm: null,
  fundEth: null,
  sendSol: null,
  sendSolTx: null,
  exportSolana: null,
  exportEvm: null,
};

const Ctx = createContext<AuthState>(OFF);

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!APP_ID || !ENTRY) return <Ctx value={OFF}>{children}</Ctx>;
  return <PrivyLoader>{children}</PrivyLoader>;
}

function PrivyLoader({ children }: { children: ReactNode }) {
  const [privy, setPrivy] = useState<PrivyState | null>(null);
  // Ready before the bundle loads only for visitors who weren't signed in;
  // returning users wait for Privy to restore their session.
  const [wasSignedIn, setWasSignedIn] = useState<boolean | null>(null);
  const mounting = useRef<Promise<void> | null>(null);
  const loginWhenReady = useRef(false);
  const storedSignedIn = useRef<boolean | null>(null);

  const load = useCallback(() => {
    // The token getter is set before React re-renders: effects run child-first,
    // so the session's /auth/session call would otherwise go out without a token.
    const onState = (s: PrivyState) => {
      setTokenGetter(s.userId ? s.getAccessToken : null);
      setPrivy(s);
    };
    mounting.current ??= importUrl(`/privy/${ENTRY}`).then((b) =>
      b.mount({ appId: APP_ID, theme: C.bg as `#${string}`, accent: C.accent as `#${string}`, onState }),
    );
    return mounting.current;
  }, []);

  useEffect(() => {
    // Coming back from Google: Privy must load to finish the login.
    const oauthReturn = typeof window !== 'undefined' && window.location.search.includes('privy_oauth_code');
    AsyncStorage.getItem(SIGNED_IN_KEY)
      .then((v) => {
        storedSignedIn.current = v === '1';
        const resume = v === '1' || oauthReturn;
        setWasSignedIn(resume);
        if (resume) load().catch(() => setWasSignedIn(false));
      })
      .catch(() => setWasSignedIn(false));
  }, [load]);

  // Remember sign-in across visits, keep API calls authenticated, and open
  // the Privy modal once it's ready if Sign in was tapped while it loaded.
  useEffect(() => {
    if (!privy?.ready) return;
    // A sign-in on this browser (not a returning signed-in visit) counts once.
    if (privy.userId && storedSignedIn.current === false) { storedSignedIn.current = true; track('sign_in'); }
    AsyncStorage.setItem(SIGNED_IN_KEY, privy.userId ? '1' : '0').catch(() => {});
    if (loginWhenReady.current && !privy.userId) {
      loginWhenReady.current = false;
      privy.login();
    }
  }, [privy]);

  const value: AuthState = privy
    ? {
        supported: true,
        ready: privy.ready,
        userId: privy.userId,
        label: privy.label,
        embeddedAddress: privy.embeddedAddress,
        login: privy.ready ? privy.login : () => { loginWhenReady.current = true; },
        logout: privy.logout,
        fund: privy.fund,
        evmAddress: privy.evmAddress,
        sendEvm: privy.signEvm ? async (tx) => {
          const from = privy.evmAddress!;
          const prepared = await api.evmPrepare({ chainId: tx.chainId, from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas });
          const signed = await privy.signEvm!({ ...tx, ...prepared });
          return api.evmSend({ from, tx: { to: tx.to, data: tx.data, value: tx.value, ...prepared }, signed });
        } : null,
        fundEth: privy.fundEth,
        sendSol: privy.signSol ? async (t) => api.solSend(await privy.signSol!(t)) : null,
        sendSolTx: privy.signSolTx ? async (b64) => api.solSend(await privy.signSolTx!(b64)) : null,
        exportSolana: privy.exportSolana,
        exportEvm: privy.exportEvm,
      }
    : {
        ...OFF,
        supported: true,
        ready: wasSignedIn === false,
        login: () => {
          loginWhenReady.current = true;
          load().catch(() => { loginWhenReady.current = false; });
        },
      };
  return <Ctx value={value}>{children}</Ctx>;
}

export const useAuth = () => use(Ctx);
