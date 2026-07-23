-- Zero-float settlements.
--
-- In zero-float mode the app never holds money: the student pays the outlet's own Bangla
-- QR directly from bKash/Nagad/a bank app, and this table records the reference so the
-- order can be closed and later reconciled against the gateway or bank statement.
--
-- This is what makes a pilot lawful in Bangladesh. Holding a student balance is e-money
-- and needs a Bangladesh Bank PSP licence (BDT 20 crore paid-up); operating without one
-- under the Payment and Settlement Systems Act 2024 is a non-bailable offence. So the
-- money never enters this system — only the evidence that it moved does.

CREATE TABLE IF NOT EXISTS settlements (
  id            BIGSERIAL PRIMARY KEY,
  charge_id     BIGINT      NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  amount_paisa  BIGINT      NOT NULL CHECK (amount_paisa > 0),
  -- How the student actually paid: bkash | nagad | rocket | bank | card | cash
  method        TEXT        NOT NULL,
  -- The MFS/bank transaction id the student read off their own app. UNIQUE because the
  -- same reference must never close two different orders.
  external_ref  TEXT        NOT NULL UNIQUE,
  recorded_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  -- Set once the reference is matched against a gateway/bank statement. Until then the
  -- outlet has a claim, not a confirmed payment — and the report says so honestly.
  reconciled_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlements_charge ON settlements (charge_id);
CREATE INDEX IF NOT EXISTS idx_settlements_open   ON settlements (created_at)
  WHERE reconciled_at IS NULL;
