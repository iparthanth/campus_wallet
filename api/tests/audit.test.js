import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { resetDb, closeDb, makeMerchant, onboardMerchant, makeUser } from './helpers.js';
import { query } from '../src/db/pool.js';
import { raiseOrder } from '../src/domain/order.js';
import { importSettlement } from '../src/domain/reconciliation.js';
import { runAudit, recordAudit, auditHistory, AUDIT_RESULT } from '../src/domain/audit.js';
import { post, ACCOUNTS, DEBIT, CREDIT } from '../src/domain/ledger.js';

let outlet;
let seq = 0;

beforeEach(async () => {
  await resetDb();
  outlet = await makeMerchant({ name: 'AB4 Canteen' });
  await onboardMerchant(outlet.merchantId);
});

afterAll(closeDb);

const order = (amountPaisa = 8500) => raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa });

const settle = (o, fee = 0) => importSettlement({
  acquirer: 'UCB',
  sourceRef: `stmt-${++seq}.csv`,
  statementDate: '2026-07-25',
  rawContent: `unique-content-${seq}`,
  lines: [{
    acquirer_txn_id: `UCB-${Date.now()}-${seq}`,
    order_ref: o.order_ref,
    gross_paisa: o.amount_paisa,
    fee_paisa: fee,
  }],
});

describe('a healthy system', () => {
  test('passes on an empty ledger', async () => {
    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.PASS);
    expect(findings.trial_balance_drift_paisa).toBe(0);
  });

  test('passes when every order has settled', async () => {
    const o = await order(8500);
    await settle(o, 170);

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.PASS);
    expect(findings.unsettled_paisa).toBe(0);
    expect(findings.failures).toHaveLength(0);
  });

  /** Money owed for an hour is normal trading, not a fault. */
  test('passes with fresh unsettled orders', async () => {
    await order(8500);

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.PASS);
    expect(findings.unsettled_paisa).toBe(8500);
    expect(findings.aged_count).toBe(0);
  });
});

describe('warnings — correct but needs attention', () => {
  /**
   * Ageing warns rather than fails, deliberately. A monitor that pages at 2am because
   * three orders are 50 hours old gets muted within a week — and the FAIL that matters
   * gets muted with it.
   */
  test('warns on orders unsettled past the ageing threshold', async () => {
    const o = await order(8500);
    await query("UPDATE charges SET created_at = now() - interval '72 hours' WHERE order_ref = $1", [o.order_ref]);

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.WARN);
    expect(findings.aged_count).toBe(1);
    expect(findings.failures).toHaveLength(0);
    expect(findings.warnings[0].check).toBe('AGED_RECEIVABLES');
  });

  test('warns on money received that no order explains', async () => {
    await importSettlement({
      acquirer: 'UCB',
      sourceRef: 'ghost.csv',
      statementDate: '2026-07-25',
      rawContent: 'ghost-file',
      lines: [{ acquirer_txn_id: 'UCB-GHOST-1', order_ref: 'PUC-99-NOTREAL', gross_paisa: 4200 }],
    });

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.WARN);
    expect(findings.unmatched_receipts).toBe(1);
  });

  test('a warning never masks a failure', async () => {
    const o = await order(8500);
    await query("UPDATE charges SET created_at = now() - interval '72 hours' WHERE order_ref = $1", [o.order_ref]);

    // Introduce a genuine cross-table failure alongside the warning.
    await post({
      idempotencyKey: `orphan-${Date.now()}`,
      kind: 'SETTLEMENT_MATCHED',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 8500 },
        { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 8500 },
      ],
    });

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.FAIL); // FAIL wins over WARN
    expect(findings.aged_count).toBe(1);
  });
});

describe('failures — an invariant is violated', () => {
  test('fails when the orders table and the ledger disagree', async () => {
    await order(8500);

    // Discharge the receivable in the ledger only — the orders table never sees it.
    await post({
      idempotencyKey: `orphan-${Date.now()}`,
      kind: 'SETTLEMENT_MATCHED',
      description: 'Simulated: ledger posted, order update lost',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 8500 },
        { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 8500 },
      ],
    });

    const findings = await runAudit();
    expect(findings.result).toBe(AUDIT_RESULT.FAIL);
    expect(findings.cross_check_discrepancies).toBe(1);
    expect(findings.failures[0].check).toBe('CROSS_CHECK');
  });

  test('the failure carries the per-outlet detail needed to investigate', async () => {
    await order(8500);
    await post({
      idempotencyKey: `orphan-${Date.now()}`,
      kind: 'SETTLEMENT_MATCHED',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 8500 },
        { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 8500 },
      ],
    });

    const findings = await runAudit();
    const disc = findings.failures[0].discrepancies[0];
    expect(disc.merchant_name).toBe('AB4 Canteen');
    expect(disc.orders_say).toBe(8500);
    expect(disc.ledger_says).toBe(0);
  });
});

describe('recording', () => {
  test('stores the run and its findings', async () => {
    const o = await order(8500);
    await settle(o);

    const recorded = await recordAudit({ businessDate: '2026-07-24' });
    expect(recorded.audit_run_id).toBeGreaterThan(0);

    const history = await auditHistory();
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe(AUDIT_RESULT.PASS);
  });

  /** Re-running a day corrects it rather than leaving two rows that disagree. */
  test('re-running a business date overwrites rather than duplicating', async () => {
    await recordAudit({ businessDate: '2026-07-24' });
    await order(8500);
    await query("UPDATE charges SET created_at = now() - interval '99 hours'");
    await recordAudit({ businessDate: '2026-07-24' });

    const history = await auditHistory();
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe(AUDIT_RESULT.WARN); // reflects the RE-RUN, not the first pass
  });

  test('keeps the full findings for later investigation', async () => {
    await order(8500);
    await recordAudit({ businessDate: '2026-07-24' });

    const row = (await query('SELECT detail FROM audit_runs WHERE business_date = $1', ['2026-07-24'])).rows[0];
    expect(row.detail).toHaveProperty('trial_balance');
    expect(row.detail).toHaveProperty('by_outlet');
  });
});

describe('the cron entry point', () => {
  test('exits 0 on PASS and 1 on FAIL', async () => {
    const { main } = await import('../src/jobs/nightlyAudit.js');

    expect(await main({ businessDate: '2026-07-24' })).toBe(0);

    await order(8500);
    await post({
      idempotencyKey: `orphan-${Date.now()}`,
      kind: 'SETTLEMENT_MATCHED',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 8500 },
        { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 8500 },
      ],
    });

    expect(await main({ businessDate: '2026-07-23' })).toBe(1);
  });

  /** WARN exits 0 so a noisy warning cannot train operators to ignore the pager. */
  test('exits 0 on WARN', async () => {
    const { main } = await import('../src/jobs/nightlyAudit.js');
    await order(8500);
    await query("UPDATE charges SET created_at = now() - interval '72 hours'");

    expect(await main({ businessDate: '2026-07-22' })).toBe(0);
  });
});
