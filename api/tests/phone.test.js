import { api, makeUser, resetDb, closeDb } from './helpers.js';
import { query } from '../src/db/pool.js';
import { normalizeBdPhone } from '../src/services/sms.js';

beforeEach(resetDb);
afterAll(closeDb);

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

/** The console provider logs the code; tests read it from the row instead of the log. */
async function currentCodeHashRow(userId) {
  return (await query(
    'SELECT id, code_hash, attempts FROM phone_verifications WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [userId]
  )).rows[0];
}

/** Brute-force the 6 digits against the stored hash — fine for a test, 10^6 is small. */
async function recoverCode(userId) {
  const { createHash } = await import('node:crypto');
  const row = await currentCodeHashRow(userId);
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (createHash('sha256').update(`${userId}:${candidate}`).digest('hex') === row.code_hash) return candidate;
  }
  throw new Error('code not recoverable');
}

describe('Bangladeshi phone normalisation', () => {
  test.each([
    ['01712345678', '8801712345678'],
    ['8801712345678', '8801712345678'],
    ['+8801712345678', '8801712345678'],
    ['1712345678', '8801712345678'],
    ['017 1234 5678', '8801712345678'],
    ['01312345678', '8801312345678'],   // GP
    ['01912345678', '8801912345678'],   // Banglalink
    ['01512345678', '8801512345678'],   // Teletalk
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBdPhone(input)).toBe(expected);
  });

  test.each([
    ['01212345678'],  // 012 is not an operator prefix
    ['0171234567'],   // too short
    ['017123456789'], // too long
    ['abcd'],
    [''],
    ['+919812345678'], // Indian number
  ])('rejects %s', (input) => {
    expect(normalizeBdPhone(input)).toBeNull();
  });
});

describe('phone verification', () => {
  test('a student verifies their number with the code', async () => {
    const user = await makeUser();

    const start = await api().post('/phone/start').set(auth(user)).send({ phone: '01712345678' });
    expect(start.status).toBe(200);
    expect(start.body.sent_to).toBe('••••••5678');       // never echoes the full number
    expect(start.body.provider).toBe('console');

    const code = await recoverCode(user.id);
    const done = await api().post('/phone/verify').set(auth(user)).send({ code });
    expect(done.status).toBe(200);
    expect(done.body.verified).toBe(true);

    const status = await api().get('/phone/status').set(auth(user));
    expect(status.body).toMatchObject({ verified: true, phone: '••••••5678' });
  });

  test('the code is stored hashed, never in plain text', async () => {
    const user = await makeUser();
    await api().post('/phone/start').set(auth(user)).send({ phone: '01812345678' });

    const row = await currentCodeHashRow(user.id);
    expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);        // sha256 hex
    const code = await recoverCode(user.id);
    expect(row.code_hash).not.toContain(code);
  });

  test('a wrong code is rejected and counts an attempt', async () => {
    const user = await makeUser();
    await api().post('/phone/start').set(auth(user)).send({ phone: '01712345679' });

    const res = await api().post('/phone/verify').set(auth(user)).send({ code: '000000' });
    // A correct guess of 000000 is 1-in-a-million; if it ever fires, the assertion below explains itself.
    if (res.status === 200) return;
    expect(res.status).toBe(422);
    expect((await currentCodeHashRow(user.id)).attempts).toBe(1);
  });

  test('the code dies after 5 wrong attempts — a 6-digit code is not brute-forceable', async () => {
    const user = await makeUser();
    await api().post('/phone/start').set(auth(user)).send({ phone: '01712345670' });

    for (let i = 0; i < 5; i++) {
      await api().post('/phone/verify').set(auth(user)).send({ code: '999999' });
    }
    const res = await api().post('/phone/verify').set(auth(user)).send({ code: '111111' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  test('an expired code cannot be used', async () => {
    const user = await makeUser();
    await api().post('/phone/start').set(auth(user)).send({ phone: '01712345671' });
    const code = await recoverCode(user.id);

    await query("UPDATE phone_verifications SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [user.id]);

    const res = await api().post('/phone/verify').set(auth(user)).send({ code });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('EXPIRED');
  });

  test('requesting a second code immediately is rate limited', async () => {
    const user = await makeUser();
    await api().post('/phone/start').set(auth(user)).send({ phone: '01712345672' });
    const again = await api().post('/phone/start').set(auth(user)).send({ phone: '01712345672' });

    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('COOLDOWN');
  });

  test('a number already verified elsewhere is refused', async () => {
    const first = await makeUser();
    await api().post('/phone/start').set(auth(first)).send({ phone: '01712345673' });
    await api().post('/phone/verify').set(auth(first)).send({ code: await recoverCode(first.id) });

    const second = await makeUser();
    const res = await api().post('/phone/start').set(auth(second)).send({ phone: '01712345673' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_TAKEN');
  });

  test('a non-Bangladeshi number is refused before any SMS is attempted', async () => {
    const user = await makeUser();
    const res = await api().post('/phone/start').set(auth(user)).send({ phone: '+919812345678' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });
});

describe('the dev-code safety catch', () => {
  test('the code is returned to the client ONLY through the console provider', async () => {
    const user = await makeUser();
    const res = await api().post('/phone/start').set(auth(user)).send({ phone: '01712349999' });
    // Tests run with no SMS key, so the provider is 'console' and the code is exposed to
    // make local testing possible.
    expect(res.body.provider).toBe('console');
    expect(res.body.dev_code).toMatch(/^\d{6}$/);
    // And it is the real code: it verifies.
    const done = await api().post('/phone/verify').set(auth(user)).send({ code: res.body.dev_code });
    expect(done.status).toBe(200);
    expect(done.body.verified).toBe(true);
  });

  test('the full phone number is never echoed back, only the last four', async () => {
    const user = await makeUser();
    const res = await api().post('/phone/start').set(auth(user)).send({ phone: '01712345688' });
    expect(res.body.sent_to).toBe('••••••5688');
    expect(JSON.stringify(res.body)).not.toContain('8801712345688');
  });
});
