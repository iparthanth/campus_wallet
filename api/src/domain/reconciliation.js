import { createHash } from 'node:crypto';
import { withTransaction, query } from '../db/pool.js';
import { post, ACCOUNTS, DEBIT, CREDIT } from './ledger.js';

/**
 * Settlement reconciliation — matching what the bank says it collected against what the
 * university says it sold.
 *
 * This is the module that replaces the accounts office reading an inbox. It is
 * deliberately conservative: it settles a line only when the reference matches an open
 * order AND the amount agrees to the paisa. Everything else becomes a visible exception
 * for a human, because a reconciler that guesses is worse than one that asks.
 *
 * READ migrations/008_reconciliation.sql for the three invariants this relies on.
 */

export class ReconciliationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ReconciliationError';
  }
}

export const LINE_STATUS = {
  MATCHED: 'MATCHED',
  UNMATCHED: 'UNMATCHED',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_REF: 'DUPLICATE_REF',
  ALREADY_IMPORTED: 'ALREADY_IMPORTED',
};

/** Stable hash of the statement's exact bytes — the re-upload guard. */
export function hashStatement(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Normalise one parsed statement row.
 *
 * Acquirers disagree about field names and about whether the commission is already
 * deducted, so normalisation happens once, here, rather than being re-derived by every
 * caller. When only two of gross/net/fee are supplied the third is computed, and the
 * database CHECK then re-proves the arithmetic.
 */
export function normaliseLine(raw) {
  const grossIn = raw.gross_paisa ?? raw.grossPaisa ?? null;
  const netIn = raw.net_paisa ?? raw.netPaisa ?? null;
  const feeIn = raw.fee_paisa ?? raw.feePaisa ?? 0;

  let gross = grossIn;
  let net = netIn;
  const fee = Number(feeIn) || 0;

  if (gross == null && net != null) gross = Number(net) + fee;
  if (net == null && gross != null) net = Number(gross) - fee;

  gross = Number(gross);
  net = Number(net);

  if (!Number.isInteger(gross) || gross <= 0) {
    throw new ReconciliationError(422, 'BAD_GROSS',
      `Statement line ${raw.acquirer_txn_id ?? '(no id)'} has a non-positive or fractional gross amount`);
  }
  if (!Number.isInteger(net) || net <= 0) {
    throw new ReconciliationError(422, 'BAD_NET',
      `Statement line ${raw.acquirer_txn_id ?? '(no id)'} has a non-positive or fractional net amount`);
  }
  if (gross !== net + fee) {
    throw new ReconciliationError(422, 'ARITHMETIC',
      `Statement line ${raw.acquirer_txn_id}: gross ${gross} != net ${net} + fee ${fee}`);
  }

  const txnId = String(raw.acquirer_txn_id ?? raw.acquirerTxnId ?? '').trim();
  if (!txnId) {
    throw new ReconciliationError(422, 'NO_TXN_ID',
      'Every statement line needs the acquirer transaction id — it is what makes settling idempotent');
  }

  // References are matched case-insensitively but stored uppercase: staff retype them.
  const ref = String(raw.order_ref ?? raw.orderRef ?? '').trim().toUpperCase() || null;

  return {
    acquirerTxnId: txnId,
    orderRef: ref,
    grossPaisa: gross,
    netPaisa: net,
    feePaisa: fee,
    paidAt: raw.paid_at ?? raw.paidAt ?? null,
  };
}

/**
 * Decide what one line means, and settle it if it cleanly matches.
 *
 * Runs inside the import transaction. Returns the status and any note, so the caller can
 * record every line — including the ones that settled nothing, which are the valuable ones.
 */
/**
 * What to do when a statement line names an order that was ALREADY paid online.
 *
 * The student has genuinely paid twice — once through the gateway, once by scanning the
 * counter's Bangla QR. Both payments are real money that has actually moved. The question
 * is what the reconciliation should record, and it is a policy question rather than a
 * technical one:
 *
 *   (a) REFUSE — return DUPLICATE_REF. The line settles nothing and lands in the
 *       exceptions list for a human to refund. Safest for the books: the receivable is
 *       already cleared and stays cleared. But the second payment then sits in the bank
 *       account unexplained until somebody acts on the exception.
 *
 *   (b) BOOK AS A REFUND DUE — settle nothing against the order, but post the money to a
 *       liability account (money PUC holds that belongs to a student). The books then show
 *       the obligation explicitly instead of leaving it implied by an exception row.
 *       More correct accounting; more machinery.
 *
 *   (c) UNMATCHED — treat it like any payment we cannot explain. Simple and consistent
 *       with the static-QR case, but loses the information that we know exactly who paid
 *       twice and for what, which is precisely what makes the refund actionable.
 *
 * CHOSEN: (a) REFUSE AND FLAG.
 *
 * The receivable was already cleared by the online payment, so settling this line a second
 * time would credit it twice and drive it negative. Nothing is posted. The line is recorded
 * with everything a person needs to act: which order, which earlier payment cleared it, and
 * how much is owed back. That second payment does sit in PUC's bank account unexplained
 * until someone works the exception — which is exactly why the note names the amount and
 * the prior transaction rather than saying "duplicate".
 *
 * @param {object}  args
 * @param {object}  args.line   the normalised statement line (grossPaisa, orderRef, acquirerTxnId)
 * @param {object}  args.order  the charge row (id, amount_paisa, merchant_id, merchant_name)
 * @param {object}  args.prior  the earlier online payment (tran_id, gateway, gateway_amount_paisa, paid_at)
 * @returns {{status: string, note: string, chargeId: number|null, postingId: null}}
 */
function doublePaymentPolicy({ line, order, prior }) {
  return {
    status: LINE_STATUS.DUPLICATE_REF,
    note:
      `Order ${line.orderRef} was already paid online via ${prior.gateway} ` +
      `(${prior.tran_id}). This statement line is a SECOND payment of ` +
      `${line.grossPaisa} paisa and a refund is owed to the student.`,
    chargeId: Number(order.id),
    postingId: null,
  };
}

async function reconcileLine(client, line) {
  // Invariant 2: this exact bank transaction has been seen before.
  const seen = await client.query(
    'SELECT id, status FROM settlement_lines WHERE acquirer_txn_id = $1',
    [line.acquirerTxnId]
  );
  if (seen.rowCount > 0) {
    return {
      status: LINE_STATUS.ALREADY_IMPORTED,
      note: `Acquirer transaction ${line.acquirerTxnId} was already imported (line ${seen.rows[0].id})`,
      chargeId: null,
      postingId: null,
    };
  }

  if (!line.orderRef) {
    return {
      status: LINE_STATUS.UNMATCHED,
      note: 'Payment carried no order reference — likely a static QR where the payer typed the amount',
      chargeId: null,
      postingId: null,
    };
  }

  // Lock the order: two statements naming the same reference must not both settle it.
  const orderRes = await client.query(
    `SELECT c.id, c.amount_paisa, c.status, c.settlement_line_id, c.merchant_id, m.name AS merchant_name
       FROM charges c JOIN merchants m ON m.id = c.merchant_id
      WHERE c.order_ref = $1 FOR UPDATE OF c`,
    [line.orderRef]
  );

  if (orderRes.rowCount === 0) {
    return {
      status: LINE_STATUS.UNMATCHED,
      note: `No order carries reference ${line.orderRef}`,
      chargeId: null,
      postingId: null,
    };
  }

  const order = orderRes.rows[0];

  if (order.settlement_line_id !== null) {
    return {
      status: LINE_STATUS.DUPLICATE_REF,
      note: `Order ${line.orderRef} was already settled by line ${order.settlement_line_id}`,
      chargeId: order.id,
      postingId: null,
    };
  }

  /*
   * The SECOND way an order can already be paid.
   *
   * Since migration 010 an order can be settled on two independent rails: the gateway
   * (immediate) or Bangla QR (this next-day statement). The check above only catches a
   * previous STATEMENT line. If a student paid online and the acquirer's file ALSO carries
   * that reference, matching here would post a second settlement — crediting the receivable
   * twice and driving it negative.
   *
   * It would not be caught by the trial balance, because each posting is internally
   * balanced. Only the next morning's cross-check would notice, which is far too late:
   * by then the money is banked and the student is owed a refund nobody logged.
   */
  const paidOnline = await client.query(
    `SELECT tran_id, gateway, gateway_amount_paisa, paid_at
       FROM order_payments
      WHERE charge_id = $1 AND status = 'PAID'`,
    [order.id]
  );

  if (paidOnline.rowCount > 0) {
    return doublePaymentPolicy({ line, order, prior: paidOnline.rows[0] });
  }

  // Exact to the paisa. A partial payment is a business conversation, not something to
  // paper over by settling the order and quietly leaving a shortfall in the books.
  if (Number(order.amount_paisa) !== line.grossPaisa) {
    return {
      status: LINE_STATUS.AMOUNT_MISMATCH,
      note: `Order ${line.orderRef} is for ${order.amount_paisa} paisa but ${line.grossPaisa} was received`,
      chargeId: order.id,
      postingId: null,
    };
  }

  return {
    status: LINE_STATUS.MATCHED,
    note: null,
    chargeId: Number(order.id),
    merchantId: Number(order.merchant_id),
    merchantName: order.merchant_name,
    postingId: null, // filled in by the caller once the ledger posting is written
  };
}

/**
 * Import an acquirer statement and reconcile every line in it.
 *
 * The whole batch is one transaction. A statement that fails halfway leaves nothing
 * behind — a half-imported statement is worse than an un-imported one, because it looks
 * finished.
 */
export async function importSettlement({
  acquirer,
  sourceRef,
  statementDate,
  rawContent,
  lines,
  importedByUserId = null,
  bankSlug = 'UCB',
}) {
  if (!acquirer || !String(acquirer).trim()) {
    throw new ReconciliationError(422, 'NO_ACQUIRER', 'Say which acquirer this statement came from');
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ReconciliationError(422, 'EMPTY_STATEMENT', 'The statement has no lines');
  }
  if (!statementDate) {
    throw new ReconciliationError(422, 'NO_DATE', 'A statement must say which business date it covers');
  }

  // Normalise (and therefore validate) everything BEFORE opening the transaction, so a
  // malformed file is rejected without leaving a half-written batch.
  const normalised = lines.map(normaliseLine);

  // Invariant 1: the same file twice.
  const contentHash = hashStatement(
    rawContent ?? JSON.stringify(normalised.map((l) => [l.acquirerTxnId, l.grossPaisa, l.netPaisa]))
  );

  return withTransaction(async (client) => {
    const dup = await client.query(
      'SELECT id, source_ref, created_at FROM settlement_imports WHERE content_sha256 = $1',
      [contentHash]
    );
    if (dup.rowCount > 0) {
      throw new ReconciliationError(409, 'ALREADY_IMPORTED',
        `This exact statement was already imported on ${new Date(dup.rows[0].created_at).toISOString().slice(0, 10)} ` +
        `as "${dup.rows[0].source_ref}" (import ${dup.rows[0].id}). Re-importing would double-count every line.`);
    }

    const batch = (await client.query(
      `INSERT INTO settlement_imports (acquirer, source_ref, statement_date, content_sha256, imported_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [acquirer, sourceRef ?? 'manual', statementDate, contentHash, importedByUserId]
    )).rows[0];

    const results = [];
    let matched = 0;
    let grossTotal = 0;

    for (const line of normalised) {
      const verdict = await reconcileLine(client, line);
      let postingId = null;

      if (verdict.status === LINE_STATUS.MATCHED) {
        // Money the university actually holds, the commission it actually paid, and the
        // receivable that is now discharged. Three legs, and they must balance.
        const entries = [
          { account: ACCOUNTS.bank(bankSlug), direction: DEBIT, amountPaisa: line.netPaisa },
        ];
        if (line.feePaisa > 0) {
          entries.push({ account: ACCOUNTS.gatewayFee(acquirer), direction: DEBIT, amountPaisa: line.feePaisa });
        }
        entries.push({
          account: ACCOUNTS.orderReceivable(verdict.merchantId, verdict.merchantName),
          direction: CREDIT,
          amountPaisa: line.grossPaisa,
        });

        const { posting } = await post({
          // Same reason as raiseOrder: without the client this commits on its own
          // connection, so a failed settlement_lines INSERT below would leave the money
          // posted to the ledger with no line to explain it.
          client,
          idempotencyKey: `settle-${line.acquirerTxnId}`,
          kind: 'SETTLEMENT_MATCHED',
          description: `${acquirer} settled ${line.orderRef}`,
          occurredAt: line.paidAt,
          entries,
        });
        postingId = posting.id;
        matched += 1;
      }

      const stored = (await client.query(
        `INSERT INTO settlement_lines
           (import_id, acquirer_txn_id, order_ref, gross_paisa, fee_paisa, net_paisa,
            paid_at, status, note, charge_id, ledger_posting_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::settlement_line_status,$9,$10,$11)
         RETURNING id, status, order_ref, gross_paisa, note`,
        [
          batch.id, line.acquirerTxnId, line.orderRef, line.grossPaisa, line.feePaisa, line.netPaisa,
          line.paidAt, verdict.status, verdict.note, verdict.chargeId, postingId,
        ]
      )).rows[0];

      if (verdict.status === LINE_STATUS.MATCHED) {
        await client.query(
          `UPDATE charges SET status = 'paid', paid_at = COALESCE($2::timestamptz, now()), settlement_line_id = $3
            WHERE id = $1`,
          [verdict.chargeId, line.paidAt, stored.id]
        );
      }

      grossTotal += line.grossPaisa;
      results.push(stored);
    }

    await client.query(
      'UPDATE settlement_imports SET line_count = $2, matched_count = $3, gross_paisa = $4 WHERE id = $1',
      [batch.id, normalised.length, matched, grossTotal]
    );

    return {
      import_id: batch.id,
      acquirer,
      statement_date: statementDate,
      line_count: normalised.length,
      matched_count: matched,
      exception_count: normalised.length - matched,
      gross_paisa: grossTotal,
      lines: results,
    };
  });
}

/** Money received that no order explains, and orders sold that no money settled. */
export async function exceptionReport({ limit = 100 } = {}) {
  const cap = Math.min(Number(limit) || 100, 500);

  const [unmatched, unsettled, summary] = await Promise.all([
    query('SELECT * FROM reconciliation_unmatched_receipts LIMIT $1', [cap]),
    query('SELECT * FROM reconciliation_unsettled_orders LIMIT $1', [cap]),
    query('SELECT * FROM reconciliation_summary ORDER BY unsettled_paisa DESC'),
  ]);

  return {
    unmatched_receipts: unmatched.rows,
    unsettled_orders: unsettled.rows,
    by_outlet: summary.rows,
    totals: {
      unmatched_receipt_count: unmatched.rowCount,
      unsettled_order_count: unsettled.rowCount,
      unsettled_paisa: summary.rows.reduce((sum, r) => sum + Number(r.unsettled_paisa), 0),
    },
  };
}

/**
 * Cross-check the order table against the ledger.
 *
 * Two independent derivations of "what is still owed": one from the orders table, one
 * from the double-entry receivable balance. They must agree. Disagreement means one of
 * them is lying, and finding out which is the entire point of keeping both.
 */
export async function crossCheck() {
  const rows = (await query(
    `SELECT s.merchant_id, s.merchant_name, s.unsettled_paisa AS orders_say,
            COALESCE(b.balance_paisa, 0) AS ledger_says
       FROM reconciliation_summary s
       LEFT JOIN ledger_account_balances b
              ON b.code = 'PUC:RECEIVABLE:ORDERS:' || s.merchant_id
      ORDER BY s.merchant_id`
  )).rows;

  const discrepancies = rows
    .map((r) => ({
      merchant_id: Number(r.merchant_id),
      merchant_name: r.merchant_name,
      orders_say: Number(r.orders_say),
      ledger_says: Number(r.ledger_says),
      drift_paisa: Number(r.orders_say) - Number(r.ledger_says),
    }))
    .filter((r) => r.drift_paisa !== 0);

  return { agrees: discrepancies.length === 0, discrepancies, checked: rows.length };
}
