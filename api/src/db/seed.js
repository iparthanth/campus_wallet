import bcrypt from 'bcryptjs';
import { pool, withTransaction, closePool } from './pool.js';
import { config } from '../config.js';

/**
 * Deterministic demo data: three students + one admin, with a flagged transaction
 * already present so the admin dashboard is never empty in a demo.
 * Safe to re-run — it truncates first.
 */
export async function seed({ silent = false } = {}) {
  const log = (...a) => { if (!silent) console.log(...a); };
  const hash = await bcrypt.hash('password123', config.bcryptRounds);

  await withTransaction(async (client) => {
    await client.query('TRUNCATE fraud_flags, transactions, wallets, users RESTART IDENTITY CASCADE');

    const people = [
      ['Partha Nath', 'partha@puc.ac.bd', 'user', 500_00],
      ['Rima Das', 'rima@puc.ac.bd', 'user', 250_00],
      ['Imran Hossain', 'imran@puc.ac.bd', 'user', 100_00],
      ['Admin', 'admin@puc.ac.bd', 'admin', 0],
    ];

    const walletIds = {};
    for (const [name, email, role, balance] of people) {
      const u = await client.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [name, email, hash, role]
      );
      const w = await client.query(
        'INSERT INTO wallets (user_id, balance_paisa) VALUES ($1,$2) RETURNING id',
        [u.rows[0].id, balance]
      );
      walletIds[email] = w.rows[0].id;
    }

    // A normal transfer, then a large one that trips the THRESHOLD rule.
    await client.query(
      `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status)
       VALUES ($1,$2,$3,'completed')`,
      [walletIds['partha@puc.ac.bd'], walletIds['rima@puc.ac.bd'], 50_00]
    );
    const flagged = await client.query(
      `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status)
       VALUES ($1,$2,$3,'flagged') RETURNING id`,
      [walletIds['partha@puc.ac.bd'], walletIds['imran@puc.ac.bd'], 600_00]
    );
    await client.query(
      `INSERT INTO fraud_flags (transaction_id, rule_name, detail)
       VALUES ($1,'THRESHOLD','৳600.00 exceeds 5x the user''s average of ৳50.00')`,
      [flagged.rows[0].id]
    );
  });

  log('seed: 4 users, 4 wallets, 2 transactions (1 flagged). Password for all: password123');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed()
    .then(closePool)
    .catch((err) => { console.error('seed failed:', err.message); process.exit(1); });
}
