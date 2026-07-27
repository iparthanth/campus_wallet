import { startFakeSsl } from './fake-sslcommerz.js';

// Config reads env at import time, so the fake's URL must be set before the modules load.
let fake, api, makeUser, balanceOf, resetDb, closeDb, query, startSslTopup, completeSslTopup;

beforeAll(async () => {
  // The closed-loop DEMO path. Transfers and top-ups move an internally-held balance,
  // which production refuses to do — holding student money is issuing a prepaid payment
  // instrument (PSS Act 2024 s.15(1)). This suite opts in explicitly so the legacy path
  // stays covered while the production default is zero_float. The mode is read at import
  // time, so modules load after the environment is set.
  process.env.WALLET_MODE = 'closed_loop';
  fake = await startFakeSsl();
  process.env.SSL_BASE_URL = fake.baseUrl;
  process.env.SSL_STORE_ID = 'testbox';
  process.env.SSL_STORE_PASSWORD = 'qwerty';

  ({ api, makeUser, balanceOf, resetDb, closeDb } = await import('./helpers.js'));
  ({ query } = await import('../src/db/pool.js'));
  ({ startSslTopup, completeSslTopup } = await import('../src/domain/sslTopup.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  await fake.close();
});

describe('SSLCommerz top-up — happy path', () => {
  test('a validated payment credits the wallet exactly once', async () => {
    const user = await makeUser({ balancePaisa: 100_00 });

    const session = await startSslTopup({ userId: user.id, amountPaisa: 500_00 });
    expect(session.tranId).toMatch(/^CW-/);
    expect(session.gatewayUrl).toContain('/checkout/');
    expect(session.methods).toEqual(expect.arrayContaining(['bKash', 'Nagad']));

    const result = await completeSslTopup({ valId: fake.valIdFor(session.tranId) });
    expect(result.credited).toBe(true);
    expect(await balanceOf(user.id)).toBe(600_00); // 100 + 500
  });

  test('the top-up records the provider and the gateway transaction id', async () => {
    const user = await makeUser();
    const session = await startSslTopup({ userId: user.id, amountPaisa: 250_00 });
    await completeSslTopup({ valId: fake.valIdFor(session.tranId) });

    const row = (await query('SELECT provider, method, status, val_id FROM topups WHERE payment_id = $1', [session.tranId])).rows[0];
    expect(row).toMatchObject({ provider: 'sslcommerz', status: 'completed' });
    expect(row.method).toBeTruthy();
    expect(row.val_id).toBeTruthy();
  });
});

describe('SSLCommerz top-up — the paths that protect the money', () => {
  test('the credited amount is checked against what the gateway settled', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const session = await startSslTopup({ userId: user.id, amountPaisa: 100_00 });

    // Student opened a ৳100 session but the gateway reports a ৳10,000 settlement —
    // a tampered return. The amounts must not match, so nothing is credited.
    fake.state.amountOverrideTaka = 10_000;

    await expect(completeSslTopup({ valId: fake.valIdFor(session.tranId) }))
      .rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('a duplicate validation does not credit twice', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const session = await startSslTopup({ userId: user.id, amountPaisa: 300_00 });

    const first = await completeSslTopup({ valId: fake.valIdFor(session.tranId) });
    const replay = await completeSslTopup({ valId: fake.valIdFor(session.tranId) }); // IPN + redirect race

    expect(first.credited).toBe(true);
    expect(replay.credited).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await balanceOf(user.id)).toBe(300_00); // once, not 600
  });

  test('a failed validation credits nothing', async () => {
    const user = await makeUser({ balancePaisa: 50_00 });
    const session = await startSslTopup({ userId: user.id, amountPaisa: 400_00 });

    fake.state.failValidation = true;
    await expect(completeSslTopup({ valId: fake.valIdFor(session.tranId) }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_VALID' });
    expect(await balanceOf(user.id)).toBe(50_00);
  });

  test('an invalid amount is refused before a session is opened', async () => {
    const user = await makeUser();
    await expect(startSslTopup({ userId: user.id, amountPaisa: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(startSslTopup({ userId: user.id, amountPaisa: -100 }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  test('validation for an unknown transaction is rejected', async () => {
    await expect(completeSslTopup({ valId: 'VAL-CW-does-not-exist' }))
      .rejects.toMatchObject({ status: expect.any(Number) });
  });
});

describe('SSLCommerz top-up — full request flow through the API', () => {
  const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

  test('POST /topup/ssl/create returns a gateway url', async () => {
    const user = await makeUser();
    const res = await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 200_00 });
    expect(res.status).toBe(201);
    expect(res.body.gatewayUrl).toContain('/checkout/');
  });

  test('the server-to-server IPN credits the wallet', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const create = await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 150_00 });

    const ipn = await api().post('/topup/ssl/ipn').type('form').send({ val_id: fake.valIdFor(create.body.tranId) });
    expect(ipn.status).toBe(200);
    expect(ipn.body.credited).toBe(true);
    expect(await balanceOf(user.id)).toBe(150_00);
  });

  test('the browser return redirects into the app after crediting', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const create = await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 175_00 });

    const ret = await api().post('/topup/ssl/return').type('form')
      .send({ val_id: fake.valIdFor(create.body.tranId), status: 'VALID' })
      .redirects(0);
    expect(ret.status).toBe(302);
    expect(ret.headers.location).toContain('topup=success');
    expect(await balanceOf(user.id)).toBe(175_00);
  });

  test('a cancelled return redirects without crediting', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    await api().post('/topup/ssl/create').set(auth(user)).send({ amount_paisa: 90_00 });

    const ret = await api().post('/topup/ssl/return').type('form')
      .send({ status: 'CANCELLED' }).redirects(0);
    expect(ret.status).toBe(302);
    expect(ret.headers.location).toContain('topup=cancelled');
    expect(await balanceOf(user.id)).toBe(0);
  });
});
