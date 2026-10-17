import { config } from "./config.ts";
import { db } from "./db.ts";

// Which wallets belong to which FloorFeed account, so a member's chosen
// account name shows wherever their wallets do (feed, leaders, wallet pages,
// alerts), ahead of .sol / ENS names (sns.ts getNames). Two sources:
// - Privy: the account's embedded wallets and any wallets linked to it, read
//   server-side with the app secret (synced on sign-in and on /profile);
// - a thesis signed with a wallet (takes.ts), which proves the poster holds it.
// EVM addresses are stored lowercase. Members can turn this off in Settings
// (profiles.show_on_wallets).
db.exec(`
CREATE TABLE IF NOT EXISTS user_wallets (
  wallet     TEXT PRIMARY KEY,   -- one owner per wallet: the latest proof wins
  user_id    TEXT NOT NULL,
  source     TEXT NOT NULL,      -- 'privy' | 'signature'
  linked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_wallets_user ON user_wallets(user_id);
`);

const norm = (w: string) => (w.startsWith("0x") ? w.toLowerCase() : w);

const upsert = db.prepare(`INSERT INTO user_wallets (wallet, user_id, source, linked_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(wallet) DO UPDATE SET user_id = excluded.user_id, source = excluded.source, linked_at = excluded.linked_at`);
export function linkWallet(userId: string, wallet: string, source: "privy" | "signature") {
  upsert.run(norm(wallet), userId, source, Date.now());
}

// Privy's server API, at most once an hour per account.
const synced = new Map<string, number>();
type PrivyAccount = { type: string; address?: string; chain_type?: string };
export async function syncPrivyWallets(userId: string) {
  if (!config.privyAppId || !process.env.PRIVY_APP_SECRET || !userId.startsWith("did:privy:")) return;
  if (Date.now() - (synced.get(userId) ?? 0) < 3_600_000) return;
  synced.set(userId, Date.now());
  try {
    const r = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.privyAppId}:${process.env.PRIVY_APP_SECRET}`).toString("base64")}`,
        "privy-app-id": config.privyAppId,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`privy ${r.status}`);
    const u = (await r.json()) as { linked_accounts?: PrivyAccount[] };
    const wallets = (u.linked_accounts ?? []).filter((a) => a.type === "wallet" && a.address).map((a) => a.address!);
    db.transaction(() => { for (const w of wallets) linkWallet(userId, w, "privy"); })();
  } catch (e) {
    synced.delete(userId);
    console.warn("user-wallets:", (e as Error).message);
  }
}

// FloorFeed account names for these wallets (only members who chose a name
// and didn't turn this off). Keys are the wallets as passed in.
export function floorfeedNames(wallets: string[]): Map<string, string> {
  if (!wallets.length) return new Map();
  const keys = [...new Set(wallets.map(norm))];
  const rows = db.prepare(`SELECT uw.wallet, p.name FROM user_wallets uw JOIN profiles p ON p.user_id = uw.user_id
    WHERE p.show_on_wallets = 1 AND uw.wallet IN (${keys.map(() => "?").join(",")})`).all(...keys) as { wallet: string; name: string }[];
  const byKey = new Map(rows.map((r) => [r.wallet, r.name]));
  const out = new Map<string, string>();
  for (const w of wallets) { const n = byKey.get(norm(w)); if (n) out.set(w, n); }
  return out;
}
