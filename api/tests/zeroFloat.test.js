import { jest } from '@jest/globals';

jest.setTimeout(30_000);

/**
 * Zero-float mode — the configuration a real Bangladeshi campus pilot must run in.
 *
 * Holding student balances is e-money under the Payment and Settlement Systems Act 2024
 * and needs a Bangladesh Bank PSP licence (BDT 20 crore paid-up capital); operating
 * unlicensed is a non-bailable offence. So these tests assert the system REFUSES to move
 * money internally and only records payments made on licensed rails.
 *
 * The mode is read at import time, so the modules are loaded after the env is set.
 */
let api, makeUser, balanceOf, resetDb, closeDb, query;

beforeAll(async () => {
  process.env.WALLET_MODE = 'zero_float';
  ({ api, makeUser, balanceOf, resetDb, closeDb } = await import('./helpers.js'));
  ({ query } = await import('../src/db/pool.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  delete process.env.WALLET_MODE;
});

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

async function makeOutlet() {
  const operator = await makeUser();
  const wallet = (await query('SELECT id FROM wallets WHERE user_id = $1', [operator.id])).rows[0];
  await query('INSERT INTO merchants (name, category, wallet_id, operator_id) VALUES ($1,$2,$3,$4)',
    ['Central Canteen', 'canteen', wallet.id, operator.id]);
  return operator;
}

async function raiseCharge(operator, amountPaisa) {
  const res = await api().post('/merchant/charges').set(auth(operator)).send({ amount_paisa: amountPaisa });
  expect(res.status).toBe(201);
  return res.body;
}

describe('zero-float mode', () => {
  test('the deployment declares that it does not hold balances', async () => {
    const res = await api().get('/mode');
    expect(res.body).toEqual({ wallet_mode: 'zero_float', holds_balance: false });
  });

  test('paying from an internal balance is REFUSED — that would be unlicensed e-money', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 500_00 });
    const charge = await raiseCharge(canteen, 85_00);

    const res = await api().post(`/charges/${charge.token}/pay`).set(auth(student));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ZERO_FLOAT');
    expect(await balanceOf(student.id)).toBe(500_00); // untouched
    expect(await balanceOf(canteen.id)).toBe(0);
  });

  test('a payment made on licensed rails is recorded and closes the bill', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 0 }); // no float, by design
    const charge = await raiseCharge(canteen, 85_00);

    const res = await api().post(`/charges/${charge.token}/settle`).set(auth(student))
      .send({ method: 'bkash', reference: 'BKS9X72QLM' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      settled: true, method: 'bkash', reference: 'BKS9X72QLM', amount_paisa: 85_00,
    });
    // Honest: the outlet has a claim until someone matches it to a bank statement.
    expect(res.body.reconciled).toBe(false);

    const after = await api().get(`/charges/${charge.token}`).set(auth(student));
    expect(after.body.status).toBe('paid');

    // No money moved inside this system. That is the entire point.
    expect(await balanceOf(student.id)).toBe(0);
    expect(await balanceOf(canteen.id)).toBe(0);
  });

  test('one transaction id cannot close two different bills', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser();
    const a = await raiseCharge(canteen, 50_00);
    const b = await raiseCharge(canteen, 70_00);

    const first = await api().post(`/charges/${a.token}/settle`).set(auth(student))
      .send({ method: 'nagad', reference: 'NGD-4471-AA' });
    const reuse = await api().post(`/charges/${b.token}/settle`).set(auth(student))
      .send({ method: 'nagad', reference: 'NGD-4471-AA' });

    expect(first.status).toBe(200);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('REFERENCE_USED');

    const stillOpen = await api().get(`/charges/${b.token}`).set(auth(student));
    expect(stillOpen.body.status).toBe('pending');
  });

  test('the reference is normalised, so casing cannot smuggle a duplicate through', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser();
    const a = await raiseCharge(canteen, 30_00);
    const b = await raiseCharge(canteen, 40_00);

    await api().post(`/charges/${a.token}/settle`).set(auth(student))
      .send({ method: 'bkash', reference: 'abc123xyz' });
    const sneaky = await api().post(`/charges/${b.token}/settle`).set(auth(student))
      .send({ method: 'bkash', reference: 'AbC123XyZ' });

    expect(sneaky.status).toBe(409);
    expect(sneaky.body.error.code).toBe('REFERENCE_USED');
  });

  test.each([
    ['paypal', 'BAD_METHOD'],   // not a Bangladeshi rail
    ['', 'BAD_METHOD'],
  ])('method %s is rejected', async (method, code) => {
    const canteen = await makeOutlet();
    const student = await makeUser();
    const charge = await raiseCharge(canteen, 25_00);

    const res = await api().post(`/charges/${charge.token}/settle`).set(auth(student))
      .send({ method, reference: 'REF12345' });
    expect([422]).toContain(res.status);
    if (res.body.error.code !== 'VALIDATION') expect(res.body.error.code).toBe(code);
  });

  test('an expired bill cannot be settled', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser();
    const charge = await raiseCharge(canteen, 60_00);
    await query("UPDATE charges SET expires_at = now() - interval '1 minute' WHERE token = $1", [charge.token]);

    const res = await api().post(`/charges/${charge.token}/settle`).set(auth(student))
      .send({ method: 'rocket', reference: 'RKT88231' });
    expect(res.status).toBe(410);
  });

  test('settlements awaiting reconciliation are reported as such', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser();
    const charge = await raiseCharge(canteen, 95_00);
    await api().post(`/charges/${charge.token}/settle`).set(auth(student))
      .send({ method: 'bkash', reference: 'BK-PENDING-1' });

    const res = await api().get('/merchant/unreconciled').set(auth(canteen));
    expect(res.status).toBe(200);
    expect(res.body.settlements[0]).toMatchObject({ external_ref: 'BK-PENDING-1', amount_paisa: 95_00 });
  });
});
