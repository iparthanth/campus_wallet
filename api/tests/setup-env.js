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
