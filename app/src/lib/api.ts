// Point EXPO_PUBLIC_API_URL at the server's LAN address when running on a
// phone (localhost only works for web/simulators on the same machine).
const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8030';
// Absolute API URL (BASE may be relative, e.g. '/api'), for code outside fetch helpers.
export const apiUrl = (path: string) => new URL(BASE + path, typeof location !== 'undefined' ? location.href : 'http://localhost').toString();

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
  realizedSol: number; // in `unit`
  unit?: Unit;         // the currency this wallet flips most in
  realizedUsd?: number | null;
  quality: number;
};
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
export type Ecosystem = 'solana' | 'evm';

export type PaperPosition = {
  id: number;
  collection: { symbol: string; name: string; floor: number | null; image?: string | null };
  currency: string; // SOL or ETH: each position stays in its collection's unit
  entryPrice: number;
  exitPrice: number | null;
  open: boolean;
  pnlSol: number;
  openedAt: number;
  copiedFrom: string | null;
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

export type LeaderWindow = '7' | '30' | 'all';
export type LeaderSort = 'pnl' | 'winrate' | 'roi' | 'flips';

export type Leaderboard = {
  windowDays: number | null;
  unit?: Unit;
  summary: { wallets: number; flips: number; realizedSol: number; profitableWallets: number; hiddenMarketMakers: number };
  rows: TraderProfile[];
};

export type Chain = 'solana' | 'ethereum' | 'base' | 'polygon' | 'abstract' | 'ink' | 'arbitrum'
  | 'hyperevm' | 'ronin' | 'apechain' | 'monad' | 'robinhood';
// Currencies P&L is kept in. A wallet's numbers are always in one of these.
export type Unit = 'SOL' | 'ETH' | 'HYPE' | 'RON' | 'APE' | 'MON';

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
};
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
// A mint (OpenSea drop): live or upcoming.
export type Drop = {
  slug: string; name: string; chain: string; image: string | null; url: string; minting: boolean; featured: boolean;
  stage: string | null; price: number | null; currency: string; priceUsd: number | null; startsAt: number | null; endsAt: number | null;
};

export type DropStage = {
  id: string | null; label: string; kind: string | null; price: number | null; nativePriced: boolean;
  startsAt: number | null; endsAt: number | null; maxPerWallet: number | null; allowlist: boolean;
};
export type DropDetail = {
  slug: string; name: string; chain: string; chainName: string; native: string; contract: string; dropType: string | null;
  image: string | null; banner: string | null; description: string | null; verified: boolean;
  website: string | null; twitter: string | null; discord: string | null;
  minting: boolean; active: DropStage | null; next: DropStage | null; stages: DropStage[];
  minted: number | null; max: number | null; soldOut: boolean; creatorFeeBps: number | null;
  supported: boolean; url: string; balance: number | null;
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
  chain?: string; // EVM holdings: which chain
  unit?: Unit;    // EVM holdings: the collection's currency
  name: string | null;
  image: string | null;
  collection: { symbol: string; name: string; floor: number | null };
  estValue: number | null; // floor minus the sell haircut (est. bid)
  boughtAt: number | null; // this wallet's last on-chain buy price, if we saw it
  listing?: { price: number; expiresAt: number; orderHash: string } | null; // live OpenSea listing (EVM)
};
// A collection's live value for the portfolio panel (server/src/marks.ts).
export type Mark = {
  unit: string; floor: number | null; value: number | null; change24h: number | null;
  updatedAt: number | null; lastSale: { price: number; at: number } | null; sales24h?: number;
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

// Ethereum / Base (amounts in ETH).
export type EvmHoldings = {
  address: string; eth: number; balances: Record<string, number>;
  // One value per currency: native balance plus NFTs marked in that unit.
  values?: Record<string, { cash: number; nfts: number; nftValue: number; total: number }>;
  nftValue: number; totalValue: number; nfts: Holding[]; untracked: number;
};
export type EvmQuote = {
  collection: { symbol: string; name: string; floor: number | null };
  chain: string;
  currency?: Unit;         // the collection's unit
  native?: string | null;  // the chain's gas token, what a buy is paid in
  balance?: number | null; // buyer's balance in `native`
  elsewhere?: { chain: string; balance: number }[]; // the same token on other chains
  gasReserve?: number | null; // estimated gas for the buy, in `native`
  fee?: { pct: number; amount: number } | null; // FloorFeed's fee on top of the price, when one is set
  listing: {
    mint: string; price: number; currency?: string; orderHash: string | null; protocolAddress: string | null; chain: string;
    name: string | null; image: string | null;
  } | null;
  balanceEth: number | null;
  executable: boolean;
  reason: string | null;
  marketUrl: string;
};
export type EvmSellQuote = {
  collection: { symbol: string; name: string; floor: number | null };
  listing?: { price: number; expiresAt: number; orderHash: string; chain: string; cancelFree: boolean } | null; // also listed on OpenSea
  chain: string; mint: string; name: string; image: string | null;
  boughtAt: number | null;
  offer: {
    price: number; net: number; currency: string; unit: string; orderHash: string; protocolAddress: string; chain: string;
    kind: 'item' | 'trait' | 'collection'; expiresAt: number | null; belowFloor: number | null;
  } | null;
  owned: boolean | null;
  approved: boolean | null;
  operator: string | null;
  executable: boolean;
  reason: string | null;
  marketUrl: string;
};
export type EvmTxOut = { chainId: number; to: string; data: string; value: string; gas: string; explorerTx?: string };
export type BridgeQuote = {
  requestId: string | null; from: string; to: string; recipient: string;
  side?: 'send' | 'receive'; reserve?: number | null; // what the amount meant; kept back for gas with a % / Max
  send: number; sendUnit: string; sendUsd: number | null;
  receive: number; receiveUnit: string;
  feeUsd: number | null; gasUsd: number | null; seconds: number | null;
  appFeeUsd: number | null; appFeePct: number | null; // FloorFeed's fee, when one is set
  balance: number | null; problem: string | null;
  tx: EvmTxOut | null;                                      // EVM origin
  solTx: { transaction: string; explorerTx: string } | null; // Solana origin (unsigned, base64; blockhash lasts ~1 min)
};
export type EvmListQuote = {
  chain: string; unit: string; mint: string; name: string; collection: { symbol: string; name: string };
  owned?: boolean; floor?: number | null; lastSale?: number | null; boughtAt?: number | null;
  market?: {
    lastSale: { price: number; at: number } | null; median: number | null; high24h: number | null; sales24h: number;
    recent: { price: number; at: number; id: string; kind: 'listing' | 'offer' }[];
  };
  bestOffer?: { price: number; net: number; currency: string } | null;
  fees?: { pct: number; recipient: string }[]; feePct?: number;
  approved?: boolean; operator?: string | null; days?: number[];
  listing?: { orderHash: string; price: number; expiresAt: number; cancelFree: boolean } | null;
  executable: boolean; reason: string | null; marketUrl?: string;
};
export type MyListing = {
  chain: string; mint: string; symbol: string | null; collection: string | null; name: string; image: string | null;
  price: number; unit: string; expiresAt: number; listedAt: number; orderHash: string; cancelFree: boolean;
  floor: number | null; boughtAt: number | null; url: string;
};
export type EvmListBuild = { chain: string; chainId: number; net: number; parameters: Record<string, unknown>; typedData: import('./auth-types').TypedData };
export type EvmCancelBuild =
  | { kind: 'offchain'; chain: string; protocolAddress: string; typedData: import('./auth-types').TypedData }
  | { kind: 'onchain'; chain: string; tx: { chainId: number; to: string; data: string; value: string; explorerTx: string } };
export type EvmNetwork = {
  chain: string; name: string; chainId: number; native: string; balance: number | null;
  tokens: { address: string; symbol: string; unit: string; unwrappable: boolean; balance: number | null }[];
};
export type ActivityKind = 'buy' | 'sell' | 'approve' | 'bridge' | 'send' | 'unwrap' | 'mint';
export type ActivityItem = {
  hash: string; chain: string; kind: ActivityKind; title: string; amount: number | null; unit: string | null;
  symbol: string | null; mint: string | null; toChain: string | null;
  status: 'pending' | 'confirmed' | 'delivering' | 'failed' | 'dropped' | 'refunded';
  createdAt: number; explorerUrl: string; outUrl: string | null;
};
export type EvmBuyTx = {
  chainId: number; to: string; data: string; value: string; valueEth: number; gas: string; gasCostEth: number | null;
  explorerTx?: string;
  priceEth?: number; feeEth?: number; // value = price + FloorFeed's fee
};

export type Alert = {
  id: number; wallet: string; name: string | null; avatar: string | null; side: 'buy' | 'sell';
  collection: { symbol: string; name: string }; currency: Unit; mint: string;
  price: number; pnl: number | null; image: string | null; t: number; read: boolean;
};
export type PushSubscriptionBody = { endpoint: string; keys: { p256dh: string; auth: string } };

// Discovery panel: collections held by proven wallets / by the wallets a user follows.
export type HolderRow = {
  symbol: string; holders: number; items: number;
  wallets: { wallet: string; name: string | null; avatar: string | null; tier: Tier }[];
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
export type WalletRef = { wallet: string; name: string | null; avatar: string | null; tier: Tier };
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

// Takes on a collection (server takes.ts): users' posts, plus FloorFeed's AI takes on notable buys.
export type UserTake = {
  kind: 'user'; id: number; text: string; t: number;
  author: { name: string; walletName: string | null; avatar: string | null; wallet: string | null; tier: Tier };
  holder: { items: number; pnlPct: number | null } | null; verified: boolean;
  floor: number | null; likes: number; liked: boolean; mine: boolean;
};
export type AiTake = { kind: 'ai'; id: string; text: string; t: number; trade: { buyer: string; buyerName: string | null; price: number; mint: string } };
export type TakeItem = UserTake | AiTake;
// The live thesis feed across collections.
export type FeedColl = { symbol: string; name: string; image: string | null; currency: string; chain: Chain };
export type ThesisFeedItem = (UserTake & { collection: FeedColl }) | (AiTake & { collection: FeedColl });
export type GuideBlock =
  | { p: string }
  | { list: { term: string; text: string }[] }
  | { steps: string[] }
  | { tip: string }
  | { img: string; alt: string; caption?: string; w: number; h: number }; // img: site path; w/h in pixels (2x)
export type GuidePart = 'basics' | 'paper' | 'real';
export type GuideSection = { id: string; part: GuidePart; title: string; blocks: GuideBlock[] };
export type Guide = { parts: { id: GuidePart; title: string; blurb: string }[]; sections: GuideSection[] };
export type TickerPrice = { symbol: string; usd: number; change24hPct: number | null };

export const api = {
  // Verifies the Privy token and moves this device's follows/paper trades to the account.
  session: (deviceId: string) => send('POST', '/auth/session', { deviceId }) as Promise<{ userId: string }>,
  capabilities: () => req<Capabilities>('/capabilities'),
  balance: (address: string) => req<{ lamports: number; sol: number }>(`/chain/balance/${address}`),
  holdings: (address: string) => req<Holdings>(`/chain/holdings/${address}`),
  quote: (symbol: string, buyer: string) => req<BuyQuote>(`/trade/quote/${symbol}?buyer=${buyer}`),
  evmBalance: (address: string) => req<Record<string, number> & { eth: number }>(`/chain/evm/balance/${address}`),
  // FloorFeed (Privy) EVM wallet: fields to sign, then broadcast through our RPC.
  evmPrepare: (b: { chainId: number; from: string; to: string; data: string; value: string; gas?: string }) =>
    send('POST', '/chain/evm/prepare', b) as Promise<import('./auth-types').PreparedEvm & { chainId: number }>,
  evmSend: (b: { from: string; tx: Record<string, string | number>; signed: string }) =>
    (send('POST', '/chain/evm/send', b) as Promise<{ hash: string }>).then((r) => r.hash),
  // Broadcast a signed Solana transaction (base64) through our RPC; resolves to its signature.
  solSend: (transaction: string) => (send('POST', '/chain/sol/send', { transaction }) as Promise<{ signature: string }>).then((r) => r.signature),
  evmListQuote: (symbol: string, id: string, seller: string) =>
    req<EvmListQuote>(`/trade/evm/list-quote/${symbol}?id=${encodeURIComponent(id)}&seller=${seller}`),
  evmListBuild: (b: { symbol: string; id: string; seller: string; price: number; days: number }) =>
    send('POST', '/trade/evm/list-build', b) as Promise<EvmListBuild>,
  evmListSubmit: (b: { chain: string; parameters: Record<string, unknown>; signature: string }) =>
    send('POST', '/trade/evm/list-submit', b) as Promise<{ orderHash: string | null }>,
  evmListings: (address: string) => req<{ listings: MyListing[] }>(`/trade/evm/listings/${address}`),
  evmCancelBuild: (b: { chain: string; orderHash: string; seller: string }) =>
    send('POST', '/trade/evm/cancel-build', b) as Promise<EvmCancelBuild>,
  evmCancelSubmit: (b: { chain: string; protocolAddress: string; orderHash: string; signature: string; seller: string }) =>
    send('POST', '/trade/evm/cancel-submit', b) as Promise<{ ok: true }>,
  marks: (symbols: string[]) => req<Record<string, Mark>>(`/portfolio/marks?c=${encodeURIComponent(symbols.join(','))}`),
  evmHoldings: (address: string) => req<EvmHoldings>(`/chain/evm/holdings/${address}`),
  evmQuote: (symbol: string, buyer?: string, id?: string) => {
    const q = new URLSearchParams();
    if (buyer) q.set('buyer', buyer);
    if (id) q.set('id', id);
    return req<EvmQuote>(`/trade/evm/quote/${encodeURIComponent(symbol)}?${q}`);
  },
  evmBuyTx: (b: { orderHash: string; protocolAddress: string; chain: string; buyer: string }) =>
    send('POST', '/trade/evm/buy-tx', b) as Promise<EvmBuyTx>,
  drop: (slug: string, minter?: string) =>
    req<DropDetail>(`/drops/${encodeURIComponent(slug)}${minter ? `?minter=${minter}` : ''}`),
  dropMintTx: (slug: string, b: { minter: string; quantity: number }) =>
    send('POST', `/drops/${encodeURIComponent(slug)}/mint-tx`, b) as Promise<EvmTxOut & { total: number; unit: string }>,
  evmNetworks: (address: string) => req<EvmNetwork[]>(`/chain/evm/networks/${address}`),
  evmUnwrapTx: (b: { chain: string; owner: string; token: string; amount?: number }) =>
    send('POST', '/chain/evm/unwrap-tx', b) as Promise<EvmTxOut & { amount: number; symbol: string; unit: string }>,
  activity: (wallet: string) => req<ActivityItem[]>(`/activity/${wallet}`),
  recordActivity: (a: {
    hash: string; wallet: string; chain: string; kind: ActivityKind; title: string;
    amount?: number | null; unit?: string | null; symbol?: string | null; mint?: string | null;
    requestId?: string | null; toChain?: string | null;
  }) => send('POST', '/activity', a) as Promise<{ ok: boolean }>,
  bridgeQuote: (b: { user: string; recipient?: string; from: string; to: string; amount?: number; side?: 'send' | 'receive'; fraction?: number }) =>
    send('POST', '/bridge/quote', b) as Promise<BridgeQuote>,
  // `deposit`: mined | failed | pending | missing (the wallet's tx never reached the chain).
  bridgeStatus: (requestId: string, deposit?: { chain: string; tx: string }) =>
    req<{ status: string; outTx: string | null; deposit?: 'mined' | 'failed' | 'pending' | 'missing' | null }>(
      `/bridge/status/${requestId}${deposit ? `?${new URLSearchParams(deposit)}` : ''}`),
  evmSellQuote: (symbol: string, seller: string, id: string) =>
    req<EvmSellQuote>(`/trade/evm/sell-quote/${encodeURIComponent(symbol)}?${new URLSearchParams({ seller, id })}`),
  evmApproveTx: (b: { chain: string; contract: string; owner: string; operator: string }) =>
    send('POST', '/trade/evm/approve-tx', b) as Promise<EvmTxOut>,
  evmSellTx: (b: { orderHash: string; protocolAddress: string; chain: string; seller: string; mint: string }) =>
    send('POST', '/trade/evm/sell-tx', b) as Promise<EvmTxOut>,
  feed: (p: { before?: number; following?: string } = {}) => {
    const q = new URLSearchParams({ limit: '25' });
    if (p.before) q.set('before', String(p.before));
    if (p.following) q.set('following', p.following);
    return req<FeedItem[]>(`/feed?${q}`);
  },
  events: (p: { view: FeedView; before?: number; following?: string; chain?: FeedChain }) => {
    const q = new URLSearchParams({ view: p.view, limit: '30' });
    if (p.chain && p.chain !== 'all') q.set('chain', p.chain);
    if (p.before) q.set('before', String(p.before));
    if (p.following) q.set('following', p.following);
    return req<{ view: FeedView; events: FeedEvent[]; next: number | null }>(`/events?${q}`);
  },
  take: (signature: string) => req<Take | null>(`/takes/${encodeURIComponent(signature)}`),
  collections: () => req<CollectionSummary[]>('/collections'),
  collection: (symbol: string, range: number) => req<CollectionDetail>(`/collections/${symbol}?range=${range}`),
  leaderboard: (p: { window: LeaderWindow; sort: LeaderSort; hideMM: boolean; unit: Unit }) =>
    req<Leaderboard>(`/leaderboard?limit=50&window=${p.window}&sort=${p.sort}&hideMM=${p.hideMM ? 1 : 0}&unit=${p.unit}`),
  wallet: (address: string, unit?: Unit) => req<WalletDetail>(`/wallets/${address}${unit ? `?unit=${unit}` : ''}`),
  item: (symbol: string, id: string) => req<ItemDetail>(`/items/${encodeURIComponent(symbol)}/${encodeURIComponent(id)}`),
  alerts: (userId: string) => req<{ unread: number; push: boolean; alerts: Alert[] }>(`/alerts/${encodeURIComponent(userId)}`),
  unread: (userId: string) => req<{ unread: number; push: boolean }>(`/alerts/${encodeURIComponent(userId)}/unread`),
  markRead: (userId: string) => send('POST', `/alerts/${encodeURIComponent(userId)}/read`, {}),
  takes: (symbol: string, userId?: string | null) =>
    req<TakeItem[]>(`/collections/${encodeURIComponent(symbol)}/takes${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  theses: (userId?: string | null) =>
    req<ThesisFeedItem[]>(`/theses?limit=40${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`),
  profile: () => req<{ name: string | null; fallback: string }>('/profile'),
  setProfileName: (name: string) => req<{ name: string }>('/profile', { method: 'PUT', body: JSON.stringify({ name }) }),
  takeMessage: (collection: string, text: string, ts: number) =>
    req<{ message: string }>(`/takes/message?${new URLSearchParams({ collection, text, ts: String(ts) })}`),
  postTake: (b: { collection: string; text: string; wallet?: string; signature?: string; ts?: number }) =>
    send('POST', '/takes', b) as Promise<{ id: number }>,
  likeTake: (id: number, userId: string) => send('POST', `/takes/${id}/like`, { userId }) as Promise<{ liked: boolean; likes: number }>,
  reportTake: (id: number, userId: string) => send('POST', `/takes/${id}/report`, { userId }),
  deleteTake: (id: number) => req<{ ok: boolean }>(`/takes/${id}`, { method: 'DELETE' }),
  blockhash: () => req<{ blockhash: string; lastValidBlockHeight: string }>('/chain/blockhash'),
  evmTransferFee: (chain: string) => req<{ chain: string; chainId: number; native: string; fee: number }>(`/chain/evm/transfer-fee?chain=${chain}`),
  evmNftTransfer: (b: { chain: string; contract: string; tokenId: string; from: string; to: string }) =>
    send('POST', '/chain/evm/nft-transfer', b) as Promise<{ chainId: number; to: string; data: string; value: string; gas: string; standard: string }>,
  pushKey: () => req<{ key: string }>('/push/key'),
  subscribePush: (userId: string, subscription: PushSubscriptionBody) => send('POST', '/push/subscribe', { userId, subscription }),
  unsubscribePush: (endpoint: string) => send('POST', '/push/unsubscribe', { endpoint }),
  holders: (userId?: string | null) =>
    req<{ smart: HolderRow[]; following: HolderRow[] }>(`/discover/holders${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  prices: () => req<TickerPrice[]>('/prices'),
  drops: () => req<Drop[]>('/drops'),
  guide: () => req<Guide>('/guide?v=2'),
  collectionHolders: (symbol: string) => req<CollectionHolder[]>(`/collections/${encodeURIComponent(symbol)}/holders`),
  collectionSales: (symbol: string) => req<CollectionSale[]>(`/collections/${encodeURIComponent(symbol)}/sales`),
  collectionMarkers: (symbol: string, range: number, proven: boolean, wallets: string[], takes = false) => {
    const q = new URLSearchParams({ range: String(range), proven: proven ? '1' : '0', takes: takes ? '1' : '0' });
    if (wallets.length) q.set('wallets', wallets.join(','));
    return req<ChartMarker[]>(`/collections/${encodeURIComponent(symbol)}/markers?${q}`);
  },
  follows: (userId: string) => req<string[]>(`/follows/${userId}`),
  follow: (userId: string, wallet: string) => send('POST', '/follows', { userId, wallet }),
  unfollow: (userId: string, wallet: string) => send('DELETE', '/follows', { userId, wallet }),
  paper: (userId: string) =>
    req<{
      positions: PaperPosition[];
      totals?: Record<string, { realized: number; unrealized: number }>;
      realizedSol: number;
      unrealizedSol: number;
    }>(`/paper/${userId}`),
  buyFloor: (userId: string, collection: string, copiedFrom?: string, count = 1) =>
    send('POST', '/paper/buy', { userId, collection, copiedFrom, count }) as Promise<{ entryPrice: number; entryPrices?: number[]; total?: number }>,
  resetPaper: (userId: string) => send('POST', '/paper/reset', { userId }) as Promise<{ deleted: number }>,
  sell: (userId: string, positionId: number) =>
    send('POST', '/paper/sell', { userId, positionId }) as Promise<{ exitPrice: number }>,
};
