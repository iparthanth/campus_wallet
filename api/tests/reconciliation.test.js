import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { resetDb, closeDb, makeMerchant, onboardMerchant, makeUser } from './helpers.js';
import { query } from '../src/db/pool.js';
import { raiseOrder } from '../src/domain/order.js';
import {
  importSettlement,
  exceptionReport,
  crossCheck,
  normaliseLine,
  hashStatement,
  LINE_STATUS,
  ReconciliationError,
} from '../src/domain/reconciliation.js';
import { balanceOf, trialBalance, post, ACCOUNTS, DEBIT, CREDIT } from '../src/domain/ledger.js';

jest.setTimeout(60_000);

let outlet;
let staff;
let txnSeq = 0;
const nextTxn = () => `UCB${Date.now()}${++txnSeq}`;

beforeEach(async () => {
  await resetDb();
  outlet = await makeMerchant({ name: 'AB4 Canteen' });
  await onboardMerchant(outlet.merchantId);
  staff = await makeUser({ role: 'admin' });
});

afterAll(closeDb);

const order = (amountPaisa = 8500) =>
  raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa });

/** One statement line as an acquirer would report it: gross, commission, net. */
const line = (o, { fee = 0, txnId = null, ref = undefined, gross = null } = {}) => ({
  acquirer_txn_id: txnId ?? nextTxn(),
  order_ref: ref === undefined ? o.order_ref : ref,
  gross_paisa: gross ?? o.amount_paisa,
  fee_paisa: fee,
  paid_at: new Date().toISOString(),
});

const importOne = (lines, extra = {}) =>
  importSettlement({
    acquirer: 'UCB',
    sourceRef: 'ucb-statement.csv',
    statementDate: '2026-07-25',
    lines,
    importedByUserId: staff.id,
    ...extra,
  });

describe('normalising acquirer statement lines', () => {
  test('derives net from gross and fee', () => {
    const n = normaliseLine({ acquirer_txn_id: 'T1', gross_paisa: 10000, fee_paisa: 200 });
    expect(n.netPaisa).toBe(9800);
  });

  test('derives gross from net and fee', () => {
    const n = normaliseLine({ acquirer_txn_id: 'T1', net_paisa: 9800, fee_paisa: 200 });
    expect(n.grossPaisa).toBe(10000);
  });

  test('rejects a line whose arithmetic does not hold', () => {
    expect(() => normaliseLine({ acquirer_txn_id: 'T1', gross_paisa: 10000, net_paisa: 9000, fee_paisa: 200 }))
      .toThrow(/gross 10000 != net 9000 \+ fee 200/);
  });

  test('rejects a line with no acquirer transaction id', () => {
    expect(() => normaliseLine({ gross_paisa: 100 })).toThrow(/transaction id/);
  });

  test('rejects fractional or non-positive amounts', () => {
    expect(() => normaliseLine({ acquirer_txn_id: 'T1', gross_paisa: 85.5 })).toThrow(ReconciliationError);
    expect(() => normaliseLine({ acquirer_txn_id: 'T1', gross_paisa: 0 })).toThrow(ReconciliationError);
  });

  test('uppercases the reference, because staff retype them', () => {
    expect(normaliseLine({ acquirer_txn_id: 'T1', gross_paisa: 100, order_ref: 'puc-1-abc' }).orderRef)
      .toBe('PUC-1-ABC');
  });
});

describe('matching a clean statement', () => {
  test('settles an order whose reference and amount both agree', async () => {
    const o = await order(8500);
    const result = await importOne([line(o, { fee: 170 })]);

    expect(result.matched_count).toBe(1);
    expect(result.exception_count).toBe(0);
    expect(result.lines[0].status).toBe(LINE_STATUS.MATCHED);
  });

  test('marks the order paid and links it to the settling line', async () => {
    const o = await order(8500);
    const result = await importOne([line(o)]);

    const row = (await query('SELECT status, paid_at, settlement_line_id FROM charges WHERE order_ref = $1', [o.order_ref])).rows[0];
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
    expect(Number(row.settlement_line_id)).toBe(Number(result.lines[0].id));
  });

  /**
   * The accounting that makes the money real: the bank account rises by the NET, the
   * commission is recognised as an expense, and the receivable is discharged at GROSS.
   */
  test('posts net to the bank, fee to expense, and clears the receivable', async () => {
    const o = await order(8500);
    await importOne([line(o, { fee: 170 })]);

    expect(Number((await balanceOf('PUC:BANK:UCB')).balance_paisa)).toBe(8330);
    expect(Number((await balanceOf('PUC:EXPENSE:FEE:UCB')).balance_paisa)).toBe(170);
    expect(Number((await balanceOf(`PUC:RECEIVABLE:ORDERS:${outlet.merchantId}`)).balance_paisa)).toBe(0);
    expect(Number((await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`)).balance_paisa)).toBe(8500);

    expect((await trialBalance()).balanced).toBe(true);
  });

  test('handles a zero-commission settlement', async () => {
    const o = await order(8500);
    await importOne([line(o, { fee: 0 })]);

    expect(Number((await balanceOf('PUC:BANK:UCB')).balance_paisa)).toBe(8500);
    expect((await trialBalance()).balanced).toBe(true);
  });

  test('settles a multi-line statement', async () => {
    const orders = [await order(8500), await order(1500), await order(30000)];
    const result = await importOne(orders.map((o) => line(o, { fee: 20 })));

    expect(result.matched_count).toBe(3);
    expect(Number((await balanceOf(`PUC:RECEIVABLE:ORDERS:${outlet.merchantId}`)).balance_paisa)).toBe(0);
    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('exceptions — the part that matters', () => {
  test('flags money received against an unknown reference', async () => {
    const result = await importOne([{
      acquirer_txn_id: nextTxn(), order_ref: 'PUC-99-NOTREAL', gross_paisa: 5000, fee_paisa: 0,
    }]);

    expect(result.matched_count).toBe(0);
    expect(result.lines[0].status).toBe(LINE_STATUS.UNMATCHED);
    expect(result.lines[0].note).toMatch(/No order carries reference/);
  });

  test('flags money received with no reference at all (static QR)', async () => {
    const result = await importOne([{ acquirer_txn_id: nextTxn(), gross_paisa: 5000 }]);

    expect(result.lines[0].status).toBe(LINE_STATUS.UNMATCHED);
    expect(result.lines[0].note).toMatch(/static QR/);
  });

  /**
   * A partial payment is a business conversation, not an accounting adjustment. Settling
   * the order anyway would leave a silent shortfall in the books.
   */
  test('refuses to settle when the amount disagrees, even by one paisa', async () => {
    const o = await order(8500);
    const result = await importOne([line(o, { gross: 8499 })]);

    expect(result.lines[0].status).toBe(LINE_STATUS.AMOUNT_MISMATCH);
    expect(result.lines[0].note).toMatch(/8500 paisa but 8499 was received/);

    // Nothing was settled, so the receivable still stands.
    expect(Number((await balanceOf(`PUC:RECEIVABLE:ORDERS:${outlet.merchantId}`)).balance_paisa)).toBe(8500);
    expect(Number((await balanceOf('PUC:BANK:UCB'))?.balance_paisa ?? 0)).toBe(0);
  });

  test('flags a second payment against an already-settled order', async () => {
    const o = await order(8500);
    await importOne([line(o)]);
    const second = await importOne([line(o)], { sourceRef: 'ucb-statement-2.csv' });

    expect(second.lines[0].status).toBe(LINE_STATUS.DUPLICATE_REF);
    // The bank balance did NOT rise twice.
    expect(Number((await balanceOf('PUC:BANK:UCB')).balance_paisa)).toBe(8500);
  });

  test('a mixed statement settles the good lines and flags the rest', async () => {
    const good = await order(8500);
    const wrongAmount = await order(1500);

    const result = await importOne([
      line(good),
      line(wrongAmount, { gross: 999 }),
      { acquirer_txn_id: nextTxn(), order_ref: 'PUC-77-GHOST', gross_paisa: 4200 },
    ]);

    expect(result.matched_count).toBe(1);
    expect(result.exception_count).toBe(2);
    expect(result.lines.map((l) => l.status).sort()).toEqual(
      [LINE_STATUS.AMOUNT_MISMATCH, LINE_STATUS.MATCHED, LINE_STATUS.UNMATCHED].sort()
    );
    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('the re-upload guard', () => {
  /**
   * The single most likely operational mistake: a staff member uploads yesterday's
   * statement again. Without this the books show twice the revenue.
   */
  test('refuses the identical file a second time', async () => {
    const o = await order(8500);
    const content = 'txn,ref,amount\nUCB-1,PUC-1-AAA,85.00';

    await importOne([line(o, { txnId: 'UCB-1' })], { rawContent: content });
    await expect(importOne([line(o, { txnId: 'UCB-1' })], { rawContent: content }))
      .rejects.toThrow(/already imported/i);
  });

  test('the refusal explains the consequence of proceeding', async () => {
    const o = await order(8500);
    const content = 'same-bytes';
    await importOne([line(o)], { rawContent: content });

    await expect(importOne([line(o)], { rawContent: content }))
      .rejects.toThrow(/double-count/);
  });

  test('the same transaction id in a DIFFERENT file settles nothing twice', async () => {
    const o = await order(8500);
    const txnId = 'UCB-SHARED-1';

    await importOne([line(o, { txnId })], { rawContent: 'file-a' });
    const second = await importOne([line(o, { txnId })], { rawContent: 'file-b' });

    expect(second.lines[0].status).toBe(LINE_STATUS.ALREADY_IMPORTED);
    expect(Number((await balanceOf('PUC:BANK:UCB')).balance_paisa)).toBe(8500);
  });

  test('hashing is stable and content-sensitive', () => {
    expect(hashStatement('abc')).toBe(hashStatement('abc'));
    expect(hashStatement('abc')).not.toBe(hashStatement('abd'));
    expect(hashStatement('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('atomicity', () => {
  /**
   * A half-imported statement is worse than an un-imported one, because it looks
   * finished. A malformed line must abort the whole batch.
   */
  test('one bad line aborts the entire statement', async () => {
    const o = await order(8500);

    await expect(importOne([
      line(o),
      { acquirer_txn_id: 'BAD-1', gross_paisa: 100, net_paisa: 50, fee_paisa: 10 }, // arithmetic fails
    ])).rejects.toThrow(ReconciliationError);

    expect((await query('SELECT count(*)::int AS n FROM settlement_imports')).rows[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM settlement_lines')).rows[0].n).toBe(0);
    // The order is untouched — still owed.
    expect((await query('SELECT status FROM charges WHERE order_ref = $1', [o.order_ref])).rows[0].status).toBe('pending');
  });

  test('rejects an empty statement rather than recording an empty batch', async () => {
    await expect(importOne([])).rejects.toThrow(/no lines/);
    expect((await query('SELECT count(*)::int AS n FROM settlement_imports')).rows[0].n).toBe(0);
  });
});

describe('the exception report', () => {
  test('lists unsettled orders with their age', async () => {
    await order(8500);
    await order(1500);

    const report = await exceptionReport();
    expect(report.unsettled_orders).toHaveLength(2);
    expect(report.totals.unsettled_paisa).toBe(10000);
    expect(report.unsettled_orders[0]).toHaveProperty('age_hours');
  });

  test('lists money received that no order explains', async () => {
    await importOne([{ acquirer_txn_id: nextTxn(), order_ref: 'PUC-9-GHOST', gross_paisa: 4200 }]);

    const report = await exceptionReport();
    expect(report.unmatched_receipts).toHaveLength(1);
    expect(report.unmatched_receipts[0].order_ref).toBe('PUC-9-GHOST');
  });

  test('empties as orders settle', async () => {
    const o = await order(8500);
    expect((await exceptionReport()).totals.unsettled_paisa).toBe(8500);

    await importOne([line(o)]);
    expect((await exceptionReport()).totals.unsettled_paisa).toBe(0);
  });

  test('breaks the outstanding total down by outlet', async () => {
    const other = await makeMerchant({ name: 'Library Desk', category: 'library' });
    await onboardMerchant(other.merchantId, { merchantIdAtAcquirer: 'PUCLIB0001' });

    await order(8500);
    await raiseOrder({ operatorUserId: other.operator.id, amountPaisa: 2000 });

    const byOutlet = (await exceptionReport()).by_outlet;
    const canteen = byOutlet.find((r) => Number(r.merchant_id) === outlet.merchantId);
    const library = byOutlet.find((r) => Number(r.merchant_id) === other.merchantId);

    expect(Number(canteen.unsettled_paisa)).toBe(8500);
    expect(Number(library.unsettled_paisa)).toBe(2000);
  });
});

describe('cross-check: orders table vs ledger', () => {
  /**
   * Two independent derivations of "what is still owed". They must agree; disagreement
   * means one of them is lying, and that is worth knowing before a student is told their
   * payment never arrived.
   */
  test('agrees after orders are raised', async () => {
    await order(8500);
    await order(1500);

    const check = await crossCheck();
    expect(check.agrees).toBe(true);
    expect(check.discrepancies).toHaveLength(0);
  });

  test('agrees after settlement', async () => {
    const o = await order(8500);
    await importOne([line(o, { fee: 170 })]);

    expect((await crossCheck()).agrees).toBe(true);
  });

  /**
   * The realistic failure this check exists to catch: a settlement is posted to the
   * ledger but the corresponding order update does not land — a crash between the two
   * writes, or a future refactor that splits them across transactions. The ledger then
   * says the receivable is discharged while the orders table still says money is owed.
   *
   * Neither table can detect this alone. That is the entire argument for keeping both.
   */
  test('detects a settlement posted to the ledger that the orders table never saw', async () => {
    await order(8500);

    // Discharge the receivable in the ledger only, leaving `charges` untouched.
    await post({
      idempotencyKey: `orphan-settle-${Date.now()}`,
      kind: 'SETTLEMENT_MATCHED',
      description: 'Simulated: ledger posted, order update lost',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 8500 },
        {
          account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name),
          direction: CREDIT,
          amountPaisa: 8500,
        },
      ],
    });

    // Orders still say ৳85 is owed; the ledger says nothing is.
    const check = await crossCheck();
    expect(check.agrees).toBe(false);
    expect(check.discrepancies).toHaveLength(1);
    expect(check.discrepancies[0].orders_say).toBe(8500);
    expect(check.discrepancies[0].ledger_says).toBe(0);
    expect(check.discrepancies[0].drift_paisa).toBe(8500);

    // The ledger itself is still internally consistent — the drift is a CROSS-table
    // disagreement, which is exactly why the trial balance alone would not catch it.
    expect((await trialBalance()).balanced).toBe(true);
  });
});
