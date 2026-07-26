import { recordAudit } from '../domain/audit.js';
import { closePool } from '../db/pool.js';

/**
 * Nightly reconciliation audit — the cron entry point.
 *
 *   node src/jobs/nightlyAudit.js
 *
 * Deploy as a scheduled job just after midnight Asia/Dhaka, auditing the day that just
 * ended. On Render this is a Cron Job; with systemd a timer; with plain cron:
 *
 *   5 0 * * *  cd /srv/campus-wallet/api && node src/jobs/nightlyAudit.js >> /var/log/campus-audit.log 2>&1
 *
 * EXIT CODES — these are the monitoring contract, so they are deliberate:
 *   0  PASS — books balance, tables agree
 *   0  WARN — correct but needs attention (aged receivables, unmatched receipts)
 *   1  FAIL — an invariant is violated; a human must look tonight, not on Monday
 *   2  the audit itself could not run (database down, bad config)
 *
 * WARN exits 0 on purpose. A monitor that pages at 2am for "three orders are 50 hours
 * old" gets muted within a week, and then the FAIL that matters is muted with it.
 */

/** Yesterday in Asia/Dhaka — the day a just-after-midnight run is actually auditing. */
function businessDateDhaka(now = new Date()) {
  const dhaka = new Date(now.getTime() + 6 * 60 * 60 * 1000); // UTC+6, no DST in Bangladesh
  dhaka.setUTCDate(dhaka.getUTCDate() - 1);
  return dhaka.toISOString().slice(0, 10);
}

function log(level, msg, extra = {}) {
  // Single-line JSON: greppable, and parseable by whatever ships the logs.
  console.log(JSON.stringify({ level, msg, job: 'nightly-audit', ts: new Date().toISOString(), ...extra }));
}

export async function main({ businessDate = null } = {}) {
  const date = businessDate ?? businessDateDhaka();
  log('info', 'audit starting', { business_date: date });

  const findings = await recordAudit({ businessDate: date });

  const summary = {
    business_date: date,
    result: findings.result,
    trial_balance_drift_paisa: findings.trial_balance_drift_paisa,
    cross_check_discrepancies: findings.cross_check_discrepancies,
    unsettled_paisa: findings.unsettled_paisa,
    unsettled_count: findings.unsettled_count,
    aged_count: findings.aged_count,
    unmatched_receipts: findings.unmatched_receipts,
    duration_ms: findings.duration_ms,
  };

  for (const failure of findings.failures) log('error', failure.message, { check: failure.check });
  for (const warning of findings.warnings) log('warn', warning.message, { check: warning.check });

  if (findings.result === 'FAIL') {
    log('error', 'AUDIT FAILED — the books do not reconcile. Investigate before trading resumes.', summary);
    return 1;
  }
  log('info', findings.result === 'WARN' ? 'audit passed with warnings' : 'audit passed', summary);
  return 0;
}

// Only run when invoked directly, so importing this module in a test is side-effect free.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/nightlyAudit.js')) {
  const dateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
  main({ businessDate: dateArg })
    .then(async (code) => { await closePool(); process.exit(code); })
    .catch(async (err) => {
      log('error', 'audit could not run', { error: err.message, stack: err.stack });
      try { await closePool(); } catch { /* already gone */ }
      process.exit(2);
    });
}
