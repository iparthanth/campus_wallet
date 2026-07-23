import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { startTopup, completeTopup, reconcileTopup, TopupError } from '../domain/topup.js';

export const topupRouter = Router();

function handle(err, res, next) {
  if (err instanceof TopupError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return next(err);
}

/** Lets the frontend hide the top-up button when bKash is not configured. */
topupRouter.get('/topup/available', (_req, res) => res.json({ available: config.bkash.enabled }));

const startSchema = z.object({ amount_paisa: z.number().int().positive() });

topupRouter.post('/topup/create', requireAuth, async (req, res, next) => {
  if (!config.bkash.enabled) {
    return res.status(503).json({ error: { code: 'BKASH_DISABLED', message: 'bKash is not configured on this server' } });
  }
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Invalid amount' } });
  }
  try {
    const out = await startTopup({ userId: req.user.id, amountPaisa: parsed.data.amount_paisa });
    return res.status(201).json(out);
  } catch (err) { return handle(err, res, next); }
});

const executeSchema = z.object({ paymentID: z.string().min(1).max(200) });

topupRouter.post('/topup/execute', requireAuth, async (req, res, next) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'paymentID required' } });
  }
  try {
    const out = await completeTopup({ paymentID: parsed.data.paymentID });
    return res.json({ credited: out.credited, replayed: out.replayed, amount_paisa: out.topup.amount_paisa });
  } catch (err) { return handle(err, res, next); }
});

/**
 * Called by the client when it is unsure whether a payment landed — and usable by an
 * operator for any stuck top-up. This is the endpoint that rescues money taken from a
 * student whose callback never arrived.
 */
topupRouter.post('/topup/reconcile', requireAuth, async (req, res, next) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'paymentID required' } });
  }
  try {
    const out = await reconcileTopup({ paymentID: parsed.data.paymentID });
    return res.json(out);
  } catch (err) { return handle(err, res, next); }
});

topupRouter.get('/topup/history', requireAuth, async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT payment_id, amount_paisa, status, trx_id, created_at, credited_at
         FROM topups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    )).rows;
    return res.json({ topups: rows });
  } catch (err) { return next(err); }
});
