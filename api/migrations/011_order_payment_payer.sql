/*
 * Who paid.
 *
 * order_payments recorded the gateway's side of a payment in full — transaction id,
 * validation id, amount, fee — but never which student made it. That was survivable while
 * the student's home screen was a balance, because the balance was the record. Removing
 * the balance (correctly: holding one is unlawful) would have left a student with NO record
 * of their own payments at all, which is a downgrade dressed up as compliance.
 *
 * A student needs to answer three questions from their own phone: what do I owe, what have
 * I paid, and what reference proves it. This column is what makes the second and third
 * answerable.
 *
 * ON DELETE SET NULL rather than CASCADE: a payment is a financial record and must outlive
 * the account that made it. Deleting a student must never delete evidence that money moved
 * — that is a reconciliation hole and, under retention rules, a records-management problem.
 */
ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS payer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- The student's own history is the query this table will serve most often.
CREATE INDEX IF NOT EXISTS idx_order_payments_payer
  ON order_payments (payer_user_id, created_at DESC)
  WHERE payer_user_id IS NOT NULL;

/*
 * A student's payment history, joined to what it bought.
 *
 * A view rather than a query buried in application code: the accounts office reads the same
 * shape when a student disputes a payment, and two divergent definitions of "what this
 * student paid" is precisely how support conversations go wrong.
 */
CREATE OR REPLACE VIEW student_payments AS
SELECT
  op.payer_user_id,
  op.tran_id,
  op.gateway,
  op.status,
  op.amount_paisa,
  op.gateway_amount_paisa,
  op.method,
  op.created_at,
  op.paid_at,
  c.order_ref,
  c.memo,
  c.token        AS order_token,
  c.status       AS order_status,
  m.name         AS merchant_name,
  m.category     AS merchant_category
FROM order_payments op
JOIN charges   c ON c.id = op.charge_id
JOIN merchants m ON m.id = c.merchant_id
WHERE op.payer_user_id IS NOT NULL;
