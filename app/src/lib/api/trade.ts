// Real trading (server routes/solana.ts, evm.ts): buy quotes, and on EVM chains
// buying, selling into offers, listing, offers and cancels through OpenSea.
import type { TypedData } from '../auth-types';
import { path, qs, req, send } from './client';
import type { Unit } from './market';
import type { EvmTxOut } from './wallet';

// Solana "buy floor" (buys open on Magic Eden until FloorFeed has API access).
export type BuyQuote = {
  collection: { symbol: string; name: string; floor: number | null };
  listing: { mint: string; price: number; name: string | null; image: string | null; rank: number | null } | null;
  networkFeeSol: number;
  balanceSol: number | null;
  executable: boolean;
  reason: string | null;
  marketUrl: string;
};

// --- EVM buy ---
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
export type EvmBuyTx = {
  chainId: number; to: string; data: string; value: string; valueEth: number; gas: string; gasCostEth: number | null;
  explorerTx?: string;
  priceEth?: number; feeEth?: number; // value = price + FloorFeed's fee
};

// --- EVM sell into the best offer ---
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

// --- EVM listings ---
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
export type EvmListBuild = { chain: string; chainId: number; net: number; parameters: Record<string, unknown>; typedData: TypedData };
export type MyListing = {
  chain: string; mint: string; symbol: string | null; collection: string | null; name: string; image: string | null;
  price: number; unit: string; expiresAt: number; listedAt: number; orderHash: string; cancelFree: boolean;
  floor: number | null; boughtAt: number | null; url: string;
};
export type EvmCancelBuild =
  | { kind: 'offchain'; chain: string; protocolAddress: string; typedData: TypedData }
  | { kind: 'onchain'; chain: string; tx: { chainId: number; to: string; data: string; value: string; explorerTx: string } };

// --- EVM offers: on one NFT (`kind: 'item'`) or any in the collection ---
export type EvmOfferQuote = {
  kind: 'item' | 'collection'; chain: string; native: string; mint: string | null; name: string; image: string | null;
  collection: { symbol: string; name: string; floor: number | null };
  days: number[];
  token?: { address: string; symbol: string; decimals: number };
  wrappable?: boolean;      // the token is the chain's coin wrapped (WETH on ETH chains), so we can wrap it here
  wrapped?: number;         // the buyer's balance of the offer token
  nativeBalance?: number;
  allowance?: number | null; // what OpenSea may spend of it; null = unlimited
  operator?: string | null;
  feePct?: number;           // what the seller gives up when they accept (comes out of the offer)
  bestOffer?: { price: number; currency: string } | null;
  mine?: { orderHash: string; price: number; expiresAt: number; cancelFree: boolean }[];
  executable: boolean; reason: string | null; marketUrl?: string;
};
export type EvmOfferBuild = {
  chain: string; chainId: number; kind: 'item' | 'collection'; parameters: Record<string, unknown>;
  criteria: Record<string, unknown> | null; typedData: TypedData;
};
export type MyOffer = {
  chain: string; orderHash: string; kind: 'item' | 'collection' | 'trait';
  symbol: string | null; collection: string | null; mint: string | null; name: string; image: string | null;
  price: number; unit: string; quantity: number; expiresAt: number; createdAt: number; cancelFree: boolean;
  floor: number | null; url: string;
};

export const tradeApi = {
  quote: (symbol: string, buyer: string) => req<BuyQuote>(path`/trade/quote/${symbol}` + qs({ buyer })),

  evmQuote: (symbol: string, buyer?: string, id?: string) => req<EvmQuote>(path`/trade/evm/quote/${symbol}` + qs({ buyer, id })),
  evmBuyTx: (b: { orderHash: string; protocolAddress: string; chain: string; buyer: string }) =>
    send<EvmBuyTx>('POST', '/trade/evm/buy-tx', b),

  evmSellQuote: (symbol: string, seller: string, id: string) =>
    req<EvmSellQuote>(path`/trade/evm/sell-quote/${symbol}` + qs({ seller, id })),
  evmApproveTx: (b: { chain: string; contract: string; owner: string; operator: string }) =>
    send<EvmTxOut>('POST', '/trade/evm/approve-tx', b),
  evmSellTx: (b: { orderHash: string; protocolAddress: string; chain: string; seller: string; mint: string }) =>
    send<EvmTxOut>('POST', '/trade/evm/sell-tx', b),

  evmListQuote: (symbol: string, id: string, seller: string) =>
    req<EvmListQuote>(path`/trade/evm/list-quote/${symbol}` + qs({ id, seller })),
  evmListBuild: (b: { symbol: string; id: string; seller: string; price: number; days: number }) =>
    send<EvmListBuild>('POST', '/trade/evm/list-build', b),
  evmListSubmit: (b: { chain: string; parameters: Record<string, unknown>; signature: string }) =>
    send<{ orderHash: string | null }>('POST', '/trade/evm/list-submit', b),
  evmListings: (address: string) => req<{ listings: MyListing[] }>(path`/trade/evm/listings/${address}`),
  // Cancels both listings and offers.
  evmCancelBuild: (b: { chain: string; orderHash: string; seller: string }) =>
    send<EvmCancelBuild>('POST', '/trade/evm/cancel-build', b),
  evmCancelSubmit: (b: { chain: string; protocolAddress: string; orderHash: string; signature: string; seller: string }) =>
    send<{ ok: true }>('POST', '/trade/evm/cancel-submit', b),

  evmOfferQuote: (symbol: string, buyer: string, id?: string | null) =>
    req<EvmOfferQuote>(path`/trade/evm/offer-quote/${symbol}` + qs({ buyer, id })),
  evmWrapTx: (b: { symbol: string; owner: string; amount: number }) =>
    send<EvmTxOut & { amount: number; symbol: string }>('POST', '/trade/evm/wrap-tx', b),
  evmOfferApproveTx: (b: { symbol: string; owner: string; operator: string }) =>
    send<EvmTxOut & { symbol: string }>('POST', '/trade/evm/offer-approve-tx', b),
  evmOfferBuild: (b: { symbol: string; id?: string | null; buyer: string; price: number; days: number }) =>
    send<EvmOfferBuild>('POST', '/trade/evm/offer-build', b),
  evmOfferSubmit: (b: { chain: string; kind: 'item' | 'collection'; parameters: Record<string, unknown>; signature: string; criteria?: Record<string, unknown> | null }) =>
    send<{ orderHash: string | null }>('POST', '/trade/evm/offer-submit', b),
  evmOffers: (address: string) => req<{ offers: MyOffer[] }>(path`/trade/evm/offers/${address}`),
};
