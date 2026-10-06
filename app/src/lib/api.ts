// Point EXPO_PUBLIC_API_URL at the server's LAN address when running on a
// phone (localhost only works for web/simulators on the same machine).
const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8030';

export type WalletStats = {
  wallet: string;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number;
  buys: number;
  volumeSol: number;
  openPositions: number;
  unrealizedSol: number;
};

export type Take = { text: string; model: string };

export type FeedItem = {
  signature: string;
  collection: { symbol: string; name: string; floor: number | null };
  mint: string;
  image: string | null;
  price: number;
  vsFloorPct: number | null;
  blockTime: number;
  buyer: WalletStats;
  seller: string;
  take: Take | null;
};

export type PaperPosition = {
  id: number;
  collection: { symbol: string; name: string; floor: number | null };
  entryPrice: number;
  exitPrice: number | null;
  open: boolean;
  pnlSol: number;
  openedAt: number;
  copiedFrom: string | null;
};

export type WalletDetail = {
  stats: WalletStats;
  trades: {
    signature: string;
    side: 'buy' | 'sell';
    collection: string;
    image: string | null;
    price: number;
    blockTime: number;
  }[];
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

const send = (method: string, path: string, body: unknown) =>
  req<any>(path, { method, body: JSON.stringify(body) });

export const api = {
  feed: (p: { before?: number; following?: string } = {}) => {
    const q = new URLSearchParams({ limit: '25' });
    if (p.before) q.set('before', String(p.before));
    if (p.following) q.set('following', p.following);
    return req<FeedItem[]>(`/feed?${q}`);
  },
  take: (signature: string) => req<Take | null>(`/takes/${signature}`),
  leaderboard: () => req<WalletStats[]>('/leaderboard?limit=50'),
  wallet: (address: string) => req<WalletDetail>(`/wallets/${address}`),
  follows: (userId: string) => req<string[]>(`/follows/${userId}`),
  follow: (userId: string, wallet: string) => send('POST', '/follows', { userId, wallet }),
  unfollow: (userId: string, wallet: string) => send('DELETE', '/follows', { userId, wallet }),
  paper: (userId: string) =>
    req<{ positions: PaperPosition[]; realizedSol: number; unrealizedSol: number }>(`/paper/${userId}`),
  buyFloor: (userId: string, collection: string, copiedFrom?: string) =>
    send('POST', '/paper/buy', { userId, collection, copiedFrom }) as Promise<{ entryPrice: number }>,
  sell: (userId: string, positionId: number) =>
    send('POST', '/paper/sell', { userId, positionId }) as Promise<{ exitPrice: number }>,
};
