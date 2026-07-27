import { withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { evaluateRules } from './fraud.js';
import { isValidPaisa } from './money.js';
import { refuseCustody } from './custody.js';

/** Domain error with an HTTP status — routes translate these straight to responses. */
export class TransferError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Move money between two wallets.
 *
 * THE FOUR GUARANTEES (this is the whole project):
 *  1. Atomic      — one DB transaction; either both balances move or neither does.
 *  2. No double-spend — both wallet rows are locked with SELECT ... FOR UPDATE before
 *                   the balance is read, so two concurrent transfers cannot both see
 *                   the same "enough balance" and both succeed.
 *  3. No deadlock — locks are acquired in ASCENDING wallet-id order. Two transfers in
 *                   opposite directions (A→B and B→A) therefore request the same locks
 *                   in the same order and queue instead of deadlocking.
 *  4. Idempotent  — a repeated idempotency_key returns the original transaction and
 *                   never debits twice (retries and double-clicks are safe).
 */
export async function transfer({ fromUserId, toEmail, amountPaisa, idempotencyKey }) {
  // Student-to-student transfer moves an internally-held balance, which is exactly the
  // stored value a university may not issue. Refused at the domain layer, so the route is
  // closed to curl as well as to the UI.
  refuseCustody(TransferError, 'students pay outlets directly over licensed rails');
  if (!isValidPaisa(amountPaisa)) {
    throw new TransferError(422, 'INVALID_AMOUNT', 'amount_paisa must be a positive whole number of paisa within the cap');
  }

  return withTransaction(async (client) => {
    // --- Idempotency replay: has this exact key already been processed? -----------------
    if (idempotencyKey) {
      const prior = await client.query(
        'SELECT id, from_wallet, to_wallet, amount_paisa, status, created_at FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (prior.rowCount > 0) {
        return { transaction: prior.rows[0], flags: [], replayed: true };
      }
    }

    // --- Resolve both wallets ----------------------------------------------------------
    const senderRes = await client.query('SELECT id FROM wallets WHERE user_id = $1', [fromUserId]);
    if (senderRes.rowCount === 0) throw new TransferError(404, 'NO_WALLET', 'Sender wallet not found');
    const fromWalletId = senderRes.rows[0].id;

    const recipientRes = await client.query(
      'SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE lower(u.email) = lower($1)',
      [toEmail]
    );
    if (recipientRes.rowCount === 0) throw new TransferError(404, 'NO_RECIPIENT', 'Recipient not found');
    const toWalletId = recipientRes.rows[0].id;

    if (fromWalletId === toWalletId) {
      throw new TransferError(422, 'SELF_TRANSFER', 'Cannot transfer to yourself');
    }

    // --- Lock BOTH wallets, lowest id first (guarantee 3) -------------------------------
    // Locking one row at a time in a sorted loop is deliberately explicit: it does not
    // depend on the planner returning ORDER BY rows in lock order.
    const lockOrder = [fromWalletId, toWalletId].sort((a, b) => a - b);
    const balances = new Map();
    for (const walletId of lockOrder) {
      const row = await client.query(
        'SELECT id, balance_paisa FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId]
      );
      balances.set(walletId, row.rows[0].balance_paisa);
    }

    // --- Balance check happens AFTER the lock (guarantee 2) -----------------------------
    const senderBalance = balances.get(fromWalletId);
    if (senderBalance < amountPaisa) {
      throw new TransferError(422, 'INSUFFICIENT_FUNDS',
        `Insufficient balance: have ${senderBalance} paisa, need ${amountPaisa}`);
    }

    // --- Move the money ----------------------------------------------------------------
    await client.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2', [amountPaisa, fromWalletId]);
    await client.query('UPDATE wallets SET balance_paisa = balance_paisa + $1 WHERE id = $2', [amountPaisa, toWalletId]);

    // --- Gather facts for the fraud rules (still inside the lock) -----------------------
    const { velocityWindowSeconds } = config.fraud;
    const factsRes = await client.query(
      `SELECT
         (SELECT count(*) FROM transactions
            WHERE from_wallet = $1 AND created_at > now() - ($2 || ' seconds')::interval) AS recent_count,
         (SELECT avg(amount_paisa) FROM transactions
            WHERE from_wallet = $1 AND created_at > now() - interval '30 days') AS avg_amount`,
      [fromWalletId, String(velocityWindowSeconds)]
    );
    const facts = {
      // +1 counts the transfer being made right now, which is not yet inserted.
      recentTransferCount: Number(factsRes.rows[0].recent_count) + 1,
      avgTransferPaisa: factsRes.rows[0].avg_amount === null ? 0 : Number(factsRes.rows[0].avg_amount),
      amountPaisa,
    };
    const flags = evaluateRules(facts);

    // --- Record the transaction (flagged transfers still complete) ----------------------
    const status = flags.length > 0 ? 'flagged' : 'completed';
    const txRes = await client.query(
      `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, from_wallet, to_wallet, amount_paisa, status, created_at`,
      [fromWalletId, toWalletId, amountPaisa, status, idempotencyKey ?? null]
    );
    const transaction = txRes.rows[0];

    for (const flag of flags) {
      await client.query(
        'INSERT INTO fraud_flags (transaction_id, rule_name, detail) VALUES ($1, $2, $3)',
        [transaction.id, flag.rule_name, flag.detail]
      );
    }

    return { transaction, flags, replayed: false };
  });
}
