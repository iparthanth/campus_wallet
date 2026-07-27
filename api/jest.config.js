export default {
  testEnvironment: 'node',
  // Point every run at <database>_test BEFORE any module reads DATABASE_URL.
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  // Native ESM: no Babel, no transpile step. Run with --experimental-vm-modules (see package.json).
  transform: {},
  // Money tests share one database, so they must not run in parallel with each other.
  // (npm test already passes --runInBand.)
  testMatch: ['**/tests/**/*.test.js'],
  /*
   * One timeout for every suite.
   *
   * These are integration tests: a real PostgreSQL round trip plus bcrypt on every user.
   * On an unloaded machine a test takes ~3s, but the whole suite runs sequentially for
   * ~12 minutes, and on a busy machine individual tests stretch well past 30s. Files had
   * drifted to a mix of 30s, 45s and 60s, so which suite failed under load was arbitrary.
   *
   * A test suite that goes red because the laptop was busy is a suite people learn to
   * re-run instead of read — and then a real failure gets re-run too. One generous,
   * uniform budget: slow is tolerated, hung is not.
   */
  testTimeout: 60_000,
  // server.js and seed.js are CLI entry points, not request-path code — excluded so the
  // coverage number reflects logic that can actually harbour a money bug.
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/db/seed.js'],
  coverageThreshold: {
    // The domain layer holds the money logic — it earns the strictest bar.
    './src/domain/': { statements: 85, branches: 75, functions: 90, lines: 85 },
  },
};
