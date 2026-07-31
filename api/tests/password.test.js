import bcrypt from 'bcryptjs';
import { api, makeUser, resetDb, closeDb } from './helpers.js';
import { query } from '../src/db/pool.js';
import { hashPassword, verifyPassword, needsRehash } from '../src/services/password.js';

/**
 * Password hashing, and the migration off bcrypt.
 *
 * WHY THIS CHANGED
 *
 * bcryptjs is pure JavaScript and runs on the request thread. At cost 12 on the free
 * instance this deploys to, one login took 9.8 SECONDS of blocked event loop — measured
 * against the live site, not estimated. While blocked the server cannot answer HTTP/2 PING
 * or WINDOW_UPDATE frames, so the proxy reset the stream at ~1s and every browser login
 * failed with a dropped connection, while /ready kept returning 200 because health checks
 * landed between attempts. It looked like a crash-loop; nothing was crashing.
 *
 * scrypt is native and runs on the libuv threadpool, so it does not block the event loop
 * at all, and is ~9x faster for equivalent work.
 *
 * The migration is the part worth testing hardest: every existing account holds a bcrypt
 * hash, and nobody may be locked out.
 */

beforeEach(resetDb);
afterAll(closeDb);

describe('hashing', () => {
  test('produces a self-describing scrypt hash, never a bare digest', async () => {
    const h = await hashPassword('correct horse battery staple');
    // Parameters travel WITH the hash, so raising the cost later does not invalidate it.
    expect(h).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h).not.toContain('correct horse');
  });

  test('the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('password123'), hashPassword('password123')]);
    // A shared salt would let one rainbow table cover every account.
    expect(a).not.toBe(b);
  });

  test('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('password123');
    expect(await verifyPassword('password123', h)).toBe(true);
    expect(await verifyPassword('password124', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  test('a corrupt stored value reads as a wrong password, not an error', async () => {
    // A 500 here would tell an attacker the row exists and is malformed.
    for (const bad of ['', 'not-a-hash', 'scrypt$broken', null, undefined, 'scrypt$16384$8$1$$']) {
      await expect(verifyPassword('password123', bad)).resolves.toBe(false);
    }
  });

  /**
   * A regression test for an authentication BYPASS this suite caught.
   *
   * The key length was derived from the stored hash. A row with an empty digest therefore
   * asked scrypt for a 0-byte key, got an empty buffer back, and
   * timingSafeEqual(empty, empty) returned TRUE — so the row matched ANY password. A
   * truncated column or a partial write would have handed out an account.
   */
  test('a truncated or empty digest never matches — any password', async () => {
    const truncated = [
      'scrypt$16384$8$1$c2FsdHNhbHRzYWx0$',        // empty digest
      'scrypt$16384$8$1$c2FsdHNhbHRzYWx0$YQ==',    // 1-byte digest
      'scrypt$16384$8$1$$YQ==',                    // empty salt
      'scrypt$0$8$1$c2FsdHNhbHRzYWx0$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWZnaGlqa2w=',
    ];
    for (const stored of truncated) {
      expect(await verifyPassword('password123', stored)).toBe(false);
      expect(await verifyPassword('literally anything else', stored)).toBe(false);
    }
  });
});

describe('legacy bcrypt hashes keep working', () => {
  test('an old bcrypt hash still verifies', async () => {
    const legacy = bcrypt.hashSync('password123', 4);
    expect(await verifyPassword('password123', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });

  test('bcrypt hashes are flagged for upgrade; current scrypt hashes are not', async () => {
    expect(needsRehash(bcrypt.hashSync('password123', 4))).toBe(true);
    expect(needsRehash(await hashPassword('password123'))).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  test('a scrypt hash made at a LOWER cost is flagged, so raising cost migrates gradually', () => {
    expect(needsRehash('scrypt$8192$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });
});

describe('logging in upgrades a legacy account in place', () => {
  /**
   * The migration must be invisible: no password reset, no flag day, no window where a
   * student cannot sign in. The plaintext is available exactly once — during a successful
   * login — so that is when the hash is rewritten.
   */
  async function legacyUser() {
    const u = await makeUser();
    await query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [bcrypt.hashSync('password123', 4), u.id]);
    return u;
  }

  test('a student with a bcrypt hash can still sign in', async () => {
    const u = await legacyUser();
    const res = await api().post('/auth/login').send({ email: u.email, password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  test('the stored hash becomes scrypt after that login', async () => {
    const u = await legacyUser();
    await api().post('/auth/login').send({ email: u.email, password: 'password123' });

    // The rewrite is deliberately not awaited into the response — the student is
    // authenticated either way and a slow write must not delay or fail their login. So
    // poll briefly rather than assuming it has landed.
    let stored;
    for (let i = 0; i < 40; i += 1) {
      stored = (await query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0].password_hash;
      if (stored.startsWith('scrypt$')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(stored).toMatch(/^scrypt\$/);
  });

  test('and the password still works afterwards', async () => {
    const u = await legacyUser();
    await api().post('/auth/login').send({ email: u.email, password: 'password123' });
    await new Promise((r) => setTimeout(r, 1500));

    const again = await api().post('/auth/login').send({ email: u.email, password: 'password123' });
    expect(again.status).toBe(200);

    const wrong = await api().post('/auth/login').send({ email: u.email, password: 'password124' });
    expect(wrong.status).toBe(401);
  });

  test('a failed login does NOT rewrite the hash', async () => {
    const u = await legacyUser();
    const before = (await query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0].password_hash;

    await api().post('/auth/login').send({ email: u.email, password: 'wrong-password' });
    await new Promise((r) => setTimeout(r, 500));

    const after = (await query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0].password_hash;
    expect(after).toBe(before);
  });
});

describe('user enumeration stays closed', () => {
  /**
   * An unknown email must cost the same as a real one. Skipping the hash on the
   * no-such-user branch makes it measurably faster and hands out valid emails by stopwatch.
   */
  test('unknown and known emails both answer 401 with the same body', async () => {
    const u = await makeUser();
    const unknown = await api().post('/auth/login').send({ email: 'nobody@puc.ac.bd', password: 'password123' });
    const known = await api().post('/auth/login').send({ email: u.email, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(unknown.body).toEqual(known.body);
  });
});
