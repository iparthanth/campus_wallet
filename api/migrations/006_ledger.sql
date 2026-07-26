-- Double-entry ledger core.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT THE `wallets` TABLE
-- -----------------------------------------------------
-- `wallets.balance_paisa` is a MUTABLE cell. It answers "how much is there now" and
-- nothing else: it cannot answer "why", "since when", or "who agreed to it". Once a
-- balance is disputed — and at a canteen counter it will be — a mutable cell has already
-- destroyed the evidence needed to settle the dispute.
--
-- This ledger is append-only. Balances are DERIVED by summing entries, so history cannot
-- silently disagree with the present. That is what makes the nightly reconciliation report
-- meaningful rather than decorative.
--
-- WHAT IT RECORDS (and deliberately does not)
-- -------------------------------------------
-- Under the Payment and Settlement Systems Act 2024 s.15(1), no "person, institution or
-- company" may issue a prepaid payment instrument without Bangladesh Bank approval, and
-- there is no closed-loop carve-out in the enacted Act. So this ledger does NOT hold
-- custodied student money. It records OBLIGATIONS and SETTLEMENTS:
--
--   * a student owes the university for an order   (receivable)
--   * revenue the university has earned            (revenue)
--   * money that actually landed in a bank account (asset)
--   * what a gateway is still holding              (clearing)
--   * commission the gateway took                  (expense)
--
-- The money itself moves over licensed rails, between the student's bank/MFS app and the
-- university's own bank account. This system records that it happened and proves the books
-- agree — which is the manual work PUC's accounts office does today by reading email.

-- ---------------------------------------------------------------------------- enums

DO $$ BEGIN
  CREATE TYPE account_class AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE entry_direction AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE posting_status AS ENUM ('POSTED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------- chart of accounts

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            BIGSERIAL PRIMARY KEY,
  -- Structured, human-readable, and stable: 'PUC:REVENUE:CANTEEN_AB4'. A report that
  -- names accounts by code stays readable when someone renames the outlet.
  code          TEXT          NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9:_]{3,80}$'),
  name          TEXT          NOT NULL CHECK (length(btrim(name)) > 0),
  class         account_class NOT NULL,
  currency      CHAR(3)       NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),

  -- Optional ownership links. A student receivable account belongs to a user; an outlet
  -- revenue account belongs to a merchant. Both NULL for institutional accounts.
  owner_user_id BIGINT        REFERENCES users(id)     ON DELETE RESTRICT,
  merchant_id   BIGINT        REFERENCES merchants(id) ON DELETE RESTRICT,

  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- An account belongs to at most one owner. Both set would make "whose money is this?"
  -- ambiguous, which is the one question a ledger must never be ambiguous about.
  CONSTRAINT one_owner_at_most CHECK (owner_user_id IS NULL OR merchant_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner    ON ledger_accounts (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_merchant ON ledger_accounts (merchant_id)   WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_class    ON ledger_accounts (class);

-- One receivable account per student, one revenue account per outlet — enforced here so
-- a duplicate cannot be created by a racing request and then quietly split a balance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_user_class
  ON ledger_accounts (owner_user_id, class) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_merchant_class
  ON ledger_accounts (merchant_id, class) WHERE merchant_id IS NOT NULL;

-- --------------------------------------------------------------------------- postings

-- A posting is one indivisible accounting event: "student 42 ordered ৳85 of lunch".
-- Its entries must balance. Nothing is ever half-posted.
CREATE TABLE IF NOT EXISTS ledger_postings (
  id              BIGSERIAL      PRIMARY KEY,
  -- The caller's key. UNIQUE is the entire idempotency mechanism: a retried request
  -- collides here and is rejected by the database rather than posting twice.
  idempotency_key TEXT           NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  -- What kind of event this was. Reports group by it; the reconciler filters on it.
  kind            TEXT           NOT NULL CHECK (kind ~ '^[A-Z_]{3,40}$'),
  status          posting_status NOT NULL DEFAULT 'POSTED',
  description     TEXT           CHECK (description IS NULL OR length(description) <= 500),

  -- BUSINESS time vs SYSTEM time, deliberately separate. A settlement file imported on
  -- Monday may describe a payment made on Saturday; a report of "Saturday's takings" that
  -- used the import timestamp would be wrong, and wrong in a way nobody notices for months.
  occurred_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

  -- A voided posting is reversed by a NEW posting, never by deletion. This column only
  -- records which posting did the reversing, so the audit trail stays intact.
  voided_by       BIGINT         REFERENCES ledger_postings(id) ON DELETE RESTRICT,
  voided_at       TIMESTAMPTZ,

  CONSTRAINT void_fields_agree CHECK (
    (status = 'VOIDED' AND voided_by IS NOT NULL AND voided_at IS NOT NULL) OR
    (status = 'POSTED' AND voided_by IS NULL     AND voided_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_postings_kind_time ON ledger_postings (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_postings_occurred  ON ledger_postings (occurred_at DESC, id DESC);

-- ---------------------------------------------------------------------------- entries

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL       PRIMARY KEY,
  posting_id   BIGINT          NOT NULL REFERENCES ledger_postings(id) ON DELETE RESTRICT,
  account_id   BIGINT          NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  direction    entry_direction NOT NULL,
  -- Always POSITIVE. Direction carries the sign. A signed amount plus a direction gives
  -- two ways to say "negative", and they eventually disagree.
  amount_paisa BIGINT          NOT NULL CHECK (amount_paisa > 0),
  created_at   TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS idx_entries_posting ON ledger_entries (posting_id);

-- --------------------------------------------------------- invariant 1: entries balance

/*
 * Sum of debits must equal sum of credits, per posting.
 *
 * This is a DEFERRABLE INITIALLY DEFERRED constraint trigger, which is the only correct
 * mechanism here: a plain CHECK cannot see other rows, and a non-deferred trigger would
 * fire after the FIRST entry is inserted, when the posting is legitimately unbalanced.
 * Deferring to COMMIT lets the application insert both legs naturally and still makes an
 * unbalanced posting impossible to commit.
 *
 * Note this fires per row. That is intentional: it must also catch an entry inserted into
 * an already-committed posting by some later code path.
 */
CREATE OR REPLACE FUNCTION assert_posting_balanced() RETURNS TRIGGER AS $$
DECLARE
  debits  BIGINT;
  credits BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(amount_paisa) FILTER (WHERE direction = 'DEBIT'),  0),
    COALESCE(SUM(amount_paisa) FILTER (WHERE direction = 'CREDIT'), 0)
  INTO debits, credits
  FROM ledger_entries
  WHERE posting_id = COALESCE(NEW.posting_id, OLD.posting_id);

  IF debits <> credits THEN
    RAISE EXCEPTION
      'Posting % does not balance: debits=% paisa, credits=% paisa (difference %)',
      COALESCE(NEW.posting_id, OLD.posting_id), debits, credits, debits - credits
      USING ERRCODE = 'check_violation';
  END IF;

  -- A posting with no entries at all is not a posting.
  IF debits = 0 AND credits = 0 THEN
    RAISE EXCEPTION 'Posting % has no entries', COALESCE(NEW.posting_id, OLD.posting_id)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_posting_balanced();

-- ------------------------------------------------------- invariant 2: entries are immutable

/*
 * An append-only ledger that can be UPDATEd is just a mutable balance with extra steps.
 * Corrections are made by posting a reversal, which leaves both the error and the fix
 * visible — that is the property an auditor actually needs.
 *
 * This blocks the application's own code paths, not a determined superuser. It is a
 * guardrail against a well-meaning future patch, which is the realistic threat.
 */
CREATE OR REPLACE FUNCTION forbid_entry_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only: % is not permitted. Post a reversing entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_entry_mutation();

-- Postings are immutable too, except for the void transition, which is the one legitimate
-- state change and is itself append-only in effect (it points at a reversing posting).
CREATE OR REPLACE FUNCTION forbid_posting_rewrite() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_postings is append-only: DELETE is not permitted. Void it instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id <> OLD.id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.kind <> OLD.kind OR NEW.occurred_at <> OLD.occurred_at THEN
    RAISE EXCEPTION 'Posting % is immutable; only the void transition may change it', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'Posting % is already voided and cannot change again', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_postings_immutable ON ledger_postings;
CREATE TRIGGER trg_postings_immutable
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_posting_rewrite();

-- ------------------------------------------------------------------- derived balances

/*
 * Balance is DERIVED, never stored.
 *
 * The sign convention follows the account's normal balance, so a report never has to
 * remember which way round a class runs:
 *   ASSET, EXPENSE            increase on DEBIT   -> debits - credits
 *   LIABILITY, EQUITY, REVENUE increase on CREDIT -> credits - debits
 *
 * At PUC's scale (~6,000 students, low thousands of postings a day) summing an indexed
 * BIGINT column is microseconds. A cached balance column would be faster and would be the
 * exact bug this table was created to eliminate, so it is not offered.
 */
CREATE OR REPLACE VIEW ledger_account_balances AS
SELECT
  a.id                AS account_id,
  a.code,
  a.name,
  a.class,
  a.owner_user_id,
  a.merchant_id,
  COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'DEBIT'),  0)::BIGINT AS debits_paisa,
  COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'CREDIT'), 0)::BIGINT AS credits_paisa,
  CASE
    WHEN a.class IN ('ASSET', 'EXPENSE')
      THEN COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'DEBIT'),  0)
         - COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'CREDIT'), 0)
    ELSE
           COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'CREDIT'), 0)
         - COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'DEBIT'),  0)
  END::BIGINT AS balance_paisa,
  COUNT(e.id)::BIGINT AS entry_count
FROM ledger_accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
LEFT JOIN ledger_postings p ON p.id = e.posting_id AND p.status = 'POSTED'
GROUP BY a.id, a.code, a.name, a.class, a.owner_user_id, a.merchant_id;

/*
 * The whole-ledger trial balance. Across every account, total debits must equal total
 * credits — the single number the nightly audit asserts is zero.
 *
 * If this is ever non-zero the correct response is to stop and investigate, not to
 * "adjust" it. A ledger that can be adjusted to balance is not evidence of anything.
 */
CREATE OR REPLACE VIEW ledger_trial_balance AS
SELECT
  COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'DEBIT'),  0)::BIGINT AS total_debits_paisa,
  COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'CREDIT'), 0)::BIGINT AS total_credits_paisa,
  (COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'DEBIT'),  0)
 - COALESCE(SUM(e.amount_paisa) FILTER (WHERE e.direction = 'CREDIT'), 0))::BIGINT AS drift_paisa,
  COUNT(DISTINCT e.posting_id)::BIGINT AS posting_count,
  COUNT(e.id)::BIGINT AS entry_count
FROM ledger_entries e
JOIN ledger_postings p ON p.id = e.posting_id
WHERE p.status = 'POSTED';
