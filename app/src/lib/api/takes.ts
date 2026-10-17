// Takes (server routes/takes.ts): users' theses on collections, plus FloorFeed's
// AI takes on notable buys, and the poster's display name.
import { path, qs, req, send } from './client';
import type { Chain, Tier } from './market';

export type UserTake = {
  kind: 'user'; id: number; text: string; t: number;
  author: { name: string; walletName: string | null; avatar: string | null; wallet: string | null; tier: Tier; champ?: number | null };
  holder: { items: number; pnlPct: number | null } | null; verified: boolean;
  floor: number | null; likes: number; liked: boolean; mine: boolean;
};
export type AiTake = { kind: 'ai'; id: string; text: string; t: number; trade: { buyer: string; buyerName: string | null; price: number; mint: string } };
export type TakeItem = UserTake | AiTake;
// The live thesis feed across collections.
export type FeedColl = { symbol: string; name: string; image: string | null; currency: string; chain: Chain };
export type ThesisFeedItem = (UserTake & { collection: FeedColl }) | (AiTake & { collection: FeedColl });

export const takesApi = {
  takes: (symbol: string, userId?: string | null) => req<TakeItem[]>(path`/collections/${symbol}/takes` + qs({ userId })),
  theses: (userId?: string | null) => req<ThesisFeedItem[]>('/theses' + qs({ limit: 40, userId })),
  profile: () => req<{ name: string | null; fallback: string }>('/profile'),
  setProfileName: (name: string) => send<{ name: string }>('PUT', '/profile', { name }),
  // The text a wallet signs to mark a take as posted by a holder.
  takeMessage: (collection: string, text: string, ts: number) => req<{ message: string }>('/takes/message' + qs({ collection, text, ts })),
  postTake: (b: { collection: string; text: string; wallet?: string; signature?: string; ts?: number }) =>
    send<{ id: number }>('POST', '/takes', b),
  likeTake: (id: number, userId: string) => send<{ liked: boolean; likes: number }>('POST', path`/takes/${id}/like`, { userId }),
  reportTake: (id: number, userId: string) => send<{ ok: true }>('POST', path`/takes/${id}/report`, { userId }),
  deleteTake: (id: number) => req<{ ok: boolean }>(path`/takes/${id}`, { method: 'DELETE' }),
};
