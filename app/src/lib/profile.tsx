import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { api, type MyProfile } from './api';
import { useSession } from './session';

// The signed-in user's own profile, shared so a rename shows everywhere at
// once (wallet menu, thesis composer, Profile, onboarding). Null while signed
// out or loading.
type ProfileState = {
  profile: MyProfile | null;
  loaded: boolean; // fetched for the current account (profile may still be null on error)
  setName: (name: string) => Promise<string>; // throws the server's message
  setShowOnWallets: (on: boolean) => Promise<void>;
  refresh: () => void;
};

const Ctx = createContext<ProfileState>({ profile: null, loaded: false, setName: async (n) => n, setShowOnWallets: async () => {}, refresh: () => {} });

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { signedIn, userId } = useSession();
  const [state, setState] = useState<{ userId: string; profile: MyProfile | null } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!signedIn || !userId) return;
    let alive = true;
    api.profile()
      .then((p) => alive && setState({ userId, profile: p }))
      .catch(() => alive && setState({ userId, profile: null }));
    return () => { alive = false; };
  }, [signedIn, userId, version]);

  const setName = useCallback(async (name: string) => {
    const r = await api.setProfileName(name);
    setState((s) => (s?.profile ? { ...s, profile: { ...s.profile, name: r.name, nameChangedAt: Date.now() } } : s));
    return r.name;
  }, []);
  const setShowOnWallets = useCallback(async (on: boolean) => {
    const r = await api.setShowOnWallets(on);
    setState((s) => (s?.profile ? { ...s, profile: { ...s.profile, showOnWallets: r.showOnWallets } } : s));
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const mine = signedIn && state?.userId === userId ? state : null;
  return <Ctx value={{ profile: mine?.profile ?? null, loaded: !!mine, setName, setShowOnWallets, refresh }}>{children}</Ctx>;
}

export const useProfile = () => use(Ctx);
