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
    { name: 'Partha Nath',   email: 'partha@puc.ac.bd', role: 'user',  opening: 3000_00 },
    { name: 'Rima Das',      email: 'rima@puc.ac.bd',   role: 'user',  opening: 3000_00 },
    { name: 'Imran Hossain', email: 'imran@puc.ac.bd',  role: 'user',  opening: 3000_00 },
    { name: 'Admin',         email: 'admin@puc.ac.bd',  role: 'admin', opening: 0 },
  ];

  /**
   * Two weeks of backdated activity.
   *
   * A dashboard is only honest if it has something to show: with a single day of data
   * the volume chart renders one dot in an empty frame, which reads as broken rather
   * than as "quiet week". The amounts are deterministic (no RNG) so the demo, the
   * screenshots, and any test that reads them stay reproducible.
   */
  const DAYS = 14;
  const pattern = [40, 125, 60, 210, 15, 95, 300, 55, 170, 25, 140, 80, 240, 65]; // taka/day
  const pairs = [
    ['partha@puc.ac.bd', 'rima@puc.ac.bd'],
    ['rima@puc.ac.bd', 'imran@puc.ac.bd'],
    ['imran@puc.ac.bd', 'partha@puc.ac.bd'],
  ];

  const transfers = [];
  for (let d = 0; d < DAYS; d++) {
    const daysAgo = DAYS - 1 - d;
    const [from, to] = pairs[d % pairs.length];
    transfers.push({ from, to, amount: pattern[d] * 100, daysAgo, flag: null });
    // A second, smaller transfer on some days so the 7-day average has texture.
    if (d % 3 === 0) {
      const [f2, t2] = pairs[(d + 1) % pairs.length];
      transfers.push({ from: f2, to: t2, amount: (20 + d * 5) * 100, daysAgo, flag: null });
    }
  }
  // The flagged one: large, and far above the sender's own average.
  transfers.push({
    from: 'partha@puc.ac.bd', to: 'imran@puc.ac.bd', amount: 600_00, daysAgo: 0,
    flag: { rule: 'THRESHOLD', detail: '৳600.00 exceeds 5x the sender’s average of ৳120.00' },
  });

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
        `INSERT INTO transactions (from_wallet, to_wallet, amount_paisa, status, created_at)
         VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval) RETURNING id`,
        [walletOf[t.from], walletOf[t.to], t.amount, t.flag ? 'flagged' : 'completed', String(t.daysAgo ?? 0)]
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
