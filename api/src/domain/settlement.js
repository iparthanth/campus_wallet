import { withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { ChargeError } from './charge.js';

/** Methods a student can actually pay an outlet with in Bangladesh. */
const METHODS = new Set(['bkash', 'nagad', 'rocket', 'upay', 'bank', 'card', 'cash']);

/**
 * Close a charge against a payment that happened OUTSIDE this system.
 *
 * The student scanned the outlet's Bangla QR in their own bKash/Nagad/bank app, so the
 * money went straight from them to the outlet's account. Nothing moves between wallets
 * here — this records the evidence and closes the order.
 *
 * The reference is UNIQUE, which is the whole anti-fraud mechanism: one bKash transaction
 * id can close exactly one bill, so a student cannot pay ৳50 once and reuse the reference
 * at three counters.
 */
export async function settleCharge({ token, method, externalRef, recordedByUserId }) {
  if (config.walletMode !== 'zero_float') {
    throw new ChargeError(409, 'WRONG_MODE', 'This deployment holds balances; pay from the wallet instead');
  }
  const m = String(method ?? '').toLowerCase();
  if (!METHODS.has(m)) {
    throw new ChargeError(422, 'BAD_METHOD', `Method must be one of: ${[...METHODS].join(', ')}`);
  }
  const ref = String(externalRef ?? '').trim().toUpperCase();
  if (ref.length < 4 || ref.length > 60) {
    throw new ChargeError(422, 'BAD_REFERENCE', 'Enter the transaction id from your payment app');
  }

  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT c.id, c.amount_paisa, c.status, c.expires_at, m.name AS merchant_name
         FROM charges c JOIN merchants m ON m.id = c.merchant_id
        WHERE c.token = $1 FOR UPDATE OF c`,
      [token]
    );
    if (res.rowCount === 0) throw new ChargeError(404, 'NO_CHARGE', 'This code is not valid');

    const charge = res.rows[0];
    if (charge.status === 'paid') throw new ChargeError(409, 'ALREADY_PAID', 'This bill is already settled');
    if (charge.status === 'cancelled') throw new ChargeError(409, 'CANCELLED', 'This bill was cancelled');
    if (new Date(charge.expires_at) < new Date()) {
      throw new ChargeError(410, 'EXPIRED', 'This bill expired — ask the counter for a new code');
    }

    try {
      await client.query(
        `INSERT INTO settlements (charge_id, amount_paisa, method, external_ref, recorded_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [charge.id, charge.amount_paisa, m, ref, recordedByUserId ?? null]
      );
    } catch (err) {
      // 23505 unique_violation — this transaction id has already closed another bill.
      if (err.code === '23505') {
        throw new ChargeError(409, 'REFERENCE_USED', 'That transaction id has already been used for another bill');
      }
      throw err;
    }

    await client.query(
      "UPDATE charges SET status='paid', paid_by=$1, paid_at=now() WHERE id=$2",
      [recordedByUserId ?? null, charge.id]
    );

    return {
      settled: true,
      merchant_name: charge.merchant_name,
      amount_paisa: charge.amount_paisa,
      method: m,
      reference: ref,
      // Deliberately explicit: the outlet has a claim until someone matches this against
      // the bank statement. Reporting it as "confirmed" would be a lie the outlet acts on.
      reconciled: false,
    };
  });
}

/** What the outlet still has to check against its bank statement. */
export async function unreconciled({ client }) {
  const c = client ?? (await import('../db/pool.js')).query;
  const rows = (await c(
    `SELECT s.external_ref, s.method, s.amount_paisa, s.created_at, m.name AS merchant_name
       FROM settlements s
       JOIN charges c   ON c.id = s.charge_id
       JOIN merchants m ON m.id = c.merchant_id
      WHERE s.reconciled_at IS NULL
      ORDER BY s.created_at DESC LIMIT 100`
  )).rows;
  return rows;
}
