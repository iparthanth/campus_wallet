import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { withTransaction, query } from '../db/pool.js';
import { config } from '../config.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/**
 * A real bcrypt hash of a throwaway password, computed once at startup.
 * Used to burn the same CPU time when the email does not exist, so an attacker
 * cannot tell registered from unregistered accounts by response timing.
 * (A hand-written fake hash string would make bcrypt.compare fail fast — and leak.)
 */
const TIMING_DUMMY_HASH = bcrypt.hashSync('timing-attack-dummy-password', config.bcryptRounds);

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

authRouter.post('/register', async (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input', issues: parsed.error.issues } });
  }
  const { name, email, password } = parsed.data;

  try {
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

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
    const ok = await bcrypt.compare(password, user ? user.password_hash : TIMING_DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    return res.json({ user: safeUser, token: signToken(safeUser) });
  } catch (err) {
    return next(err);
  }
});
