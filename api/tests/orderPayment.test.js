import { startFakeSsl } from './fake-sslcommerz.js';

/**
 * Paying ONE order online — the lawful zero-float gateway flow.
 *
 * The bug these tests exist to prevent recurring: SSLCommerz worked, but was wired only to
 * the top-up path, which credits a wallet balance. That is the closed-loop flow production
 * refuses to boot into, so in the mode this system actually ships there was no way to pay
 * online at all. Every component passed its own tests; nothing tested the composition.
 *
 * Config reads env at import time, so the fake's URL is set before the modules load.
 */
let fake, makeUser, makeMerchant, onboardMerchant, resetDb, closeDb, query;
let raiseOrder, startOrderPayment, confirmOrderPayment, closeOrderPayment, paymentsForOrder;
let balanceOfAccount, trialBalance, post, ACCOUNTS, DEBIT, CREDIT, withTransaction;

beforeAll(async () => {
  fake = await startFakeSsl();
  process.env.SSL_BASE_URL = fake.baseUrl;
  process.env.SSL_STORE_ID = 'testbox';
  process.env.SSL_STORE_PASSWORD = 'qwerty';

  ({ makeUser, makeMerchant, onboardMerchant, resetDb, closeDb } = await import('./helpers.js'));
  ({ query, withTransaction } = await import('../src/db/pool.js'));
  ({ raiseOrder } = await import('../src/domain/order.js'));
  ({ startOrderPayment, confirmOrderPayment, closeOrderPayment, paymentsForOrder } =
    await import('../src/domain/orderPayment.js'));
  ({ balanceOf: balanceOfAccount, trialBalance, post, ACCOUNTS, DEBIT, CREDIT } =
    await import('../src/domain/ledger.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  await fake.close();
});

/** An onboarded outlet with one pending order on it. */
async function anOrder({ amountPaisa = 85_00, memo = 'Rice, dal, egg' } = {}) {
  const outlet = await makeMerchant();
  await onboardMerchant(outlet.merchantId);
  const order = await raiseOrder({
    operatorUserId: outlet.operator.id,
    amountPaisa,
    memo,
  });
  return { outlet, order };
}

/* ------------------------------------------------------------------ happy path */

describe('paying an order online', () => {
  test('opens a gateway session against the order, not a wallet top-up', async () => {
    const { order } = await anOrder();
    const student = await makeUser();

    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });

    // The order reference is embedded so an operator reading the gateway's own dashboard
    // can tell which order a payment belongs to.
    expect(session.tran_id).toContain(order.order_ref);
    expect(session.gateway_url).toContain('/checkout/');
    expect(session.amount_paisa).toBe(85_00);
    expect(session.methods).toEqual(expect.arrayContaining(['bKash', 'Nagad']));
  });

  test('a validated payment settles the order and posts to the ledger', async () => {
    const { outlet, order } = await anOrder();
    const student = await makeUser();

    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    const out = await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    expect(out.settled).toBe(true);

    const charge = (await query('SELECT status, paid_at FROM charges WHERE token = $1', [order.token])).rows[0];
    expect(charge.status).toBe('paid');
    expect(charge.paid_at).not.toBeNull();

    // Raising the order debited receivable 8500; paying it credits the same 8500 back.
    const receivable = await balanceOfAccount(ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name).code);
    expect(Number(receivable.balance_paisa)).toBe(0);

    // The money sits in CLEARING, not BANK — the gateway is holding it, not the university.
    const clearing = await balanceOfAccount(ACCOUNTS.gatewayClearing('sslcommerz').code);
    expect(Number(clearing.balance_paisa)).toBe(85_00);
  });

  test('NOTHING is credited to any wallet — the university holds no balance', async () => {
    const { order } = await anOrder();
    const student = await makeUser({ balancePaisa: 0 });

    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const wallets = await query('SELECT COALESCE(SUM(balance_paisa),0)::bigint AS total FROM wallets');
    expect(Number(wallets.rows[0].total)).toBe(0);
  });

  test('the books still balance after an online payment', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const tb = await trialBalance();
    expect(Number(tb.drift_paisa)).toBe(0);
  });

  test("the gateway's fee is recorded as an expense, not silently absorbed", async () => {
    const { order } = await anOrder({ amountPaisa: 100_00 });
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });

    // SSLCommerz will pay out ৳97.50 of the ৳100 collected — a ৳2.50 commission.
    fake.state.storeAmountTaka = 97.5;
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const fee = await balanceOfAccount(ACCOUNTS.gatewayFee('sslcommerz').code);
    expect(Number(fee.balance_paisa)).toBe(250);

    // Clearing holds only what will actually arrive.
    const clearing = await balanceOfAccount(ACCOUNTS.gatewayClearing('sslcommerz').code);
    expect(Number(clearing.balance_paisa)).toBe(97_50);
  });
});

/* ------------------------------------------------------- the failure paths that matter */

describe('the redirect and the IPN racing', () => {
  /**
   * On Bangladeshi mobile data the browser redirect frequently never arrives, so the IPN
   * is the path that actually works — and both can land at once.
   */
  test('settling twice credits the order once', async () => {
    const { outlet, order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    const valId = fake.valIdFor(session.tran_id);

    const first = await confirmOrderPayment({ valId });
    const second = await confirmOrderPayment({ valId });

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
    expect(second.replayed).toBe(true);

    const clearing = await balanceOfAccount(ACCOUNTS.gatewayClearing('sslcommerz').code);
    expect(Number(clearing.balance_paisa)).toBe(85_00); // not 17000

    const receivable = await balanceOfAccount(ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name).code);
    expect(Number(receivable.balance_paisa)).toBe(0);
  });

  test('concurrent confirmations settle exactly once', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    const valId = fake.valIdFor(session.tran_id);

    const results = await Promise.allSettled([
      confirmOrderPayment({ valId }),
      confirmOrderPayment({ valId }),
    ]);
    const settled = results.filter((r) => r.status === 'fulfilled' && r.value.settled);
    expect(settled).toHaveLength(1);

    const rows = await query("SELECT COUNT(*)::int AS n FROM order_payments WHERE status = 'PAID'");
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('tampering', () => {
  /**
   * The whole security boundary. A student could open an ৳85 session, edit the redirect,
   * and claim a ৳10,000 order was paid — only the gateway's own number counts.
   */
  test('an amount the gateway did not settle is refused', async () => {
    const { order } = await anOrder({ amountPaisa: 85_00 });
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });

    fake.state.amountOverrideTaka = 10; // gateway says ৳10 was paid, order expects ৳85
    await expect(confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) }))
      .rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });

    const charge = (await query('SELECT status FROM charges WHERE token = $1', [order.token])).rows[0];
    expect(charge.status).toBe('pending');
  });

  test('a mismatch is RECORDED, not discarded — it is a refund conversation', async () => {
    const { order } = await anOrder({ amountPaisa: 85_00 });
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });

    fake.state.amountOverrideTaka = 10;
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) }).catch(() => {});

    const { payments } = await paymentsForOrder(order.token);
    expect(payments[0].status).toBe('MISMATCH');
    expect(Number(payments[0].gateway_amount_paisa)).toBe(10_00);
    expect(payments[0].note).toMatch(/1000 paisa but the order is 8500/);
  });

  test('a failed validation settles nothing', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });

    fake.state.failValidation = true;
    await expect(confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_VALID' });

    const tb = await trialBalance();
    expect(Number(tb.drift_paisa)).toBe(0);
  });

  test('an unknown transaction is refused', async () => {
    await expect(confirmOrderPayment({ valId: 'VAL-NOPE-NOT-REAL' }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_VALID' });
  });
});

describe('refusing to start a payment that cannot succeed', () => {
  test('an already-paid order cannot be paid again', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    await expect(startOrderPayment({ token: order.token, payerUserId: student.id }))
      .rejects.toMatchObject({ code: 'ALREADY_PAID' });
  });

  test('a second session is refused while one is still open', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    await startOrderPayment({ token: order.token, payerUserId: student.id });

    await expect(startOrderPayment({ token: order.token, payerUserId: student.id }))
      .rejects.toMatchObject({ code: 'PAYMENT_IN_PROGRESS' });
  });

  test('abandoning a session frees the order for a fresh attempt', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    const first = await startOrderPayment({ token: order.token, payerUserId: student.id });

    await closeOrderPayment({ tranId: first.tran_id, status: 'CANCELLED', note: 'student went back' });

    const second = await startOrderPayment({ token: order.token, payerUserId: student.id });
    expect(second.tran_id).not.toBe(first.tran_id);
  });

  test('an expired order cannot be paid', async () => {
    const { order } = await anOrder();
    const student = await makeUser();
    await query("UPDATE charges SET expires_at = now() - interval '1 minute' WHERE token = $1", [order.token]);

    await expect(startOrderPayment({ token: order.token, payerUserId: student.id }))
      .rejects.toMatchObject({ code: 'ORDER_EXPIRED' });
  });

  test('an unknown order code is refused', async () => {
    const student = await makeUser();
    await expect(startOrderPayment({ token: 'not-a-real-token', payerUserId: student.id }))
      .rejects.toMatchObject({ code: 'NO_ORDER' });
  });
});

/* --------------------------------------------------- reconciliation must stay honest */

describe('reconciliation sees an online payment as settled', () => {
  /**
   * The views decided "settled" by settlement_line_id, which only the acquirer's next-day
   * statement supplies. Without the repair in migration 010, an order paid online would sit
   * in "sold but never paid for" forever and the exception list would fill with false
   * alarms until nobody read it.
   */
  test('a paid order leaves the unsettled-orders exception list', async () => {
    const { order } = await anOrder();
    const student = await makeUser();

    const before = await query('SELECT COUNT(*)::int AS n FROM reconciliation_unsettled_orders');
    expect(before.rows[0].n).toBe(1);

    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const after = await query('SELECT COUNT(*)::int AS n FROM reconciliation_unsettled_orders');
    expect(after.rows[0].n).toBe(0);
  });

  test('the per-outlet summary counts it as settled', async () => {
    const { outlet, order } = await anOrder();
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const row = (await query(
      'SELECT * FROM reconciliation_summary WHERE merchant_id = $1', [outlet.merchantId]
    )).rows[0];
    expect(Number(row.orders_settled)).toBe(1);
    expect(Number(row.orders_unsettled)).toBe(0);
    expect(Number(row.unsettled_paisa)).toBe(0);
  });

  test('money the gateway still holds is visible', async () => {
    const { order } = await anOrder({ amountPaisa: 100_00 });
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    fake.state.storeAmountTaka = 97.5;
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const row = (await query("SELECT * FROM gateway_clearing_outstanding WHERE gateway = 'sslcommerz'")).rows[0];
    expect(Number(row.payment_count)).toBe(1);
    expect(Number(row.gross_paisa)).toBe(100_00);
    expect(Number(row.fee_paisa)).toBe(250);
  });
});

/* --------------------------------------- an abandoned session that pays anyway, late */

describe('a second gateway session settling after the order is already paid', () => {
  /**
   * The student opens session A, gives up on it, pays with session B — and then A completes
   * at the gateway anyway and its IPN lands. Both are real money.
   *
   * Without a DUPLICATE status this would try to mark A as PAID, violate the "one PAID
   * payment per order" index, and surface as a raw constraint error — which the IPN handler
   * reads as transient, so SSLCommerz would retry it forever.
   */
  async function twoSessionsOnePaid() {
    const { outlet, order } = await anOrder({ amountPaisa: 85_00 });
    const student = await makeUser();

    const a = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await closeOrderPayment({ tranId: a.tran_id, status: 'CANCELLED', note: 'student gave up' });

    const b = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(b.tran_id) });

    // Session A was abandoned but the gateway completed it anyway; put it back in play.
    await query("UPDATE order_payments SET status = 'INITIATED' WHERE tran_id = $1", [a.tran_id]);
    return { outlet, order, a, b };
  }

  test('is refused with a clear code, not a constraint violation', async () => {
    const { a } = await twoSessionsOnePaid();
    await expect(confirmOrderPayment({ valId: fake.valIdFor(a.tran_id) }))
      .rejects.toMatchObject({ code: 'ALREADY_SETTLED' });
  });

  test('is recorded as DUPLICATE with the refund owed', async () => {
    const { order, a } = await twoSessionsOnePaid();
    await confirmOrderPayment({ valId: fake.valIdFor(a.tran_id) }).catch(() => {});

    const { payments } = await paymentsForOrder(order.token);
    const dup = payments.find((p) => p.tran_id === a.tran_id);
    expect(dup.status).toBe('DUPLICATE');
    expect(Number(dup.gateway_amount_paisa)).toBe(85_00);
    expect(dup.note).toMatch(/refund is owed/);
  });

  test('the receivable is not credited twice and the books balance', async () => {
    const { outlet, a } = await twoSessionsOnePaid();
    await confirmOrderPayment({ valId: fake.valIdFor(a.tran_id) }).catch(() => {});

    const receivable = await balanceOfAccount(ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name).code);
    expect(Number(receivable.balance_paisa)).toBe(0);

    const clearing = await balanceOfAccount(ACCOUNTS.gatewayClearing('sslcommerz').code);
    expect(Number(clearing.balance_paisa)).toBe(85_00); // one payment's worth, not two

    const tb = await trialBalance();
    expect(Number(tb.drift_paisa)).toBe(0);
  });
});

/* ------------------------------------------------ paying twice, on two different rails */

describe('an order paid online, then ALSO settled by the Bangla QR statement', () => {
  /**
   * The student really has paid twice: once through the gateway, once by scanning the
   * counter's QR. Both are real money.
   *
   * Without this guard the importer would match the statement line and post a SECOND
   * settlement, crediting the receivable twice and driving it negative. The trial balance
   * would still PASS — each posting is internally balanced — so only the next morning's
   * cross-check would notice, by which time the money is banked and a student is owed a
   * refund nobody logged.
   */
  let importSettlement;

  beforeAll(async () => {
    ({ importSettlement } = await import('../src/domain/reconciliation.js'));
  });

  async function paidOnlineOrder() {
    const { outlet, order } = await anOrder({ amountPaisa: 85_00 });
    const student = await makeUser();
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });
    return { outlet, order };
  }

  /** Import one acquirer line naming the given order reference. */
  function statementFor(orderRef, { txnId = 'UCB-DOUBLE-1', grossPaisa = 85_00 } = {}) {
    return importSettlement({
      acquirer: 'UCB',
      sourceRef: 'double-pay-test.csv',
      statementDate: '2026-07-26',
      rawContent: `${txnId},${orderRef},85.00,0.00`,
      lines: [{ acquirer_txn_id: txnId, order_ref: orderRef, gross_paisa: grossPaisa, fee_paisa: 0 }],
    });
  }

  test('the statement line settles nothing', async () => {
    const { order } = await paidOnlineOrder();
    const out = await statementFor(order.order_ref);

    expect(out.matched_count).toBe(0);
    expect(out.exception_count).toBe(1);
  });

  test('it is recorded as DUPLICATE_REF, naming the payment that already cleared it', async () => {
    const { order } = await paidOnlineOrder();
    await statementFor(order.order_ref);

    const line = (await query(
      'SELECT status, note FROM settlement_lines WHERE order_ref = $1', [order.order_ref]
    )).rows[0];

    expect(line.status).toBe('DUPLICATE_REF');
    expect(line.note).toMatch(/already paid online via sslcommerz/);
    expect(line.note).toMatch(/PUCORD-/);           // the earlier transaction, so it is traceable
    expect(line.note).toMatch(/refund is owed/);     // and the action required is explicit
  });

  test('the receivable is NOT credited twice', async () => {
    const { outlet, order } = await paidOnlineOrder();
    await statementFor(order.order_ref);

    // Raised +8500, cleared once by the online payment. A second credit would make it -8500.
    const receivable = await balanceOfAccount(ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name).code);
    expect(Number(receivable.balance_paisa)).toBe(0);
  });

  test('the books still balance and the order stays paid exactly once', async () => {
    const { order } = await paidOnlineOrder();
    await statementFor(order.order_ref);

    const tb = await trialBalance();
    expect(Number(tb.drift_paisa)).toBe(0);

    const charge = (await query(
      'SELECT status, settlement_line_id FROM charges WHERE order_ref = $1', [order.order_ref]
    )).rows[0];
    expect(charge.status).toBe('paid');
    // Never linked to the duplicate line — it was cleared by the gateway, not by this.
    expect(charge.settlement_line_id).toBeNull();
  });
});

/* ------------------------------------------- regression: the ledger atomicity bug */

describe('a ledger posting commits with its caller, not on its own', () => {
  /**
   * withTransaction() is NOT re-entrant — it takes a fresh connection each call. So post()
   * used to open a SECOND transaction that committed independently: if the caller then
   * failed, its work rolled back while the posting survived, leaving a receivable for an
   * order that never existed. The trial balance still balanced (the posting is internally
   * balanced), so the nightly audit PASSED while the cross-check reported a phantom.
   *
   * 300 tests missed it because triggering it needs the caller to fail AFTER a successful
   * post, which no happy-path test does. This test does exactly that.
   */
  test('a posting made inside a failed transaction does not survive', async () => {
    const outlet = await makeMerchant();
    const key = 'rollback-regression-001';

    await expect(withTransaction(async (client) => {
      await post({
        client,
        idempotencyKey: key,
        kind: 'ROLLBACK_TEST',
        entries: [
          { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: DEBIT, amountPaisa: 500 },
          { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 500 },
        ],
      });
      throw new Error('caller failed after posting');
    })).rejects.toThrow('caller failed after posting');

    const rows = await query('SELECT COUNT(*)::int AS n FROM ledger_postings WHERE idempotency_key = $1', [key]);
    expect(rows.rows[0].n).toBe(0);

    const tb = await trialBalance();
    expect(Number(tb.drift_paisa)).toBe(0);
  });

  test('without a caller transaction it still commits on its own', async () => {
    const outlet = await makeMerchant();
    const { posting } = await post({
      idempotencyKey: 'standalone-posting-001',
      kind: 'STANDALONE_TEST',
      entries: [
        { account: ACCOUNTS.orderReceivable(outlet.merchantId, outlet.name), direction: DEBIT, amountPaisa: 500 },
        { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 500 },
      ],
    });
    expect(posting.id).toBeDefined();

    const rows = await query('SELECT COUNT(*)::int AS n FROM ledger_postings WHERE idempotency_key = $1',
      ['standalone-posting-001']);
    expect(rows.rows[0].n).toBe(1);
  });
});
