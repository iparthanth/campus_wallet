import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { api, resetDb, closeDb, makeUser, makeMerchant, onboardMerchant } from './helpers.js';
import { query } from '../src/db/pool.js';

jest.setTimeout(60_000);

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

let outlet;
let admin;
let student;
let seq = 0;

beforeEach(async () => {
  await resetDb();
  outlet = await makeMerchant({ name: 'AB4 Canteen' });
  admin = await makeUser({ role: 'admin' });
  student = await makeUser();
});

afterAll(closeDb);

const raise = (amount = 8500, memo = 'Lunch') =>
  api().post('/orders').set(auth(outlet.operator)).send({ amount_paisa: amount, memo });

describe('POST /orders', () => {
  test('409s until the outlet is onboarded by an acquirer', async () => {
    const res = await raise();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ONBOARDED');
    expect(res.body.error.message).toMatch(/AB4 Canteen/);
  });

  test('creates an order with a Bangla QR once onboarded', async () => {
    await onboardMerchant(outlet.merchantId);
    const res = await raise();

    expect(res.status).toBe(201);
    expect(res.body.order_ref).toMatch(/^PUC-/);
    expect(res.body.bangla_qr_payload).toMatch(/^0002/);
    expect(res.body.bangla_qr_payload).toMatch(/6304[0-9A-F]{4}$/);
    expect(res.body.acquirer).toBe('UCB');
  });

  test('rejects a bad amount', async () => {
    await onboardMerchant(outlet.merchantId);
    for (const bad of [0, -1, 85.5]) {
      const res = await api().post('/orders').set(auth(outlet.operator)).send({ amount_paisa: bad });
      expect(res.status).toBe(422);
    }
  });

  test('403s for a user who runs no outlet', async () => {
    const res = await api().post('/orders').set(auth(student)).send({ amount_paisa: 8500 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_AN_OPERATOR');
  });

  test('401s without a token', async () => {
    expect((await api().post('/orders').send({ amount_paisa: 8500 })).status).toBe(401);
  });
});

describe('GET /orders/:token', () => {
  test('shows the student the outlet and amount', async () => {
    await onboardMerchant(outlet.merchantId);
    const order = (await raise()).body;

    const res = await api().get(`/orders/${order.token}`).set(auth(student));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merchant_name: 'AB4 Canteen', amount_paisa: 8500, status: 'pending' });
  });

  /** The payload is a payment instruction for the outlet's account. Never hand it out. */
  test('never leaks the QR payload to the payer', async () => {
    await onboardMerchant(outlet.merchantId);
    const order = (await raise()).body;

    const res = await api().get(`/orders/${order.token}`).set(auth(student));
    expect(res.body.bangla_qr_payload).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('6304');
  });

  test('404s on an unknown token', async () => {
    expect((await api().get('/orders/nope').set(auth(student))).status).toBe(404);
  });
});

describe('POST /admin/settlements/import', () => {
  async function orderAndSettle(lines, extra = {}) {
    return api().post('/admin/settlements/import').set(auth(admin)).send({
      acquirer: 'UCB',
      source_ref: `stmt-${++seq}.csv`,
      statement_date: '2026-07-25',
      raw_content: `content-${seq}`,
      lines,
      ...extra,
    });
  }

  test('settles a matching line and reports zero exceptions', async () => {
    await onboardMerchant(outlet.merchantId);
    const order = (await raise()).body;

    const res = await orderAndSettle([{
      acquirer_txn_id: 'UCB-1', order_ref: order.order_ref, gross_paisa: 8500, fee_paisa: 170,
    }]);

    expect(res.status).toBe(201);
    expect(res.body.matched_count).toBe(1);
    expect(res.body.exception_count).toBe(0);
  });

  test('reports exceptions rather than failing the request', async () => {
    const res = await orderAndSettle([{
      acquirer_txn_id: 'UCB-GHOST', order_ref: 'PUC-99-NOPE', gross_paisa: 5000,
    }]);

    expect(res.status).toBe(201);
    expect(res.body.matched_count).toBe(0);
    expect(res.body.lines[0].status).toBe('UNMATCHED');
  });

  test('409s on a re-uploaded statement', async () => {
    await onboardMerchant(outlet.merchantId);
    const order = (await raise()).body;
    const lines = [{ acquirer_txn_id: 'UCB-DUP', order_ref: order.order_ref, gross_paisa: 8500 }];

    await api().post('/admin/settlements/import').set(auth(admin))
      .send({ acquirer: 'UCB', statement_date: '2026-07-25', raw_content: 'same', lines });
    const second = await api().post('/admin/settlements/import').set(auth(admin))
      .send({ acquirer: 'UCB', statement_date: '2026-07-25', raw_content: 'same', lines });

    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/double-count/);
  });

  test('403s for a non-admin — importing moves money in the books', async () => {
    const res = await api().post('/admin/settlements/import').set(auth(student)).send({
      acquirer: 'UCB', statement_date: '2026-07-25',
      lines: [{ acquirer_txn_id: 'X', gross_paisa: 100 }],
    });
    expect(res.status).toBe(403);
  });

  test('422s on a malformed statement', async () => {
    const res = await api().post('/admin/settlements/import').set(auth(admin))
      .send({ acquirer: 'UCB', statement_date: 'not-a-date', lines: [] });
    expect(res.status).toBe(422);
  });
});

describe('reconciliation and audit endpoints', () => {
  test('exceptions list what is outstanding', async () => {
    await onboardMerchant(outlet.merchantId);
    await raise(8500);

    const res = await api().get('/admin/reconciliation/exceptions').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.totals.unsettled_paisa).toBe(8500);
  });

  test('cross-check returns 200 when the tables agree', async () => {
    await onboardMerchant(outlet.merchantId);
    await raise(8500);

    const res = await api().get('/admin/reconciliation/cross-check').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.agrees).toBe(true);
  });

  test('trial balance returns 200 and zero drift on a healthy ledger', async () => {
    await onboardMerchant(outlet.merchantId);
    await raise(8500);

    const res = await api().get('/admin/ledger/trial-balance').set(auth(admin));
    expect(res.status).toBe(200);
    expect(Number(res.body.drift_paisa)).toBe(0);
    expect(res.body.balanced).toBe(true);
  });

  test('a dry-run audit passes on a healthy system', async () => {
    await onboardMerchant(outlet.merchantId);
    await raise(8500);

    const res = await api().get('/admin/audit/run').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('PASS');
  });

  test('recording an audit stores it in history', async () => {
    const run = await api().post('/admin/audit/run').set(auth(admin)).send({ business_date: '2026-07-24' });
    expect(run.status).toBe(201);

    const history = await api().get('/admin/audit/history').set(auth(admin));
    expect(history.body.runs).toHaveLength(1);
    expect(history.body.runs[0].result).toBe('PASS');
  });

  test('a ledger account statement is readable by code', async () => {
    await onboardMerchant(outlet.merchantId);
    await raise(8500);

    const res = await api().get(`/admin/ledger/accounts/PUC:REVENUE:MERCHANT:${outlet.merchantId}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(Number(res.body.account.balance_paisa)).toBe(8500);
    expect(res.body.statement).toHaveLength(1);
  });

  test('404s on an unknown ledger account', async () => {
    expect((await api().get('/admin/ledger/accounts/PUC:NOPE').set(auth(admin))).status).toBe(404);
  });

  test('every admin endpoint refuses a non-admin', async () => {
    for (const path of [
      '/admin/reconciliation/exceptions',
      '/admin/reconciliation/cross-check',
      '/admin/audit/run',
      '/admin/audit/history',
      '/admin/ledger/trial-balance',
    ]) {
      expect((await api().get(path).set(auth(student))).status).toBe(403);
    }
  });
});

describe('the full counter-to-bank journey over HTTP', () => {
  /**
   * The end-to-end story shown to PUC: an order is raised, a student pays it over
   * licensed rails, the bank's statement arrives, and the books close clean.
   */
  test('order -> settlement -> audit passes with the money in the right accounts', async () => {
    await onboardMerchant(outlet.merchantId);

    const order = (await raise(8500, 'Rice and curry')).body;
    expect(order.bangla_qr_payload).toBeTruthy();

    // Before payment: the university is owed ৳85.
    let exceptions = (await api().get('/admin/reconciliation/exceptions').set(auth(admin))).body;
    expect(exceptions.totals.unsettled_paisa).toBe(8500);

    // The bank's statement arrives: ৳85 gross, ৳1.70 commission, ৳83.30 net.
    const imported = await api().post('/admin/settlements/import').set(auth(admin)).send({
      acquirer: 'UCB',
      source_ref: 'ucb-2026-07-25.csv',
      statement_date: '2026-07-25',
      raw_content: 'ucb,statement,bytes',
      lines: [{ acquirer_txn_id: 'UCB-77', order_ref: order.order_ref, gross_paisa: 8500, fee_paisa: 170 }],
    });
    expect(imported.body.matched_count).toBe(1);

    // After: nothing outstanding.
    exceptions = (await api().get('/admin/reconciliation/exceptions').set(auth(admin))).body;
    expect(exceptions.totals.unsettled_paisa).toBe(0);

    // The money landed where it should.
    const bank = (await api().get('/admin/ledger/accounts/PUC:BANK:UCB').set(auth(admin))).body;
    expect(Number(bank.account.balance_paisa)).toBe(8330);

    const fee = (await api().get('/admin/ledger/accounts/PUC:EXPENSE:FEE:UCB').set(auth(admin))).body;
    expect(Number(fee.account.balance_paisa)).toBe(170);

    // And the audit agrees.
    const audit = (await api().get('/admin/audit/run').set(auth(admin))).body;
    expect(audit.result).toBe('PASS');
    expect(audit.trial_balance_drift_paisa).toBe(0);

    // The order is closed and points at the evidence.
    const settled = (await query('SELECT status, settlement_line_id FROM charges WHERE order_ref = $1', [order.order_ref])).rows[0];
    expect(settled.status).toBe('paid');
    expect(settled.settlement_line_id).not.toBeNull();
  });
});
