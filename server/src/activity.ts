import { db } from "./db.ts";
import { bridgeStatus } from "./bridge.ts";
import { EVM_CHAINS } from "./config.ts";
import { evmTxInfo, forgetBalances } from "./trade-evm.ts";

// A wallet's FloorFeed transactions (buys, sells, approvals, bridges, sends,
// unwraps) with their real on-chain outcome, so users can confirm a trade went
// through without reading a block explorer. The app records each transaction
// the moment the wallet returns its hash; status is resolved here against the
// chain (and Relay for bridges). An entry whose sender isn't the wallet is
// dropped, so nobody can put fake rows into someone else's history.

db.exec(`
CREATE TABLE IF NOT EXISTS wallet_activity (
  hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  chain TEXT NOT NULL,
  kind TEXT NOT NULL,          -- buy | sell | approve | bridge | send | unwrap
  title TEXT NOT NULL,
  amount REAL, unit TEXT,      -- the headline amount (paid, received, moved)
  symbol TEXT, mint TEXT,      -- the NFT, for buys and sells
  request_id TEXT,             -- Relay request, for bridges
  to_chain TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | delivering | failed | dropped
  out_tx TEXT,                 -- bridge payout on the destination chain
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_activity_wallet ON wallet_activity (wallet, created_at DESC);
`);

export const ACTIVITY_KINDS = ["buy", "sell", "approve", "bridge", "send", "unwrap"] as const;
type Row = {
  hash: string; wallet: string; chain: string; kind: string; title: string; amount: number | null; unit: string | null;
  symbol: string | null; mint: string | null; request_id: string | null; to_chain: string | null;
  status: string; out_tx: string | null; created_at: number; updated_at: number;
};

const insert = db.prepare(`INSERT OR IGNORE INTO wallet_activity
  (hash, wallet, chain, kind, title, amount, unit, symbol, mint, request_id, to_chain, created_at, updated_at)
  VALUES (@hash, @wallet, @chain, @kind, @title, @amount, @unit, @symbol, @mint, @request_id, @to_chain, @now, @now)`);
const setStatus = db.prepare("UPDATE wallet_activity SET status = ?, out_tx = COALESCE(?, out_tx), updated_at = ? WHERE hash = ?");
const remove = db.prepare("DELETE FROM wallet_activity WHERE hash = ?");
const list = db.prepare("SELECT * FROM wallet_activity WHERE wallet = ? ORDER BY created_at DESC LIMIT ?");
const countRecent = db.prepare("SELECT COUNT(*) n FROM wallet_activity WHERE wallet = ? AND created_at > ?");

export function recordActivity(a: {
  hash: string; wallet: string; chain: string; kind: string; title: string;
  amount?: number | null; unit?: string | null; symbol?: string | null; mint?: string | null;
  requestId?: string | null; toChain?: string | null;
}) {
  if (!(a.chain in EVM_CHAINS)) throw new Error("Unsupported chain");
  const wallet = a.wallet.toLowerCase();
  // Generous for a person, useless for flooding.
  if ((countRecent.get(wallet, now() - 3600) as { n: number }).n >= 60) throw new Error("Too many entries");
  insert.run({
    hash: a.hash.toLowerCase(), wallet, chain: a.chain, kind: a.kind, title: a.title.slice(0, 140),
    amount: a.amount ?? null, unit: a.unit ?? null, symbol: a.symbol ?? null, mint: a.mint ?? null,
    request_id: a.requestId ?? null, to_chain: a.toChain ?? null, now: now(),
  });
}

const now = () => Math.floor(Date.now() / 1000);
const DROP_AFTER = 15 * 60; // a hash that never shows up on chain in 15 min was dropped

// Bring unfinished entries up to date (a few per call keeps it cheap).
async function refresh(rows: Row[]) {
  const open = rows.filter((r) => r.status === "pending" || r.status === "delivering").slice(0, 8);
  await Promise.all(open.map(async (r) => {
    const info = await evmTxInfo(r.chain, r.hash).catch(() => null);
    if (!info) return;
    if (info.from && info.from !== r.wallet) { remove.run(r.hash); r.status = "removed"; return; }
    let status = r.status, outTx: string | null = null;
    if (info.state === "failed") status = "failed";
    else if (info.state === "missing") status = now() - r.created_at > DROP_AFTER ? "dropped" : "pending";
    else if (info.state === "pending") status = "pending";
    else if (r.kind === "bridge" && r.request_id) {
      const b = await bridgeStatus(r.request_id).catch(() => null);
      status = b?.status === "success" ? "confirmed" : b?.status === "refund" ? "refunded" : b?.status === "failure" ? "failed" : "delivering";
      outTx = b?.outTx ?? null;
    } else status = "confirmed";
    if (status !== r.status || outTx) {
      setStatus.run(status, outTx, now(), r.hash);
      if (status !== "pending" && status !== "delivering") forgetBalances(r.wallet);
      r.status = status;
      if (outTx) r.out_tx = outTx;
    }
  }));
}

export async function walletActivity(wallet: string, limit = 50) {
  const rows = list.all(wallet.toLowerCase(), limit) as Row[];
  await refresh(rows);
  return rows.filter((r) => r.status !== "removed").map((r) => ({
    hash: r.hash, chain: r.chain, kind: r.kind, title: r.title, amount: r.amount, unit: r.unit,
    symbol: r.symbol, mint: r.mint, toChain: r.to_chain, status: r.status, createdAt: r.created_at,
    explorerUrl: `${EVM_CHAINS[r.chain as keyof typeof EVM_CHAINS]?.explorer ?? "https://etherscan.io"}/tx/${r.hash}`,
    outUrl: r.out_tx && r.to_chain ? `${EVM_CHAINS[r.to_chain as keyof typeof EVM_CHAINS]?.explorer}/tx/${r.out_tx}` : null,
  }));
}
