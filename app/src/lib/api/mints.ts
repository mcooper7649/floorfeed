// Mints (server routes/mints.ts, market.ts /drops): OpenSea drops, the Mint hub
// with what FloorFeed measures on chain, reminders, and in-app mint transactions.
import { path, req, send, qs } from './client';
import type { WalletRef } from './market';
import type { EvmTxOut } from './wallet';

// A mint (OpenSea drop): live or upcoming.
export type Drop = {
  slug: string; name: string; chain: string; image: string | null; url: string; minting: boolean; featured: boolean;
  stage: string | null; price: number | null; currency: string; priceUsd: number | null; startsAt: number | null; endsAt: number | null;
};

// The Mint hub (GET /mints): a drop plus what FloorFeed measures on chain.
export type MintWallet = WalletRef;
export type HubDrop = Drop & {
  contract: string | null;
  launched?: boolean; // launched on FloorFeed (open /c/[chain]/[address])
  section: 'live' | 'upcoming' | 'done';
  chainName: string; supported: boolean; verified: boolean | null;
  minted: number | null; max: number | null; openEdition: boolean;
  mints10m: number | null; mints1h: number | null; minters: number;
  proven: { count: number; wallets: MintWallet[] };
};
export type DropActivity = Pick<HubDrop, 'mints10m' | 'mints1h' | 'minters' | 'proven' | 'verified'>;

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

export const mintsApi = {
  drops: () => req<Drop[]>('/drops'),
  mints: () => req<{ drops: HubDrop[]; at: number }>('/mints'),
  drop: (slug: string, minter?: string) => req<DropDetail>(path`/drops/${slug}` + qs({ minter })),
  dropActivity: (slug: string) => req<DropActivity>(path`/drops/${slug}/activity`),
  dropMintTx: (slug: string, b: { minter: string; quantity: number }) =>
    send<EvmTxOut & { total: number; unit: string }>('POST', path`/drops/${slug}/mint-tx`, b),
  mintReminders: (userId: string) => req<{ reminders: { slug: string; startsAt: number }[] }>(path`/mints/reminders/${userId}`),
  remind: (userId: string, slug: string, on: boolean) => send<{ ok: true; on: boolean }>('POST', '/mints/remind', { userId, slug, on }),
};
