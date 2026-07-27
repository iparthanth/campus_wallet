import { withTransaction, query } from '../db/pool.js';

/**
 * Double-entry ledger — the domain API over migration 006.
 *
 * The database enforces the invariants (postings balance, entries are append-only,
 * idempotency keys are unique). This module exists to make the correct thing easy to
 * write and the incorrect thing hard to express, so no caller is ever tempted to reach
 * for raw SQL and skip a guarantee.
 *
 * READ migrations/006_ledger.sql FIRST — it explains why balances are derived rather
 * than stored, and why this ledger records obligations rather than custodied money.
 */

export class LedgerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'LedgerError';
  }
}

export const DEBIT = 'DEBIT';
export const CREDIT = 'CREDIT';

/**
 * Standard chart of accounts.
 *
 * Codes are structured and stable so a report stays readable after someone renames an
 * outlet. The naming scheme is PUC:<ROLE>:<SUBJECT>.
 */
export const ACCOUNTS = {
  /** What a student owes the university for orders raised but not yet settled. */
  studentReceivable: (userId) => ({
    code: `PUC:RECEIVABLE:STUDENT:${userId}`,
    name: `Student receivable #${userId}`,
    accountClass: 'ASSET',
    ownerUserId: userId,
  }),
  /** Revenue earned by one outlet. */
  merchantRevenue: (merchantId, merchantName) => ({
    code: `PUC:REVENUE:MERCHANT:${merchantId}`,
    name: `${merchantName ?? `Merchant #${merchantId}`} revenue`,
    accountClass: 'REVENUE',
    merchantId,
  }),
  /**
   * Orders raised at an outlet but not yet matched to a received payment.
   *
   * Used instead of a per-student receivable at a counter, because in the zero-float flow
   * the student pays from their own bank or MFS app and is not identified until the
   * settlement file arrives. This account's balance IS the reconciliation exception list:
   * every paisa in it is an order the university believes it is owed but cannot yet prove
   * it received. It should trend to zero daily, and an aged balance is the alarm.
   */
  orderReceivable: (merchantId, merchantName) => ({
    code: `PUC:RECEIVABLE:ORDERS:${merchantId}`,
    name: `${merchantName ?? `Merchant #${merchantId}`} unsettled orders`,
    accountClass: 'ASSET',
  }),
  /** Cash actually sitting in the university's collection account. */
  bank: (slug = 'UCB') => ({
    code: `PUC:BANK:${slug.toUpperCase()}`,
    name: `${slug.toUpperCase()} collection account`,
    accountClass: 'ASSET',
  }),
  /**
   * Money a gateway has taken from the student but not yet paid across to the bank.
   * Bangladeshi gateways settle T+1 to T+3, so this account is routinely non-zero and
   * its balance is a real, checkable claim against the gateway.
   */
  gatewayClearing: (gateway) => ({
    code: `PUC:CLEARING:${String(gateway).toUpperCase()}`,
    name: `${gateway} clearing`,
    accountClass: 'ASSET',
  }),
  /** Commission the gateway kept. Real cost, so it is recognised, not netted silently. */
  gatewayFee: (gateway) => ({
    code: `PUC:EXPENSE:FEE:${String(gateway).toUpperCase()}`,
    name: `${gateway} processing fees`,
    accountClass: 'EXPENSE',
  }),
};

const VALID_CLASSES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

/**
 * Find or create an account, idempotently.
 *
 * ON CONFLICT rather than SELECT-then-INSERT: two concurrent first-orders from the same
 * student would otherwise race and one would fail on the unique index. The same class of
 * bug the auth route avoids by letting the database decide.
 */
export async function ensureAccount(spec, client = null) {
  const { code, name, accountClass, ownerUserId = null, merchantId = null } = spec;

  if (!VALID_CLASSES.has(accountClass)) {
    throw new LedgerError(500, 'BAD_ACCOUNT_CLASS', `Unknown account class "${accountClass}"`);
  }

  const run = client ? (sql, params) => client.query(sql, params) : query;

  const res = await run(
    `INSERT INTO ledger_accounts (code, name, class, owner_user_id, merchant_id)
     VALUES ($1, $2, $3::account_class, $4, $5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, code, name, class, owner_user_id, merchant_id`,
    [code, name, accountClass, ownerUserId, merchantId]
  );
  return res.rows[0];
}

/**
 * Validate a set of entries before touching the database.
 *
 * The deferred constraint trigger is the real guarantee, but it reports at COMMIT, by
 * which point the stack trace points at the commit and not at whichever caller built a
 * lopsided posting. Checking here means the error names the actual mistake.
 */
function assertBalanced(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new LedgerError(422, 'TOO_FEW_ENTRIES',
      'A posting needs at least two entries — one debit and one credit');
  }

  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.amountPaisa) || entry.amountPaisa <= 0) {
      throw new LedgerError(422, 'INVALID_AMOUNT',
        `Entry amount must be a positive whole number of paisa, got ${entry.amountPaisa}`);
    }
    if (entry.direction === DEBIT) debits += entry.amountPaisa;
    else if (entry.direction === CREDIT) credits += entry.amountPaisa;
    else {
      throw new LedgerError(422, 'INVALID_DIRECTION',
        `Entry direction must be DEBIT or CREDIT, got "${entry.direction}"`);
    }
  }

  if (debits !== credits) {
    throw new LedgerError(422, 'UNBALANCED',
      `Posting does not balance: debits ${debits} paisa, credits ${credits} paisa (difference ${debits - credits})`);
  }
  if (debits === 0) {
    throw new LedgerError(422, 'ZERO_POSTING', 'A posting cannot be for zero');
  }
}

/**
 * Write one balanced posting.
 *
 * Idempotent: replaying the same key returns the original posting untouched, exactly as
 * a repeated transfer does. That matters because a settlement file can legitimately be
 * imported twice — a staff member re-uploads it, or a retry fires — and importing it
 * twice must not double the university's recorded revenue.
 *
 * Each entry names its account by SPEC (see ACCOUNTS), not by id, so callers never have
 * to resolve accounts themselves and a missing account is created rather than throwing.
 */
/**
 * Run `fn` inside the caller's transaction if one was handed in, otherwise open our own.
 *
 * withTransaction() is NOT re-entrant: it takes a fresh connection and runs an independent
 * transaction. So a caller who was already inside a transaction and called post() got a
 * SECOND connection and a SECOND transaction that committed on its own. If the caller then
 * failed, its work rolled back while the ledger posting stayed — a posting for an order
 * that does not exist. The trial balance still balanced (the posting is internally
 * balanced), so the nightly audit passed while the cross-check reported a phantom
 * receivable. It also held two pool connections per write, which is a connection-exhaustion
 * deadlock under load.
 *
 * Passing the client through is the fix, and it matches how ensureAccount() already works.
 */
function inTransaction(client, fn) {
  return client ? fn(client) : withTransaction(fn);
}

export async function post({
  idempotencyKey,
  kind,
  description = null,
  occurredAt = null,
  entries,
  // Supply this when the caller is already inside a transaction, so the posting commits
  // or rolls back WITH the rest of the caller's work rather than independently of it.
  client = null,
}) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new LedgerError(422, 'BAD_IDEMPOTENCY_KEY',
      'idempotency_key must be a string of 8–200 characters');
  }
  if (!/^[A-Z_]{3,40}$/.test(kind ?? '')) {
    throw new LedgerError(422, 'BAD_KIND', 'kind must be UPPER_SNAKE_CASE, 3–40 characters');
  }
  assertBalanced(entries);

  return inTransaction(client, async (client) => {
    // Replay check first — cheap, and short-circuits before any account is created.
    const prior = await client.query(
      `SELECT id, idempotency_key, kind, status, description, occurred_at, created_at
         FROM ledger_postings WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (prior.rowCount > 0) {
      const posting = prior.rows[0];
      const priorEntries = await client.query(
        `SELECT e.id, e.direction, e.amount_paisa, a.code AS account_code
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.posting_id = $1 ORDER BY e.id`,
        [posting.id]
      );
      return { posting, entries: priorEntries.rows, replayed: true };
    }

    const postingRes = await client.query(
      `INSERT INTO ledger_postings (idempotency_key, kind, description, occurred_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
       RETURNING id, idempotency_key, kind, status, description, occurred_at, created_at`,
      [idempotencyKey, kind, description, occurredAt]
    );
    const posting = postingRes.rows[0];

    const written = [];
    for (const entry of entries) {
      const account = entry.accountId
        ? { id: entry.accountId, code: entry.accountCode ?? null }
        : await ensureAccount(entry.account, client);

      const row = await client.query(
        `INSERT INTO ledger_entries (posting_id, account_id, direction, amount_paisa)
         VALUES ($1, $2, $3::entry_direction, $4)
         RETURNING id, direction, amount_paisa`,
        [posting.id, account.id, entry.direction, entry.amountPaisa]
      );
      written.push({ ...row.rows[0], account_code: account.code });
    }

    // COMMIT here fires the deferred balance trigger. If the application-level check
    // above were ever wrong, this is where the database refuses the write.
    return { posting, entries: written, replayed: false };
  });
}

/**
 * Reverse a posting by writing its mirror image.
 *
 * Nothing is deleted or edited: the original posting stays visible, marked VOIDED, and
 * points at the posting that reversed it. An auditor can see both the mistake and the
 * correction, which is the entire reason to keep an append-only ledger.
 */
export async function reverse({ postingId, idempotencyKey, reason, client = null }) {
  if (!reason || String(reason).trim().length < 3) {
    throw new LedgerError(422, 'NO_REASON', 'A reversal must record why it happened');
  }

  return inTransaction(client, async (client) => {
    const orig = await client.query(
      'SELECT id, kind, status, description FROM ledger_postings WHERE id = $1 FOR UPDATE',
      [postingId]
    );
    if (orig.rowCount === 0) {
      throw new LedgerError(404, 'NO_POSTING', `Posting ${postingId} does not exist`);
    }
    if (orig.rows[0].status === 'VOIDED') {
      throw new LedgerError(409, 'ALREADY_VOIDED', `Posting ${postingId} is already voided`);
    }

    const original = await client.query(
      'SELECT account_id, direction, amount_paisa FROM ledger_entries WHERE posting_id = $1 ORDER BY id',
      [postingId]
    );

    const reversalRes = await client.query(
      `INSERT INTO ledger_postings (idempotency_key, kind, description)
       VALUES ($1, $2, $3)
       RETURNING id, idempotency_key, kind, status, occurred_at, created_at`,
      [idempotencyKey, 'REVERSAL', `Reverses posting ${postingId}: ${reason}`]
    );
    const reversal = reversalRes.rows[0];

    for (const entry of original.rows) {
      await client.query(
        `INSERT INTO ledger_entries (posting_id, account_id, direction, amount_paisa)
         VALUES ($1, $2, $3::entry_direction, $4)`,
        [reversal.id, entry.account_id, entry.direction === DEBIT ? CREDIT : DEBIT, entry.amount_paisa]
      );
    }

    await client.query(
      "UPDATE ledger_postings SET status = 'VOIDED', voided_by = $1, voided_at = now() WHERE id = $2",
      [reversal.id, postingId]
    );

    return { reversal, reversedPostingId: postingId };
  });
}

/** Current derived balance of one account, or null if the account does not exist. */
export async function balanceOf(code) {
  const res = await query(
    `SELECT account_id, code, class, debits_paisa, credits_paisa, balance_paisa, entry_count
       FROM ledger_account_balances WHERE code = $1`,
    [code]
  );
  return res.rows[0] ?? null;
}

/**
 * The whole-ledger assertion: total debits must equal total credits.
 *
 * `drift_paisa` is the number the nightly audit checks. It is zero or the books are
 * broken; there is no acceptable small value.
 */
export async function trialBalance() {
  const res = await query('SELECT * FROM ledger_trial_balance');
  const row = res.rows[0] ?? {
    total_debits_paisa: 0, total_credits_paisa: 0, drift_paisa: 0, posting_count: 0, entry_count: 0,
  };
  return { ...row, balanced: Number(row.drift_paisa) === 0 };
}

/** Every posting touching an account, newest first — the statement a dispute needs. */
export async function statement(code, { limit = 50 } = {}) {
  const res = await query(
    `SELECT p.id AS posting_id, p.kind, p.description, p.occurred_at, p.status,
            e.direction, e.amount_paisa
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_postings p ON p.id = e.posting_id
      WHERE a.code = $1
      ORDER BY p.occurred_at DESC, e.id DESC
      LIMIT $2`,
    [code, Math.min(Number(limit) || 50, 500)]
  );
  return res.rows;
}
