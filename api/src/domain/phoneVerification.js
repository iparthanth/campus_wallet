import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { sendSms, normalizeBdPhone, smsProvider, otpMessage } from '../services/sms.js';

export class OtpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CODE_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;      // then the code dies — stops a 6-digit brute force
const RESEND_COOLDOWN_SEC = 60;
const MAX_PER_DAY = 8;       // SMS costs money; an abuser should not be able to spend it

const hash = (code, userId) =>
  createHash('sha256').update(`${userId}:${code}`).digest('hex');

/**
 * Send a verification code.
 *
 * Rate limits exist for two different reasons and both matter: protecting the student
 * from being SMS-bombed by someone who knows their number, and protecting the project's
 * SMS balance from being drained by a script.
 */
export async function startVerification({ userId, phoneInput }) {
  const phone = normalizeBdPhone(phoneInput);
  if (!phone) {
    throw new OtpError(422, 'INVALID_PHONE',
      'Enter a Bangladeshi mobile number, e.g. 01712345678');
  }

  const taken = await query(
    'SELECT 1 FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND id <> $2',
    [phone, userId]
  );
  if (taken.rowCount > 0) {
    throw new OtpError(409, 'PHONE_TAKEN', 'That number is already verified on another account');
  }

  const recent = await query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')                      AS today,
       MAX(created_at)                                                                    AS last_sent
     FROM phone_verifications WHERE user_id = $1`,
    [userId]
  );
  const { today, last_sent: lastSent } = recent.rows[0];

  if (Number(today) >= MAX_PER_DAY) {
    throw new OtpError(429, 'TOO_MANY_CODES', 'Too many codes requested today — try again tomorrow');
  }
  if (lastSent && (Date.now() - new Date(lastSent).getTime()) / 1000 < RESEND_COOLDOWN_SEC) {
    const wait = Math.ceil(RESEND_COOLDOWN_SEC - (Date.now() - new Date(lastSent).getTime()) / 1000);
    throw new OtpError(429, 'COOLDOWN', `Wait ${wait}s before requesting another code`);
  }

  // randomInt is drawn from the CSPRNG. Math.random() would make codes predictable.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  await withTransaction(async (client) => {
    // Any previous open code is void the moment a new one is sent, so two live codes
    // never exist for one account.
    await client.query(
      'UPDATE phone_verifications SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL',
      [userId]
    );
    await client.query(
      `INSERT INTO phone_verifications (user_id, phone, code_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [userId, phone, hash(code, userId), String(CODE_TTL_MINUTES)]
    );
  });

  await sendSms(phone, otpMessage(code, CODE_TTL_MINUTES));

  return {
    sent_to: `••••••${phone.slice(-4)}`,   // never echo the full number back
    expires_in_seconds: CODE_TTL_MINUTES * 60,
    provider: smsProvider.name,            // 'console' in dev — the code is in the server log
  };
}

/** Check a code and, if it matches, mark the phone verified. */
export async function verifyCode({ userId, code }) {
  const res = await query(
    `SELECT id, phone, code_hash, attempts, expires_at
       FROM phone_verifications
      WHERE user_id = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (res.rowCount === 0) throw new OtpError(404, 'NO_CODE', 'Request a code first');

  const v = res.rows[0];
  if (new Date(v.expires_at) < new Date()) {
    throw new OtpError(410, 'EXPIRED', 'That code expired — request a new one');
  }
  if (v.attempts >= MAX_ATTEMPTS) {
    throw new OtpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong attempts — request a new code');
  }

  const supplied = Buffer.from(hash(String(code ?? ''), userId));
  const stored = Buffer.from(v.code_hash);
  // Both are fixed-length sha256 hex, so timingSafeEqual is safe to call directly and
  // the comparison does not leak how much of the code was right.
  const ok = supplied.length === stored.length && timingSafeEqual(supplied, stored);

  if (!ok) {
    await query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = $1', [v.id]);
    throw new OtpError(422, 'WRONG_CODE', `Incorrect code — ${MAX_ATTEMPTS - v.attempts - 1} attempt(s) left`);
  }

  await withTransaction(async (client) => {
    await client.query('UPDATE phone_verifications SET consumed_at = now() WHERE id = $1', [v.id]);
    await client.query(
      'UPDATE users SET phone = $1, phone_verified_at = now() WHERE id = $2',
      [v.phone, userId]
    );
  });

  return { verified: true, phone: `••••••${v.phone.slice(-4)}` };
}
