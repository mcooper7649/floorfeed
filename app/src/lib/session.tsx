import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { api } from './api';

// Anonymous per-device identity. Phase 2 swaps this for a Privy user id +
// embedded Solana wallet; everything keyed on userId keeps working.
type Session = {
  userId: string | null;
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
  const [userId, setUserId] = useState<string | null>(null);
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
      setUserId(id);
      const saved = await AsyncStorage.getItem(WATCH_KEY).catch(() => null);
      if (saved) setWatchlist(new Set(JSON.parse(saved) as string[]));
      api.follows(id).then((w) => setFollowing(new Set(w))).catch(() => {});
    })();
  }, []);

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
    <Ctx value={{ userId, following, toggleFollow, portfolioVersion, bumpPortfolio, watchlist, toggleWatch }}>
      {children}
    </Ctx>
  );
}

export function useSession() {
  const s = use(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
