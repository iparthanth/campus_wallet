import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db/pool.js';
import { createCharge, getCharge, payCharge, merchantSummary, ChargeError } from '../domain/charge.js';

export const campusRouter = Router();

function handle(err, res, next) {
  if (err instanceof ChargeError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return next(err);
}

/** The outlets a student can pay — canteen, photocopy, library. */
campusRouter.get('/merchants', requireAuth, async (_req, res, next) => {
  try {
    const rows = (await query(
      'SELECT id, name, category FROM merchants WHERE active = true ORDER BY category, name'
    )).rows;
    return res.json({ merchants: rows });
  } catch (err) { return next(err); }
});

/* ----------------------------------------------------------- counter side */

const chargeSchema = z.object({
  amount_paisa: z.number().int().positive(),
  memo: z.string().trim().max(120).optional(),
});

campusRouter.post('/merchant/charges', requireAuth, async (req, res, next) => {
  const parsed = chargeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Invalid amount' } });
  }
  try {
    const charge = await createCharge({
      operatorUserId: req.user.id,
      amountPaisa: parsed.data.amount_paisa,
      memo: parsed.data.memo,
    });
    // The QR encodes the app URL a phone camera can open directly.
    return res.status(201).json({ ...charge, qr_payload: `campuswallet://pay/${charge.token}` });
  } catch (err) { return handle(err, res, next); }
});

campusRouter.get('/merchant/summary', requireAuth, async (req, res, next) => {
  try {
    return res.json(await merchantSummary(req.user.id));
  } catch (err) { return handle(err, res, next); }
});

/* ----------------------------------------------------------- student side */

/** Read a scanned code. Deliberately requires auth: a bill is not public information. */
campusRouter.get('/charges/:token', requireAuth, async (req, res, next) => {
  try {
    return res.json(await getCharge(req.params.token));
  } catch (err) { return handle(err, res, next); }
});

campusRouter.post('/charges/:token/pay', requireAuth, async (req, res, next) => {
  try {
    return res.json(await payCharge({ token: req.params.token, payerUserId: req.user.id }));
  } catch (err) { return handle(err, res, next); }
});
