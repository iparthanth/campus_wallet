-- Premier University Campus Wallet — initial schema
-- MONEY RULE: every amount is integer paisa (BIGINT). Never float, never decimal-in-JS.
-- ৳100.50 is stored as 10050.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT      NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- CHECK is the last line of defence: even a bug in app code cannot create negative money.
  balance_paisa BIGINT      NOT NULL DEFAULT 0 CHECK (balance_paisa >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  from_wallet     BIGINT      NOT NULL REFERENCES wallets(id),
  to_wallet       BIGINT      NOT NULL REFERENCES wallets(id),
  amount_paisa    BIGINT      NOT NULL CHECK (amount_paisa > 0),
  status          TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','flagged')),
  -- NULL allowed (idempotency optional) but any non-null key can appear only once.
  idempotency_key TEXT        UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_transfer CHECK (from_wallet <> to_wallet)
);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT      NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rule_name      TEXT        NOT NULL,
  detail         TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keyset pagination on history: (created_at, id) DESC. Not OFFSET — OFFSET degrades linearly
-- and skips/duplicates rows when data is inserted mid-scroll.
CREATE INDEX IF NOT EXISTS idx_tx_from_created ON transactions (from_wallet, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_to_created   ON transactions (to_wallet,   created_at DESC, id DESC);
-- Velocity rule reads "transfers from this wallet in the last 60s".
CREATE INDEX IF NOT EXISTS idx_tx_from_time    ON transactions (from_wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_flags_tx        ON fraud_flags (transaction_id);
