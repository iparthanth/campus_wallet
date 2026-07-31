import { Router } from 'express';
import { hashPassword, verifyPassword, needsRehash, timingDummyHash } from '../services/password.js';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { withTransaction, query } from '../db/pool.js';
import { config } from '../config.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(72),  // bcrypt only hashes the first 72 bytes
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// The equal-work branch for an unknown email lives in services/password.js.

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' }
  );
}

authRouter.post('/register', async (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input', issues: parsed.error.issues } });
  }
  const { name, email, password } = parsed.data;

  try {
    const passwordHash = await hashPassword(password);

    // A user and their wallet are created together or not at all.
    const user = await withTransaction(async (client) => {
      const userRes = await client.query(
        'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email, role',
        [name, email, passwordHash]
      );
      const created = userRes.rows[0];
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [created.id]);
      return created;
    });

    return res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    // 23505 = unique_violation. We let the DB constraint decide, instead of
    // SELECT-then-INSERT, which has a race window under concurrent signups.
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } });
    }
    return next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input' } });
  }
  const { email, password } = parsed.data;

  try {
    const result = await query('SELECT id, name, email, role, password_hash FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // Same generic message and a hash comparison either way, so response time and
    // wording do not reveal whether the email exists (user enumeration).
    const ok = await verifyPassword(password, user ? user.password_hash : timingDummyHash);
    if (!user || !ok) {
      return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'Invalid email or password' } });
    }

    /*
     * Upgrade a legacy bcrypt hash now, while the plaintext is briefly in hand. Deliberately
     * not awaited into the response path: the student is authenticated either way, and a
     * slow write must not delay their login or fail it.
     */
    if (needsRehash(user.password_hash)) {
      hashPassword(password)
        .then((fresh) => query('UPDATE users SET password_hash = $1 WHERE id = $2', [fresh, user.id]))
        .catch((err) => console.error(JSON.stringify({
          level: 'warn', msg: 'password rehash failed', user_id: user.id, error: err.message,
        })));
    }

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    return res.json({ user: safeUser, token: signToken(safeUser) });
  } catch (err) {
    return next(err);
  }
});
