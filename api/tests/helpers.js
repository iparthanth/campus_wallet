import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export const app = createApp();
export const api = () => request(app);

let migrated = false;

/**
 * Hard guard: refuse to truncate anything that is not obviously a test database.
 * setup-env.js should already have redirected us, but a destructive operation deserves
 * a second, independent check rather than trusting configuration to be correct.
 */
async function assertTestDatabase() {
  const { rows } = await query('SELECT current_database() AS db');
  const db = rows[0].db;
  if (!db.endsWith('_test')) {
    throw new Error(
      `REFUSING TO TRUNCATE: connected to "${db}", which is not a _test database. ` +
      `Tests must never run against development or production data.`
    );
  }
}

/** Fresh schema once, then a clean table state before every test. */
export async function resetDb() {
  if (!migrated) {
    await assertTestDatabase();
    await migrate({ silent: true });
    migrated = true;
  }
  await query('TRUNCATE fraud_flags, transactions, wallets, users RESTART IDENTITY CASCADE');
}

export async function closeDb() {
  await pool.end();
}

let counter = 0;
/** Register a user and return { token, email, id }. Each test seeds its own users. */
export async function makeUser({ balancePaisa = 0, role = 'user' } = {}) {
  const email = `u${++counter}_${Date.now()}@puc.ac.bd`;
  const res = await api().post('/auth/register').send({ name: 'Test User', email, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);

  const id = res.body.user.id;
  if (balancePaisa > 0) {
    await query('UPDATE wallets SET balance_paisa = $1 WHERE user_id = $2', [balancePaisa, id]);
  }
  if (role !== 'user') {
    await query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    const login = await api().post('/auth/login').send({ email, password: 'password123' });
    return { id, email, token: login.body.token };
  }
  return { id, email, token: res.body.token };
}

export async function balanceOf(userId) {
  const r = await query('SELECT balance_paisa FROM wallets WHERE user_id = $1', [userId]);
  return r.rows[0].balance_paisa;
}
