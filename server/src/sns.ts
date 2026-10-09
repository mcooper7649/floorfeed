import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { db } from "./db.ts";

// .sol names for wallets (Solana Name Service "favorite domain"), resolved
// over plain JSON-RPC so the server needs no Solana SDK. Results, including
// "no name", are cached in wallet_names and rechecked weekly.
db.exec(`CREATE TABLE IF NOT EXISTS wallet_names (
  wallet     TEXT PRIMARY KEY,
  name       TEXT,
  checked_at INTEGER NOT NULL
)`);

const NAME_PROGRAM = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
const OFFERS_PROGRAM = "85iDfUvr3HJyLM2zcq5BXSiDvUWfw6cSE1FfNBo8Ap29";
const REVERSE_CLASS = "33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z";
const SOL_TLD = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const RECHECK_SEC = 7 * 86_400;

// --- base58 ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
export function b58encode(buf: Uint8Array): string {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = "1" + out; }
  return out;
}

// --- program-derived addresses (must be OFF the ed25519 curve) ---
const P = 2n ** 255n - 19n;
const D = (-121665n * inv(121666n)) % P + P;
function pow(b: bigint, e: bigint) {
  let r = 1n; b %= P;
  for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; }
  return r;
}
function inv(x: bigint) { return pow(((x % P) + P) % P, P - 2n); }
function onCurve(key: Buffer) {
  const b = Buffer.from(key);
  b[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(b).reverse().toString("hex"));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = ((y2 - 1n + P) * inv(D * y2 + 1n)) % P;
  if (x2 === 0n) return true;
  return pow(x2, (P - 1n) / 2n) === 1n; // Euler's criterion: x² has a square root
}
function pda(seeds: Buffer[], program: string): Buffer {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])).update(prog).update("ProgramDerivedAddress");
    const key = h.digest();
    if (!onCurve(key)) return key;
  }
  throw new Error("no PDA");
}
const nameKey = (name: string, cls: string | null, parent: string | null) =>
  pda([
    createHash("sha256").update("SPL Name Service" + name).digest(),
    cls ? b58decode(cls) : Buffer.alloc(32),
    parent ? b58decode(parent) : Buffer.alloc(32),
  ], NAME_PROGRAM);

async function accounts(keys: string[]): Promise<(Buffer | null)[]> {
  if (!keys.length) return [];
  const res = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "base64" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json()) as { result?: { value: ({ data: [string, string] } | null)[] }; error?: unknown };
  if (!j.result) throw new Error(`rpc: ${JSON.stringify(j.error)}`);
  return j.result.value.map((a) => (a ? Buffer.from(a.data[0], "base64") : null));
}

// Resolves up to 100 wallets in three RPC calls.
export async function resolveNames(wallets: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(wallets.map((w) => [w, null]));
  const favKeys = wallets.map((w) => b58encode(pda([Buffer.from("favourite_domain"), b58decode(w)], OFFERS_PROGRAM)));
  const favs = await accounts(favKeys);
  const picks = wallets
    .map((w, i) => ({ w, fav: favs[i] }))
    .filter((x): x is { w: string; fav: Buffer } => !!x.fav && x.fav.length >= 33)
    .map((x) => ({ w: x.w, domain: b58encode(x.fav.subarray(1, 33)) }));
  if (!picks.length) return out;
  const [domains, reverses] = await Promise.all([
    accounts(picks.map((p) => p.domain)),
    accounts(picks.map((p) => b58encode(nameKey(p.domain, REVERSE_CLASS, null)))),
  ]);
  picks.forEach((p, i) => {
    const d = domains[i];
    const r = reverses[i];
    if (!d || !r || r.length < 100) return;
    // Name record header: parent(32) owner(32) class(32). Only top-level
    // .sol names still owned by the wallet count (a favorite can go stale).
    if (b58encode(d.subarray(0, 32)) !== SOL_TLD || b58encode(d.subarray(32, 64)) !== p.w) return;
    const len = r.readUInt32LE(96);
    const name = r.subarray(100, 100 + len).toString("utf8");
    if (/^[a-z0-9_-]{1,40}$/i.test(name)) out.set(p.w, `${name}.sol`);
  });
  return out;
}

const getNames = (wallets: string[]) => {
  if (!wallets.length) return new Map<string, string>();
  const rows = db.prepare(`SELECT wallet, name FROM wallet_names WHERE name IS NOT NULL AND wallet IN (${wallets.map(() => "?").join(",")})`)
    .all(...wallets) as { wallet: string; name: string }[];
  return new Map(rows.map((r) => [r.wallet, r.name]));
};
export { getNames };

// Wallets the feed has shown but not (recently) resolved get queued here and
// resolved in the background, so the feed never waits on RPC.
const queue = new Set<string>();
export function wantNames(wallets: string[]) {
  if (!wallets.length) return;
  const now = Math.floor(Date.now() / 1000);
  const fresh = new Set((db.prepare(`SELECT wallet FROM wallet_names WHERE checked_at > ? AND wallet IN (${wallets.map(() => "?").join(",")})`)
    .all(now - RECHECK_SEC, ...wallets) as { wallet: string }[]).map((r) => r.wallet));
  for (const w of wallets) if (!fresh.has(w)) queue.add(w);
}

const save = db.prepare(`INSERT INTO wallet_names (wallet, name, checked_at) VALUES (?, ?, ?)
  ON CONFLICT(wallet) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at`);
let busy = false;
async function drain() {
  if (busy || !queue.size) return;
  busy = true;
  const batch = [...queue].slice(0, 100);
  try {
    const names = await resolveNames(batch);
    const now = Math.floor(Date.now() / 1000);
    db.transaction(() => { for (const [w, n] of names) save.run(w, n, now); })();
    for (const w of batch) queue.delete(w);
  } catch (e) {
    console.warn("sns:", (e as Error).message);
  } finally {
    busy = false;
  }
}
// One wallet, resolved now if it hasn't been checked recently (wallet pages
// can't wait for the background queue). Falls back to whatever is cached.
export async function nameFor(wallet: string): Promise<string | null> {
  const row = db.prepare("SELECT name, checked_at FROM wallet_names WHERE wallet = ?").get(wallet) as
    { name: string | null; checked_at: number } | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (row && row.checked_at > now - RECHECK_SEC) return row.name;
  try {
    const name = (await resolveNames([wallet])).get(wallet) ?? null;
    save.run(wallet, name, now);
    queue.delete(wallet);
    return name;
  } catch {
    return row?.name ?? null;
  }
}

export function startNames() { setInterval(drain, 15_000).unref(); }
