import { randomBytes } from 'node:crypto';
import { withTransaction, query } from '../db/pool.js';
import { isValidPaisa } from './money.js';
import { post, ACCOUNTS, DEBIT, CREDIT } from './ledger.js';
import { buildBanglaQr, requireAcquirerIssued, BanglaQrError } from './banglaQr.js';

/**
 * Counter orders paid over Bangla QR.
 *
 * THE FLOW, AND WHY IT LOOKS LIKE THIS
 * ------------------------------------
 *   1. Counter staff raise an order: "that's ৳85".
 *   2. This system mints an EMVCo Bangla QR carrying the amount and an order reference,
 *      built from the merchant identifier the outlet's ACQUIRING BANK issued.
 *   3. The student scans it with whatever app they already have — bKash, Nagad, a bank
 *      app — and the money moves over licensed rails, straight to the outlet's account.
 *   4. The acquirer's settlement file comes back carrying that order reference, and the
 *      reconciler matches it and closes the order.
 *
 * At no point does this system hold the money. That is not a limitation to be engineered
 * around, it is the reason the deployment is lawful: under the Payment and Settlement
 * Systems Act 2024 s.15(1) no institution may issue a prepaid payment instrument without
 * Bangladesh Bank approval, and there is no closed-loop carve-out in the enacted Act.
 *
 * The accounting recognises revenue when the goods are handed over, which is at step 1 —
 * so the order receivable carries the gap between "sold" and "paid". That balance is the
 * reconciliation exception list, and it is supposed to trend to zero every day.
 */

export class OrderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'OrderError';
  }
}

/** How long a QR stays payable. Long enough to pay, short enough not to linger. */
const ORDER_TTL_MINUTES = 15;

/**
 * Build a human-legible order reference.
 *
 * Constraints, all real: EMVCo tag 62 sub-tag 05 caps it at 25 characters; the database
 * CHECK requires ^[A-Z0-9-]{6,25}$; and a staff member has to read it off a settlement
 * report and find it in the admin UI, so it cannot be an opaque hash.
 *
 * Shape: PUC-<merchantId>-<8 random base32 chars>. Random rather than sequential because
 * a predictable reference lets someone probe another outlet's orders.
 */
export function makeOrderRef(merchantId) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += ALPHABET[bytes[i] % ALPHABET.length];

  const ref = `PUC-${merchantId}-${suffix}`;
  if (ref.length > 25) {
    throw new OrderError(500, 'REF_TOO_LONG', `Order reference ${ref} exceeds the 25-character QR field`);
  }
  return ref;
}

/** The outlet record plus everything needed to mint its QR. */
async function loadOutlet(operatorUserId, client = null) {
  const run = client ? (sql, params) => client.query(sql, params) : query;
  const res = await run(
    `SELECT id, name, category, acquirer_issued, acquirer_name, acquirer_guid,
            acquirer_merchant_id, acquirer_template_tag, qr_merchant_name, qr_city
       FROM merchants
      WHERE operator_id = $1 AND active = true`,
    [operatorUserId]
  );
  if (res.rowCount === 0) {
    throw new OrderError(403, 'NOT_AN_OPERATOR', 'This account does not operate a campus outlet');
  }
  return res.rows[0];
}

/**
 * Mint the Bangla QR payload for an outlet and amount.
 *
 * Separated from raiseOrder so it can be unit-tested and so an operator can preview a
 * static QR before any order exists.
 */
export function qrForOutlet(merchant, { amountPaisa = null, orderRef = null } = {}) {
  requireAcquirerIssued(merchant);

  return buildBanglaQr({
    merchantAccounts: [{
      tag: merchant.acquirer_template_tag ?? '29',
      globallyUniqueIdentifier: merchant.acquirer_guid,
      merchantId: merchant.acquirer_merchant_id,
    }],
    merchantName: merchant.qr_merchant_name,
    merchantCity: merchant.qr_city ?? 'Chattogram',
    amountPaisa,
    additionalData: orderRef ? { referenceLabel: orderRef } : null,
  });
}

/**
 * Raise an order at a counter.
 *
 * The ledger posting and the order row are written in ONE transaction. If either fails,
 * neither exists — an order with no accounting entry would be revenue the books never
 * saw, which is the exact failure the double-entry ledger was introduced to prevent.
 */
export async function raiseOrder({ operatorUserId, amountPaisa, memo = null }) {
  if (!isValidPaisa(amountPaisa)) {
    throw new OrderError(422, 'INVALID_AMOUNT', 'Enter a valid amount');
  }

  return withTransaction(async (client) => {
    const outlet = await loadOutlet(operatorUserId, client);

    // Fails loudly if the outlet has no acquirer-issued identifier. Better a blocked
    // counter than a queue of declined payments.
    let qrPayload;
    const orderRef = makeOrderRef(outlet.id);
    try {
      qrPayload = qrForOutlet(outlet, { amountPaisa, orderRef });
    } catch (err) {
      if (err instanceof BanglaQrError) {
        throw new OrderError(409, err.code, err.message);
      }
      throw err;
    }

    // Revenue is recognised now: the student is walking away with the food.
    const { posting } = await post({
      // Joins THIS transaction. Without the client, the posting would commit on its own
      // connection and survive a failure of the charges INSERT below — a receivable for an
      // order that never existed.
      client,
      idempotencyKey: `order-raised-${orderRef}`,
      kind: 'ORDER_RAISED',
      description: memo ? `${outlet.name}: ${memo}` : `${outlet.name} counter order`,
      entries: [
        { account: ACCOUNTS.orderReceivable(outlet.id, outlet.name), direction: DEBIT, amountPaisa },
        { account: ACCOUNTS.merchantRevenue(outlet.id, outlet.name), direction: CREDIT, amountPaisa },
      ],
    });

    const token = randomBytes(9).toString('base64url'); // 72 bits, for the in-app deep link
    const row = (await client.query(
      `INSERT INTO charges (merchant_id, amount_paisa, memo, token, order_ref,
                            bangla_qr_payload, ledger_posting_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval)
       RETURNING id, token, order_ref, amount_paisa, memo, status, expires_at, created_at`,
      [outlet.id, amountPaisa, memo, token, orderRef, qrPayload, posting.id, String(ORDER_TTL_MINUTES)]
    )).rows[0];

    return {
      ...row,
      merchant_name: outlet.name,
      bangla_qr_payload: qrPayload,
      acquirer: outlet.acquirer_name,
      ledger_posting_id: posting.id,
    };
  });
}

/**
 * What the student sees after scanning the in-app deep link.
 *
 * Deliberately does not expose the QR payload: a payload is a payment instruction for the
 * outlet's account, and a student who can fetch arbitrary payloads could print and
 * substitute one. They only ever need to see what they are being asked to pay.
 */
/**
 * The SQL fragment that resolves either identifier to one order.
 *
 * Shared, not repeated, because repeating it is what caused the bug this fixes. getOrder
 * was widened to accept the human-readable reference; startOrderPayment was not. So a
 * student could look an order up by the code printed on the counter screen, see it
 * correctly, press "Pay online" — and be told "This code is not valid" underneath the
 * order that had just loaded.
 *
 * One definition of "which order is this", used everywhere an order is looked up.
 */
export const ORDER_LOOKUP_SQL = '(c.token = $1 OR upper(c.order_ref) = upper($1))';

/** Whatever the student typed or scanned, trimmed. */
export const normaliseOrderCode = (code) => String(code ?? '').trim();

export async function getOrder(code) {
  /*
   * Accepts EITHER identifier, because there are two and they serve different people.
   *
   *   token      72 random bits, never displayed. Rides inside the QR deep link, so a
   *              scan cannot be guessed at and neighbouring orders cannot be probed.
   *   order_ref  PUC-3-K9F2QT7M. Crockford base32 — no I, L, O or U — chosen precisely so
   *              it survives being read aloud across a noisy counter and typed by hand.
   *
   * This looked up the token ONLY. The counter displays the reference, so a student who
   * typed exactly what was on the screen in front of them got "This code is not valid".
   * The human-readable identifier existed, was carefully designed, and was not accepted
   * anywhere — the manual path was dead while the QR path worked.
   *
   * The reference is ~40 bits, weaker than the token, which is why it unlocks only this
   * view: amount, outlet and status. The QR payload — the actual payment instruction — is
   * still never returned, so guessing a reference reveals what someone owes, not a way to
   * take their money. Auth is required and the endpoint is rate limited.
   */
  const row = (await query(
    `SELECT c.token, c.order_ref, c.amount_paisa, c.memo, c.status, c.expires_at, c.paid_at,
            m.name AS merchant_name, m.category
       FROM charges c JOIN merchants m ON m.id = c.merchant_id
      WHERE ${ORDER_LOOKUP_SQL}`,
    [normaliseOrderCode(code)]
  )).rows[0];
  if (!row) throw new OrderError(404, 'NO_ORDER', 'This code is not valid');

  const expired = row.status === 'pending' && new Date(row.expires_at) < new Date();
  return { ...row, status: expired ? 'expired' : row.status };
}

/** The counter's own view: today's takings and what is still unpaid. */
export async function outletSummary(operatorUserId) {
  const outlet = await loadOutlet(operatorUserId);

  const stats = (await query(
    `SELECT
       COALESCE(SUM(amount_paisa) FILTER (WHERE status='paid' AND paid_at::date = now()::date),0)::bigint AS settled_today_paisa,
       COUNT(*) FILTER (WHERE status='paid'    AND paid_at::date = now()::date)                          AS settled_today_count,
       COALESCE(SUM(amount_paisa) FILTER (WHERE status='pending'),0)::bigint                             AS awaiting_paisa,
       COUNT(*) FILTER (WHERE status='pending')                                                          AS awaiting_count
     FROM charges WHERE merchant_id = $1`,
    [outlet.id]
  )).rows[0];

  const recent = (await query(
    `SELECT token, order_ref, amount_paisa, memo, status, created_at, paid_at
       FROM charges WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [outlet.id]
  )).rows;

  return {
    outlet: {
      id: outlet.id,
      name: outlet.name,
      category: outlet.category,
      // Surfaced so the counter UI can say "not live yet" instead of failing on tap.
      acquirer_issued: outlet.acquirer_issued,
      acquirer_name: outlet.acquirer_name,
    },
    stats,
    recent,
  };
}
