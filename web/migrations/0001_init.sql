-- Cloudflare D1 SQLite Schema (0001_init.sql)
-- Strictly separates public verified market prices from per-user isolated encrypted vaults.

-- 1. Verified Historical Closing Prices (Permanent Cache — reduces external API calls to ~0)
CREATE TABLE IF NOT EXISTS price_history_cache (
  ticker TEXT NOT NULL,
  market TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  consensus_price REAL NOT NULL,
  valid_source_count INTEGER NOT NULL,
  spread_pct REAL NOT NULL,
  status_code TEXT NOT NULL,
  outlier_source TEXT,
  sources_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (ticker, market, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_price_history_lookup
  ON price_history_cache (ticker, market, trade_date DESC);

-- 2. Per-User Private Portfolio Vault (Row-Level Isolated by Cloudflare Access verified email)
-- When client-side E2EE is enabled, payload_json stores ONLY AES-256-GCM ciphertext (Zero-Knowledge).
CREATE TABLE IF NOT EXISTS user_vault (
  user_email TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  is_encrypted INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 3. Layer 5 & 6 Anonymous Performance & SLA Telemetry (STRICTLY ZERO financial/PII data)
CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms REAL NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  valid_sources INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_recent
  ON telemetry_events (created_at DESC);
