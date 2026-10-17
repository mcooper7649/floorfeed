// Wallets on every chain (server routes/solana.ts, evm.ts, wallet.ts): balances,
// holdings, broadcasting signed transactions, sends, bridging, activity and history.
import type { PreparedEvm } from '../auth-types';
import { BASE, path, qs, req, send } from './client';
import type { Unit } from './market';

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
  drop?: { chain: string; address: string }; // from a FloorFeed launchpad collection: no floor yet, opens its mint page
};
export type Holdings = { address: string; sol: number; nftValue: number; totalValue: number; nfts: Holding[]; untracked: number };
// Ethereum / Base (amounts in ETH).
export type EvmHoldings = {
  address: string; eth: number; balances: Record<string, number>;
  // One value per currency: native balance plus NFTs marked in that unit.
  values?: Record<string, { cash: number; nfts: number; nftValue: number; total: number }>;
  nftValue: number; totalValue: number; nfts: Holding[]; untracked: number;
};
export type EvmNetwork = {
  chain: string; name: string; chainId: number; native: string; balance: number | null;
  tokens: { address: string; symbol: string; unit: string; unwrappable: boolean; balance: number | null }[];
};

// An unsigned, simulated EVM transaction for the user's wallet.
export type EvmTxOut = { chainId: number; to: string; data: string; value: string; gas: string; explorerTx?: string };
// A coin transfer to any address, built and simulated by the API: `tx` for an
// EVM wallet, `solTx` (unsigned base64; blockhash lasts ~1 min) for Solana.
export type SendTx = (Partial<EvmTxOut> & { solTx?: { transaction: string; explorerTx: string } }) & {
  amount: number; amountExact: string; symbol: string; unit: string; fee: number; native: string;
};
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

export type ActivityKind = 'buy' | 'sell' | 'approve' | 'bridge' | 'send' | 'unwrap' | 'mint';
export type ActivityItem = {
  hash: string; chain: string; kind: ActivityKind; title: string; amount: number | null; unit: string | null;
  symbol: string | null; mint: string | null; toChain: string | null;
  status: 'pending' | 'confirmed' | 'delivering' | 'failed' | 'dropped' | 'refunded';
  createdAt: number; explorerUrl: string; outUrl: string | null;
};
export type HistoryType =
  | 'buy' | 'sale' | 'listing' | 'offer' | 'mint' | 'launch' | 'transfer_in' | 'transfer_out'
  | 'bridge' | 'send' | 'approve' | 'unwrap';
// One row of a wallet's history: FloorFeed txs merged with the marketplace record.
// Tx statuses as ActivityItem; listings: active | sold | cancelled | expired | inactive;
// offers: active | accepted | cancelled | expired | inactive (`listing` holds the order either way).
export type HistoryEntry = {
  id: string; at: number; type: HistoryType; status: string; wallet: string; chain: string;
  title: string; name: string; collection: string | null; symbol: string | null;
  mint: string | null; tokenId: string | null; image: string | null;
  price: number | null; unit: string | null; counterparty: string | null;
  via: 'floorfeed' | 'opensea' | 'magiceden'; saleKind: 'listing' | 'offer' | null;
  tx: string | null; explorerUrl: string | null; marketUrl: string | null;
  toChain: string | null; outUrl: string | null;
  listing: { orderHash: string; listedAt: number; expiresAt: number | null; closedAt: number | null; soldTx: string | null; buyer: string | null } | null;
};
export type History = { entries: HistoryEntry[]; more: boolean; partial: boolean };

export const walletApi = {
  capabilities: () => req<Capabilities>('/capabilities'),

  // Solana
  balance: (address: string) => req<{ lamports: number; sol: number }>(path`/chain/balance/${address}`),
  holdings: (address: string) => req<Holdings>(path`/chain/holdings/${address}`),
  blockhash: () => req<{ blockhash: string; lastValidBlockHeight: string }>('/chain/blockhash'),
  // Broadcast a signed Solana transaction (base64) through our RPC; resolves to its signature.
  solSend: (transaction: string) => send<{ signature: string }>('POST', '/chain/sol/send', { transaction }).then((r) => r.signature),

  // EVM
  evmBalance: (address: string) => req<Record<string, number> & { eth: number }>(path`/chain/evm/balance/${address}`),
  evmHoldings: (address: string) => req<EvmHoldings>(path`/chain/evm/holdings/${address}`),
  evmNetworks: (address: string) => req<EvmNetwork[]>(path`/chain/evm/networks/${address}`),
  // FloorFeed (Privy) EVM wallet: fields to sign, then broadcast through our RPC.
  evmPrepare: (b: { chainId: number; from: string; to: string; data: string; value: string; gas?: string }) =>
    send<PreparedEvm & { chainId: number }>('POST', '/chain/evm/prepare', b),
  evmSend: (b: { from: string; tx: Record<string, string | number>; signed: string }) =>
    send<{ hash: string }>('POST', '/chain/evm/send', b).then((r) => r.hash),
  evmUnwrapTx: (b: { chain: string; owner: string; token: string; amount?: number }) =>
    send<EvmTxOut & { amount: number; symbol: string; unit: string }>('POST', '/chain/evm/unwrap-tx', b),
  evmTransferFee: (chain: string) => req<{ chain: string; chainId: number; native: string; fee: number }>('/chain/evm/transfer-fee' + qs({ chain })),
  evmNftTransfer: (b: { chain: string; contract: string; tokenId: string; from: string; to: string }) =>
    send<EvmTxOut & { standard: string }>('POST', '/chain/evm/nft-transfer', b),

  // Coins to any address, on any chain.
  sendTx: (b: { chain: string; from: string; to: string; token?: string; amount?: string; max?: boolean }) =>
    send<SendTx>('POST', '/chain/send-tx', b),
  bridgeQuote: (b: { user: string; recipient?: string; from: string; to: string; amount?: number; side?: 'send' | 'receive'; fraction?: number }) =>
    send<BridgeQuote>('POST', '/bridge/quote', b),
  // `deposit`: mined | failed | pending | missing (the wallet's tx never reached the chain).
  bridgeStatus: (requestId: string, deposit?: { chain: string; tx: string }) =>
    req<{ status: string; outTx: string | null; deposit?: 'mined' | 'failed' | 'pending' | 'missing' | null }>(
      path`/bridge/status/${requestId}` + qs({ chain: deposit?.chain, tx: deposit?.tx })),

  // FloorFeed transactions and the full history.
  activity: (wallet: string) => req<ActivityItem[]>(path`/activity/${wallet}`),
  recordActivity: (a: {
    hash: string; wallet: string; chain: string; kind: ActivityKind; title: string;
    amount?: number | null; unit?: string | null; symbol?: string | null; mint?: string | null;
    requestId?: string | null; toChain?: string | null;
  }) => send<{ ok: boolean }>('POST', '/activity', a),
  history: (wallets: string[]) => req<History>('/history' + qs({ w: wallets.join(',') })),
  historyCsvUrl: (wallets: string[], o: { types?: string[]; since?: number } = {}) =>
    BASE + '/history' + qs({ w: wallets.join(','), format: 'csv', types: o.types?.join(','), since: o.since || undefined }),
};
