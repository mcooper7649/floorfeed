import { useEffect, useState } from 'react';

import { api } from './api';

// The display name for one wallet that didn't come with one from the API
// (the header button, a history counterparty, a send recipient): the owner's
// FloorFeed account name, else its .sol / ENS name (server: GET /names).
// Calls made in the same tick share one request; answers are kept for 2 min.

const TTL = 2 * 60_000;
const cache = new Map<string, { name: string | null; at: number }>();
let pending: { wallets: Set<string>; done: Promise<void> } | null = null;

function fetchName(wallet: string): Promise<void> {
  if (!pending) {
    const batch = { wallets: new Set<string>(), done: Promise.resolve() };
    batch.done = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      pending = null;
      const ws = [...batch.wallets];
      const names = await api.names(ws).catch(() => ({} as Record<string, string | null>));
      const now = Date.now();
      for (const w of ws) cache.set(w, { name: names[w] ?? null, at: now });
    });
    pending = batch;
  }
  pending.wallets.add(wallet);
  return pending.done;
}

const fresh = (w: string) => { const c = cache.get(w); return c && Date.now() - c.at < TTL ? c : null; };

export function useWalletName(wallet: string | null | undefined): string | null {
  const [got, setGot] = useState<{ wallet: string; name: string | null } | null>(null);
  useEffect(() => {
    if (!wallet || fresh(wallet)) return;
    let alive = true;
    fetchName(wallet).then(() => { if (alive) setGot({ wallet, name: cache.get(wallet)?.name ?? null }); });
    return () => { alive = false; };
  }, [wallet]);
  if (!wallet) return null;
  return fresh(wallet)?.name ?? (got?.wallet === wallet ? got.name : null);
}
