import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { api } from './api';
import { useAuth } from './auth';

// Identity: an anonymous per-device id, or the Privy user id once signed in.
// The first sign-in on a device moves that device's follows and paper trades
// to the account (server: /auth/session).
type Session = {
  userId: string | null;
  signedIn: boolean;
  following: Set<string>;
  toggleFollow: (wallet: string) => Promise<void>;
  // Bumped after paper trades so the Portfolio tab refetches.
  portfolioVersion: number;
  bumpPortfolio: () => void;
  // Collection watchlist, kept on the device.
  watchlist: Set<string>;
  toggleWatch: (symbol: string) => void;
};

const Ctx = createContext<Session | null>(null);
const KEY = 'floorfeed.userId';
const WATCH_KEY = 'floorfeed.watchlist';

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // Server-confirmed account, tagged with the Privy id it belongs to.
  const [account, setAccount] = useState<{ privyId: string; userId: string } | null>(null);
  const accountId = auth.userId && account?.privyId === auth.userId ? account.userId : null;
  const userId = auth.userId ? accountId : deviceId;
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [portfolioVersion, setPortfolioVersion] = useState(0);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      let id = await AsyncStorage.getItem(KEY);
      if (!id) {
        id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        await AsyncStorage.setItem(KEY, id);
      }
      setDeviceId(id);
      const saved = await AsyncStorage.getItem(WATCH_KEY).catch(() => null);
      if (saved) setWatchlist(new Set(JSON.parse(saved) as string[]));
    })();
  }, []);

  // Sign-in / sign-out: confirm the account with the server, then switch ids.
  useEffect(() => {
    const privyId = auth.userId;
    if (!auth.ready || !deviceId || !privyId) return;
    let alive = true;
    api.session(deviceId)
      .then((r) => { if (alive) { setAccount({ privyId, userId: r.userId }); setPortfolioVersion((v) => v + 1); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [auth.ready, auth.userId, deviceId]);

  // Follows for whichever identity is active.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    api.follows(userId).then((w) => alive && setFollowing(new Set(w))).catch(() => {});
    return () => { alive = false; };
  }, [userId]);

  const toggleFollow = useCallback(
    async (wallet: string) => {
      if (!userId) return;
      const isFollowing = following.has(wallet);
      setFollowing((prev) => {
        const next = new Set(prev);
        if (isFollowing) next.delete(wallet);
        else next.add(wallet);
        return next;
      });
      await (isFollowing ? api.unfollow(userId, wallet) : api.follow(userId, wallet));
    },
    [userId, following],
  );

  const bumpPortfolio = useCallback(() => setPortfolioVersion((v) => v + 1), []);

  const toggleWatch = useCallback((symbol: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      AsyncStorage.setItem(WATCH_KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  return (
    <Ctx value={{ userId, signedIn: !!auth.userId && !!accountId, following, toggleFollow, portfolioVersion, bumpPortfolio, watchlist, toggleWatch }}>
      {children}
    </Ctx>
  );
}

export function useSession() {
  const s = use(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
