// Minimal Magic Eden public API client (no key needed). The public tier
// rate-limits aggressively, so all calls go through one serial queue.
const BASE = "https://api-mainnet.magiceden.dev/v2";
const MIN_GAP_MS = 1500;
const LAMPORTS = 1e9;

let last = 0;
let chain: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function get<T>(path: string, attempt = 0): Promise<T> {
  return throttled(async () => {
    const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
      return get<T>(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`ME ${res.status} ${path}`);
    return (await res.json()) as T;
  });
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

export async function getSales(symbol: string, limit = 100): Promise<MeActivity[]> {
  const rows = await get<MeActivity[]>(
    `/collections/${symbol}/activities?offset=0&limit=${limit}&type=buyNow`,
  );
  return rows.filter((r) => r.buyer && r.seller && r.price > 0);
}
