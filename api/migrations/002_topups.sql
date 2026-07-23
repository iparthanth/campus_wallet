-- Wallet top-up via bKash Tokenized Checkout (sandbox).
-- Money enters the system here, so this table is the audit trail for every taka created
-- from outside. payment_id is UNIQUE: bKash's identifier is the idempotency key, which is
-- what makes a replayed callback safe.

CREATE TABLE IF NOT EXISTS topups (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paisa  BIGINT      NOT NULL CHECK (amount_paisa > 0),
  payment_id    TEXT        NOT NULL UNIQUE,
  trx_id        TEXT,
  -- initiated -> completed | failed. Only the initiated -> completed edge credits a wallet,
  -- and it can only be traversed once because of the row lock in creditFromTopup().
  status        TEXT        NOT NULL DEFAULT 'initiated'
                            CHECK (status IN ('initiated','completed','failed')),
  credited_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topups_user ON topups (user_id, created_at DESC);
-- The reconciler scans for top-ups left hanging when a callback never arrived.
CREATE INDEX IF NOT EXISTS idx_topups_stale ON topups (status, created_at) WHERE status = 'initiated';
