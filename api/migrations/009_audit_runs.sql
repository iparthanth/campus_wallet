-- Nightly reconciliation audit.
--
-- An invariant that is only checked by the test suite is checked on a developer's laptop
-- and never in production. This table is where the running system records that it checked
-- itself, and what it found — so "were the books in balance last Tuesday?" has an answer
-- that does not depend on anyone having been watching.
--
-- The audit asserts, every night:
--   1. total debits = total credits across the whole ledger        (internal consistency)
--   2. the orders table agrees with the ledger, per outlet         (cross-table consistency)
--   3. nothing has been owed for longer than the ageing threshold  (operational health)
--
-- Check 1 alone is not enough: two tables can each be internally perfect and still
-- disagree with each other, which is precisely the failure that loses money quietly.

DO $$ BEGIN
  CREATE TYPE audit_result AS ENUM ('PASS', 'WARN', 'FAIL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS audit_runs (
  id                  BIGSERIAL    PRIMARY KEY,
  -- The business date audited, not the moment the job ran. A job that runs at 00:05 is
  -- auditing yesterday, and a report that conflates the two is off by one every night.
  business_date       DATE         NOT NULL,
  result              audit_result NOT NULL,

  -- Check 1 — the ledger against itself. Must be exactly zero.
  trial_balance_drift_paisa BIGINT NOT NULL,

  -- Check 2 — orders against the ledger. Zero means every outlet agrees.
  cross_check_discrepancies INT    NOT NULL DEFAULT 0 CHECK (cross_check_discrepancies >= 0),

  -- Check 3 — operational health rather than correctness. Money can legitimately be
  -- outstanding for a few hours; for days it means something is broken upstream.
  unsettled_paisa     BIGINT       NOT NULL DEFAULT 0,
  unsettled_count     INT          NOT NULL DEFAULT 0,
  aged_count          INT          NOT NULL DEFAULT 0,
  unmatched_receipts  INT          NOT NULL DEFAULT 0,

  -- Full findings, so a failure can be investigated months later without re-deriving it
  -- from data that has since moved on.
  detail              JSONB        NOT NULL DEFAULT '{}'::jsonb,

  duration_ms         INT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One audit per business date. Re-running overwrites rather than accumulating duplicates
-- that would make "did the 24th pass?" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_runs_date ON audit_runs (business_date);
CREATE INDEX IF NOT EXISTS idx_audit_runs_failures ON audit_runs (created_at DESC) WHERE result <> 'PASS';
