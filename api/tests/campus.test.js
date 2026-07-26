import { jest } from '@jest/globals';

jest.setTimeout(30_000);

/**
 * The LEGACY closed-loop counter flow: the student pays from a balance this system holds.
 *
 * That mode is a demonstration only and production refuses to boot in it — holding
 * student balances is issuing a prepaid payment instrument under the Payment and
 * Settlement Systems Act 2024 s.15(1). The lawful counter flow is orders paid over
 * Bangla QR; see order.test.js and orders.api.test.js.
 *
 * This file opts INTO closed_loop explicitly rather than relying on a default, so the
 * legacy path stays covered while the production default is zero_float. The mode is read
 * at import time, so modules load after the environment is set.
 */
let api, makeUser, balanceOf, resetDb, closeDb, query;

beforeAll(async () => {
  process.env.WALLET_MODE = 'closed_loop';
  ({ api, makeUser, balanceOf, resetDb, closeDb } = await import('./helpers.js'));
  ({ query } = await import('../src/db/pool.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  delete process.env.WALLET_MODE;
});

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

/** Make a user into the operator of a campus outlet. */
async function makeOutlet(name = 'Central Canteen', category = 'canteen') {
  const operator = await makeUser();
  const wallet = (await query('SELECT id FROM wallets WHERE user_id = $1', [operator.id])).rows[0];
  await query(
    'INSERT INTO merchants (name, category, wallet_id, operator_id) VALUES ($1,$2,$3,$4)',
    [name, category, wallet.id, operator.id]
  );
  return operator;
}

async function raiseCharge(operator, amountPaisa, memo = 'Lunch') {
  const res = await api().post('/merchant/charges').set(auth(operator))
    .send({ amount_paisa: amountPaisa, memo });
  expect(res.status).toBe(201);
  return res.body;
}

describe('campus payments — the counter flow', () => {
  test('a student scans a canteen QR and pays; money lands in the outlet wallet', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 500_00 });

    const charge = await raiseCharge(canteen, 85_00, 'Rice, dal, egg');
    expect(charge.qr_payload).toBe(`campuswallet://pay/${charge.token}`);

    // What the student sees after scanning, before agreeing.
    const preview = await api().get(`/charges/${charge.token}`).set(auth(student));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ amount_paisa: 85_00, merchant_name: 'Central Canteen', status: 'pending' });

    const paid = await api().post(`/charges/${charge.token}/pay`).set(auth(student));
    expect(paid.status).toBe(200);
    expect(paid.body.paid).toBe(true);

    expect(await balanceOf(student.id)).toBe(415_00);
    expect(await balanceOf(canteen.id)).toBe(85_00);
  });

  test('money is conserved — the canteen gains exactly what the student loses', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 300_00 });
    const before = (await query('SELECT SUM(balance_paisa)::bigint AS t FROM wallets')).rows[0].t;

    const charge = await raiseCharge(canteen, 120_00);
    await api().post(`/charges/${charge.token}/pay`).set(auth(student));

    const after = (await query('SELECT SUM(balance_paisa)::bigint AS t FROM wallets')).rows[0].t;
    expect(after).toBe(before);
  });

  test('two phones scanning the same QR: exactly one payment goes through', async () => {
    const canteen = await makeOutlet();
    const a = await makeUser({ balancePaisa: 500_00 });
    const b = await makeUser({ balancePaisa: 500_00 });
    const charge = await raiseCharge(canteen, 100_00);

    const [r1, r2] = await Promise.all([
      api().post(`/charges/${charge.token}/pay`).set(auth(a)).then((r) => r),
      api().post(`/charges/${charge.token}/pay`).set(auth(b)).then((r) => r),
    ]);

    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    expect(okCount).toBe(1);
    // The canteen was paid once, not twice.
    expect(await balanceOf(canteen.id)).toBe(100_00);
    expect(await balanceOf(a.id) + await balanceOf(b.id)).toBe(900_00);
  });

  test('paying an already-paid bill is refused', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 500_00 });
    const charge = await raiseCharge(canteen, 60_00);

    await api().post(`/charges/${charge.token}/pay`).set(auth(student));
    const again = await api().post(`/charges/${charge.token}/pay`).set(auth(student));

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PAID');
    expect(await balanceOf(student.id)).toBe(440_00); // charged once
  });

  test('an expired bill cannot be paid', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 500_00 });
    const charge = await raiseCharge(canteen, 75_00);

    await query("UPDATE charges SET expires_at = now() - interval '1 minute' WHERE token = $1", [charge.token]);

    const res = await api().post(`/charges/${charge.token}/pay`).set(auth(student));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('EXPIRED');
    expect(await balanceOf(student.id)).toBe(500_00);
  });

  test('a student without enough balance is refused and nothing moves', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 40_00 });
    const charge = await raiseCharge(canteen, 85_00);

    const res = await api().post(`/charges/${charge.token}/pay`).set(auth(student));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(student.id)).toBe(40_00);
    expect(await balanceOf(canteen.id)).toBe(0);
  });

  test('an unguessable token — a made-up code is not payable', async () => {
    const student = await makeUser({ balancePaisa: 500_00 });
    const res = await api().get('/charges/not-a-real-token').set(auth(student));
    expect(res.status).toBe(404);
  });
});

describe('outlet operator permissions', () => {
  test('an ordinary student cannot raise a charge', async () => {
    const student = await makeUser({ balancePaisa: 100_00 });
    const res = await api().post('/merchant/charges').set(auth(student)).send({ amount_paisa: 50_00 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_AN_OPERATOR');
  });

  test('the counter sees its takings for the day', async () => {
    const canteen = await makeOutlet();
    const student = await makeUser({ balancePaisa: 500_00 });

    for (const amt of [50_00, 30_00]) {
      const c = await raiseCharge(canteen, amt);
      await api().post(`/charges/${c.token}/pay`).set(auth(student));
    }
    await raiseCharge(canteen, 99_00); // left open at the counter

    const res = await api().get('/merchant/summary').set(auth(canteen));
    expect(res.status).toBe(200);
    expect(Number(res.body.stats.today_paisa)).toBe(80_00);
    expect(Number(res.body.stats.today_count)).toBe(2);
    expect(Number(res.body.stats.open_count)).toBe(1);
  });

  test('an outlet cannot pay its own bill', async () => {
    const canteen = await makeOutlet();
    await query('UPDATE wallets SET balance_paisa = 500_00 WHERE user_id = $1'.replace('500_00', '50000'), [canteen.id]);
    const charge = await raiseCharge(canteen, 20_00);

    const res = await api().post(`/charges/${charge.token}/pay`).set(auth(canteen));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_PAY');
  });
});
