import { Router, urlencoded } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { raiseOrder, getOrder, outletSummary, OrderError } from '../domain/order.js';
import {
  startOrderPayment, confirmOrderPayment, closeOrderPayment,
  paymentsForOrder, clearingOutstanding,
} from '../domain/orderPayment.js';
import { importSettlement, exceptionReport, crossCheck, ReconciliationError } from '../domain/reconciliation.js';
import { runAudit, recordAudit, auditHistory } from '../domain/audit.js';
import { balanceOf, statement, trialBalance, LedgerError } from '../domain/ledger.js';

export const ordersRouter = Router();

/** Domain errors carry their own HTTP status; anything else is a real 500. */
function handle(err, res, next) {
  if (err instanceof OrderError || err instanceof ReconciliationError || err instanceof LedgerError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return next(err);
}

/* ------------------------------------------------------------------ counter side */

const raiseSchema = z.object({
  amount_paisa: z.number().int().positive(),
  memo: z.string().trim().max(120).optional(),
});

/**
 * Counter staff raise an order and get back a Bangla QR to show the student.
 *
 * 409 NOT_ONBOARDED is the expected response until the outlet's acquiring bank has issued
 * a merchant identifier — a deployment step that needs PUC's own authority, not code.
 */
ordersRouter.post('/orders', requireAuth, async (req, res, next) => {
  const parsed = raiseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Enter a valid amount' } });
  }
  try {
    const order = await raiseOrder({
      operatorUserId: req.user.id,
      amountPaisa: parsed.data.amount_paisa,
      memo: parsed.data.memo,
    });
    return res.status(201).json(order);
  } catch (err) { return handle(err, res, next); }
});

/** The counter's own view: settled today, still awaiting payment, recent orders. */
ordersRouter.get('/outlet/summary', requireAuth, async (req, res, next) => {
  try {
    return res.json(await outletSummary(req.user.id));
  } catch (err) { return handle(err, res, next); }
});

/* ------------------------------------------------------------------ student side */

/**
 * What the student sees after scanning the in-app link.
 *
 * Never returns the QR payload — that is a payment instruction for the outlet's bank
 * account, and a student able to fetch arbitrary payloads could print and substitute one.
 */
ordersRouter.get('/orders/:token', requireAuth, async (req, res, next) => {
  try {
    return res.json(await getOrder(req.params.token));
  } catch (err) { return handle(err, res, next); }
});

/* ------------------------------------------------- paying an order online (gateway) */

/**
 * Start an online payment for one order.
 *
 * This is the lawful gateway path: the student pays THIS order, the money goes to the
 * university's merchant account, and the ledger records it against the order. Nothing is
 * credited to a balance, because the university may not hold one.
 */
ordersRouter.post('/orders/:token/pay/ssl', requireAuth, async (req, res, next) => {
  try {
    return res.status(201).json(await startOrderPayment({
      token: req.params.token,
      payerUserId: req.user.id,
    }));
  } catch (err) { return handle(err, res, next); }
});

/** Every payment attempt for an order — the history someone needs when chasing a payment. */
ordersRouter.get('/orders/:token/payments', requireAuth, async (req, res, next) => {
  try {
    return res.json(await paymentsForOrder(req.params.token));
  } catch (err) { return handle(err, res, next); }
});

/**
 * Where SSLCommerz sends the student's BROWSER back.
 *
 * Every parameter here is attacker-editable, so none is trusted: only `val_id` is used,
 * and only to ask the gateway server-to-server what actually happened.
 */
ordersRouter.post('/orders/ssl/return', urlencoded({ extended: true }), async (req, res) => {
  const { val_id: valId, status, tran_id: tranId } = req.body ?? {};
  const app = config.ssl.appUrl;

  if (status !== 'VALID' && status !== 'VALIDATED') {
    // Release the session so the student can immediately try again rather than being told
    // a payment is already in progress for an order they just abandoned.
    if (tranId) {
      await closeOrderPayment({
        tranId,
        status: status === 'FAILED' ? 'FAILED' : 'CANCELLED',
        note: `Gateway reported ${status}`,
      }).catch(() => { /* best effort — the IPN is the reliable path */ });
    }
    return res.redirect(302, `${app}/?order=${status === 'FAILED' ? 'failed' : 'cancelled'}`);
  }

  try {
    const out = await confirmOrderPayment({ valId });
    return res.redirect(302, `${app}/?order=paid&ref=${encodeURIComponent(out.payment.order_ref)}`);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'order ssl return failed', detail: err.message }));
    return res.redirect(302, `${app}/?order=error&code=${encodeURIComponent(err.code ?? 'UNKNOWN')}`);
  }
});

/**
 * Server-to-server notification — the path that actually works.
 *
 * On Bangladeshi mobile data the browser redirect frequently never arrives: the student
 * backgrounds the app, the connection drops, the tab closes. The IPN still lands.
 * Settlement is idempotent, so the IPN racing the redirect is harmless.
 *
 * The status code matters more than it looks. SSLCommerz retries on a 5xx, so:
 *   - a PERMANENT failure (unknown transaction, amount mismatch) acks 202. Retrying will
 *     never succeed and would just fill the log with the same error forever.
 *   - a TRANSIENT failure (database unreachable) returns 500 so the gateway retries. The
 *     legacy top-up handler acks everything, which silently drops a real payment whenever
 *     the database happens to be down at that moment.
 */
const PERMANENT_IPN_FAILURES = new Set([
  'UNKNOWN_PAYMENT', 'AMOUNT_MISMATCH', 'PAYMENT_NOT_VALID', 'NO_VAL_ID', 'NO_ORDER',
  // A duplicate is permanent by definition — the order is already settled and no amount of
  // retrying changes that. It is recorded for refund, not retried.
  'ALREADY_SETTLED',
]);

ordersRouter.post('/orders/ssl/ipn', urlencoded({ extended: true }), async (req, res) => {
  const valId = req.body?.val_id;
  if (!valId) return res.status(400).json({ error: { code: 'NO_VAL_ID', message: 'val_id required' } });

  try {
    const out = await confirmOrderPayment({ valId });
    return res.json({ settled: out.settled, replayed: out.replayed });
  } catch (err) {
    const permanent = PERMANENT_IPN_FAILURES.has(err.code);
    console.error(JSON.stringify({
      level: 'error', msg: 'order ssl ipn failed', code: err.code ?? null,
      permanent, detail: err.message,
    }));
    return permanent
      ? res.status(202).json({ received: true, code: err.code })
      : res.status(500).json({ error: { code: 'RETRY', message: 'Temporary failure — please retry' } });
  }
});

/* --------------------------------------------------------- reconciliation (admin) */

/** Money the gateway is holding: collected from students, not yet in PUC's bank account. */
ordersRouter.get('/admin/reconciliation/clearing', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    return res.json(await clearingOutstanding());
  } catch (err) { return handle(err, res, next); }
});


const settlementSchema = z.object({
  acquirer: z.string().trim().min(2).max(40),
  source_ref: z.string().trim().max(200).optional(),
  statement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  raw_content: z.string().max(5_000_000).optional(),
  bank_slug: z.string().trim().max(20).optional(),
  lines: z.array(z.object({
    acquirer_txn_id: z.string().trim().min(1).max(120),
    order_ref: z.string().trim().max(40).nullish(),
    gross_paisa: z.number().int().optional(),
    net_paisa: z.number().int().optional(),
    fee_paisa: z.number().int().nonnegative().optional(),
    paid_at: z.string().datetime().nullish(),
  })).min(1).max(10_000),
});

/**
 * Import an acquirer settlement statement and reconcile it.
 *
 * This is the endpoint that replaces reading accounts@puc.ac.bd by hand. It is
 * admin-only: importing a statement moves money in the books.
 */
ordersRouter.post('/admin/settlements/import', requireAuth, requireAdmin, async (req, res, next) => {
  const parsed = settlementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      error: { code: 'VALIDATION', message: 'Invalid settlement statement', issues: parsed.error.issues.slice(0, 10) },
    });
  }
  try {
    const result = await importSettlement({
      acquirer: parsed.data.acquirer,
      sourceRef: parsed.data.source_ref,
      statementDate: parsed.data.statement_date,
      rawContent: parsed.data.raw_content,
      bankSlug: parsed.data.bank_slug,
      lines: parsed.data.lines,
      importedByUserId: req.user.id,
    });
    return res.status(201).json(result);
  } catch (err) { return handle(err, res, next); }
});

/** Money received that no order explains, and orders sold that no money settled. */
ordersRouter.get('/admin/reconciliation/exceptions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    return res.json(await exceptionReport({ limit: req.query.limit }));
  } catch (err) { return next(err); }
});

/** Do the orders table and the ledger agree? Two derivations, one answer. */
ordersRouter.get('/admin/reconciliation/cross-check', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const result = await crossCheck();
    // 409 when they disagree: this is not a successful read, it is an alarm.
    return res.status(result.agrees ? 200 : 409).json(result);
  } catch (err) { return next(err); }
});

/* ------------------------------------------------------------------- audit (admin) */

/** Run the audit on demand without recording it — a dry run. */
ordersRouter.get('/admin/audit/run', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const findings = await runAudit();
    return res.status(findings.result === 'FAIL' ? 409 : 200).json(findings);
  } catch (err) { return next(err); }
});

/** Run and record. Same thing the nightly cron does. */
ordersRouter.post('/admin/audit/run', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const findings = await recordAudit({ businessDate: req.body?.business_date ?? null });
    return res.status(findings.result === 'FAIL' ? 409 : 201).json(findings);
  } catch (err) { return next(err); }
});

ordersRouter.get('/admin/audit/history', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    return res.json({ runs: await auditHistory({ limit: req.query.limit }) });
  } catch (err) { return next(err); }
});

/* ------------------------------------------------------------------ ledger (admin) */

/** The whole-ledger control total. `balanced: false` means stop and investigate. */
ordersRouter.get('/admin/ledger/trial-balance', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const tb = await trialBalance();
    return res.status(tb.balanced ? 200 : 409).json(tb);
  } catch (err) { return next(err); }
});

ordersRouter.get('/admin/ledger/accounts/:code', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const account = await balanceOf(req.params.code);
    if (!account) {
      return res.status(404).json({ error: { code: 'NO_ACCOUNT', message: 'No such ledger account' } });
    }
    return res.json({ account, statement: await statement(req.params.code, { limit: req.query.limit }) });
  } catch (err) { return next(err); }
});
