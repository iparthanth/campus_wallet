import { startFakeSsl } from './fake-sslcommerz.js';

/**
 * The university must not hold student money — enforced, not merely claimed.
 *
 * THE BUG THESE TESTS EXIST TO PREVENT RECURRING
 *
 * The zero-float architecture was added ALONGSIDE the closed-loop one instead of replacing
 * it, and only payCharge and settlement ever checked the mode. So a PRODUCTION deployment
 * running WALLET_MODE=zero_float — while its handover document promised the Registrar that
 * "the university never holds student money at any point" — still let a student top up a
 * balance, hold it, and transfer it to another student.
 *
 * That is issuing a prepaid payment instrument under the Payment and Settlement Systems Act
 * 2024 s.15(1), and it was live on the internet. The boot guard in config.js refuses the
 * wrong MODE; it never stopped the wrong OPERATIONS.
 *
 * Every refusal below is asserted at the DOMAIN layer and again over HTTP, because hiding a
 * button is presentation and a route is still reachable by curl.
 */
let fake, api, makeUser, makeMerchant, onboardMerchant, resetDb, closeDb, query;
let transfer, startTopup, completeTopup, reconcileTopup, startSslTopup, completeSslTopup;
let raiseOrder, startOrderPayment, confirmOrderPayment, myPayments, holdsBalances;

beforeAll(async () => {
  fake = await startFakeSsl();
  process.env.SSL_BASE_URL = fake.baseUrl;
  process.env.SSL_STORE_ID = 'testbox';
  process.env.SSL_STORE_PASSWORD = 'qwerty';
  // The lawful mode. Explicit rather than relying on the default, so this file states the
  // condition it is testing.
  process.env.WALLET_MODE = 'zero_float';

  ({ api, makeUser, makeMerchant, onboardMerchant, resetDb, closeDb } = await import('./helpers.js'));
  ({ query } = await import('../src/db/pool.js'));
  ({ transfer } = await import('../src/domain/transfer.js'));
  ({ startTopup, completeTopup, reconcileTopup } = await import('../src/domain/topup.js'));
  ({ startSslTopup, completeSslTopup } = await import('../src/domain/sslTopup.js'));
  ({ raiseOrder } = await import('../src/domain/order.js'));
  ({ startOrderPayment, confirmOrderPayment, myPayments } = await import('../src/domain/orderPayment.js'));
  ({ holdsBalances } = await import('../src/domain/custody.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  await fake.close();
  delete process.env.WALLET_MODE;
});

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

describe('the deployment declares it holds nothing', () => {
  test('holdsBalances() is false in zero_float', () => {
    expect(holdsBalances()).toBe(false);
  });
});

describe('moving an internally-held balance is refused', () => {
  test('student-to-student transfer', async () => {
    const alice = await makeUser({ balancePaisa: 1000_00 });
    const bob = await makeUser();

    await expect(transfer({
      fromUserId: alice.id, toEmail: bob.email, amountPaisa: 100_00, idempotencyKey: 'k-1',
    })).rejects.toMatchObject({ code: 'ZERO_FLOAT' });
  });

  test('and no money moved when it was refused', async () => {
    const alice = await makeUser({ balancePaisa: 1000_00 });
    const bob = await makeUser({ balancePaisa: 0 });

    await transfer({ fromUserId: alice.id, toEmail: bob.email, amountPaisa: 100_00, idempotencyKey: 'k-2' })
      .catch(() => {});

    const total = await query('SELECT COALESCE(SUM(balance_paisa),0)::bigint AS t FROM wallets');
    expect(Number(total.rows[0].t)).toBe(1000_00);       // unchanged
    const txs = await query('SELECT COUNT(*)::int AS n FROM transactions');
    expect(txs.rows[0].n).toBe(0);                        // and nothing recorded
  });

  test('bKash top-up: start, complete and reconcile', async () => {
    const user = await makeUser();
    for (const call of [
      () => startTopup({ userId: user.id, amountPaisa: 500_00 }),
      () => completeTopup({ paymentID: 'anything' }),
      () => reconcileTopup({ paymentID: 'anything' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'ZERO_FLOAT' });
    }
  });

  test('SSLCommerz top-up: start and complete', async () => {
    const user = await makeUser();
    await expect(startSslTopup({ userId: user.id, amountPaisa: 500_00 }))
      .rejects.toMatchObject({ code: 'ZERO_FLOAT' });
    await expect(completeSslTopup({ valId: 'anything' }))
      .rejects.toMatchObject({ code: 'ZERO_FLOAT' });
  });
});

describe('the HTTP routes are closed too, not just the UI', () => {
  /*
   * The screen no longer shows a Top up button. That is presentation. These assertions are
   * the control — a hidden button is still a reachable route.
   */
  test('POST /transfers is refused', async () => {
    const alice = await makeUser({ balancePaisa: 1000_00 });
    const bob = await makeUser();
    const res = await api().post('/transfers').set(auth(alice))
      // ≥8 chars, or zod rejects it as VALIDATION before the custody rule is ever reached —
      // which would make this test pass for the wrong reason if it asserted "not 200".
      .send({ to_email: bob.email, amount_paisa: 100_00, idempotency_key: 'http-transfer-1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ZERO_FLOAT');
  });

  test('POST /topup/ssl/create is refused', async () => {
    const user = await makeUser();
    const res = await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 500_00 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ZERO_FLOAT');
  });

  test('the refusal explains what to do instead', async () => {
    const user = await makeUser();
    const res = await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 500_00 });
    // A 409 that only says "no" teaches a student nothing about how to pay.
    expect(res.body.error.message).toMatch(/does not hold balances/);
    expect(res.body.error.message).toMatch(/pay each order/);
  });
});

describe('what a student gets INSTEAD of a balance', () => {
  /*
   * Removing the balance is the compliance fix. This is the part that stops it being a
   * downgrade: a balance answered "how much have I got"; these answer "what did I pay, to
   * whom, and what proves it" — the questions that matter at a counter.
   */
  async function paidOrder(student, { amountPaisa = 85_00, memo = 'Rice, dal, egg' } = {}) {
    const outlet = await makeMerchant();
    await onboardMerchant(outlet.merchantId);
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa, memo });
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });
    return { outlet, order };
  }

  test('a paid order appears in the student’s own history with its reference', async () => {
    const student = await makeUser();
    const { order } = await paidOrder(student);

    const { payments, totals } = await myPayments(student.id);
    expect(payments).toHaveLength(1);
    expect(payments[0].order_ref).toBe(order.order_ref);
    expect(payments[0].status).toBe('PAID');
    expect(payments[0].merchant_name).toBe('Central Canteen');
    expect(payments[0].memo).toBe('Rice, dal, egg');
    expect(totals.paid_paisa).toBe(85_00);
  });

  test('one student never sees another’s payments', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await paidOrder(alice);

    const mine = await myPayments(bob.id);
    expect(mine.payments).toHaveLength(0);
    expect(mine.totals.paid_paisa).toBe(0);
  });

  test('GET /me/payments is scoped to the caller and takes no user id', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await paidOrder(alice);

    const asBob = await api().get('/me/payments').set(auth(bob));
    expect(asBob.status).toBe(200);
    expect(asBob.body.payments).toHaveLength(0);

    // Even asked nicely for someone else's, it answers with the caller's own.
    const spoof = await api().get(`/me/payments?user_id=${alice.id}`).set(auth(bob));
    expect(spoof.body.payments).toHaveLength(0);
  });

  test('an unconfirmed payment is shown as in-flight, not as paid', async () => {
    const student = await makeUser();
    const outlet = await makeMerchant();
    await onboardMerchant(outlet.merchantId);
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 40_00 });
    await startOrderPayment({ token: order.token, payerUserId: student.id });

    const { totals, in_flight: inFlight } = await myPayments(student.id);
    // Counting it as paid would tell a student they had paid while the gateway may still
    // decline; hiding it entirely invites them to pay the same order twice.
    expect(totals.paid_paisa).toBe(0);
    expect(totals.paid_count).toBe(0);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].order_ref).toBe(order.order_ref);
  });

  test('the total counts what the gateway settled, not what was asked for', async () => {
    const student = await makeUser();
    const outlet = await makeMerchant();
    await onboardMerchant(outlet.merchantId);
    const order = await raiseOrder({ operatorUserId: outlet.operator.id, amountPaisa: 100_00 });
    const session = await startOrderPayment({ token: order.token, payerUserId: student.id });
    fake.state.storeAmountTaka = 97.5;                    // gateway keeps ৳2.50
    await confirmOrderPayment({ valId: fake.valIdFor(session.tran_id) });

    const { totals } = await myPayments(student.id);
    expect(totals.paid_paisa).toBe(100_00);               // the student paid ৳100
  });

  test('a payment record outlives the student account that made it', async () => {
    const student = await makeUser();
    await paidOrder(student);

    // ON DELETE SET NULL, not CASCADE: deleting a person must not delete evidence money moved.
    await query('DELETE FROM users WHERE id = $1', [student.id]);
    const rows = await query("SELECT payer_user_id, status FROM order_payments WHERE status = 'PAID'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].payer_user_id).toBeNull();
  });
});
