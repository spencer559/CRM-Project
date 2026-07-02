-- Mileage Sync — D1 schema
-- Apply with:
--   wrangler d1 execute mileage --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
