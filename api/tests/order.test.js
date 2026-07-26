import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { resetDb, closeDb, makeMerchant, onboardMerchant } from './helpers.js';
import { query } from '../src/db/pool.js';
import { raiseOrder, getOrder, outletSummary, makeOrderRef, qrForOutlet, OrderError } from '../src/domain/order.js';
import { verifyBanglaQr, parseBanglaQr, parseTlv } from '../src/domain/banglaQr.js';
import { balanceOf, trialBalance } from '../src/domain/ledger.js';

jest.setTimeout(30_000);

let outlet;

beforeEach(async () => {
  await resetDb();
  outlet = await makeMerchant({ name: 'AB4 Canteen' });
});

afterAll(closeDb);

describe('order references', () => {
  test('fit the QR field and the database constraint', () => {
    for (let i = 0; i < 200; i += 1) {
      const ref = makeOrderRef(42);
      expect(ref.length).toBeLessThanOrEqual(25);
      expect(ref).toMatch(/^[A-Z0-9-]{6,25}$/);
    }
  });

  test('are unpredictable — a sequential reference would let one outlet probe another', () => {
    const refs = new Set(Array.from({ length: 500 }, () => makeOrderRef(1)));
    expect(refs.size).toBe(500);
  });

  test('omit ambiguous characters so staff can read them off a settlement report', () => {
    const suffixes = Array.from({ length: 200 }, () => makeOrderRef(1).split('-')[2]).join('');
    expect(suffixes).not.toMatch(/[ILOU]/);
  });
});

describe('the acquirer onboarding gate', () => {
  /**
   * The most important test in this file. An outlet that no bank has onboarded cannot be
   * paid, so the system must refuse to raise an order rather than print a QR that every
   * acquirer declines — which would fail at a counter, in front of a queue.
   */
  test('refuses to raise an order for an outlet no acquirer has onboarded', async () => {
    await expect(raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 }))
      .rejects.toThrow(/NOT_ONBOARDED|no acquirer-issued/);
  });

  test('the refusal names the outlet so the error is actionable', async () => {
    await expect(raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 }))
      .rejects.toThrow(/AB4 Canteen/);
  });

  test('writes NOTHING when it refuses — no order, no ledger entry', async () => {
    await expect(raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 })).rejects.toThrow();

    expect((await query('SELECT count(*)::int AS n FROM charges')).rows[0].n).toBe(0);
    expect(Number((await trialBalance()).posting_count)).toBe(0);
  });

  test('succeeds once the outlet is onboarded', async () => {
    await onboardMerchant(outlet.merchantId);
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    expect(order.order_ref).toMatch(/^PUC-/);
  });

  test('rejects an operator who runs no outlet at all', async () => {
    const stranger = await makeMerchant({ name: 'Other' });
    await query('UPDATE merchants SET active = false WHERE id = $1', [stranger.merchantId]);
    await expect(raiseOrder({ operatorUserId: stranger.operator.id, amountPaisa: 100 }))
      .rejects.toThrow(/does not operate/);
  });
});

describe('raising an order', () => {
  beforeEach(async () => {
    await onboardMerchant(outlet.merchantId);
  });

  test('mints a valid, verifiable Bangla QR', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500, memo: 'Lunch' });

    const result = verifyBanglaQr(order.bangla_qr_payload);
    expect(result.valid).toBe(true);
  });

  test('the QR carries the amount, the currency, the country and the acquirer merchant id', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    const tags = parseBanglaQr(order.bangla_qr_payload);

    expect(tags['54']).toBe('85');   // ৳85.00
    expect(tags['53']).toBe('050');  // BDT
    expect(tags['58']).toBe('BD');
    expect(tags['52']).toBe('8220'); // colleges & universities

    const template = parseTlv(tags['29']);
    expect(template['00']).toBe('BD.COM.UCB');
    expect(template['01']).toBe(`PUC${String(outlet.merchantId).padStart(7, '0')}`);
  });

  /** Without the reference in the QR, a payment can be received but never matched. */
  test('the QR carries the order reference that reconciliation depends on', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    const additional = parseTlv(parseBanglaQr(order.bangla_qr_payload)['62']);

    expect(additional['05']).toBe(order.order_ref);
  });

  test('recognises revenue and an offsetting receivable in the ledger', async () => {
    await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });

    expect(Number((await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`)).balance_paisa)).toBe(8500);
    expect(Number((await balanceOf(`PUC:RECEIVABLE:ORDERS:${outlet.merchantId}`)).balance_paisa)).toBe(8500);
    expect((await trialBalance()).balanced).toBe(true);
  });

  test('links the order row to its ledger posting', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    expect(order.ledger_posting_id).toBeGreaterThan(0);

    const row = (await query('SELECT ledger_posting_id FROM charges WHERE order_ref = $1', [order.order_ref])).rows[0];
    expect(Number(row.ledger_posting_id)).toBe(Number(order.ledger_posting_id));
  });

  test('rejects invalid amounts without writing anything', async () => {
    for (const bad of [0, -1, 85.5]) {
      await expect(raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: bad })).rejects.toThrow(OrderError);
    }
    expect((await query('SELECT count(*)::int AS n FROM charges')).rows[0].n).toBe(0);
  });

  test('each order gets its own reference and its own QR', async () => {
    const a = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    const b = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });

    expect(a.order_ref).not.toBe(b.order_ref);
    expect(a.bangla_qr_payload).not.toBe(b.bangla_qr_payload);
  });

  test('two orders accumulate both revenue and receivable', async () => {
    await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 1500 });

    expect(Number((await balanceOf(`PUC:RECEIVABLE:ORDERS:${outlet.merchantId}`)).balance_paisa)).toBe(10000);
    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('what the student sees', () => {
  beforeEach(async () => {
    await onboardMerchant(outlet.merchantId);
  });

  test('shows the outlet and the amount', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500, memo: 'Lunch' });
    const view = await getOrder(order.token);

    expect(view).toMatchObject({
      merchant_name: 'AB4 Canteen',
      amount_paisa: 8500,
      memo: 'Lunch',
      status: 'pending',
    });
  });

  /**
   * A payload is a payment instruction for the outlet's own bank account. Handing it to
   * any authenticated student would let one print and substitute it elsewhere on campus.
   */
  test('never exposes the QR payload to the payer', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    const view = await getOrder(order.token);

    expect(view.bangla_qr_payload).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('6304');
  });

  test('reports an elapsed order as expired', async () => {
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    await query("UPDATE charges SET expires_at = now() - interval '1 minute' WHERE order_ref = $1", [order.order_ref]);

    expect((await getOrder(order.token)).status).toBe('expired');
  });

  test('rejects an unknown token', async () => {
    await expect(getOrder('not-a-real-token')).rejects.toThrow(/not valid/);
  });
});

describe('the counter summary', () => {
  test('tells an un-onboarded outlet that it is not live', async () => {
    const summary = await outletSummary(outlet.operator.id);
    expect(summary.outlet.acquirer_issued).toBe(false);
  });

  test('reports what is still awaiting payment', async () => {
    await onboardMerchant(outlet.merchantId);
    await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 8500 });
    await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 1500 });

    const summary = await outletSummary(outlet.operator.id);
    expect(Number(summary.stats.awaiting_paisa)).toBe(10000);
    expect(Number(summary.stats.awaiting_count)).toBe(2);
    expect(summary.recent).toHaveLength(2);
  });
});

describe('static outlet QR (no amount)', () => {
  test('omits the amount so the payer types it in', async () => {
    await onboardMerchant(outlet.merchantId);
    const merchant = (await query('SELECT * FROM merchants WHERE id = $1', [outlet.merchantId])).rows[0];

    const payload = qrForOutlet(merchant);
    const tags = parseBanglaQr(payload);

    expect(tags['54']).toBeUndefined();
    expect(tags['01']).toBe('11'); // static
    expect(verifyBanglaQr(payload).valid).toBe(true);
  });
});
