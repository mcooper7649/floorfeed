import { config } from "./config.ts";

// Solana base58 address (32-byte public key).
export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${body.error.message}`);
  return body.result as T;
}

// Balances are read often (every wallet render) and change rarely: 15s cache.
const balanceCache = new Map<string, { at: number; lamports: number }>();
export async function solBalance(address: string) {
  const hit = balanceCache.get(address);
  if (hit && Date.now() - hit.at < 15_000) return { lamports: hit.lamports, sol: hit.lamports / 1e9 };
  const { value } = await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
  balanceCache.set(address, { at: Date.now(), lamports: value });
  return { lamports: value, sol: value / 1e9 };
}

// What the client may offer. Buying needs at least one marketplace key.
export function capabilities() {
  const magiceden = Boolean(config.magicEdenApiKey);
  const tensor = Boolean(config.tensorApiKey);
  return {
    buy: { enabled: magiceden || tensor, magiceden, tensor },
    rpc: config.solanaRpcUrl.includes("mainnet-beta.solana.com") ? "public" : "custom",
  };
}
