import { withTransaction } from '../db/pool.js';
import { isValidPaisa } from './money.js';
import * as bkash from '../services/bkash.js';

export class TopupError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Step 1 — ask bKash to create a payment and record our side of it. */
export async function startTopup({ userId, amountPaisa }) {
  if (!isValidPaisa(amountPaisa)) {
    throw new TopupError(422, 'INVALID_AMOUNT', 'amount_paisa must be a positive whole number of paisa within the cap');
  }

  const invoiceNumber = `CW-${userId}-${Date.now()}`;
  const created = await bkash.createPayment({
    amountPaisa,
    invoiceNumber,
    callbackURL: (await import('../config.js')).config.bkash.callbackUrl,
  });

  const paymentID = created.paymentID;
  if (!paymentID) throw new TopupError(502, 'BKASH_ERROR', 'bKash did not return a paymentID');

  await withTransaction(async (client) => {
    await client.query(
      'INSERT INTO topups (user_id, amount_paisa, payment_id) VALUES ($1,$2,$3)',
      [userId, amountPaisa, paymentID]
    );
  });

  return { paymentID, bkashURL: created.bkashURL, amountPaisa, invoiceNumber };
}

/**
 * Credit the wallet for a top-up, exactly once.
 *
 * The topup row is locked FOR UPDATE and re-checked inside the transaction, so a
 * duplicated callback, a retry, and the background reconciler can all race here and
 * only one of them will move money — the same discipline as transfer().
 */
async function creditFromTopup(client, { paymentID, trxId }) {
  const res = await client.query(
    'SELECT id, user_id, amount_paisa, status FROM topups WHERE payment_id = $1 FOR UPDATE',
    [paymentID]
  );
  if (res.rowCount === 0) throw new TopupError(404, 'UNKNOWN_PAYMENT', 'No top-up for that paymentID');

  const topup = res.rows[0];
  if (topup.status === 'completed') {
    return { topup, credited: false, replayed: true }; // already credited — do nothing
  }
  if (topup.status === 'failed') {
    throw new TopupError(409, 'TOPUP_FAILED', 'This top-up already failed');
  }

  await client.query(
    'UPDATE wallets SET balance_paisa = balance_paisa + $1 WHERE user_id = $2',
    [topup.amount_paisa, topup.user_id]
  );
  await client.query(
    "UPDATE topups SET status = 'completed', trx_id = $1, credited_at = now() WHERE id = $2",
    [trxId ?? null, topup.id]
  );

  return { topup, credited: true, replayed: false };
}

/** Translate a bKash transport failure into the right HTTP status for our client. */
function mapBkashError(err) {
  // 2062 = invalid payment ID. That is the caller's mistake, not our server failing.
  if (err.httpStatus === 404 || err.bkashStatusCode === '2062') {
    return new TopupError(404, 'UNKNOWN_PAYMENT', 'bKash does not recognise that paymentID');
  }
  return new TopupError(502, 'BKASH_UNAVAILABLE', 'Could not reach bKash — try again shortly');
}

/** Step 2 — the user returned from bKash; execute and credit. */
export async function completeTopup({ paymentID }) {
  let result;
  try {
    result = await bkash.executePayment(paymentID);
  } catch (err) {
    throw mapBkashError(err);
  }

  // bKash reports success as transactionStatus "Completed" with a trxID.
  const ok = result.transactionStatus === 'Completed' || result.statusCode === '0000';
  if (!ok) {
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE topups SET status = 'failed' WHERE payment_id = $1 AND status = 'initiated'",
        [paymentID]
      );
    });
    throw new TopupError(402, 'PAYMENT_NOT_COMPLETED', result.statusMessage ?? 'Payment was not completed');
  }

  return withTransaction((client) => creditFromTopup(client, { paymentID, trxId: result.trxID }));
}

/**
 * Recovery path: the user paid but we never received the callback.
 * Asks bKash for the truth and credits if the payment really did complete.
 */
export async function reconcileTopup({ paymentID }) {
  let status;
  try {
    status = await bkash.queryPayment(paymentID);
  } catch (err) {
    throw mapBkashError(err);
  }
  const completed = status.transactionStatus === 'Completed';

  if (!completed) {
    return { credited: false, reason: status.transactionStatus ?? 'unknown' };
  }
  return withTransaction((client) => creditFromTopup(client, { paymentID, trxId: status.trxID }));
}
