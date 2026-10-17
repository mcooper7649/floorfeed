// A user's own state (server routes/account.ts): sign-in, follows, paper
// trading, alerts and web push; plus support reports.
import { path, qs, req, send } from './client';
import type { Unit } from './market';

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
export type PaperBook = {
  positions: PaperPosition[];
  totals?: Record<string, { realized: number; unrealized: number }>; // per unit
  realizedSol: number;
  unrealizedSol: number;
};

// Top practice traders (GET /practice/leaderboard): ranked by return on what
// they put in, in dollars across coins; open positions at today's floor.
export type PracticeWindow = '7' | '30' | 'all';
export type PracticeRow = {
  rank: number; name: string; you: boolean;
  trades: number; open: number; wins: number;
  roiPct: number; pnlUsd: number; costUsd: number;
  best: { symbol: string; collection: string; pct: number } | null;
};
export type PracticeBoard = {
  window: PracticeWindow; minTrades: number; traders: number; rows: PracticeRow[];
  you: PracticeRow | { trades: number; needed: number }; // ranked, or how many more trades to rank
};

export type Alert = {
  id: number; wallet: string; name: string | null; avatar: string | null; side: 'buy' | 'sell';
  collection: { symbol: string; name: string }; currency: Unit; mint: string;
  price: number; pnl: number | null; image: string | null; t: number; read: boolean;
};
export type PushSubscriptionBody = { endpoint: string; keys: { p256dh: string; auth: string } };

export type SupportTopic = 'bug' | 'trade' | 'wallet' | 'idea' | 'other';
export type SupportReport = {
  topic: SupportTopic; message: string; contact?: string; tx?: string;
  wallets?: string[]; userId?: string; page?: string; mode?: 'paper' | 'real';
};

type Ok = { ok: true };

export const accountApi = {
  // Verifies the Privy token and moves this device's follows/paper trades to the account.
  session: (deviceId: string) => send<{ userId: string }>('POST', '/auth/session', { deviceId }),

  follows: (userId: string) => req<string[]>(path`/follows/${userId}`),
  follow: (userId: string, wallet: string) => send<Ok>('POST', '/follows', { userId, wallet }),
  unfollow: (userId: string, wallet: string) => send<Ok>('DELETE', '/follows', { userId, wallet }),

  paper: (userId: string) => req<PaperBook>(path`/paper/${userId}`),
  buyFloor: (userId: string, collection: string, copiedFrom?: string, count = 1) =>
    send<{ entryPrice: number; entryPrices?: number[]; total?: number }>('POST', '/paper/buy', { userId, collection, copiedFrom, count }),
  sell: (userId: string, positionId: number) => send<{ exitPrice: number }>('POST', '/paper/sell', { userId, positionId }),
  resetPaper: (userId: string) => send<{ deleted: number }>('POST', '/paper/reset', { userId }),
  practiceBoard: (window: PracticeWindow, userId?: string | null) =>
    req<PracticeBoard>('/practice/leaderboard' + qs({ window, userId })),

  alerts: (userId: string) => req<{ unread: number; push: boolean; alerts: Alert[] }>(path`/alerts/${userId}`),
  unread: (userId: string) => req<{ unread: number; push: boolean }>(path`/alerts/${userId}/unread`),
  markRead: (userId: string) => send<{ marked: number }>('POST', path`/alerts/${userId}/read`, {}),
  pushKey: () => req<{ key: string }>('/push/key'),
  subscribePush: (userId: string, subscription: PushSubscriptionBody) => send<Ok>('POST', '/push/subscribe', { userId, subscription }),
  unsubscribePush: (endpoint: string) => send<{ removed: number }>('POST', '/push/unsubscribe', { endpoint }),

  support: (b: SupportReport) => send<{ ok: true; id: number }>('POST', '/support', b),
};
