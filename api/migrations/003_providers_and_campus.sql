-- Two things this migration adds:
--   1. A payment PROVIDER on top-ups, because SSLCommerz (which fronts bKash, Nagad,
--      Rocket and the banks) now sits alongside direct bKash.
--   2. The parts that make this a CAMPUS wallet rather than a generic P2P wallet:
--      student identity, campus merchants, and counter charges paid by QR.

ALTER TABLE topups ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'bkash'
  CHECK (provider IN ('bkash', 'sslcommerz'));
-- SSLCommerz identifies a session by tran_id and confirms it with val_id.
ALTER TABLE topups ADD COLUMN IF NOT EXISTS val_id TEXT;
ALTER TABLE topups ADD COLUMN IF NOT EXISTS method TEXT;   -- 'bKash', 'NAGAD', 'VISA'…

-- ---------------------------------------------------------------- students
ALTER TABLE users ADD COLUMN IF NOT EXISTS student_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;

-- ---------------------------------------------------------------- merchants
-- A campus wallet without merchants is just a P2P transfer app. These are the places
-- a student actually spends: the canteen, the photocopy counter, the library desk.
CREATE TABLE IF NOT EXISTS merchants (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL CHECK (category IN ('canteen','stationery','library','transport','club')),
  -- A merchant holds a wallet like anyone else: money moves between wallets, never
  -- into thin air, so the conservation invariant still covers merchant payments.
  wallet_id   BIGINT      NOT NULL UNIQUE REFERENCES wallets(id) ON DELETE CASCADE,
  operator_id BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A charge is the counter staff saying "that's ৳85". The student scans and confirms.
CREATE TABLE IF NOT EXISTS charges (
  id             BIGSERIAL PRIMARY KEY,
  merchant_id    BIGINT      NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_paisa   BIGINT      NOT NULL CHECK (amount_paisa > 0),
  memo           TEXT,
  -- The QR carries this token, not the charge id: an incrementing id would let anyone
  -- pay (or probe) someone else's bill by guessing the next number.
  token          TEXT        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','paid','expired','cancelled')),
  paid_by        BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  transaction_id BIGINT      REFERENCES transactions(id) ON DELETE SET NULL,
  -- A bill left open at a busy canteen counter must not stay payable all day.
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_charges_merchant ON charges (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charges_open     ON charges (status, expires_at) WHERE status = 'pending';
