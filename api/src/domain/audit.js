import { query } from '../db/pool.js';
import { trialBalance } from './ledger.js';
import { crossCheck, exceptionReport } from './reconciliation.js';

/**
 * The nightly self-audit.
 *
 * Every guarantee this system makes is checked here, against the live database, on a
 * schedule — because an invariant proven only in the test suite is proven only on a
 * developer's laptop.
 *
 * The three checks are deliberately independent:
 *
 *   1. TRIAL BALANCE   — the ledger against itself. Debits must equal credits.
 *   2. CROSS-CHECK     — the orders table against the ledger, per outlet.
 *   3. AGEING          — how long money has been owed but not received.
 *
 * Check 1 passing does not imply check 2 passes: two tables can each be internally
 * perfect and still disagree, which is exactly the failure that loses money quietly.
 */

/** Beyond this, an unsettled order stops being "in flight" and starts being a problem. */
const AGED_THRESHOLD_HOURS = 48;

export const AUDIT_RESULT = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };

/**
 * Run every check and return the findings. Does not write anything.
 *
 * Separated from recording so the same logic backs both the nightly job and an on-demand
 * admin request, and so a test can assert on the findings without a row appearing.
 */
export async function runAudit({ agedThresholdHours = AGED_THRESHOLD_HOURS } = {}) {
  const started = Date.now();

  const [tb, cross, exceptions] = await Promise.all([
    trialBalance(),
    crossCheck(),
    exceptionReport({ limit: 500 }),
  ]);

  const drift = Number(tb.drift_paisa);
  const aged = exceptions.unsettled_orders.filter((o) => Number(o.age_hours) > agedThresholdHours);

  const failures = [];
  const warnings = [];

  // 1. The ledger must balance. There is no acceptable non-zero value here.
  if (drift !== 0) {
    failures.push({
      check: 'TRIAL_BALANCE',
      message: `Ledger does not balance: debits exceed credits by ${drift} paisa`,
      severity: 'FAIL',
    });
  }

  // 2. The two independent derivations of "what is owed" must agree.
  if (!cross.agrees) {
    failures.push({
      check: 'CROSS_CHECK',
      message: `${cross.discrepancies.length} outlet(s) where the orders table and the ledger disagree`,
      severity: 'FAIL',
      discrepancies: cross.discrepancies,
    });
  }

  // 3. Ageing is operational, not a correctness violation — so it warns, not fails.
  //    Conflating the two would train staff to ignore genuine FAILs.
  if (aged.length > 0) {
    warnings.push({
      check: 'AGED_RECEIVABLES',
      message: `${aged.length} order(s) unsettled for more than ${agedThresholdHours}h`,
      severity: 'WARN',
      oldest_hours: Math.max(...aged.map((o) => Number(o.age_hours))),
    });
  }

  if (exceptions.unmatched_receipts.length > 0) {
    warnings.push({
      check: 'UNMATCHED_RECEIPTS',
      message: `${exceptions.unmatched_receipts.length} payment(s) received that no order explains`,
      severity: 'WARN',
    });
  }

  const result = failures.length > 0
    ? AUDIT_RESULT.FAIL
    : warnings.length > 0 ? AUDIT_RESULT.WARN : AUDIT_RESULT.PASS;

  return {
    result,
    trial_balance_drift_paisa: drift,
    cross_check_discrepancies: cross.discrepancies.length,
    unsettled_paisa: exceptions.totals.unsettled_paisa,
    unsettled_count: exceptions.unsettled_orders.length,
    aged_count: aged.length,
    unmatched_receipts: exceptions.unmatched_receipts.length,
    failures,
    warnings,
    detail: {
      trial_balance: tb,
      cross_check: cross,
      aged_orders: aged.slice(0, 50),
      by_outlet: exceptions.by_outlet,
    },
    duration_ms: Date.now() - started,
  };
}

/**
 * Run the audit and record it.
 *
 * Upserts on business_date: re-running a day's audit corrects it rather than leaving two
 * rows that disagree about whether the day passed.
 */
export async function recordAudit({ businessDate = null, agedThresholdHours } = {}) {
  const findings = await runAudit({ agedThresholdHours });
  const date = businessDate ?? new Date().toISOString().slice(0, 10);

  const row = (await query(
    `INSERT INTO audit_runs
       (business_date, result, trial_balance_drift_paisa, cross_check_discrepancies,
        unsettled_paisa, unsettled_count, aged_count, unmatched_receipts, detail, duration_ms)
     VALUES ($1, $2::audit_result, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (business_date) DO UPDATE SET
       result = EXCLUDED.result,
       trial_balance_drift_paisa = EXCLUDED.trial_balance_drift_paisa,
       cross_check_discrepancies = EXCLUDED.cross_check_discrepancies,
       unsettled_paisa = EXCLUDED.unsettled_paisa,
       unsettled_count = EXCLUDED.unsettled_count,
       aged_count = EXCLUDED.aged_count,
       unmatched_receipts = EXCLUDED.unmatched_receipts,
       detail = EXCLUDED.detail,
       duration_ms = EXCLUDED.duration_ms,
       created_at = now()
     RETURNING id, business_date, result, created_at`,
    [
      date, findings.result, findings.trial_balance_drift_paisa, findings.cross_check_discrepancies,
      findings.unsettled_paisa, findings.unsettled_count, findings.aged_count,
      findings.unmatched_receipts,
      JSON.stringify({ failures: findings.failures, warnings: findings.warnings, ...findings.detail }),
      findings.duration_ms,
    ]
  )).rows[0];

  return { ...findings, audit_run_id: row.id, business_date: row.business_date };
}

/** Recent audit history — what an administrator opens to see whether the books are healthy. */
export async function auditHistory({ limit = 30 } = {}) {
  return (await query(
    `SELECT id, business_date, result, trial_balance_drift_paisa, cross_check_discrepancies,
            unsettled_paisa, unsettled_count, aged_count, unmatched_receipts, duration_ms, created_at
       FROM audit_runs ORDER BY business_date DESC LIMIT $1`,
    [Math.min(Number(limit) || 30, 365)]
  )).rows;
}
