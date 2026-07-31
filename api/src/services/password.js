import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing.
 *
 * WHY THIS REPLACED BCRYPT
 *
 * `bcryptjs` is pure JavaScript and runs on the request thread. At cost 12 on the free
 * instance this deployment runs on, a single login took 9.8 SECONDS of blocked event loop
 * — measured, not estimated. While blocked, the server cannot answer HTTP/2 PING or
 * WINDOW_UPDATE frames, so the platform's proxy concluded the connection was dead and reset
 * the stream at ~1s. Every browser login failed with a dropped connection while /ready kept
 * returning 200, because health checks landed in the gaps between attempts.
 *
 * The tempting fix — lower the cost factor — trades away password security to work around
 * a hardware limit, and would still block the loop, just for less time.
 *
 * scrypt is native C, and Node's async form runs it on the libuv threadpool, so it does not
 * block the event loop AT ALL. The same work is ~9x faster and the server stays responsive
 * to other requests while it runs. It is also a KDF OWASP recommends for password storage,
 * and it is memory-hard, which bcrypt is not — a meaningful advantage against GPU cracking.
 *
 * MIGRATION
 *
 * Existing accounts hold bcrypt hashes. Those keep working: verify() detects the format and
 * uses the right algorithm. A hash is upgraded to scrypt on the next successful login, when
 * the plaintext is briefly available — no password reset, no flag day, and no window where
 * anyone cannot sign in.
 */

/** Stored form: scrypt$N$r$p$salt$hash — self-describing, so parameters can change later. */
const PREFIX = 'scrypt';
const KEY_LEN = 64;
const R = 8;
const P = 1;

/**
 * Cost. N must be a power of two; the work and memory are both linear in N.
 *
 * 16384 (2^14) is Node's own default: ~44ms on ordinary hardware, ~1.1s on the 0.1-CPU free
 * instance. Raise it via PASSWORD_SCRYPT_N on real hardware — a university deployment on a
 * normal server should use 32768 or higher. It is stored inside each hash, so raising it
 * does not invalidate existing passwords: they simply verify at the cost they were made
 * with and upgrade on next login.
 */
const N = config.scryptN;

/** libuv's threadpool default is 4, so this bounds concurrent hashing, not the whole server. */
const MAXMEM = 256 * N * R;

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [PREFIX, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verify against either format.
 *
 * Never throws on a malformed stored value: a corrupt row must read as "wrong password",
 * not as a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || stored.length === 0) return false;

  // bcrypt hashes are self-identifying: $2a$, $2b$, $2y$.
  if (/^\$2[aby]\$/.test(stored)) {
    try {
      return await bcrypt.compare(plain, stored);
    } catch {
      return false;
    }
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');

    /*
     * AUTHENTICATION BYPASS GUARD — do not remove.
     *
     * Without these length checks, a stored value of `scrypt$16384$8$1$c2FsdA==$` parses
     * cleanly with an EMPTY digest. scrypt is then asked for a 0-byte key, returns an empty
     * buffer, and timingSafeEqual(empty, empty) is TRUE — so that row matches ANY password.
     * A truncated column, a partial write, or a bad migration would hand out an account.
     *
     * Deriving the key length from the stored hash is what makes this possible at all, so
     * the stored length is validated rather than trusted.
     */
    if (salt.length < 8 || expected.length < 32) return false;

    const parsedN = Number(n);
    const parsedR = Number(r);
    if (!Number.isInteger(parsedN) || !Number.isInteger(parsedR) || parsedN < 2 || parsedR < 1) {
      return false;
    }

    const derived = await scryptAsync(plain, salt, expected.length, {
      N: parsedN, r: parsedR, p: Number(p), maxmem: 256 * parsedN * parsedR,
    });
    // Constant time: a length-varying or short-circuiting compare leaks the hash by timing.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * True when this hash should be rewritten after a successful login.
 *
 * Covers both a legacy bcrypt hash and a scrypt hash made at a lower cost than we now use,
 * so raising PASSWORD_SCRYPT_N migrates accounts gradually as people sign in.
 */
export function needsRehash(stored) {
  if (typeof stored !== 'string') return true;
  if (/^\$2[aby]\$/.test(stored)) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return true;
  return Number(parts[1]) < N;
}

/**
 * A hash of a throwaway password, for the no-such-user branch of login.
 *
 * Computed once at startup so that a login attempt for an unknown email does the SAME work
 * as one for a real account. Skipping it would make "no such user" measurably faster and
 * hand out a list of valid emails by stopwatch.
 */
export const timingDummyHash = await hashPassword('timing-attack-dummy-password');
