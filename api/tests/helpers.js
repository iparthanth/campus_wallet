import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { __resetRateLimits } from '../src/middleware/rateLimit.js';

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
  // TRUNCATE, not DELETE: ledger_entries carries an append-only trigger that refuses
  // DELETE by design. TRUNCATE is a different operation and is not caught by it, which
  // is what lets an immutable ledger still be reset between tests.
  //
  // audit_runs is listed EXPLICITLY because it has no foreign key to anything else.
  // CASCADE only reaches tables that reference a truncated one, so an unreferenced table
  // is silently skipped — which leaked audit rows between test files until it was found.
  // Any future table with no FK must be added here by hand for the same reason.
  await query(
    `TRUNCATE audit_runs,
              settlement_lines, settlement_imports,
              ledger_entries, ledger_postings, ledger_accounts,
              fraud_flags, transactions, wallets, users
     RESTART IDENTITY CASCADE`
  );
  // Rate-limit counters are process state, not database state — reset them too, or a
  // later test inherits an earlier one's exhausted budget.
  __resetRateLimits();
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

/**
 * Create a campus outlet and the user who operates it.
 *
 * Returns the merchant id as well as the operator, because the ledger keys revenue
 * accounts on merchant_id and that column carries a real foreign key — a test that
 * invents an id gets a constraint violation, correctly.
 */
export async function makeMerchant({ name = 'Central Canteen', category = 'canteen' } = {}) {
  const operator = await makeUser();
  const wallet = (await query('SELECT id FROM wallets WHERE user_id = $1', [operator.id])).rows[0];
  const merchant = (await query(
    'INSERT INTO merchants (name, category, wallet_id, operator_id) VALUES ($1,$2,$3,$4) RETURNING id, name',
    [name, category, wallet.id, operator.id]
  )).rows[0];
  return { operator, merchantId: Number(merchant.id), walletId: Number(wallet.id), name: merchant.name };
}

/**
 * Mark an outlet as onboarded by an acquiring bank.
 *
 * In production this is a manual administrative step gated on PUC supplying its EIIN,
 * a Registrar recommendation and a board resolution to the acquirer — no code path
 * performs it. Tests need the post-onboarding state, so they set it directly.
 */
export async function onboardMerchant(merchantId, {
  acquirerName = 'UCB',
  guid = 'BD.COM.UCB',
  merchantIdAtAcquirer = null,
  qrName = 'PREMIER UNIV CANTEEN',
  city = 'Chattogram',
} = {}) {
  const mid = merchantIdAtAcquirer ?? `PUC${String(merchantId).padStart(7, '0')}`;
  await query(
    `UPDATE merchants
        SET acquirer_issued = true, acquirer_name = $2, acquirer_guid = $3,
            acquirer_merchant_id = $4, qr_merchant_name = $5, qr_city = $6, onboarded_at = now()
      WHERE id = $1`,
    [merchantId, acquirerName, guid, mid, qrName, city]
  );
  return { acquirerName, guid, merchantIdAtAcquirer: mid, qrName, city };
}
