import { jest } from '@jest/globals';
import { startFakeBkash } from './fake-bkash.js';

jest.setTimeout(30_000);

// bKash config must exist BEFORE config.js is imported, so the modules are pulled in
// dynamically after the fake server is up and the env is set.
let fake, api, makeUser, balanceOf, resetDb, closeDb, query, bkash;

beforeAll(async () => {
  fake = await startFakeBkash();
  process.env.BKASH_BASE_URL = fake.baseUrl;
  process.env.BKASH_APP_KEY = 'test-app-key';
  process.env.BKASH_APP_SECRET = 'test-app-secret';
  process.env.BKASH_USERNAME = 'test-user';
  process.env.BKASH_PASSWORD = 'test-pass';

  ({ api, makeUser, balanceOf, resetDb, closeDb } = await import('./helpers.js'));
  ({ query } = await import('../src/db/pool.js'));
  bkash = await import('../src/services/bkash.js');
});

beforeEach(async () => {
  await resetDb();
  bkash.__clearTokenCache();
});

afterAll(async () => {
  await closeDb();
  await fake.close();
});

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

async function createTopup(user, amountPaisa) {
  const res = await api().post('/topup/create').set(auth(user)).send({ amount_paisa: amountPaisa });
  expect(res.status).toBe(201);
  return res.body.paymentID;
}

describe('bKash top-up — happy path', () => {
  test('creating and executing a payment credits the wallet exactly once', async () => {
    const user = await makeUser({ balancePaisa: 100_00 });

    const paymentID = await createTopup(user, 500_00);
    const exec = await api().post('/topup/execute').set(auth(user)).send({ paymentID });

    expect(exec.status).toBe(200);
    expect(exec.body.credited).toBe(true);
    expect(await balanceOf(user.id)).toBe(600_00); // 100 + 500
  });

  test('the top-up is recorded with its bKash transaction id', async () => {
    const user = await makeUser();
    const paymentID = await createTopup(user, 250_00);
    await api().post('/topup/execute').set(auth(user)).send({ paymentID });

    const history = await api().get('/topup/history').set(auth(user));
    expect(history.status).toBe(200);
    expect(history.body.topups[0]).toMatchObject({ payment_id: paymentID, status: 'completed', amount_paisa: 250_00 });
    expect(history.body.topups[0].trx_id).toBeTruthy();
  });
});

describe('bKash top-up — the failure modes that actually happen', () => {
  test('a duplicated callback does NOT credit twice', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const paymentID = await createTopup(user, 300_00);

    const first = await api().post('/topup/execute').set(auth(user)).send({ paymentID });
    const replay = await api().post('/topup/execute').set(auth(user)).send({ paymentID });

    expect(first.body.credited).toBe(true);
    expect(replay.body.credited).toBe(false);
    expect(replay.body.replayed).toBe(true);
    expect(await balanceOf(user.id)).toBe(300_00); // credited once, not 600
  });

  test('two simultaneous callbacks credit only once', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const paymentID = await createTopup(user, 400_00);

    const [a, b] = await Promise.all([
      api().post('/topup/execute').set(auth(user)).send({ paymentID }).then((r) => r),
      api().post('/topup/execute').set(auth(user)).send({ paymentID }).then((r) => r),
    ]);

    const creditedCount = [a, b].filter((r) => r.body.credited === true).length;
    expect(creditedCount).toBe(1);
    expect(await balanceOf(user.id)).toBe(400_00);
  });

  test('a missed callback is recovered by reconciliation — the money is not lost', async () => {
    const user = await makeUser({ balancePaisa: 0 });
    const paymentID = await createTopup(user, 750_00);

    // The student pays in the bKash app, then their connection drops and the callback
    // never reaches us. Our database still says "initiated".
    fake.markPaidSilently(paymentID);
    const before = await query('SELECT status FROM topups WHERE payment_id = $1', [paymentID]);
    expect(before.rows[0].status).toBe('initiated');
    expect(await balanceOf(user.id)).toBe(0);

    // Reconciliation asks bKash what really happened and credits.
    const rec = await api().post('/topup/reconcile').set(auth(user)).send({ paymentID });
    expect(rec.status).toBe(200);
    expect(rec.body.credited).toBe(true);
    expect(await balanceOf(user.id)).toBe(750_00);

    // And reconciling again is safe.
    const again = await api().post('/topup/reconcile').set(auth(user)).send({ paymentID });
    expect(again.body.credited).toBe(false);
    expect(await balanceOf(user.id)).toBe(750_00);
  });

  test('a failed payment credits nothing and is marked failed', async () => {
    const user = await makeUser({ balancePaisa: 50_00 });
    const paymentID = await createTopup(user, 900_00);

    fake.state.failNextExecute = true;
    const res = await api().post('/topup/execute').set(auth(user)).send({ paymentID });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PAYMENT_NOT_COMPLETED');
    expect(await balanceOf(user.id)).toBe(50_00); // untouched

    const row = await query('SELECT status FROM topups WHERE payment_id = $1', [paymentID]);
    expect(row.rows[0].status).toBe('failed');
  });

  test('an unknown paymentID is a 404, not a 500 (a typo is not an outage)', async () => {
    const user = await makeUser();
    const res = await api().post('/topup/execute').set(auth(user)).send({ paymentID: 'TR-does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_PAYMENT');
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('top-up requires authentication', async () => {
    const res = await api().post('/topup/create').send({ amount_paisa: 100_00 });
    expect(res.status).toBe(401);
  });
});

describe('token handling', () => {
  test('the access token is cached, not re-granted on every call', async () => {
    const user = await makeUser();
    const grantsBefore = fake.state.tokenGrants;

    await createTopup(user, 100_00);
    await createTopup(user, 100_00);
    await createTopup(user, 100_00);

    // Three payments, one token grant — bKash locks accounts that request tokens too often.
    expect(fake.state.tokenGrants - grantsBefore).toBe(1);
  });
});
