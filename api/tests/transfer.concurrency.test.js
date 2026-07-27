import { api, makeUser, balanceOf, resetDb, closeDb } from './helpers.js';

beforeEach(resetDb);
afterAll(closeDb);

/**
 * INVARIANT tests, not the correctness proof.
 *
 * Honest limitation: firing two requests with Promise.all does NOT reliably produce a
 * race inside the database — the first transaction usually commits before the second
 * even issues its SELECT. I verified this by deleting FOR UPDATE from transfer.js and
 * watching these tests still pass.
 *
 * The deterministic proof lives in lock.semantics.test.js, which forces the interleaving
 * with two controlled connections and fails (500 instead of 422) when the lock is removed.
 *
 * These remain valuable: they assert the invariants that must hold under ANY interleaving —
 * money is conserved, balances never go negative, and an over-draw is refused.
 */
describe('concurrent double-spend prevention', () => {
  test('two simultaneous transfers of 60% of balance: exactly one succeeds', async () => {
    const START = 1000_00; // ৳1000 in paisa
    const AMOUNT = 600_00; // 60% — two of these cannot both fit

    const sender = await makeUser({ balancePaisa: START });
    const recipient = await makeUser();

    // Fire both at the same instant, on separate connections from the pool.
    const [a, b] = await Promise.all([
      api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
        .send({ to_email: recipient.email, amount_paisa: AMOUNT }),
      api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
        .send({ to_email: recipient.email, amount_paisa: AMOUNT }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);

    const failed = a.status === 422 ? a : b;
    expect(failed.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // The money is the real assertion: exactly one transfer moved.
    expect(await balanceOf(sender.id)).toBe(START - AMOUNT);
    expect(await balanceOf(recipient.id)).toBe(AMOUNT);
  });

  test('ten simultaneous transfers drain the balance exactly, never below zero', async () => {
    const START = 500_00;
    const AMOUNT = 100_00; // only 5 of 10 can succeed

    const sender = await makeUser({ balancePaisa: START });
    const recipient = await makeUser();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
          .send({ to_email: recipient.email, amount_paisa: AMOUNT })
      )
    );

    const succeeded = results.filter((r) => r.status === 201).length;
    expect(succeeded).toBe(5);
    expect(await balanceOf(sender.id)).toBe(0);
    expect(await balanceOf(recipient.id)).toBe(START);
  });

  test('opposite-direction transfers do not deadlock (ascending lock order)', async () => {
    const alice = await makeUser({ balancePaisa: 1000_00 });
    const bob = await makeUser({ balancePaisa: 1000_00 });

    // A->B and B->A at once. With unordered locking this can deadlock; with ascending
    // wallet-id ordering both transactions queue on the same lock first.
    const [r1, r2] = await Promise.all([
      api().post('/transfers').set('Authorization', `Bearer ${alice.token}`)
        .send({ to_email: bob.email, amount_paisa: 100_00 }),
      api().post('/transfers').set('Authorization', `Bearer ${bob.token}`)
        .send({ to_email: alice.email, amount_paisa: 100_00 }),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await balanceOf(alice.id)).toBe(1000_00);
    expect(await balanceOf(bob.id)).toBe(1000_00);
  });
});

describe('idempotency', () => {
  test('replaying the same idempotency_key never debits twice', async () => {
    const sender = await makeUser({ balancePaisa: 500_00 });
    const recipient = await makeUser();
    const key = 'idem-key-abcdef123456';

    const first = await api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: 100_00, idempotency_key: key });
    const replay = await api().post('/transfers').set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: 100_00, idempotency_key: key });

    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.transaction.id).toBe(first.body.transaction.id);

    expect(await balanceOf(sender.id)).toBe(400_00); // debited once
    expect(await balanceOf(recipient.id)).toBe(100_00);
  });
});
