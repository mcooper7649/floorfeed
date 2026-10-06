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
`);
