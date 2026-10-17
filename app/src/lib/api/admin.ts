// The owner's admin panel (server routes/admin.ts, admin.ts). Every call 404s
// unless the signed-in account is an admin.
import { path, qs, req, send } from './client';

export type AdminRevenue = {
  days: number;
  totalAllTime: number; totalWindow: number;
  streams: { id: 'bridge' | 'buy' | 'launch'; label: string; allTime: number; window: number | null; count: number; pending: number; setting: string }[];
  daily: { day: string; bridge: number; buy: number }[];
  routes: { route: string; bridges: number; usd: number }[];
  relay: { feeWallet: string | null; claimableUsd: number | null; currency: string | null; claimUrl: string };
  launches: { id: string; name: string; chain: string; address: string; status: string; minted: number; max: number; feeEach: number; unit: string; fees: number; usd: number | null }[];
  factory: { chain: string; mintFee: number; unit: string; recipient: string | null }[];
};

export type AdminUser = {
  id: string; name: string | null; joinedAt: number; method: string; contact: string | null; twoStep: boolean;
  wallets: number; practiceTrades: number; follows: number; theses: number; realTxs: number;
};
export type AdminUsers = {
  days: number; total: number; newInWindow: number; named: number; twoStep: number; traders: number;
  signups: { day: string; n: number }[];
  anonymous: { practice: number; follows: number; push: number };
  rows: AdminUser[];
};

type Count = { visitors: number };
export type AdminMarketing = {
  days: number;
  totals: { visitors: number; pageviews: number };
  daily: { day: string; visitors: number; pageviews: number }[];
  sources: ({ source: string } & Count)[];
  pages: ({ path: string; views: number } & Count)[];
  countries: ({ country: string } & Count)[];
  devices: ({ device: string } & Count)[];
  funnel: { step: string; visitors: number }[];
  events: { name: string; count: number; visitors: number }[];
  campaigns: { source: string; medium: string; campaign: string; visitors: number; signins: number }[];
  quality: { source: string; visitors: number; signins: number; traders: number }[];
  x: {
    posted: { kind: string; n: number }[]; queued: number; failed: number; lastPostedAt: number | null; fromX: number;
    recent: { kind: string; text: string; url: string | null; postedAt: number }[];
  };
};

export type AdminActivity = {
  days: number;
  byKind: { kind: string; n: number; wallets: number }[];
  volume: { kind: string; unit: string; amount: number; n: number; usd: number | null }[];
  byChain: { chain: string; n: number }[];
  failed: { status: string; n: number }[];
  recent: { createdAt: number; kind: string; title: string; chain: string; amount: number | null; unit: string | null; status: string; feeUsd: number | null; name: string | null }[];
  practice: { n: number; traders: number };
};

export type AdminModeration = {
  takes: { id: number; collection: string; text: string; reports: number; hidden: number; createdAt: number; name: string | null }[];
  support: { id: number; created_at: number; topic: string; message: string; contact: string | null; tx: string | null; wallets: string[]; page: string | null; status: string }[];
  launches: { id: string; name: string; symbol: string; chain: string; status: string; address: string | null; updatedAt: number; owner: string | null; items: number }[];
};

export type AdminSystem = {
  uptimeSec: number; memoryMb: number; dbBytes: number | null; lastEventAt: number | null; stuck: number;
  tradesByChain24h: { chain: string; last: number; n: number }[];
  tables: Record<string, number>;
  config: { helius: boolean; privy: boolean; adminUsers: number; relayFeeBps: number; buyFeeBps: number; launchChains: string[] };
};

const d = (days: number) => qs({ days });

export const adminApi = {
  adminMe: () => req<{ admin: boolean }>('/admin/me'),
  adminRevenue: (days: number) => req<AdminRevenue>(`/admin/revenue${d(days)}`),
  adminUsers: (days: number) => req<AdminUsers>(`/admin/users${d(days)}`),
  adminMarketing: (days: number) => req<AdminMarketing>(`/admin/marketing${d(days)}`),
  adminActivity: (days: number) => req<AdminActivity>(`/admin/activity${d(days)}`),
  adminModeration: () => req<AdminModeration>('/admin/moderation'),
  adminSystem: () => req<AdminSystem>('/admin/system'),
  adminRestoreTake: (id: number) => send<{ ok: true }>('POST', path`/admin/takes/${id}/restore`, {}),
  adminDeleteTake: (id: number) => req<{ ok: true }>(path`/admin/takes/${id}`, { method: 'DELETE' }),
  adminSupport: (id: number, action: 'close' | 'reopen') => send<{ ok: true }>('POST', path`/admin/support/${id}/${action}`, {}),
  adminLaunch: (id: string, action: 'hide' | 'show') => send<{ ok: true }>('POST', path`/admin/launches/${id}/${action}`, {}),
};
