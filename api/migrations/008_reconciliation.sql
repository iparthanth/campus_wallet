-- Settlement reconciliation.
--
-- WHY THIS IS THE PRODUCT
-- -----------------------
-- Premier University's published fee procedure asks students to pay by bank transfer and
-- then EMAIL accounts@puc.ac.bd with the transaction details, warning that "the deposit
-- will not be updated unless this information is provided". Someone reads that inbox and
-- types the payments into a spreadsheet by hand.
--
-- That is the work this schema automates. The acquirer already knows what it collected;
-- this system already knows what it sold. Reconciliation is matching the two and, more
-- importantly, showing precisely what does NOT match — because the exceptions are where
-- money actually goes missing, and a report that only shows successes hides them.
--
-- THE THREE INVARIANTS
-- --------------------
--   1. The same statement file imported twice must not double-count      (content_sha256)
--   2. One acquirer transaction may settle at most one order              (acquirer_txn_id)
--   3. gross = net + fee, always                                          (CHECK)

DO $$ BEGIN
  CREATE TYPE settlement_line_status AS ENUM (
    'MATCHED',          -- tied to exactly one open order of the same amount
    'UNMATCHED',        -- money arrived that no order explains
    'AMOUNT_MISMATCH',  -- reference found, but the amount disagrees
    'DUPLICATE_REF',    -- the referenced order was already settled
    'ALREADY_IMPORTED'  -- this acquirer transaction was seen in an earlier batch
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------------- import batch

CREATE TABLE IF NOT EXISTS settlement_imports (
  id             BIGSERIAL   PRIMARY KEY,
  acquirer       TEXT        NOT NULL CHECK (length(btrim(acquirer)) > 0),
  -- Filename, API batch id — whatever identifies the source to a human reading the log.
  source_ref     TEXT        NOT NULL,
  -- The business date the statement covers, which is NOT the date it was imported.
  statement_date DATE        NOT NULL,

  /*
   * Hash of the file's exact bytes.
   *
   * UNIQUE, and this is the whole defence against the most likely operational mistake:
   * a staff member re-uploads yesterday's statement. Without it every line settles a
   * second time and the books show twice the revenue. With it, the second import is
   * refused before a single line is read.
   */
  content_sha256 CHAR(64)    NOT NULL UNIQUE CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),

  imported_by    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  line_count     INT         NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  matched_count  INT         NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  gross_paisa    BIGINT      NOT NULL DEFAULT 0 CHECK (gross_paisa >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT matched_within_lines CHECK (matched_count <= line_count)
);

CREATE INDEX IF NOT EXISTS idx_settlement_imports_date
  ON settlement_imports (acquirer, statement_date DESC);

-- -------------------------------------------------------------------------- statement line

CREATE TABLE IF NOT EXISTS settlement_lines (
  id              BIGSERIAL              PRIMARY KEY,
  import_id       BIGINT                 NOT NULL REFERENCES settlement_imports(id) ON DELETE RESTRICT,

  /*
   * The acquirer's own transaction identifier.
   *
   * NOT globally unique, deliberately. The invariant is narrower and more precise: one
   * real movement of money may SETTLE at most one order (enforced by the partial unique
   * index below, on MATCHED rows only).
   *
   * A transaction legitimately appears twice when an acquirer re-cuts a batch. The second
   * occurrence must still be RECORDED — as an ALREADY_IMPORTED exception — because an
   * audit trail that silently drops re-import attempts cannot answer "why does the bank
   * think it sent this twice?". A blanket UNIQUE here would make that row unstorable.
   */
  acquirer_txn_id TEXT                   NOT NULL CHECK (length(btrim(acquirer_txn_id)) > 0),

  -- The order reference the payer's app carried through from EMVCo tag 62/05. NULL when
  -- the payer used a static QR and typed the amount, which is a legitimate case and is
  -- exactly why UNMATCHED exists as a status rather than an error.
  order_ref       TEXT,

  gross_paisa     BIGINT                 NOT NULL CHECK (gross_paisa > 0),
  fee_paisa       BIGINT                 NOT NULL DEFAULT 0 CHECK (fee_paisa >= 0),
  net_paisa       BIGINT                 NOT NULL CHECK (net_paisa > 0),

  -- When the payer actually paid, per the acquirer. Business time, not import time.
  paid_at         TIMESTAMPTZ,

  status          settlement_line_status NOT NULL,
  -- Free text explaining an exception, shown to the staff member who has to resolve it.
  note            TEXT,

  charge_id         BIGINT REFERENCES charges(id)          ON DELETE RESTRICT,
  ledger_posting_id BIGINT REFERENCES ledger_postings(id)  ON DELETE RESTRICT,

  created_at      TIMESTAMPTZ            NOT NULL DEFAULT now(),

  -- The acquirer keeps its commission out of the gross. If these three ever disagree the
  -- statement was parsed wrongly, and silently trusting it would put the error in the books.
  CONSTRAINT gross_equals_net_plus_fee CHECK (gross_paisa = net_paisa + fee_paisa),

  -- A matched line must say what it matched and what it posted. A line that claims
  -- MATCHED with no order attached is the shape of a bug that quietly loses money.
  CONSTRAINT matched_lines_are_linked CHECK (
    status <> 'MATCHED' OR (charge_id IS NOT NULL AND ledger_posting_id IS NOT NULL AND order_ref IS NOT NULL)
  )
);

/*
 * THE invariant: one acquirer transaction settles at most one order.
 *
 * Partial, on MATCHED rows only. This is the difference between "we never record a
 * duplicate" (wrong — destroys the audit trail) and "a duplicate can never move money
 * twice" (right). If application logic ever regressed and tried to settle the same bank
 * transaction against a second order, this index refuses the write.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_lines_settles_once
  ON settlement_lines (acquirer_txn_id) WHERE status = 'MATCHED';

CREATE INDEX IF NOT EXISTS idx_settlement_lines_import ON settlement_lines (import_id);
CREATE INDEX IF NOT EXISTS idx_settlement_lines_txn    ON settlement_lines (acquirer_txn_id);
CREATE INDEX IF NOT EXISTS idx_settlement_lines_status ON settlement_lines (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_lines_ref    ON settlement_lines (order_ref) WHERE order_ref IS NOT NULL;

-- Open exceptions are what staff work through each morning, so they get their own index.
CREATE INDEX IF NOT EXISTS idx_settlement_lines_open
  ON settlement_lines (created_at DESC) WHERE status <> 'MATCHED';

-- ----------------------------------------------------------------- orders gain settlement

-- A settled order points back at the line that settled it, so "how do we know this was
-- paid?" is answerable from the order row alone during a dispute.
ALTER TABLE charges ADD COLUMN IF NOT EXISTS settlement_line_id BIGINT
  REFERENCES settlement_lines(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_settlement_line
  ON charges (settlement_line_id) WHERE settlement_line_id IS NOT NULL;

-- ------------------------------------------------------------------- the exception views

/*
 * Money received that no order explains.
 *
 * Usually a static-QR payment where the payer typed the amount, or a reference that was
 * mistyped. Either way somebody paid the university and the university does not know what
 * for — which must be visible, not swallowed.
 */
CREATE OR REPLACE VIEW reconciliation_unmatched_receipts AS
SELECT l.id, l.acquirer_txn_id, l.order_ref, l.gross_paisa, l.net_paisa, l.fee_paisa,
       l.paid_at, l.status, l.note, i.acquirer, i.statement_date, i.source_ref
FROM settlement_lines l
JOIN settlement_imports i ON i.id = l.import_id
WHERE l.status <> 'MATCHED'
ORDER BY l.created_at DESC;

/*
 * Orders sold but never paid for.
 *
 * The mirror image, and the more alarming direction: goods left the counter and no money
 * arrived. `age_hours` is what turns this from a list into a priority queue.
 */
CREATE OR REPLACE VIEW reconciliation_unsettled_orders AS
SELECT c.id, c.order_ref, c.amount_paisa, c.memo, c.created_at, c.expires_at, c.status,
       m.id AS merchant_id, m.name AS merchant_name,
       ROUND(EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0, 1) AS age_hours
FROM charges c
JOIN merchants m ON m.id = c.merchant_id
WHERE c.order_ref IS NOT NULL
  AND c.settlement_line_id IS NULL
  AND c.status <> 'cancelled'
ORDER BY c.created_at ASC;

/*
 * The daily control total, per outlet.
 *
 * `unsettled_paisa` must equal that outlet's PUC:RECEIVABLE:ORDERS balance in the ledger.
 * Two independent derivations of the same number: if they ever disagree, either the
 * ledger or the order table is wrong, and that is worth knowing before a student is told
 * their payment did not arrive.
 */
CREATE OR REPLACE VIEW reconciliation_summary AS
SELECT
  m.id   AS merchant_id,
  m.name AS merchant_name,
  COUNT(c.id)                                                                        AS orders_total,
  COUNT(c.id) FILTER (WHERE c.settlement_line_id IS NOT NULL)                        AS orders_settled,
  COUNT(c.id) FILTER (WHERE c.settlement_line_id IS NULL AND c.status <> 'cancelled') AS orders_unsettled,
  COALESCE(SUM(c.amount_paisa), 0)::BIGINT                                           AS gross_paisa,
  COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.settlement_line_id IS NOT NULL), 0)::BIGINT AS settled_paisa,
  COALESCE(SUM(c.amount_paisa) FILTER (WHERE c.settlement_line_id IS NULL AND c.status <> 'cancelled'), 0)::BIGINT AS unsettled_paisa
FROM merchants m
LEFT JOIN charges c ON c.merchant_id = m.id AND c.order_ref IS NOT NULL
GROUP BY m.id, m.name;
