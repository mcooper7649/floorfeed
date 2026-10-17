import { C } from '@/constants/brand';
import type { HistoryEntry, HistoryType } from './api';
import { amt, shortAddr } from './format';

// Labels, icons and wording for history rows, shared by the History page and
// the Portfolio activity card.

export const TYPE: Record<HistoryType, { label: string; icon: string }> = {
  buy: { label: 'Buy', icon: '↓' },
  sale: { label: 'Sale', icon: '↑' },
  listing: { label: 'Listing', icon: '◇' },
  offer: { label: 'Offer', icon: '◈' },
  mint: { label: 'Mint', icon: '✦' },
  launch: { label: 'Launch', icon: '✦' },
  transfer_in: { label: 'Received', icon: '↘' },
  transfer_out: { label: 'Sent', icon: '↗' },
  bridge: { label: 'Bridge', icon: '⇄' },
  send: { label: 'Send', icon: '→' },
  approve: { label: 'Approval', icon: '✓' },
  unwrap: { label: 'Unwrap', icon: '◎' },
};

// Filter groups on the History page (and the CSV export's `types`).
export const GROUPS: { id: string; label: string; types: HistoryType[] | null }[] = [
  { id: 'all', label: 'All', types: null },
  { id: 'buys', label: 'Buys', types: ['buy'] },
  { id: 'sales', label: 'Sales', types: ['sale'] },
  { id: 'listings', label: 'Listings', types: ['listing'] },
  { id: 'offers', label: 'Offers', types: ['offer'] },
  { id: 'mints', label: 'Mints', types: ['mint', 'launch'] },
  { id: 'transfers', label: 'Transfers', types: ['transfer_in', 'transfer_out'] },
  { id: 'wallet', label: 'Wallet', types: ['bridge', 'send', 'approve', 'unwrap'] },
];

export const STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: C.dim },
  delivering: { label: 'Delivering', color: C.dim },
  confirmed: { label: 'Confirmed', color: C.up },
  failed: { label: 'Failed', color: C.down },
  dropped: { label: 'Not sent', color: C.down },
  refunded: { label: 'Refunded', color: C.dim },
  active: { label: 'Active', color: C.accent },
  sold: { label: 'Sold', color: C.up },
  accepted: { label: 'Accepted', color: C.up },
  cancelled: { label: 'Cancelled', color: C.dim },
  expired: { label: 'Expired', color: C.muted },
  inactive: { label: 'Inactive', color: C.muted },
};
export const statusOf = (s: string) => STATUS[s] ?? { label: s, color: C.dim };
export const inFlight = (e: { status: string }) => e.status === 'pending' || e.status === 'delivering';

// Money in (+) for sales, out (−) for buys and mints; listings are just asks.
export function signedPrice(e: HistoryEntry) {
  if (e.price == null || !e.unit) return null;
  const sign = e.type === 'sale' ? '+' : e.type === 'buy' || e.type === 'mint' ? '−' : '';
  return `${sign}${amt(e.price, e.unit)}`;
}

const span = (sec: number) => {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

// "Sold after 4h to 0x2e3f…", "Expires in 18h", "Cancelled after 2d".
export function lifecycle(e: HistoryEntry) {
  const l = e.listing;
  if (!l) return null;
  const now = Date.now() / 1000;
  if (e.type === 'offer') {
    if (e.status === 'accepted') return `Accepted${l.closedAt ? ` after ${span(l.closedAt - l.listedAt)}` : ''}${l.buyer ? ` by ${shortAddr(l.buyer)}` : ''}`;
    if (e.status === 'cancelled') return `Cancelled${l.closedAt ? ` after ${span(l.closedAt - l.listedAt)}` : ''}`;
    if (e.status === 'expired') return `Expired${l.expiresAt ? ` ${dateLabel(l.expiresAt)}` : ''}`;
    if (e.status === 'inactive') return "Not fillable right now: the wallet's WETH or allowance is short";
    return l.expiresAt ? `Expires in ${span(l.expiresAt - now)}` : 'Live';
  }
  if (e.status === 'sold') return `Sold${l.closedAt ? ` after ${span(l.closedAt - l.listedAt)}` : ''}${l.buyer ? ` to ${shortAddr(l.buyer)}` : ''}`;
  if (e.status === 'cancelled') return `Cancelled${l.closedAt ? ` after ${span(l.closedAt - l.listedAt)}` : ''}`;
  if (e.status === 'expired') return `Expired${l.expiresAt ? ` ${dateLabel(l.expiresAt)}` : ''}`;
  if (e.status === 'inactive') return 'Not fillable: the NFT left the wallet';
  return l.expiresAt ? `Expires in ${span(l.expiresAt - now)}` : 'Live';
}

export const clock = (t: number) => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const dateLabel = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const stamp = (t: number) => `${dateLabel(t)}, ${clock(t)}`;

export function dayLabel(t: number) {
  const d = new Date(t * 1000);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? `Today · ${dateLabel(t)}` : same(d, yest) ? `Yesterday · ${dateLabel(t)}`
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

export const viaLabel = (v: HistoryEntry['via']) => (v === 'floorfeed' ? 'FloorFeed' : v === 'opensea' ? 'OpenSea' : 'Magic Eden');
