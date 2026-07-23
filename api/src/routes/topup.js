import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { startTopup, completeTopup, reconcileTopup, TopupError } from '../domain/topup.js';
import { startSslTopup, completeSslTopup } from '../domain/sslTopup.js';
import express from 'express';

export const topupRouter = Router();

const startSchema = z.object({ amount_paisa: z.number().int().positive() });

function handle(err, res, next) {
  if (err instanceof TopupError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return next(err);
}

/** Lets the frontend hide the top-up button when bKash is not configured. */
topupRouter.get('/topup/available', (_req, res) => res.json({
  available: config.bkash.enabled || config.ssl.enabled,
  providers: {
    bkash: config.bkash.enabled,
    sslcommerz: config.ssl.enabled,   // bKash, Nagad, Rocket, upay, cards — one session
  },
}));

/* ------------------------------------------------------------------ SSLCommerz */

topupRouter.post('/topup/ssl/create', requireAuth, async (req, res, next) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: { code: 'VALIDATION', message: 'Invalid amount' } });
  try {
    return res.status(201).json(await startSslTopup({ userId: req.user.id, amountPaisa: parsed.data.amount_paisa }));
  } catch (err) { return handle(err, res, next); }
});

/**
 * Where SSLCommerz sends the student's BROWSER back. These parameters are attacker-
 * editable, so nothing here is trusted: val_id is handed to the validation API and only
 * that server-to-server answer moves money. Then we redirect into the app.
 */
topupRouter.post('/topup/ssl/return', express.urlencoded({ extended: true }), async (req, res) => {
  const { val_id: valId, status } = req.body ?? {};
  const app = config.ssl.appUrl;

  if (status !== 'VALID' && status !== 'VALIDATED') {
    return res.redirect(302, `${app}/?topup=${status === 'FAILED' ? 'failed' : 'cancelled'}`);
  }
  try {
    const out = await completeSslTopup({ valId });
    return res.redirect(302, `${app}/?topup=success&credited=${out.credited ? 1 : 0}`);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'ssl return failed', detail: err.message }));
    return res.redirect(302, `${app}/?topup=error`);
  }
});

/**
 * Server-to-server notification. This is the reliable path: it arrives even when the
 * student closes the tab on the gateway page, which on Bangladeshi mobile data is
 * common. Crediting is idempotent, so the IPN and the redirect racing is harmless.
 */
topupRouter.post('/topup/ssl/ipn', express.urlencoded({ extended: true }), async (req, res) => {
  const valId = req.body?.val_id;
  if (!valId) return res.status(400).json({ error: { code: 'NO_VAL_ID', message: 'val_id required' } });
  try {
    const out = await completeSslTopup({ valId });
    return res.json({ credited: out.credited, replayed: out.replayed });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'ssl ipn failed', detail: err.message }));
    return res.status(202).json({ received: true }); // ack so the gateway stops retrying a permanent failure
  }
});

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
