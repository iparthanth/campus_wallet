export default {
  testEnvironment: 'node',
  // Point every run at <database>_test BEFORE any module reads DATABASE_URL.
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  // Native ESM: no Babel, no transpile step. Run with --experimental-vm-modules (see package.json).
  transform: {},
  // Money tests share one database, so they must not run in parallel with each other.
  // (npm test already passes --runInBand.)
  testMatch: ['**/tests/**/*.test.js'],
  // server.js and seed.js are CLI entry points, not request-path code — excluded so the
  // coverage number reflects logic that can actually harbour a money bug.
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/db/seed.js'],
  coverageThreshold: {
    // The domain layer holds the money logic — it earns the strictest bar.
    './src/domain/': { statements: 85, branches: 75, functions: 90, lines: 85 },
  },
};
