import { hashPassword } from '../services/password.js';
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
export async function seed({ silent = false, ifEmpty = false } = {}) {
  const log = (...a) => { if (!silent) console.log(...a); };

  /*
   * `ifEmpty` exists for hosted demo deployments, where the seed runs on every boot.
   *
   * Without it, a free-tier host that sleeps after 15 minutes idle wipes the database on
   * each cold start — so an account someone created while looking at the demo is gone by
   * the time they come back to it. Seeding once, on an empty database, is what "demo data"
   * is supposed to mean.
   *
   * This is a convenience for demos, NOT a safety net for production: it makes a repeated
   * seed harmless, it does not make the seed safe to point at real data. Production runs
   * migrations only (DEPLOY.md §A.3).
   */
  if (ifEmpty) {
    const existing = Number((await query('SELECT count(*)::int AS n FROM users')).rows[0].n);
    if (existing > 0) {
      log(`seed: skipped — ${existing} user(s) already exist (--if-empty)`);
      return;
    }
  }

  const hash = await hashPassword('password123');

  // Opening balances, chosen so the post-transfer balances land on round numbers.
  const people = [
    { name: 'Partha Nath',   email: 'partha@puc.ac.bd', role: 'user',  opening: 3000_00 },
    { name: 'Rima Das',      email: 'rima@puc.ac.bd',   role: 'user',  opening: 3000_00 },
    { name: 'Imran Hossain', email: 'imran@puc.ac.bd',  role: 'user',  opening: 3000_00 },
    { name: 'Admin',         email: 'admin@puc.ac.bd',  role: 'admin', opening: 0 },
    // Counter staff. Each operates one campus outlet.
    { name: 'Canteen Counter',  email: 'canteen@puc.ac.bd', role: 'user', opening: 0 },
    { name: 'Photocopy Counter',email: 'copy@puc.ac.bd',    role: 'user', opening: 0 },
    { name: 'Library Desk',     email: 'library@puc.ac.bd', role: 'user', opening: 0 },
  ];

  // The outlets a student actually spends at. Without these it is a P2P app, not a
  // campus wallet: money has nowhere to go except another student.
  /*
   * `qr_name` is what the student sees in their banking app when they scan, so it is
   * capped at the 25 characters EMVCo tag 59 allows and written the way a bank would
   * approve it — not the friendly name above.
   *
   * The acquirer credentials below are DEMONSTRATION PLACEHOLDERS. They are shaped like
   * the real thing so the Bangla QR flow can be shown end to end on a laptop, but no bank
   * issued them and a QR built from them will be declined at a real counter. Production
   * credentials arrive only from acquirer onboarding, which needs PUC's EIIN and a board
   * resolution (PUC-HANDOVER.md §5.1) — nothing in this repository can shortcut it.
   */
  const outlets = [
    { operator: 'canteen@puc.ac.bd', name: 'Central Canteen',   category: 'canteen',
      qrName: 'PUC CENTRAL CANTEEN' },
    { operator: 'copy@puc.ac.bd',    name: 'Photocopy Corner',  category: 'stationery',
      qrName: 'PUC PHOTOCOPY CORNER' },
    { operator: 'library@puc.ac.bd', name: 'Library Fine Desk', category: 'library',
      qrName: 'PUC LIBRARY DESK' },
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

    for (const o of outlets) {
      const op = (await client.query('SELECT id FROM users WHERE email = $1', [o.operator])).rows[0];
      const w = (await client.query('SELECT id FROM wallets WHERE user_id = $1', [op.id])).rows[0];
      const m = (await client.query(
        'INSERT INTO merchants (name, category, wallet_id, operator_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [o.name, o.category, w.id, op.id]
      )).rows[0];

      // Mark the outlet as onboarded so the zero-float counter flow is demonstrable
      // locally. In production this UPDATE has no code path at all — it is an
      // administrative step performed only once the acquirer has issued the identifiers.
      await client.query(
        `UPDATE merchants
            SET acquirer_issued = true, acquirer_name = $2, acquirer_guid = $3,
                acquirer_merchant_id = $4, qr_merchant_name = $5, qr_city = $6,
                onboarded_at = now()
          WHERE id = $1`,
        [m.id, 'DEMO-BANK', 'BD.DEMO.NOTREAL', `DEMO${String(m.id).padStart(7, '0')}`,
         o.qrName, 'Chattogram']
      );
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
  log('');
  log('  Outlets are onboarded with DEMONSTRATION acquirer credentials (DEMO-BANK /');
  log('  BD.DEMO.NOTREAL). The Bangla QR flow works end to end locally, but no bank issued');
  log('  these identifiers and a QR built from them will be declined at a real counter.');
  log('  Real credentials come from acquirer onboarding — see PUC-HANDOVER.md §5.1.');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed({ ifEmpty: process.argv.includes('--if-empty') })
    .then(closePool)
    .catch((err) => { console.error('seed failed:', err.message); process.exit(1); });
}
