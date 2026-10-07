// Minimal Magic Eden public API client (no key needed). The public tier
// rate-limits aggressively, so all calls go through one serial queue.
const BASE = "https://api-mainnet.magiceden.dev/v2";
const MIN_GAP_MS = 1500;
const LAMPORTS = 1e9;

// One request at a time, MIN_GAP_MS apart. Jobs carry a priority so a
// user opening a collection page jumps ahead of background polling.
type Job = { run: () => Promise<unknown>; priority: number; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const queue: Job[] = [];
let last = 0;
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority > queue[best].priority) best = i;
    const job = queue.splice(best, 1)[0];
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try { job.resolve(await job.run()); } catch (err) { job.reject(err); }
  }
  pumping = false;
}

function schedule<T>(run: () => Promise<T>, priority: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ run, priority, resolve: resolve as (v: unknown) => void, reject });
    void pump();
  });
}

export const PRIORITY = { background: 0, prefetch: 5, user: 10 } as const;

// 429s back off inside the job, holding the queue: everyone slows down
// together instead of hammering the API. `retries: 0` for cosmetic calls.
async function get<T>(path: string, { retries = 2, priority = 0 } = {}): Promise<T> {
  return schedule(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`ME ${res.status} ${path}`);
      return (await res.json()) as T;
    }
  }, priority);
}

export type MeActivity = {
  signature: string;
  type: string;
  collection: string;
  tokenMint: string;
  buyer: string;
  seller: string;
  price: number; // SOL
  blockTime: number;
  image?: string;
  source?: string;
};

export type CollectionStats = {
  floor: number | null;
  listed: number | null;
  avg24h: number | null;
  volume7d: number | null;
};

export async function getStats(symbol: string): Promise<CollectionStats> {
  const s = await get<{
    floorPrice?: number;
    listedCount?: number;
    avgPrice24hr?: number;
    volume7d?: number;
  }>(`/collections/${symbol}/stats`);
  const sol = (v?: number) => (v == null ? null : v / LAMPORTS);
  return {
    floor: sol(s.floorPrice),
    listed: s.listedCount ?? null,
    avg24h: sol(s.avgPrice24hr),
    volume7d: sol(s.volume7d),
  };
}

export async function getSales(symbol: string, limit = 100, offset = 0, priority = 0): Promise<MeActivity[]> {
  const rows = await get<MeActivity[]>(
    `/collections/${symbol}/activities?offset=${offset}&limit=${limit}&type=buyNow`, { priority },
  );
  return rows.filter((r) => r.buyer && r.seller && r.price > 0);
}

export async function getCollectionMeta(symbol: string) {
  const m = await get<{ name?: string; image?: string; description?: string }>(`/collections/${symbol}`, { retries: 0 });
  return { image: m.image ?? null, description: m.description ?? null };
}

// Cheapest active listings, ascending by price (SOL).
export type Listing = { mint: string; price: number; name: string | null; image: string | null; rank: number | null };

type MeListing = {
  tokenMint: string;
  price: number;
  extra?: { img?: string };
  token?: { name?: string; image?: string };
  rarity?: { moonrank?: { rank?: number }; meInstant?: { rank?: number }; howrare?: { rank?: number } };
};

export async function getListings(symbol: string, limit = 20): Promise<Listing[]> {
  const rows = await get<MeListing[]>(
    `/collections/${symbol}/listings?offset=0&limit=${limit}`, { retries: 0, priority: PRIORITY.user },
  );
  return rows.filter((r) => r.price > 0).map((r) => ({
    mint: r.tokenMint,
    price: r.price,
    name: r.token?.name ?? null,
    image: r.extra?.img ?? r.token?.image ?? null,
    rank: r.rarity?.meInstant?.rank ?? r.rarity?.moonrank?.rank ?? r.rarity?.howrare?.rank ?? null,
  })).sort((a, b) => a.price - b.price);
}
