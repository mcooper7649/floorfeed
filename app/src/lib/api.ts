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

// Event feed (GET /events). Trader identity: .sol name, avatar = art of an
// NFT they hold, tier from flip record ("mm" = likely AMM market maker).
export type Tier = 'elite' | 'pro' | 'mm' | 'new' | null;
export type Trader = {
  wallet: string;
  name: string | null;
  avatar: string | null;
  tier: Tier;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number;
  quality: number;
};
type EventColl = { symbol: string; name: string; floor: number | null };
type EventBase = { id: string; t: number; collection: EventColl; score?: number };
export type BuyEvent = EventBase & { kind: 'buy'; signature: string; mint: string; image: string | null; price: number;
  vsFloorPct: number | null; wallet: Trader; take: Take | null };
export type FlipEvent = EventBase & { kind: 'flip'; signature: string; mint: string; image: string | null; buy: number;
  sell: number; pnl: number; pnlPct: number; holdHours: number; wallet: Trader; buyer: Trader };
export type SweepEvent = EventBase & { kind: 'sweep'; wallet: Trader; count: number; total: number; avg: number;
  images: string[]; vsFloorPct: number | null };
export type ClusterEvent = EventBase & { kind: 'cluster'; wallets: Trader[]; count: number; buys: number; avg: number;
  images: string[]; vsFloorPct: number | null; since: number };
export type FeedEvent = BuyEvent | FlipEvent | SweepEvent | ClusterEvent;
export type FeedView = 'top' | 'latest' | 'wins';

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
  profile: TraderProfile;
  trades: {
    signature: string;
    side: 'buy' | 'sell';
    collection: string;
    symbol: string;
    image: string | null;
    price: number;
    blockTime: number;
  }[];
};

export type TraderProfile = {
  wallet: string;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number;
  roiPct: number | null;
  avgPnlSol: number | null;
  avgHoldHours: number | null;
  bestFlip: { collection: string; symbol: string; pnlSol: number } | null;
  worstFlipSol: number | null;
  streak: number;
  collections: { symbol: string; name: string; flips: number; pnlSol: number }[];
  trades: number;
  poolShare: number;
  likelyMarketMaker: boolean;
  lastActive: number | null;
  openPositions: number;
  unrealizedSol: number;
  series: number[];
};

export type LeaderWindow = '7' | '30' | 'all';
export type LeaderSort = 'pnl' | 'winrate' | 'roi' | 'flips';

export type Leaderboard = {
  windowDays: number | null;
  summary: { wallets: number; flips: number; realizedSol: number; profitableWallets: number; hiddenMarketMakers: number };
  rows: TraderProfile[];
};

export type Chain = 'solana' | 'ethereum' | 'base' | 'polygon';
export type MarketCategory = 'PFP' | 'Art' | 'Gaming' | 'Assets' | 'Domains' | 'Memberships' | 'Utility';

export type CollectionSummary = {
  symbol: string;
  name: string;
  chain: Chain;
  currency: string; // native currency of floor/volume amounts (SOL, ETH)
  source: 'magiceden' | 'opensea';
  category: MarketCategory;
  live: boolean; // full sales tracking (feed, charts, flippers)
  image: string | null;
  floor: number | null;
  floorUsd: number | null;
  listed: number | null;
  owners: number | null;
  avg24h: number | null;
  volume7d: number | null;
  volume7dUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  sales24h: number | null;
  volume24h: number | null;
  volume24hUsd: number | null;
  spark: { day: number; median: number }[];
};

export type Listing = { mint: string; price: number; name: string | null; image: string | null; rank: number | null };

// One chart bucket (hour, 6 hours or day; see CollectionDetail.bucketSec). `day` is the bucket start.
export type DailyPoint = { day: number; low: number; median: number; high: number; count: number; volume: number };

export type CollectionDetail = {
  symbol: string;
  name: string;
  chain: Chain;
  currency: string;
  source: 'magiceden' | 'opensea';
  externalUrl: string;
  category: MarketCategory;
  live: boolean;
  image: string | null;
  description: string | null;
  stats: {
    floor: number | null;
    listed: number | null;
    avg24h: number | null;
    volume7d: number | null;
    sales24h: number;
    volume24h: number;
    owners?: number | null;
    supply?: number | null;
    volume30d?: number | null;
    floorUsd?: number | null;
  };
  rangeDays: number;
  bucketSec: number;
  asOf: number; // server time (unix s) the window ends at
  historyStartsAt: number | null;
  sales: { signature: string; price: number; t: number }[];
  daily: DailyPoint[];
  floorHistory: { ts: number; floor: number | null }[];
  listings: Listing[];
  topFlippers: { wallet: string; flips: number; wins: number; realizedSol: number }[];
  recentSales: { signature: string; mint: string; buyer: string; price: number; t: number; image: string | null }[];
};

// Signed-in (Privy) users send their access token; anonymous device ids don't.
let tokenGetter: (() => Promise<string | null>) | null = null;
export const setTokenGetter = (fn: typeof tokenGetter) => { tokenGetter = fn; };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  const token = tokenGetter ? await tokenGetter().catch(() => null) : null;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

const send = (method: string, path: string, body: unknown) =>
  req<any>(path, { method, body: JSON.stringify(body) });

export type Capabilities = { buy: { enabled: boolean; magiceden: boolean; tensor: boolean }; rpc: 'public' | 'custom' };

export type Holding = {
  mint: string;
  name: string | null;
  image: string | null;
  collection: { symbol: string; name: string; floor: number | null };
  estValue: number | null; // floor minus the sell haircut (est. bid)
  boughtAt: number | null; // this wallet's last on-chain buy price, if we saw it
};
export type Holdings = { address: string; sol: number; nftValue: number; totalValue: number; nfts: Holding[]; untracked: number };

export type BuyQuote = {
  collection: { symbol: string; name: string; floor: number | null };
  listing: { mint: string; price: number; name: string | null; image: string | null; rank: number | null } | null;
  networkFeeSol: number;
  balanceSol: number | null;
  executable: boolean;
  reason: string | null;
  marketUrl: string;
};

export const api = {
  // Verifies the Privy token and moves this device's follows/paper trades to the account.
  session: (deviceId: string) => send('POST', '/auth/session', { deviceId }) as Promise<{ userId: string }>,
  capabilities: () => req<Capabilities>('/capabilities'),
  balance: (address: string) => req<{ lamports: number; sol: number }>(`/chain/balance/${address}`),
  holdings: (address: string) => req<Holdings>(`/chain/holdings/${address}`),
  quote: (symbol: string, buyer: string) => req<BuyQuote>(`/trade/quote/${symbol}?buyer=${buyer}`),
  feed: (p: { before?: number; following?: string } = {}) => {
    const q = new URLSearchParams({ limit: '25' });
    if (p.before) q.set('before', String(p.before));
    if (p.following) q.set('following', p.following);
    return req<FeedItem[]>(`/feed?${q}`);
  },
  events: (p: { view: FeedView; before?: number; following?: string }) => {
    const q = new URLSearchParams({ view: p.view, limit: '30' });
    if (p.before) q.set('before', String(p.before));
    if (p.following) q.set('following', p.following);
    return req<{ view: FeedView; events: FeedEvent[]; next: number | null }>(`/events?${q}`);
  },
  take: (signature: string) => req<Take | null>(`/takes/${signature}`),
  collections: () => req<CollectionSummary[]>('/collections'),
  collection: (symbol: string, range: number) => req<CollectionDetail>(`/collections/${symbol}?range=${range}`),
  leaderboard: (p: { window: LeaderWindow; sort: LeaderSort; hideMM: boolean }) =>
    req<Leaderboard>(`/leaderboard?limit=50&window=${p.window}&sort=${p.sort}&hideMM=${p.hideMM ? 1 : 0}`),
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
