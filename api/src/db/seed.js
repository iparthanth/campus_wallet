import bcrypt from 'bcryptjs';
import { withTransaction, closePool, query } from './pool.js';
import { config } from '../config.js';

/**
 * Deterministic demo data. Safe to re-run — it truncates first.
 *
 * IMPORTANT: the seed applies every transaction to the wallet balances, exactly as a
 * real transfer would. An earlier version inserted transaction rows while setting
 * balances independently, which produced a demo where ৳650 had left a ৳500 account and
 * a recipient of ৳600 held ৳100. In a project whose whole claim is that money is never
 * created or destroyed, inconsistent demo data is worse than no demo data — so the
 * function asserts the ledger reconciles before it commits.
 */
export async function seed({ silent = false } = {}) {
  const log = (...a) => { if (!silent) console.log(...a); };
  const hash = await bcrypt.hash('password123', config.bcryptRounds);

  // Opening balances, chosen so the post-transfer balances land on round numbers.
  const people = [
    { name: 'Partha Nath',   email: 'partha@puc.ac.bd', role: 'user',  opening: 1150_00 },
    { name: 'Rima Das',      email: 'rima@puc.ac.bd',   role: 'user',  opening: 200_00 },
    { name: 'Imran Hossain', email: 'imran@puc.ac.bd',  role: 'user',  opening: 100_00 },
    { name: 'Admin',         email: 'admin@puc.ac.bd',  role: 'admin', opening: 0 },
  ];

  // Transfers to replay. The flagged one is large and far above the sender's average,
  // which is exactly what the THRESHOLD rule looks for.
  const transfers = [
    { from: 'partha@puc.ac.bd', to: 'rima@puc.ac.bd',  amount: 50_00,  flag: null },
    { from: 'partha@puc.ac.bd', to: 'imran@puc.ac.bd', amount: 600_00, flag: {
        rule: 'THRESHOLD', detail: '৳600.00 exceeds 5x the sender’s average of ৳50.00' } },
  ];

  await withTransaction(async (client) => {
    await client.query('TRUNCATE fraud_flags, transactions, wallets, users RESTART IDENTITY CASCADE');

    const walletOf = {};
    for (const p of people) {
      const u = await client.query(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [p.name, p.email, hash, p.role]
      );
      const w = await client.query(
        'INSERT INTO wallets (user_id, balance_paisa) VALUES ($1,$2) RETURNING id',
        [u.rows[0].id, p.opening]
      );
      walletOf[p.email] = w.rows[0].id;
    }

    for (const t of transfers) {
      // Apply the money movement, not just the record of it.
      await client.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2', [t.amount, walletOf[t.from]]);
      await client.query('UPDATE wallets SET balance_paisa = balance_paisa + $1 WHERE id = $2', [t.amount, walletOf[t.to]]);

      const tx = await client.query(
        `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [walletOf[t.from], walletOf[t.to], t.amount, t.flag ? 'flagged' : 'completed']
      );
      if (t.flag) {
        await client.query(
          'INSERT INTO fraud_flags (transaction_id, rule_name, detail) VALUES ($1,$2,$3)',
          [tx.rows[0].id, t.flag.rule, t.flag.detail]
        );
      }
    }

    // The seed must satisfy the same invariant the application does.
    const openingTotal = people.reduce((sum, p) => sum + p.opening, 0);
    const { rows } = await client.query('SELECT COALESCE(SUM(balance_paisa),0)::bigint AS total FROM wallets');
    if (Number(rows[0].total) !== openingTotal) {
      throw new Error(`seed does not reconcile: wallets hold ${rows[0].total} paisa, opening total was ${openingTotal}`);
    }
  });

  const summary = (await query(
    `SELECT u.email, w.balance_paisa FROM users u JOIN wallets w ON w.user_id = u.id ORDER BY u.id`
  )).rows;
  log('seed: ledger reconciles. Password for all accounts: password123');
  for (const r of summary) log(`  ${r.email.padEnd(20)} ৳${(r.balance_paisa / 100).toFixed(2)}`);
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed()
    .then(closePool)
    .catch((err) => { console.error('seed failed:', err.message); process.exit(1); });
}
