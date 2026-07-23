import { randomBytes } from 'node:crypto';
import { withTransaction, query } from '../db/pool.js';
import { isValidPaisa } from './money.js';

export class ChargeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** How long a bill stays payable at the counter before it lapses. */
const CHARGE_TTL_MINUTES = 10;

/**
 * Counter staff raise a charge: "that's ৳85 for lunch". The student scans the QR.
 *
 * The QR carries a random token rather than the row id. With an incrementing id anyone
 * could pay — or probe — the next student's bill by guessing a number.
 */
export async function createCharge({ operatorUserId, amountPaisa, memo }) {
  if (!isValidPaisa(amountPaisa)) {
    throw new ChargeError(422, 'INVALID_AMOUNT', 'Enter a valid amount');
  }

  const merchant = (await query(
    'SELECT id, name FROM merchants WHERE operator_id = $1 AND active = true',
    [operatorUserId]
  )).rows[0];
  if (!merchant) throw new ChargeError(403, 'NOT_AN_OPERATOR', 'This account does not operate a campus outlet');

  const token = randomBytes(9).toString('base64url'); // 72 bits — not guessable at counter scale

  const row = (await query(
    `INSERT INTO charges (merchant_id, amount_paisa, memo, token, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)
     RETURNING id, token, amount_paisa, memo, expires_at`,
    [merchant.id, amountPaisa, memo ?? null, token, String(CHARGE_TTL_MINUTES)]
  )).rows[0];

  return { ...row, merchant_name: merchant.name };
}

/** What the student sees after scanning, before agreeing to pay. */
export async function getCharge(token) {
  const row = (await query(
    `SELECT c.token, c.amount_paisa, c.memo, c.status, c.expires_at,
            m.name AS merchant_name, m.category
       FROM charges c JOIN merchants m ON m.id = c.merchant_id
      WHERE c.token = $1`,
    [token]
  )).rows[0];
  if (!row) throw new ChargeError(404, 'NO_CHARGE', 'This code is not valid');

  const expired = row.status === 'pending' && new Date(row.expires_at) < new Date();
  return { ...row, status: expired ? 'expired' : row.status };
}

/**
 * Student confirms and pays.
 *
 * Same four guarantees as a peer transfer, because it IS a transfer — student wallet to
 * merchant wallet. Money is never created here: the campus outlet holds a real wallet, so
 * the conservation invariant still covers canteen sales.
 *
 * The extra hazard is the charge itself: two phones scanning one QR must not both pay.
 * The charge row is locked first and its status re-checked inside the transaction, so
 * the second payer loses the race cleanly.
 */
export async function payCharge({ token, payerUserId }) {
  return withTransaction(async (client) => {
    const chargeRes = await client.query(
      `SELECT c.id, c.merchant_id, c.amount_paisa, c.status, c.expires_at, m.wallet_id AS merchant_wallet, m.name
         FROM charges c JOIN merchants m ON m.id = c.merchant_id
        WHERE c.token = $1 FOR UPDATE OF c`,
      [token]
    );
    if (chargeRes.rowCount === 0) throw new ChargeError(404, 'NO_CHARGE', 'This code is not valid');

    const charge = chargeRes.rows[0];
    if (charge.status === 'paid') throw new ChargeError(409, 'ALREADY_PAID', 'This bill has already been paid');
    if (charge.status === 'cancelled') throw new ChargeError(409, 'CANCELLED', 'This bill was cancelled');
    if (new Date(charge.expires_at) < new Date()) {
      await client.query("UPDATE charges SET status='expired' WHERE id=$1 AND status='pending'", [charge.id]);
      throw new ChargeError(410, 'EXPIRED', 'This bill expired — ask the counter for a new code');
    }

    const payerWallet = (await client.query('SELECT id FROM wallets WHERE user_id = $1', [payerUserId])).rows[0];
    if (!payerWallet) throw new ChargeError(404, 'NO_WALLET', 'Wallet not found');
    if (payerWallet.id === charge.merchant_wallet) {
      throw new ChargeError(422, 'SELF_PAY', 'An outlet cannot pay its own bill');
    }

    // Ascending wallet-id order, exactly as in transfer() — a student paying the canteen
    // while the canteen pays a supplier must not deadlock against each other.
    const [lo, hi] = [payerWallet.id, charge.merchant_wallet].sort((a, b) => a - b);
    const balances = new Map();
    for (const id of [lo, hi]) {
      const r = await client.query('SELECT id, balance_paisa FROM wallets WHERE id = $1 FOR UPDATE', [id]);
      balances.set(id, r.rows[0].balance_paisa);
    }

    if (balances.get(payerWallet.id) < charge.amount_paisa) {
      throw new ChargeError(422, 'INSUFFICIENT_FUNDS',
        `Not enough balance: you have ${balances.get(payerWallet.id)} paisa, this bill is ${charge.amount_paisa}`);
    }

    await client.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2',
      [charge.amount_paisa, payerWallet.id]);
    await client.query('UPDATE wallets SET balance_paisa = balance_paisa + $1 WHERE id = $2',
      [charge.amount_paisa, charge.merchant_wallet]);

    const tx = (await client.query(
      `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status)
       VALUES ($1,$2,$3,'completed') RETURNING id, amount_paisa, created_at`,
      [payerWallet.id, charge.merchant_wallet, charge.amount_paisa]
    )).rows[0];

    await client.query(
      "UPDATE charges SET status='paid', paid_by=$1, transaction_id=$2, paid_at=now() WHERE id=$3",
      [payerUserId, tx.id, charge.id]
    );

    return { paid: true, merchant_name: charge.name, amount_paisa: charge.amount_paisa, transaction: tx };
  });
}

/** The counter's own view: today's takings and the open bills. */
export async function merchantSummary(operatorUserId) {
  const merchant = (await query(
    'SELECT m.id, m.name, m.category, w.balance_paisa FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE m.operator_id = $1',
    [operatorUserId]
  )).rows[0];
  if (!merchant) throw new ChargeError(403, 'NOT_AN_OPERATOR', 'This account does not operate a campus outlet');

  const stats = (await query(
    `SELECT COALESCE(SUM(amount_paisa) FILTER (WHERE status='paid' AND paid_at::date = now()::date),0)::bigint AS today_paisa,
            COUNT(*) FILTER (WHERE status='paid' AND paid_at::date = now()::date)                              AS today_count,
            COUNT(*) FILTER (WHERE status='pending' AND expires_at > now())                                    AS open_count
       FROM charges WHERE merchant_id = $1`,
    [merchant.id]
  )).rows[0];

  const recent = (await query(
    `SELECT c.token, c.amount_paisa, c.memo, c.status, c.created_at, u.email AS paid_by_email
       FROM charges c LEFT JOIN users u ON u.id = c.paid_by
      WHERE c.merchant_id = $1 ORDER BY c.created_at DESC LIMIT 10`,
    [merchant.id]
  )).rows;

  return { merchant, stats, recent };
}
