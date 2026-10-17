// Market data (server routes/market.ts): collections, items, the feeds, the
// leaderboard, wallets, discovery, prices and the guide.
import { path, qs, req } from './client';

export type Chain = 'solana' | 'ethereum' | 'base' | 'polygon' | 'abstract' | 'ink' | 'arbitrum'
  | 'hyperevm' | 'ronin' | 'apechain' | 'monad' | 'robinhood';
// Currencies P&L is kept in. A wallet's numbers are always in one of these.
export type Unit = 'SOL' | 'ETH' | 'HYPE' | 'RON' | 'APE' | 'MON';
export type Ecosystem = 'solana' | 'evm';

// --- Wallets and traders ---

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

// Trader identity: .sol name, avatar = art of an NFT they hold, tier from flip
// record ("mm" = likely AMM market maker).
export type Tier = 'elite' | 'pro' | 'mm' | 'new' | null;
export type Trader = {
  wallet: string;
  name: string | null;
  avatar: string | null;
  tier: Tier;
  flips: number;
  wins: number;
  winRate: number | null;
  realizedSol: number; // in `unit`
  unit?: Unit;         // the currency this wallet flips most in
  realizedUsd?: number | null;
  quality: number;
};
export type WalletRef = { wallet: string; name: string | null; avatar: string | null; tier: Tier };

export type TraderProfile = {
  name?: string | null; // .sol name (leaderboard rows)
  avatar?: string | null;
  wallet: string;
  unit?: Unit; // every amount in this profile is in this currency
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
  bidBuyShare?: number; // EVM: share of buys filled by accepted bids
  likelyMarketMaker: boolean;
  lastActive: number | null;
  openPositions: number;
  unrealizedSol: number;
  series: number[];
};

export type WalletDetail = {
  identity?: Trader; // absent from older API builds
  unit?: Unit; // the currency stats/profile are in
  units?: { unit: Unit; trades: number; flips: number; realized: number; realizedUsd: number | null }[];
  stats: WalletStats;
  profile: TraderProfile;
  trades: {
    signature: string;
    mint: string;
    currency?: string;
    side: 'buy' | 'sell';
    collection: string;
    symbol: string;
    image: string | null;
    price: number;
    blockTime: number;
  }[];
};

export type LeaderWindow = '7' | '30' | 'all';
export type LeaderSort = 'pnl' | 'winrate' | 'roi' | 'flips';
export type Leaderboard = {
  windowDays: number | null;
  unit?: Unit;
  summary: { wallets: number; flips: number; realizedSol: number; profitableWallets: number; hiddenMarketMakers: number };
  rows: TraderProfile[];
};

// --- Feeds ---

export type Take = { text: string; model: string };

// GET /feed: recent buys (older app screens).
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

// GET /events: the ranked feed.
type EventColl = { symbol: string; name: string; floor: number | null; chain: Chain; currency: string };
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
export type FeedChain = 'all' | 'solana' | 'evm';

// --- Collections and items ---

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
  createdAt?: string | null; // YYYY-MM-DD, EVM collections (OpenSea)
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
  topFlippers: { wallet: string; name?: string | null; avatar?: string | null; flips: number; wins: number; realizedSol: number }[];
  recentSales: { signature: string; mint: string; buyer: string; buyerName?: string | null; price: number; t: number; image: string | null }[];
  about?: CollectionAbout;
};

// Collection page: About panel, Holders and Sales tabs (server collection-tabs.ts).
export type CollectionAbout = {
  changes: { label: string; pct: number | null }[];
  activity24h: { sales: number; volume: number; buyers: number; sellers: number; provenBuys: number; provenSells: number };
  fees: { marketplacePct: number | null; royaltyPct: number | null; sellerFeesPct: number | null; buyTaker: number; sellTaker: number };
  info: {
    chain: Chain; supply: number | null; owners: number | null; listed: number | null; holdersTracked: number;
    trackedSince: number | null; address: string | null; website: string | null; twitter: string | null; discord: string | null;
  };
};
export type CollectionHolder = WalletRef & {
  items: number; value: number | null; cost: number; pnl: number | null; pnlPct: number | null; avgEntry: number; avgHoldHours: number;
};
export type CollectionSale = {
  signature: string; mint: string; image: string | null; price: number; t: number; vsFloorPct: number | null;
  kind: 'listing' | 'bid'; buyer: WalletRef; seller: WalletRef;
};
// A trade drawn on the price chart as the trader's avatar.
export type ChartMarker = {
  t: number; price: number; side: 'buy' | 'sell' | 'take'; wallet: string; mint: string;
  name: string | null; avatar: string | null; tier: Tier;
  text?: string; takeId?: number; // takes: posted when the floor was at `price`
};

// One NFT (GET /items/:symbol/:id). id = Solana mint or EVM contract:tokenId.
export type ItemDetail = {
  symbol: string;
  id: string;
  chain: Chain;
  currency: string;
  collection: { symbol: string; name: string; floor: number | null; image: string | null };
  name: string | null;
  image: string | null;
  owner: { wallet: string; name: string | null; tier: Tier } | null;
  rarity: { rank: number; total: number | null; source: string } | null;
  rarityPending: boolean;
  traits: { type: string; value: string; count: number | null; pct: number | null }[];
  listing: { price: number; url: string } | null;
  lastSale: { price: number; t: number } | null;
  history: {
    signature: string; price: number; t: number; buyer: string; buyerName: string | null;
    seller: string; sellerName: string | null; flipPnl: number | null;
  }[];
  marketUrl: string;
  explorerUrl: string;
  drop?: { chain: string; address: string }; // a FloorFeed launchpad collection (no market data yet)
};

// A collection's live value for the portfolio panel (server/src/marks.ts).
export type Mark = {
  unit: string; floor: number | null; value: number | null; change24h: number | null;
  updatedAt: number | null; lastSale: { price: number; at: number } | null; sales24h?: number;
};

// --- Discovery, prices, guide ---

// Discovery panel: collections held by proven wallets / by the wallets a user follows.
export type HolderRow = {
  symbol: string; holders: number; items: number;
  wallets: { wallet: string; name: string | null; avatar: string | null; tier: Tier }[];
};
export type TickerPrice = { symbol: string; usd: number; change24hPct: number | null };

export type GuideBlock =
  | { p: string }
  | { list: { term: string; text: string }[] }
  | { steps: string[] }
  | { tip: string }
  | { img: string; alt: string; caption?: string; w: number; h: number }; // img: site path; w/h in pixels (2x)
export type GuidePart = 'basics' | 'paper' | 'real';
export type GuideSection = { id: string; part: GuidePart; title: string; blocks: GuideBlock[] };
export type Guide = { parts: { id: GuidePart; title: string; blurb: string }[]; sections: GuideSection[] };

export const marketApi = {
  // Display names for wallets (FloorFeed account name, else .sol / ENS); lib/names.ts batches these.
  names: (wallets: string[]) => req<Record<string, string | null>>('/names' + qs({ w: wallets.join(',') })),
  collections: () => req<CollectionSummary[]>('/collections'),
  collection: (symbol: string, range: number) => req<CollectionDetail>(path`/collections/${symbol}` + qs({ range })),
  collectionHolders: (symbol: string) => req<CollectionHolder[]>(path`/collections/${symbol}/holders`),
  collectionSales: (symbol: string) => req<CollectionSale[]>(path`/collections/${symbol}/sales`),
  collectionMarkers: (symbol: string, range: number, proven: boolean, wallets: string[], takes = false) =>
    req<ChartMarker[]>(path`/collections/${symbol}/markers` + qs({
      range, proven: proven ? '1' : '0', takes: takes ? '1' : '0', wallets: wallets.join(','),
    })),
  item: (symbol: string, id: string) => req<ItemDetail>(path`/items/${symbol}/${id}`),
  marks: (symbols: string[]) => req<Record<string, Mark>>('/portfolio/marks' + qs({ c: symbols.join(',') })),

  feed: (p: { before?: number; following?: string } = {}) =>
    req<FeedItem[]>('/feed' + qs({ limit: 25, before: p.before || undefined, following: p.following })),
  events: (p: { view: FeedView; before?: number; following?: string; chain?: FeedChain; kinds?: 'all' | 'buys' | 'flips'; hideBots?: boolean }) =>
    req<{ view: FeedView; events: FeedEvent[]; next: number | null }>('/events' + qs({
      view: p.view, limit: 30,
      kinds: p.kinds !== 'all' ? p.kinds : undefined,
      bots: p.hideBots ? 'hide' : undefined,
      chain: p.chain !== 'all' ? p.chain : undefined,
      before: p.before || undefined,
      following: p.following,
    })),
  // The AI take on one trade (generated on first request).
  take: (signature: string) => req<Take | null>(path`/takes/${signature}`),

  leaderboard: (p: { window: LeaderWindow; sort: LeaderSort; hideMM: boolean; unit: Unit }) =>
    req<Leaderboard>('/leaderboard' + qs({ limit: 50, window: p.window, sort: p.sort, hideMM: p.hideMM ? 1 : 0, unit: p.unit })),
  wallet: (address: string, unit?: Unit) => req<WalletDetail>(path`/wallets/${address}` + qs({ unit })),

  holders: (userId?: string | null) => req<{ smart: HolderRow[]; following: HolderRow[] }>('/discover/holders' + qs({ userId })),
  prices: () => req<TickerPrice[]>('/prices'),
  guide: () => req<Guide>('/guide' + qs({ v: 2 })),
};
