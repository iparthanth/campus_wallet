let pool, query, makeUser, resetDb, closeDb;

beforeAll(async () => {
  // The closed-loop DEMO path. Transfers and top-ups move an internally-held balance,
  // which production refuses to do — holding student money is issuing a prepaid payment
  // instrument (PSS Act 2024 s.15(1)). This suite opts in explicitly so the legacy path
  // stays covered while the production default is zero_float. The mode is read at import
  // time, so modules load after the environment is set.
  process.env.WALLET_MODE = 'closed_loop';
  ({ pool, query } = await import('../src/db/pool.js'));
  ({ makeUser, resetDb, closeDb } = await import('./helpers.js'));
});

beforeEach(() => resetDb());
afterAll(async () => {
  await closeDb();
  delete process.env.WALLET_MODE;
});

/**
 * WHY THIS FILE EXISTS
 *
 * The HTTP-level concurrency test fires two requests with Promise.all and hopes they
 * overlap inside the database. They usually do NOT: Node's event loop often lets the
 * first transaction commit before the second one even issues its SELECT. A test that
 * only *sometimes* creates a race cannot prove the lock works — and I proved that by
 * deleting FOR UPDATE and watching the suite still pass.
 *
 * These tests drive two database connections directly and control the interleaving, so
 * the race is guaranteed rather than hoped for.
 */

async function walletIdFor(userId) {
  const r = await query('SELECT id FROM wallets WHERE user_id = $1', [userId]);
  return r.rows[0].id;
}

describe('row-lock semantics (deterministic)', () => {
  test('FOR UPDATE blocks a second transaction from reading the same row', async () => {
    const user = await makeUser({ balancePaisa: 1000_00 });
    const walletId = await walletIdFor(user.id);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT balance_paisa FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);

      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '600ms'");

      // B must NOT be able to take the same lock while A holds it.
      await expect(
        b.query('SELECT balance_paisa FROM wallets WHERE id = $1 FOR UPDATE', [walletId])
      ).rejects.toThrow(/lock timeout|canceling statement/i);

      await a.query('COMMIT');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  test('WITHOUT the lock, two transactions read the SAME stale balance — the bug', async () => {
    const user = await makeUser({ balancePaisa: 1000_00 });
    const walletId = await walletIdFor(user.id);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // Plain SELECT (no FOR UPDATE) — exactly what the buggy version does.
      const seenByA = (await a.query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId])).rows[0].balance_paisa;
      const seenByB = (await b.query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId])).rows[0].balance_paisa;

      // Both see ৳1000, so both would approve a ৳600 transfer. This is the double-spend.
      expect(seenByA).toBe(1000_00);
      expect(seenByB).toBe(1000_00);
      expect(seenByA).toBe(seenByB);

      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  test('the CHECK constraint still refuses to mint money if the lock were ever removed', async () => {
    const user = await makeUser({ balancePaisa: 1000_00 });
    const walletId = await walletIdFor(user.id);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // Both transactions read the stale balance and both decide ৳600 is affordable.
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId]);
      await b.query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId]);

      await a.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2', [600_00, walletId]);
      await a.query('COMMIT'); // balance is now ৳400

      // B's UPDATE re-reads the row under READ COMMITTED and applies to ৳400,
      // which would take it to -৳200. The CHECK constraint refuses.
      await expect(
        b.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2', [600_00, walletId])
      ).rejects.toThrow(/violates check constraint/i);

      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }

    // Defence in depth held: the balance is correct, no money was created.
    const finalBalance = (await query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId])).rows[0].balance_paisa;
    expect(finalBalance).toBe(400_00);
  });
});

describe('the transfer code path actually takes the lock', () => {
  /**
   * THE REGRESSION GUARD — and it took three attempts to make it honest.
   *
   * Attempt 1 (two parallel HTTP requests) passed without the lock: the requests rarely
   * actually overlapped.
   * Attempt 2 ("does it block?") also passed without the lock: the UPDATE takes a row
   * lock too, so the request blocks either way.
   *
   * The real difference is WHAT THE STALE READ DECIDES. Here another transaction is
   * mid-flight reducing the balance to ৳400 while we attempt a ৳600 transfer:
   *   • WITH FOR UPDATE — our SELECT waits, then reads the true ৳400 and returns a
   *     clean 422 INSUFFICIENT_FUNDS.
   *   • WITHOUT it — our SELECT reads the stale ৳1000, approves the transfer, and the
   *     UPDATE then drives the balance to -৳200, hitting the CHECK constraint: a 500.
   *
   * So: 422 means the lock is doing its job; 500 means it is gone.
   */
  test('a stale read is impossible: concurrent drawdown yields 422, never a constraint crash', async () => {
    const { api } = await import('./helpers.js');
    const sender = await makeUser({ balancePaisa: 1000_00 });
    const recipient = await makeUser();
    const walletId = await walletIdFor(sender.id);

    // Another transaction is already spending ৳600 of the ৳1000, uncommitted.
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('UPDATE wallets SET balance_paisa = balance_paisa - $1 WHERE id = $2', [600_00, walletId]);

    // Our transfer also wants ৳600 — affordable against the stale ৳1000, not against ৳400.
    // NOTE: the trailing .then() is load-bearing. A supertest chain does not dispatch
    // until something subscribes to it, so without this the request would sit idle
    // through the sleep below and only run after COMMIT — silently testing nothing.
    const inflight = api()
      .post('/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ to_email: recipient.email, amount_paisa: 600_00 })
      .then((r) => r);

    await new Promise((r) => setTimeout(r, 800)); // let the transfer reach its SELECT
    await blocker.query('COMMIT');
    blocker.release();

    const res = await inflight;
    expect(res.status).toBe(422);                          // ← 500 if FOR UPDATE is removed
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // The other transaction's ৳600 went through; ours correctly did not.
    const finalBalance = (await query('SELECT balance_paisa FROM wallets WHERE id = $1', [walletId])).rows[0].balance_paisa;
    expect(finalBalance).toBe(400_00);
  });
});

describe('money conservation invariant', () => {
  /**
   * The property that must hold no matter how requests interleave:
   * money is only ever moved, never created or destroyed.
   */
  test('total balance across all wallets is unchanged by any number of transfers', async () => {
    const alice = await makeUser({ balancePaisa: 1000_00 });
    const bob = await makeUser({ balancePaisa: 500_00 });
    const carol = await makeUser({ balancePaisa: 250_00 });

    const totalBefore = (await query('SELECT SUM(balance_paisa)::bigint AS t FROM wallets')).rows[0].t;

    const { api } = await import('./helpers.js');
    await Promise.all([
      api().post('/transfers').set('Authorization', `Bearer ${alice.token}`).send({ to_email: bob.email, amount_paisa: 300_00 }),
      api().post('/transfers').set('Authorization', `Bearer ${bob.token}`).send({ to_email: carol.email, amount_paisa: 200_00 }),
      api().post('/transfers').set('Authorization', `Bearer ${carol.token}`).send({ to_email: alice.email, amount_paisa: 100_00 }),
      api().post('/transfers').set('Authorization', `Bearer ${alice.token}`).send({ to_email: carol.email, amount_paisa: 900_00 }),
    ]);

    const totalAfter = (await query('SELECT SUM(balance_paisa)::bigint AS t FROM wallets')).rows[0].t;
    expect(totalAfter).toBe(totalBefore);

    // And no wallet is ever negative.
    const negatives = await query('SELECT count(*)::int AS n FROM wallets WHERE balance_paisa < 0');
    expect(negatives.rows[0].n).toBe(0);
  });
});
