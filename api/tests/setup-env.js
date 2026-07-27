/**
 * Runs before any test module is imported (jest `setupFiles`).
 *
 * Redirects every test run to a SEPARATE database by appending `_test` to the database
 * name in DATABASE_URL. Without this, `npm test` truncates the development database and
 * silently destroys your seed data — which is exactly what happened once before this
 * file existed.
 *
 * Set TEST_DATABASE_URL to override completely (CI does not need the rewrite).
 */
// Load .env HERE first. config.js also calls dotenv, but that happens later — so without
// this the rewrite below would see an undefined DATABASE_URL, skip silently, and the tests
// would run against the development database.
import 'dotenv/config';

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (process.env.DATABASE_URL && !/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  process.env.DATABASE_URL = url.toString();
}

// Tests are slow enough with bcrypt at 12; 4 is plenty to prove the hashing path works.
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS ?? '4';

/**
 * Never send a real SMS from a test. Not once, not by accident.
 *
 * The line above loads .env, so the moment a real SMS_API_KEY is configured for development
 * the suite would pick it up, swap the console provider for the live one, and text the
 * fixture numbers in phone.test.js. Those are plausible Bangladeshi numbers — 8801712345678
 * and friends — which means they belong to real people who would receive verification codes
 * for an account they have never heard of, and each run would spend real credit.
 *
 * Forced rather than defaulted: a test must not be able to opt back in.
 */
delete process.env.SMS_API_KEY;
process.env.SMS_PROVIDER = 'console';
