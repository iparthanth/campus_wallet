import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db/pool.js';
import { createCharge, getCharge, payCharge, merchantSummary, ChargeError } from '../domain/charge.js';
import { startVerification, verifyCode, OtpError } from '../domain/phoneVerification.js';

export const campusRouter = Router();

function handle(err, res, next) {
  if (err instanceof ChargeError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  return next(err);
}

function handleOtp(err, res, next) {
  if (err instanceof OtpError) {
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

/* ------------------------------------------------- phone verification (real OTP) */

const phoneSchema = z.object({ phone: z.string().min(6).max(20) });
const codeSchema = z.object({ code: z.string().regex(/^\d{4,8}$/) });

campusRouter.post('/phone/start', requireAuth, async (req, res, next) => {
  const parsed = phoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Enter a mobile number' } });
  }
  try {
    return res.json(await startVerification({ userId: req.user.id, phoneInput: parsed.data.phone }));
  } catch (err) { return handleOtp(err, res, next); }
});

campusRouter.post('/phone/verify', requireAuth, async (req, res, next) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: { code: 'VALIDATION', message: 'Enter the 6-digit code' } });
  }
  try {
    return res.json(await verifyCode({ userId: req.user.id, code: parsed.data.code }));
  } catch (err) { return handleOtp(err, res, next); }
});

campusRouter.get('/phone/status', requireAuth, async (req, res, next) => {
  try {
    const r = await query('SELECT phone, phone_verified_at FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    return res.json({
      verified: Boolean(u?.phone_verified_at),
      phone: u?.phone ? `••••••${u.phone.slice(-4)}` : null,
    });
  } catch (err) { return next(err); }
});
