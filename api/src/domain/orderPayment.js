import { withTransaction, query } from '../db/pool.js';
import { config } from '../config.js';
import { post, ACCOUNTS, DEBIT, CREDIT } from './ledger.js';
import { OrderError } from './order.js';
import * as ssl from '../services/sslcommerz.js';

/**
 * Paying ONE order through a payment gateway — the lawful zero-float online flow.
 *
 * The student pays a specific order. The money goes to the university's own merchant
 * account at the gateway and is recorded against that order in the ledger. At no point
 * does this system hold a balance, which is what keeps it on the right side of PSS Act
 * 2024 s.15(1).
 *
 * Contrast with the legacy /topup path, which credits `wallets.balance_paisa`. That is the
 * closed-loop flow production refuses to boot into, and it was — until this module — the
 * ONLY thing the working SSLCommerz integration was wired to. The gateway served an
 * unlawful flow while the lawful flow had no gateway at all.
 *
 * Security boundary: nothing the browser sends is trusted. The redirect carries parameters
 * a student can edit, so only the server-to-server validation response decides whether an
 * order is marked paid, and the amount it reports is checked against what we asked for.
 */

/** How long a gateway session is considered live before we stop expecting an answer. */
const SESSION_TTL_MINUTES = 30;

/**
 * Begin an online payment for an order.
 *
 * Records our side BEFORE redirecting. If the student pays and the callback never arrives —
 * routine on Bangladeshi mobile data — the row is still here for the IPN or a manual
 * reconcile to find. A gateway session with no local record is an unrecoverable payment.
 */
export async function startOrderPayment({ token, payerUserId }) {
  const order = (await query(
    `SELECT c.id, c.order_ref, c.amount_paisa, c.memo, c.status, c.expires_at,
            m.id AS merchant_id, m.name AS merchant_name
       FROM charges c JOIN merchants m ON m.id = c.merchant_id
      WHERE c.token = $1`,
    [token]
  )).rows[0];

  if (!order) throw new OrderError(404, 'NO_ORDER', 'This code is not valid');
  if (order.status === 'paid') {
    throw new OrderError(409, 'ALREADY_PAID', 'This order has already been paid');
  }
  if (order.status !== 'pending' || new Date(order.expires_at) < new Date()) {
    throw new OrderError(409, 'ORDER_EXPIRED', 'This order has expired. Ask the counter to raise it again.');
  }
  if (!config.ssl.enabled) {
    throw new OrderError(503, 'GATEWAY_DISABLED', 'Online payment is not configured on this deployment');
  }

  // Refuse to open a second session while one is still live. Two open sessions for one
  // order is how a student ends up paying twice and needing a refund nobody notices.
  const live = (await query(
    `SELECT tran_id FROM order_payments
      WHERE charge_id = $1 AND status = 'INITIATED'
        AND created_at > now() - ($2 || ' minutes')::interval`,
    [order.id, String(SESSION_TTL_MINUTES)]
  )).rows[0];
  if (live) {
    throw new OrderError(409, 'PAYMENT_IN_PROGRESS',
      'A payment for this order is already open. Finish or cancel it before starting another.');
  }

  const payer = (await query('SELECT id, name, email FROM users WHERE id = $1', [payerUserId])).rows[0];
  if (!payer) throw new OrderError(404, 'NO_USER', 'User not found');

  // Ours, and unique. It is the join key on the confirmation path, so it is never derived
  // from anything the browser can influence. The order_ref is embedded so an operator
  // reading the gateway's own dashboard can tell which order a payment belongs to.
  const tranId = `PUCORD-${order.order_ref}-${Date.now()}`;

  let session;
  try {
    session = await ssl.initiatePayment({
      amountPaisa: Number(order.amount_paisa),
      tranId,
      customer: { name: payer.name, email: payer.email },
      callbackBase: config.ssl.callbackBase,
      returnPath: '/orders/ssl/return',
      ipnPath: '/orders/ssl/ipn',
      // What the student sees on the gateway's own page.
      product: { name: `${order.merchant_name} — ${order.order_ref}`, category: 'campus' },
    });
  } catch (err) {
    throw new OrderError(502, 'GATEWAY_UNAVAILABLE', err.message);
  }

  await query(
    `INSERT INTO order_payments (charge_id, gateway, tran_id, session_key, amount_paisa)
     VALUES ($1, 'sslcommerz', $2, $3, $4)`,
    [order.id, tranId, session.sessionKey ?? null, order.amount_paisa]
  );

  return {
    tran_id: tranId,
    gateway_url: session.gatewayUrl,
    methods: session.methods,
    order_ref: order.order_ref,
    amount_paisa: Number(order.amount_paisa),
    merchant_name: order.merchant_name,
  };
}

/**
 * Settle a validated payment against its order — exactly once.
 *
 * Locks the payment row before deciding, so the browser redirect, the server-to-server IPN
 * and a manual retry can all arrive at the same instant and only one settles. On
 * Bangladeshi mobile data the redirect frequently never arrives at all, so the IPN is not
 * a nicety — it is the path that actually works.
 */
async function settleOnce(client, { tranId, valId, method, bankTranId, paidPaisa, feePaisa }) {
  const res = await client.query(
    `SELECT op.id, op.charge_id, op.amount_paisa, op.status,
            c.order_ref, c.status AS order_status, c.merchant_id,
            m.name AS merchant_name
       FROM order_payments op
       JOIN charges c   ON c.id = op.charge_id
       JOIN merchants m ON m.id = c.merchant_id
      WHERE op.tran_id = $1
      FOR UPDATE OF op, c`,
    [tranId]
  );
  if (res.rowCount === 0) {
    throw new OrderError(404, 'UNKNOWN_PAYMENT', 'No order payment matches that transaction');
  }

  const payment = res.rows[0];
  if (payment.status === 'PAID') {
    return { payment, settled: false, replayed: true };
  }

  /*
   * The order was already settled — by a DIFFERENT payment.
   *
   * Realistic: the student abandons session A, pays with session B, and A completes late at
   * the gateway anyway. Both are real money, so this is a second payment and a refund is
   * owed. The charge row is locked above (FOR UPDATE OF op, c) so two payments for the same
   * order cannot race past this check.
   *
   * Recorded rather than thrown away, and recorded with a status of its own: without one,
   * marking this PAID would violate the "one PAID payment per order" index and surface as a
   * raw constraint error, which the IPN handler would read as transient and ask the gateway
   * to retry forever.
   */
  if (payment.order_status === 'paid') {
    await client.query(
      `UPDATE order_payments
          SET status = 'DUPLICATE', val_id = $2, method = $3, bank_tran_id = $4,
              gateway_amount_paisa = $5, note = $6
        WHERE id = $1`,
      [payment.id, valId ?? null, method ?? null, bankTranId ?? null, paidPaisa,
       `Order ${payment.order_ref} was already settled by another payment. ` +
       `This is a SECOND payment of ${paidPaisa} paisa and a refund is owed to the student.`]
    );
    return { payment, settled: false, duplicate: { paidPaisa, orderRef: payment.order_ref } };
  }

  const expected = Number(payment.amount_paisa);

  /*
   * The gateway's number is the only one that counts.
   *
   * Without this a student could open a ৳10 session, edit the redirect, and claim a ৳10,000
   * order was paid. Recorded as MISMATCH rather than thrown away: a payment that really
   * happened for the wrong amount is a refund conversation, and destroying the evidence
   * makes that conversation impossible.
   */
  if (paidPaisa !== expected) {
    await client.query(
      `UPDATE order_payments
          SET status = 'MISMATCH', val_id = $2, method = $3, bank_tran_id = $4,
              gateway_amount_paisa = $5,
              note = $6
        WHERE id = $1`,
      [payment.id, valId ?? null, method ?? null, bankTranId ?? null, paidPaisa,
       `Gateway settled ${paidPaisa} paisa but the order is ${expected} paisa`]
    );
    /*
     * Returned, NOT thrown.
     *
     * Throwing here would roll back the transaction — erasing the very MISMATCH row we
     * just wrote to record it. The rejection and the audit trail have opposite
     * transactional needs: the rejection must undo the money movement, the record must
     * survive it. So the transaction commits the evidence and the caller raises the error
     * afterwards. Money really did arrive for the wrong amount; that is a refund
     * conversation, and destroying the evidence makes it impossible to have.
     */
    return { payment, settled: false, mismatch: { paidPaisa, expected } };
  }

  /*
   * Stage 2 of the three-stage model (see migration 010).
   *
   * The gateway is holding the money, not PUC — so it lands in CLEARING, not BANK. The
   * bank leg is posted later, when the gateway's settlement report is imported. Booking
   * straight to bank here would show cash the university does not yet have.
   */
  const net = paidPaisa - feePaisa;
  const entries = [
    { account: ACCOUNTS.gatewayClearing('sslcommerz'), direction: DEBIT, amountPaisa: net },
  ];
  if (feePaisa > 0) {
    entries.push({ account: ACCOUNTS.gatewayFee('sslcommerz'), direction: DEBIT, amountPaisa: feePaisa });
  }
  entries.push({
    account: ACCOUNTS.orderReceivable(payment.merchant_id, payment.merchant_name),
    direction: CREDIT,
    amountPaisa: paidPaisa,
  });

  const { posting } = await post({
    client,
    idempotencyKey: `order-paid-${tranId}`,
    kind: 'ORDER_PAID_ONLINE',
    description: `SSLCommerz settled ${payment.order_ref}`,
    entries,
  });

  await client.query(
    `UPDATE order_payments
        SET status = 'PAID', val_id = $2, method = $3, bank_tran_id = $4,
            gateway_amount_paisa = $5, fee_paisa = $6,
            ledger_posting_id = $7, paid_at = now()
      WHERE id = $1`,
    [payment.id, valId, method ?? null, bankTranId ?? null, paidPaisa, feePaisa, posting.id]
  );

  await client.query(
    "UPDATE charges SET status = 'paid', paid_at = now() WHERE id = $1 AND status <> 'paid'",
    [payment.charge_id]
  );

  return { payment, settled: true, replayed: false, postingId: posting.id };
}

/**
 * Confirm with the gateway, then settle.
 *
 * Validation happens BEFORE the transaction opens: it is a network call to a third party,
 * and holding a database transaction open across it would pin a connection for as long as
 * SSLCommerz takes to answer.
 */
export async function confirmOrderPayment({ valId }) {
  if (!valId) throw new OrderError(422, 'NO_VAL_ID', 'A validation id is required');

  const result = await ssl.validatePayment(valId);
  if (!result.ok) {
    throw new OrderError(402, 'PAYMENT_NOT_VALID', `Gateway reported ${result.status}`);
  }

  const paidPaisa = Math.round(result.amountTaka * 100);
  // store_amount is what the gateway will actually pay out; the difference is its fee.
  const storeTaka = Number(result.raw?.store_amount ?? result.amountTaka);
  const feePaisa = Math.max(0, paidPaisa - Math.round(storeTaka * 100));

  const out = await withTransaction((client) =>
    settleOnce(client, {
      tranId: result.tranId,
      valId,
      method: result.method,
      bankTranId: result.bankTranId,
      paidPaisa,
      feePaisa,
    }));

  // Raised only after the row has committed, so the evidence outlives the refusal.
  if (out.mismatch) {
    throw new OrderError(409, 'AMOUNT_MISMATCH',
      `Gateway settled ${out.mismatch.paidPaisa} paisa but this order expects ${out.mismatch.expected}`);
  }
  if (out.duplicate) {
    throw new OrderError(409, 'ALREADY_SETTLED',
      `Order ${out.duplicate.orderRef} was already paid. This ${out.duplicate.paidPaisa} paisa ` +
      'payment is a duplicate and a refund is owed.');
  }
  return out;
}

/** Mark an abandoned or refused session, so it stops blocking a fresh attempt. */
export async function closeOrderPayment({ tranId, status, note = null }) {
  if (!['FAILED', 'CANCELLED'].includes(status)) {
    throw new OrderError(422, 'BAD_STATUS', 'Only FAILED or CANCELLED may be recorded here');
  }
  const res = await query(
    `UPDATE order_payments SET status = $2, note = $3
      WHERE tran_id = $1 AND status = 'INITIATED'
      RETURNING id, charge_id, status`,
    [tranId, status, note]
  );
  return res.rows[0] ?? null;
}

/** Payment attempts for one order — the history a student or officer needs when chasing. */
export async function paymentsForOrder(token) {
  const order = (await query('SELECT id FROM charges WHERE token = $1', [token])).rows[0];
  if (!order) throw new OrderError(404, 'NO_ORDER', 'This code is not valid');

  const rows = (await query(
    `SELECT tran_id, gateway, status, amount_paisa, gateway_amount_paisa, fee_paisa,
            method, bank_tran_id, note, created_at, paid_at
       FROM order_payments WHERE charge_id = $1 ORDER BY created_at DESC`,
    [order.id]
  )).rows;
  return { payments: rows };
}

/** What the gateway is still holding — collected from students, not yet in PUC's bank. */
export async function clearingOutstanding() {
  const rows = (await query('SELECT * FROM gateway_clearing_outstanding')).rows;
  return { clearing: rows };
}
