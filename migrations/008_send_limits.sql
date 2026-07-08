-- 008_send_limits.sql — per-sender daily send caps + warmup ramp
-- Protects domain reputation: no sending identity can exceed its daily cap
-- regardless of how often the cron runs, and new identities ramp up gradually.

-- Per-day counter, keyed by the actual sending identity (from address / mailbox).
CREATE TABLE IF NOT EXISTS send_counters (
  identity    VARCHAR(320) NOT NULL,
  day         DATE NOT NULL,
  sent_count  INTEGER NOT NULL DEFAULT 0,
  first_send_day DATE,            -- first day this identity ever sent (warmup anchor)
  PRIMARY KEY (identity, day)
);

CREATE INDEX IF NOT EXISTS idx_send_counters_day ON send_counters(day);

-- Track when each identity started warming up so the ramp is per-identity.
CREATE TABLE IF NOT EXISTS send_identities (
  identity        VARCHAR(320) PRIMARY KEY,
  warmup_start    DATE NOT NULL DEFAULT CURRENT_DATE,
  daily_cap_override INTEGER,     -- optional manual override of the computed cap
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
