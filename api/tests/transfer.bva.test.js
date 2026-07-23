import { jest } from '@jest/globals';
import { api, makeUser, balanceOf, resetDb, closeDb } from './helpers.js';

jest.setTimeout(30_000);

beforeEach(resetDb);
afterAll(closeDb);

/**
 * Boundary Value Analysis on the money boundary.
 * The interesting values are not "some number" — they are 0, ±1 around the balance,
 * and the exact balance. Bugs live on boundaries, so tests live there too.
 */
describe('BVA — transfer amount boundaries', () => {
  const START = 1000_00;

  test.each([
    ['zero',                     0,             422],
    ['negative',                 -100,          422],
    ['fractional paisa (float)', 100.5,         422],
    ['one paisa (minimum valid)',1,             201],
    ['exactly the balance',      START,         201],
    ['balance plus one paisa',   START + 1,     422],
    ['above the sanity cap',     100_000_001,   422],
  ])('%s -> %i', async (_label, amount, expected) => {
    const sender = await makeUser({ balancePaisa: START });
    const recipient = await makeUser();

    const res = await api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: amount });

    expect(res.status).toBe(expected);
    if (expected === 201) {
      expect(res.body.transaction.amount_paisa).toBe(amount);
    } else {
      expect(res.body.error.code).toBeDefined();
    }
  });

  test('balance never goes negative even at the exact boundary', async () => {
    const sender = await makeUser({ balancePaisa: START });
    const recipient = await makeUser();

    await api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: START });

    expect(await balanceOf(sender.id)).toBe(0);

    const overdraft = await api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: 1 });
    expect(overdraft.status).toBe(422);
    expect(await balanceOf(sender.id)).toBe(0);
  });
});

describe('BVA — recipient and identity', () => {
  test('self-transfer is rejected', async () => {
    const user = await makeUser({ balancePaisa: 500_00 });
    const res = await api().post('/transfers').set('Authorization', `Bearer ${user.token}`)
      .send({ to_email: user.email, amount_paisa: 100_00 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SELF_TRANSFER');
    expect(await balanceOf(user.id)).toBe(500_00);
  });

  test('unknown recipient is rejected and money does not move', async () => {
    const user = await makeUser({ balancePaisa: 500_00 });
    const res = await api().post('/transfers').set('Authorization', `Bearer ${user.token}`)
      .send({ to_email: 'nobody@puc.ac.bd', amount_paisa: 100_00 });
    expect(res.status).toBe(404);
    expect(await balanceOf(user.id)).toBe(500_00);
  });

  test('unauthenticated transfer is rejected', async () => {
    const res = await api().post('/transfers').send({ to_email: 'a@puc.ac.bd', amount_paisa: 100 });
    expect(res.status).toBe(401);
  });
});
