import { withTransaction, query } from '../db/pool.js';
import { config } from '../config.js';
import { isValidPaisa } from './money.js';
import { TopupError } from './topup.js';
import * as ssl from '../services/sslcommerz.js';

/** Opens an SSLCommerz session and records our side before the student leaves the site. */
export async function startSslTopup({ userId, amountPaisa }) {
  if (!isValidPaisa(amountPaisa)) {
    throw new TopupError(422, 'INVALID_AMOUNT', 'Enter a valid amount');
  }

  const user = (await query('SELECT id, name, email FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) throw new TopupError(404, 'NO_USER', 'User not found');

  // tran_id is ours and must be unique — it is what ties the gateway's answer back to
  // this row, and it doubles as the idempotency key on the credit path.
  const tranId = `CW-${userId}-${Date.now()}`;

  let session;
  try {
    session = await ssl.initiatePayment({
      amountPaisa,
      tranId,
      customer: { name: user.name, email: user.email },
      callbackBase: config.ssl.callbackBase,
    });
  } catch (err) {
    throw new TopupError(502, 'GATEWAY_UNAVAILABLE', err.message);
  }

  await withTransaction((client) =>
    client.query(
      "INSERT INTO topups (user_id, amount_paisa, payment_id, provider) VALUES ($1,$2,$3,'sslcommerz')",
      [userId, amountPaisa, tranId]
    )
  );

  return { tranId, gatewayUrl: session.gatewayUrl, methods: session.methods, amountPaisa };
}

/**
 * Credit a wallet for a validated SSLCommerz payment — exactly once.
 *
 * Locks the topup row before deciding, so the browser redirect, the server-to-server
 * IPN, and a manual retry can all arrive at the same moment and only one credits.
 */
async function creditOnce(client, { tranId, valId, method }) {
  const res = await client.query(
    'SELECT id, user_id, amount_paisa, status FROM topups WHERE payment_id = $1 FOR UPDATE',
    [tranId]
  );
  if (res.rowCount === 0) throw new TopupError(404, 'UNKNOWN_PAYMENT', 'No top-up matches that transaction');

  const topup = res.rows[0];
  if (topup.status === 'completed') return { topup, credited: false, replayed: true };

  await client.query('UPDATE wallets SET balance_paisa = balance_paisa + $1 WHERE user_id = $2',
    [topup.amount_paisa, topup.user_id]);
  await client.query(
    "UPDATE topups SET status='completed', val_id=$1, method=$2, credited_at=now() WHERE id=$3",
    [valId ?? null, method ?? null, topup.id]
  );
  return { topup, credited: true, replayed: false };
}

/**
 * Confirm a payment and credit the wallet.
 *
 * The amount is re-checked against what SSLCommerz says was actually paid. Without that,
 * a student could open a ৳10 session, edit the redirect, and claim a ৳10,000 top-up —
 * the gateway's number is the only one that counts.
 */
export async function completeSslTopup({ valId }) {
  const result = await ssl.validatePayment(valId);
  if (!result.ok) {
    throw new TopupError(402, 'PAYMENT_NOT_VALID', `Gateway reported ${result.status}`);
  }

  const expected = (await query('SELECT amount_paisa FROM topups WHERE payment_id = $1', [result.tranId])).rows[0];
  if (!expected) throw new TopupError(404, 'UNKNOWN_PAYMENT', 'No top-up matches that transaction');

  const paidPaisa = Math.round(result.amountTaka * 100);
  if (paidPaisa !== Number(expected.amount_paisa)) {
    throw new TopupError(409, 'AMOUNT_MISMATCH',
      `Gateway settled ${paidPaisa} paisa but this top-up expected ${expected.amount_paisa}`);
  }

  return withTransaction((client) =>
    creditOnce(client, { tranId: result.tranId, valId, method: result.method }));
}
