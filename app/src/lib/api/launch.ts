// Launchpad (server routes/launch.ts): creators' drafts, uploads, deploy and
// manage transactions, and the public mint page of a launched collection.
import { path, qs, req, send } from './client';
import type { EvmTxOut } from './wallet';

export type LaunchConfig = {
  enabled: boolean; uploads: boolean; chains: { id: string; name: string; native: string }[];
  factory: string | null; maxItems: number; gateway: string;
};
export type LaunchPhaseIn = { name: string; start: number; end: number; price: string; maxPerWallet: number; allowlist: boolean;
  members?: boolean; // FloorFeed members phase: any signed-in account, limit per account
};
export type LaunchDraftIn = {
  chain: string; name: string; symbol: string; description: string; website?: string | null; twitter?: string | null;
  royaltyBps: number; royaltyTo?: string | null; storage: 'ipfs' | 'onchain'; reveal: 'instant' | 'later';
  coverCid?: string | null; bannerCid?: string | null; placeholderCid?: string | null; phases: LaunchPhaseIn[];
};
export type LaunchDraft = Omit<LaunchDraftIn, 'storage' | 'reveal'> & {
  id: string; storage: string; reveal: string; allowlists: Record<string, number>; items: number;
  metaCid: string | null; contractUri: string | null; creator: string | null; address: string | null; deployTx: string | null;
  status: 'draft' | 'live'; createdAt: number; updatedAt: number;
};
export type LaunchItemIn = { idx: number; cid: string; mime?: string; name?: string; attributes?: { trait_type: string; value: string | number }[] };
export type LaunchedPhase = {
  index: number; name: string; start: number; end: number; price: number; maxPerWallet: number; allowlist: boolean;
  allowlistSize: number | null; members: boolean; eligible: boolean | null; mintedByWallet: number | null; mintedByAccount: number | null; active: boolean;
};
export type LaunchedCollection = {
  id: string; chain: string; chainName: string; native: string; address: string; name: string; symbol: string; description: string;
  website: string | null; twitter: string | null; image: string | null; banner: string | null; creator: string;
  minted: number; max: number; soldOut: boolean; mintFee: number; revealed: boolean; phases: LaunchedPhase[];
  royaltyBps: number; balance: number | null; explorer: string;
};

// Every draft route takes the creator's userId (body, or query for GETs).
const draft = (id: string, rest = '') => path`/launch/drafts/${id}` + rest;

export const launchApi = {
  launchConfig: () => req<LaunchConfig>('/launch/config'),
  myLaunches: (userId: string) => req<{ launches: LaunchDraft[] }>('/launch/mine' + qs({ userId })),
  createLaunch: (userId: string, d: LaunchDraftIn) => send<LaunchDraft>('POST', '/launch/drafts', { userId, draft: d }),
  getLaunch: (userId: string, id: string) => req<LaunchDraft>(draft(id) + qs({ userId })),
  updateLaunch: (userId: string, id: string, d: LaunchDraftIn) => send<LaunchDraft>('PUT', draft(id), { userId, draft: d }),
  deleteLaunch: (userId: string, id: string) => send<{ ok: true }>('DELETE', draft(id), { userId }),
  // Signed upload URLs for `count` files.
  launchSign: (userId: string, id: string, count: number, kind: 'art' | 'image') =>
    send<{ urls: string[] }>('POST', draft(id, '/sign'), { userId, count, kind }),
  launchItems: (userId: string, id: string, items: LaunchItemIn[]) => send<{ items: number }>('POST', draft(id, '/items'), { userId, items }),
  launchTrim: (userId: string, id: string, n: number) => send<{ items: number }>('POST', draft(id, '/trim'), { userId, n }),
  launchListItems: (userId: string, id: string, offset = 0, limit = 48) =>
    req<{ items: (LaunchItemIn & { attributes: { trait_type: string; value: string | number }[] })[] }>(
      draft(id, '/items') + qs({ userId, offset, limit })),
  launchAllowlist: (userId: string, id: string, phase: number, wallets: string[]) =>
    send<{ phase: number; wallets: number; skipped: number }>('POST', draft(id, '/allowlist'), { userId, phase, wallets }),
  launchMetadata: (userId: string, id: string) => send<LaunchDraft>('POST', draft(id, '/metadata'), { userId }),
  launchDeployTx: (userId: string, id: string, creator: string) =>
    send<EvmTxOut & { predicted: string; mintFee: number }>('POST', draft(id, '/deploy-tx'), { userId, creator }),
  launchDeployed: (userId: string, id: string, hash: string) => send<LaunchDraft>('POST', draft(id, '/deployed'), { userId, hash }),
  launchManageTx: (userId: string, id: string, action: 'reveal' | 'withdraw' | 'freeze') =>
    send<EvmTxOut & { owner: string }>('POST', draft(id, '/manage-tx'), { userId, action }),

  launched: (chain: string, address: string, wallet?: string, userId?: string) =>
    req<LaunchedCollection>(path`/launch/c/${chain}/${address}` + qs({ wallet, userId })),
  // userId (a signed-in account) is needed for FloorFeed members phases.
  launchMintTx: (chain: string, address: string, b: { minter: string; phase: number; quantity: number; userId?: string }) =>
    send<EvmTxOut & { total: number; unit: string }>('POST', path`/launch/c/${chain}/${address}/mint-tx`, b),
};
