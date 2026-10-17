import Database from "better-sqlite3";
import { config } from "./config.ts";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  signature  TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  mint       TEXT NOT NULL,
  buyer      TEXT NOT NULL,
  seller     TEXT NOT NULL,
  price      REAL NOT NULL,          -- SOL
  block_time INTEGER NOT NULL,       -- unix seconds
  image      TEXT,
  source     TEXT
);
CREATE INDEX IF NOT EXISTS trades_time  ON trades(block_time DESC);
CREATE INDEX IF NOT EXISTS trades_buyer ON trades(buyer);
CREATE INDEX IF NOT EXISTS trades_mint  ON trades(mint);
CREATE INDEX IF NOT EXISTS trades_seller ON trades(seller);
CREATE INDEX IF NOT EXISTS trades_mint  ON trades(mint, block_time);

CREATE TABLE IF NOT EXISTS collections (
  symbol      TEXT PRIMARY KEY,
  floor       REAL,                  -- SOL
  listed      INTEGER,
  avg_24h     REAL,
  volume_7d   REAL,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS collection_snapshots (
  symbol TEXT NOT NULL,
  ts     INTEGER NOT NULL,          -- unix ms
  floor  REAL,
  listed INTEGER,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS takes (
  signature  TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
  user_id TEXT NOT NULL,
  wallet  TEXT NOT NULL,
  PRIMARY KEY (user_id, wallet)
);

CREATE INDEX IF NOT EXISTS trades_collection_time ON trades(collection, block_time);

CREATE TABLE IF NOT EXISTS paper_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  collection  TEXT NOT NULL,
  entry_price REAL NOT NULL,
  opened_at   INTEGER NOT NULL,
  copied_from TEXT,                  -- trade signature that inspired it
  exit_price  REAL,
  closed_at   INTEGER
);

-- Finished weekly practice seasons (practice.ts): the final board, kept
-- server-side (it holds user ids), one row per season.
CREATE TABLE IF NOT EXISTS practice_seasons (
  season       TEXT PRIMARY KEY,         -- the Monday it started, "2026-10-12" (UTC)
  finalized_at INTEGER NOT NULL,
  results      TEXT NOT NULL             -- JSON: ranked rows with user_id
);

-- X (Twitter) posts drafted from FloorFeed data. Flow: draft → approved
-- (Telegram button or auto-approve) → posted by the browser poster.
CREATE TABLE IF NOT EXISTS social_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL UNIQUE,      -- dedupe, e.g. "movers:2026-10-09"
  text        TEXT NOT NULL,
  image       TEXT,
  status      TEXT NOT NULL DEFAULT 'draft', -- draft|approved|posted|skipped|expired|failed
  created_at  INTEGER NOT NULL,          -- unix ms
  expires_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  posted_at   INTEGER,
  post_url    TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  tg_chat     TEXT,
  tg_message  INTEGER
);
CREATE INDEX IF NOT EXISTS social_posts_status ON social_posts(status, created_at);

-- NFT detail pages: every item of a Solana collection with its traits and a
-- rarity rank FloorFeed computes itself (from Helius DAS), plus per-collection
-- trait counts (Solana: computed; EVM: from OpenSea).
CREATE TABLE IF NOT EXISTS nft_items (
  mint       TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  name       TEXT,
  image      TEXT,
  attrs      TEXT NOT NULL,        -- JSON [{type, value}]
  score      REAL,
  rank       INTEGER
);
CREATE INDEX IF NOT EXISTS nft_items_collection ON nft_items(collection, rank);
-- EVM collections found by discovery.ts (each chain's top by 7-day volume).
CREATE TABLE IF NOT EXISTS evm_discovered (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  chain    TEXT NOT NULL,
  category TEXT NOT NULL,
  rank     INTEGER NOT NULL,
  seen_at  INTEGER NOT NULL
);
-- Wallet alerts (alerts.ts): one row per follower per trade by a followed
-- wallet, plus the browsers that asked for push notifications.
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  signature  TEXT NOT NULL,
  side       TEXT NOT NULL,            -- buy | sell
  collection TEXT NOT NULL,
  mint       TEXT NOT NULL,
  price      REAL NOT NULL,
  pnl        REAL,                     -- sells of a tracked buy: after fees
  image      TEXT,
  block_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,         -- unix ms
  read_at    INTEGER,
  UNIQUE (user_id, signature, wallet)
);
CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id, id DESC);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
-- Small bits of server state (cursors, webhook ids).
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_traits (
  symbol      TEXT PRIMARY KEY,
  total       INTEGER NOT NULL,
  counts      TEXT NOT NULL,       -- JSON {type: {value: count}}
  computed_at INTEGER NOT NULL
);
`);

// Columns added after the first release; ALTER is a no-op error if present.
for (const col of [
  "image TEXT", "description TEXT",
  // multi-chain (OpenSea-sourced collections)
  "chain TEXT NOT NULL DEFAULT 'solana'", "currency TEXT NOT NULL DEFAULT 'SOL'",
  "owners INTEGER", "supply INTEGER", "volume_24h_ext REAL", "sales_24h_ext INTEGER",
  "volume_30d REAL", "external_url TEXT",
  // metadata bookkeeping: 'official' (marketplace metadata) or 'sale' (art
  // from a recent sale, used until official metadata arrives), plus a
  // retry backoff so failed lookups aren't repeated every cycle
  "image_source TEXT", "meta_checked_at INTEGER", "meta_failures INTEGER NOT NULL DEFAULT 0",
  // the one currency this collection's sales are kept in (EVM; see units.ts)
  "sale_currency TEXT",
  // fees.ts: Solana royalty measured from listing buys; EVM required seller fees (OpenSea)
  "royalty_bps INTEGER", "seller_fee_bps INTEGER",
  // collection page links (OpenSea info for EVM)
  "website TEXT", "twitter TEXT", "discord TEXT", "contract TEXT",
  "created_ext TEXT", // collection creation date (OpenSea), for "New & hot"
]) {
  try { db.exec(`ALTER TABLE collections ADD COLUMN ${col}`); } catch {}
}

// What the buyer actually paid and the seller actually received (fees.ts);
// NULL = not read from chain, the fee model fills in.
for (const col of ["cost REAL", "proceeds REAL", "fees_checked INTEGER NOT NULL DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch {}
}
db.exec(`CREATE INDEX IF NOT EXISTS trades_fees_checked ON trades(fees_checked, block_time)`);
