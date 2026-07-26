import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { raiseOrder, getOrder, outletSummary, OrderError } from '../domain/order.js';
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

/* --------------------------------------------------------- reconciliation (admin) */

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
