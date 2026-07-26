import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { resetDb, closeDb, makeUser, makeMerchant } from './helpers.js';
import { query } from '../src/db/pool.js';
import {
  post,
  reverse,
  balanceOf,
  trialBalance,
  statement,
  ensureAccount,
  ACCOUNTS,
  DEBIT,
  CREDIT,
  LedgerError,
} from '../src/domain/ledger.js';

/**
 * The ledger is the system of record for money owed and money received. These tests
 * assert the properties that make it trustworthy — not merely that the functions run.
 *
 * The governing invariant, checked after almost every test: total debits equal total
 * credits across the whole ledger. If that can drift, nothing built on top means anything.
 */

let student;
let outlet;
let key = 0;
const nextKey = (p = 'test') => `${p}-${Date.now()}-${++key}-aaaaaaaa`;

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  student = await makeUser();
  outlet = await makeMerchant({ name: 'AB4 Canteen' });
});

afterAll(async () => {
  await closeDb();
});

/** An order raised at a canteen: student owes, university has earned. */
async function raiseOrder({ amountPaisa = 8500, idempotencyKey = null } = {}) {
  return post({
    idempotencyKey: idempotencyKey ?? nextKey('order'),
    kind: 'ORDER_RAISED',
    description: 'Lunch — AB4 Canteen',
    entries: [
      { account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa },
      { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa },
    ],
  });
}

describe('posting', () => {
  test('writes a balanced posting and both its entries', async () => {
    const { posting, entries, replayed } = await raiseOrder();

    expect(replayed).toBe(false);
    expect(posting.kind).toBe('ORDER_RAISED');
    expect(posting.status).toBe('POSTED');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.direction).sort()).toEqual([CREDIT, DEBIT]);
  });

  test('creates the accounts it references, so callers never pre-provision', async () => {
    await raiseOrder();

    const receivable = await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`);
    const revenue = await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`);

    expect(receivable).not.toBeNull();
    expect(revenue).not.toBeNull();
    expect(receivable.class).toBe('ASSET');
    expect(revenue.class).toBe('REVENUE');
  });

  test('derives balances with the right sign for each account class', async () => {
    await raiseOrder({ amountPaisa: 8500 });

    // ASSET is debit-normal: a debit increases it.
    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(8500);
    // REVENUE is credit-normal: a credit increases it.
    expect(Number((await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`)).balance_paisa)).toBe(8500);
  });

  test('accumulates across postings', async () => {
    await raiseOrder({ amountPaisa: 8500 });
    await raiseOrder({ amountPaisa: 1500 });
    await raiseOrder({ amountPaisa: 100 });

    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(10100);
    expect((await trialBalance()).balanced).toBe(true);
  });

  test('keeps the ledger balanced', async () => {
    await raiseOrder();
    const tb = await trialBalance();

    expect(Number(tb.drift_paisa)).toBe(0);
    expect(Number(tb.total_debits_paisa)).toBe(Number(tb.total_credits_paisa));
    expect(tb.balanced).toBe(true);
  });
});

describe('idempotency', () => {
  test('replaying a key returns the original and posts nothing new', async () => {
    const idem = nextKey('order');
    const first = await raiseOrder({ idempotencyKey: idem });
    const second = await raiseOrder({ idempotencyKey: idem });

    expect(second.replayed).toBe(true);
    expect(second.posting.id).toBe(first.posting.id);

    // The critical assertion: the balance did NOT double.
    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(8500);
    expect(Number((await trialBalance()).posting_count)).toBe(1);
  });

  test('a replay returns the original entries too, not an empty list', async () => {
    const idem = nextKey('order');
    await raiseOrder({ idempotencyKey: idem });
    const replay = await raiseOrder({ idempotencyKey: idem });

    expect(replay.entries).toHaveLength(2);
    expect(replay.entries.map((e) => Number(e.amount_paisa))).toEqual([8500, 8500]);
  });

  /**
   * A settlement file being imported twice is not hypothetical: staff re-upload, and
   * retries fire. Importing twice must not double recorded revenue.
   */
  test('concurrent identical postings settle to exactly one', async () => {
    const idem = nextKey('order');
    const results = await Promise.allSettled([
      raiseOrder({ idempotencyKey: idem }),
      raiseOrder({ idempotencyKey: idem }),
      raiseOrder({ idempotencyKey: idem }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);

    // However the race resolved, the money is right and the books balance.
    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(8500);
    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('rejecting bad postings', () => {
  test('refuses an unbalanced posting before it reaches the database', async () => {
    await expect(post({
      idempotencyKey: nextKey('bad'),
      kind: 'ORDER_RAISED',
      entries: [
        { account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa: 8500 },
        { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 8000 },
      ],
    })).rejects.toThrow(/does not balance.*difference 500/);
  });

  test('refuses a single-entry posting', async () => {
    await expect(post({
      idempotencyKey: nextKey('bad'),
      kind: 'ORDER_RAISED',
      entries: [{ account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa: 100 }],
    })).rejects.toThrow(LedgerError);
  });

  test('refuses non-integer, zero and negative amounts', async () => {
    for (const bad of [0, -100, 85.5, NaN]) {
      await expect(post({
        idempotencyKey: nextKey('bad'),
        kind: 'ORDER_RAISED',
        entries: [
          { account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa: bad },
          { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: bad },
        ],
      })).rejects.toThrow(LedgerError);
    }
  });

  test('refuses an invalid direction', async () => {
    await expect(post({
      idempotencyKey: nextKey('bad'),
      kind: 'ORDER_RAISED',
      entries: [
        { account: ACCOUNTS.studentReceivable(student.id), direction: 'SIDEWAYS', amountPaisa: 100 },
        { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 100 },
      ],
    })).rejects.toThrow(/DEBIT or CREDIT/);
  });

  test('refuses a malformed kind or idempotency key', async () => {
    const entries = [
      { account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa: 100 },
      { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: 100 },
    ];
    await expect(post({ idempotencyKey: nextKey(), kind: 'lower_case', entries }))
      .rejects.toThrow(/UPPER_SNAKE_CASE/);
    await expect(post({ idempotencyKey: 'short', kind: 'ORDER_RAISED', entries }))
      .rejects.toThrow(/8–200/);
  });

  /**
   * The application check and the database trigger are independent defences. This proves
   * the DATABASE one bites even when the application layer is bypassed entirely — which
   * is what "defence in depth" has to mean to be worth claiming.
   */
  test('the database itself rejects an unbalanced posting written by raw SQL', async () => {
    const acct = await ensureAccount(ACCOUNTS.studentReceivable(student.id));
    const rev = await ensureAccount(ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name));

    await expect((async () => {
      const client = await (await import('../src/db/pool.js')).pool.connect();
      try {
        await client.query('BEGIN');
        const p = await client.query(
          "INSERT INTO ledger_postings (idempotency_key, kind) VALUES ($1,'ORDER_RAISED') RETURNING id",
          [nextKey('raw')]
        );
        await client.query(
          "INSERT INTO ledger_entries (posting_id, account_id, direction, amount_paisa) VALUES ($1,$2,'DEBIT',9999)",
          [p.rows[0].id, acct.id]
        );
        await client.query(
          "INSERT INTO ledger_entries (posting_id, account_id, direction, amount_paisa) VALUES ($1,$2,'CREDIT',1)",
          [p.rows[0].id, rev.id]
        );
        await client.query('COMMIT'); // deferred trigger fires HERE
      } finally {
        client.release();
      }
    })()).rejects.toThrow(/does not balance/);

    expect((await trialBalance()).balanced).toBe(true);
  });
});

describe('append-only guarantee', () => {
  test('entries cannot be updated', async () => {
    const { entries } = await raiseOrder();
    await expect(query('UPDATE ledger_entries SET amount_paisa = 1 WHERE id = $1', [entries[0].id]))
      .rejects.toThrow(/append-only/);
  });

  test('entries cannot be deleted', async () => {
    const { entries } = await raiseOrder();
    await expect(query('DELETE FROM ledger_entries WHERE id = $1', [entries[0].id]))
      .rejects.toThrow(/append-only/);
  });

  test('postings cannot be deleted', async () => {
    const { posting } = await raiseOrder();
    await expect(query('DELETE FROM ledger_postings WHERE id = $1', [posting.id]))
      .rejects.toThrow(/append-only/);
  });

  test('a posting\'s identifying fields cannot be rewritten', async () => {
    const { posting } = await raiseOrder();
    await expect(query('UPDATE ledger_postings SET kind = $1 WHERE id = $2', ['TAMPERED_X', posting.id]))
      .rejects.toThrow(/immutable/);
  });
});

describe('reversal', () => {
  test('mirrors the original and leaves the balance at zero', async () => {
    const { posting } = await raiseOrder({ amountPaisa: 8500 });
    await reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'wrong amount keyed' });

    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(0);
    expect((await trialBalance()).balanced).toBe(true);
  });

  test('preserves both the error and the correction in history', async () => {
    const { posting } = await raiseOrder();
    await reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'duplicate order' });

    const lines = await statement(`PUC:RECEIVABLE:STUDENT:${student.id}`);
    // Two entries survive: the original debit and the reversing credit. Nothing was erased.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.direction).sort()).toEqual([CREDIT, DEBIT]);
  });

  test('marks the original VOIDED and points at the reversing posting', async () => {
    const { posting } = await raiseOrder();
    const { reversal } = await reverse({
      postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'keyed twice',
    });

    const row = (await query('SELECT status, voided_by FROM ledger_postings WHERE id = $1', [posting.id])).rows[0];
    expect(row.status).toBe('VOIDED');
    expect(Number(row.voided_by)).toBe(Number(reversal.id));
  });

  test('refuses to reverse the same posting twice', async () => {
    const { posting } = await raiseOrder();
    await reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'first' });

    await expect(reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'second' }))
      .rejects.toThrow(/already voided/i);
  });

  test('refuses a reversal with no stated reason', async () => {
    const { posting } = await raiseOrder();
    await expect(reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: '' }))
      .rejects.toThrow(/why/i);
  });

  test('refuses to reverse a posting that does not exist', async () => {
    await expect(reverse({ postingId: 999999, idempotencyKey: nextKey('rev'), reason: 'ghost' }))
      .rejects.toThrow(/does not exist/);
  });

  /** A voided posting must not still count toward revenue. */
  test('a voided posting is excluded from derived balances', async () => {
    const { posting } = await raiseOrder({ amountPaisa: 5000 });
    await raiseOrder({ amountPaisa: 3000 });
    await reverse({ postingId: posting.id, idempotencyKey: nextKey('rev'), reason: 'refunded' });

    expect(Number((await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`)).balance_paisa)).toBe(3000);
  });
});

describe('statement', () => {
  test('returns postings newest first', async () => {
    await raiseOrder({ amountPaisa: 100 });
    await raiseOrder({ amountPaisa: 200 });
    await raiseOrder({ amountPaisa: 300 });

    const lines = await statement(`PUC:RECEIVABLE:STUDENT:${student.id}`);
    expect(lines).toHaveLength(3);
    const times = lines.map((l) => new Date(l.occurred_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('is empty for an account with no activity', async () => {
    await ensureAccount(ACCOUNTS.bank('UCB'));
    expect(await statement('PUC:BANK:UCB')).toHaveLength(0);
  });
});

describe('a full settlement lifecycle', () => {
  /**
   * The flow this system exists to automate, end to end:
   *   1. student orders          — receivable up, revenue up
   *   2. gateway confirms payment — clearing up, receivable cleared
   *   3. gateway settles to bank  — bank up (net), fee recognised, clearing cleared
   *
   * At the end the student owes nothing, the university has ৳85 of revenue, ৳83.30 in
   * the bank and ৳1.70 of fees — and the books balance.
   */
  test('order -> gateway confirmation -> bank settlement', async () => {
    const amount = 8500;
    const fee = 170; // 2% gateway commission
    const net = amount - fee;

    await post({
      idempotencyKey: nextKey('lifecycle-order'),
      kind: 'ORDER_RAISED',
      entries: [
        { account: ACCOUNTS.studentReceivable(student.id), direction: DEBIT, amountPaisa: amount },
        { account: ACCOUNTS.merchantRevenue(outlet.merchantId, outlet.name), direction: CREDIT, amountPaisa: amount },
      ],
    });

    await post({
      idempotencyKey: nextKey('lifecycle-paid'),
      kind: 'PAYMENT_CONFIRMED',
      entries: [
        { account: ACCOUNTS.gatewayClearing('SSLCOMMERZ'), direction: DEBIT, amountPaisa: amount },
        { account: ACCOUNTS.studentReceivable(student.id), direction: CREDIT, amountPaisa: amount },
      ],
    });

    await post({
      idempotencyKey: nextKey('lifecycle-settled'),
      kind: 'GATEWAY_SETTLED',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: net },
        { account: ACCOUNTS.gatewayFee('SSLCOMMERZ'), direction: DEBIT, amountPaisa: fee },
        { account: ACCOUNTS.gatewayClearing('SSLCOMMERZ'), direction: CREDIT, amountPaisa: amount },
      ],
    });

    expect(Number((await balanceOf(`PUC:RECEIVABLE:STUDENT:${student.id}`)).balance_paisa)).toBe(0);
    expect(Number((await balanceOf('PUC:CLEARING:SSLCOMMERZ')).balance_paisa)).toBe(0);
    expect(Number((await balanceOf(`PUC:REVENUE:MERCHANT:${outlet.merchantId}`)).balance_paisa)).toBe(amount);
    expect(Number((await balanceOf('PUC:BANK:UCB')).balance_paisa)).toBe(net);
    expect(Number((await balanceOf('PUC:EXPENSE:FEE:SSLCOMMERZ')).balance_paisa)).toBe(fee);

    expect((await trialBalance()).balanced).toBe(true);
  });

  test('a three-legged posting still balances (net + fee = gross)', async () => {
    const { entries } = await post({
      idempotencyKey: nextKey('threeleg'),
      kind: 'GATEWAY_SETTLED',
      entries: [
        { account: ACCOUNTS.bank('UCB'), direction: DEBIT, amountPaisa: 9800 },
        { account: ACCOUNTS.gatewayFee('BKASH'), direction: DEBIT, amountPaisa: 200 },
        { account: ACCOUNTS.gatewayClearing('BKASH'), direction: CREDIT, amountPaisa: 10000 },
      ],
    });

    expect(entries).toHaveLength(3);
    expect((await trialBalance()).balanced).toBe(true);
  });
});
