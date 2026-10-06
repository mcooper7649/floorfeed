// OpenSea API v2, keyless subset: collection stats + collection info.
// (Sales events, listings and rankings need an API key; see README.)
// OPENSEA_API_KEY in the environment is sent when present.
// The keyless limit is ~120 req/min; a 700ms gap stays well under it.
const BASE = "https://api.opensea.io/api/v2";
const MIN_GAP_MS = 700;
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

// Keyless access is intermittent: the same request can get 200 or a 401
// "missing API key", so 401/429 are retried a couple of times. Setting
// OPENSEA_API_KEY (free) makes this reliable.
async function get<T>(path: string, attempt = 0): Promise<T> {
  const res = await throttled(() =>
    fetch(BASE + path, {
      headers: {
        accept: "application/json",
        "user-agent": "FloorFeed/0.1 (+https://floorfeed.mycodedojo.com)",
        ...(process.env.OPENSEA_API_KEY ? { "x-api-key": process.env.OPENSEA_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if ((res.status === 401 || res.status === 429) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    return get<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenSea ${res.status} ${path}`);
  return (await res.json()) as T;
}

type Interval = { interval: string; volume: number; sales: number };

export async function getOsStats(slug: string) {
  const s = await get<{
    total: { floor_price?: number; floor_price_symbol?: string; num_owners?: number };
    intervals: Interval[];
  }>(`/collections/${slug}/stats`);
  const iv = (name: string) => s.intervals.find((i) => i.interval === name);
  return {
    floor: s.total.floor_price ?? null,
    currency: s.total.floor_price_symbol || "ETH",
    owners: s.total.num_owners ?? null,
    volume24h: iv("one_day")?.volume ?? null,
    sales24h: iv("one_day")?.sales ?? null,
    volume7d: iv("seven_day")?.volume ?? null,
    volume30d: iv("thirty_day")?.volume ?? null,
  };
}

export async function getOsInfo(slug: string) {
  const c = await get<{ image_url?: string; description?: string; total_supply?: number; opensea_url?: string }>(
    `/collections/${slug}`,
  );
  return {
    image: c.image_url || null,
    description: c.description || null,
    supply: c.total_supply ?? null,
    url: c.opensea_url ?? `https://opensea.io/collection/${slug}`,
  };
}
