/*
 * Who raised this order.
 *
 * THE PROBLEM THIS FIXES
 *
 * charges recorded merchant_id and paid_by, but nothing about who CREATED the order. The
 * only attribution available was merchants.operator_id — and that is a CURRENT pointer,
 * not a historical fact. Reassign the canteen counter to a different staff member and
 * every past order silently begins to look as though that person raised it.
 *
 * That is not a missing field, it is a record that rewrites itself. For a system whose
 * whole claim is that money is traceable, "who took this ৳5,000 payment on Tuesday" must
 * have one answer that never changes. The paying side already had `paid_by`; the raising
 * side was simply never asked.
 *
 * It also unblocks the thing the university will eventually want: more than one person on
 * a counter. Today merchants.operator_id allows exactly one, so a canteen with a morning
 * and an evening shift cannot tell the two apart. Recording the actual person per order is
 * the half of that which matters for audit, and it can be done now without waiting for a
 * multi-operator model.
 *
 * ON DELETE SET NULL, not CASCADE — deleting a staff account must never delete the record
 * that an order existed. The same reasoning as order_payments.payer_user_id.
 */
ALTER TABLE charges
  ADD COLUMN IF NOT EXISTS raised_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- "What did this person take today" — the shift-reconciliation question.
CREATE INDEX IF NOT EXISTS idx_charges_raised_by
  ON charges (raised_by_user_id, created_at DESC)
  WHERE raised_by_user_id IS NOT NULL;

/*
 * Backfill existing rows to the outlet's current operator, and say plainly in the column
 * comment that these are INFERRED.
 *
 * The alternative was leaving them NULL. That is more honest about provenance but makes
 * every historical order unattributable, and the inference is very likely correct for a
 * demo database seeded minutes ago. What matters is that the guess is recorded as a guess
 * rather than presented as evidence — anything raised from now on is a real observation.
 */
UPDATE charges c
   SET raised_by_user_id = m.operator_id
  FROM merchants m
 WHERE m.id = c.merchant_id
   AND c.raised_by_user_id IS NULL
   AND m.operator_id IS NOT NULL;

COMMENT ON COLUMN charges.raised_by_user_id IS
  'The user who raised this order, captured at creation. Rows predating migration 012 were '
  'backfilled from merchants.operator_id and are INFERRED, not observed.';

/*
 * Who raised it, who paid it, and what it cost — one place, for the counter screen and the
 * accounts office both.
 *
 * A view rather than the same join written twice: an outlet asking "what did my morning
 * shift take" and a reconciler asking "who raised the order behind this exception" must
 * get the same answer from the same definition.
 */
CREATE OR REPLACE VIEW order_attribution AS
SELECT
  c.id                AS charge_id,
  c.order_ref,
  c.amount_paisa,
  c.memo,
  c.status,
  c.created_at,
  c.paid_at,
  m.id                AS merchant_id,
  m.name              AS merchant_name,
  c.raised_by_user_id,
  raiser.name         AS raised_by_name,
  raiser.email        AS raised_by_email,
  -- Who actually paid, from the zero-float gateway record. NULL while unpaid, which is
  -- the normal state for anything settled by Bangla QR until the bank's file arrives.
  op.payer_user_id,
  payer.name          AS paid_by_name,
  op.gateway,
  op.status           AS payment_status
FROM charges c
JOIN merchants m       ON m.id = c.merchant_id
LEFT JOIN users raiser ON raiser.id = c.raised_by_user_id
LEFT JOIN order_payments op ON op.charge_id = c.id AND op.status = 'PAID'
LEFT JOIN users payer  ON payer.id = op.payer_user_id
WHERE c.order_ref IS NOT NULL;
