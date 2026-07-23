export default {
  testEnvironment: 'node',
  // Native ESM: no Babel, no transpile step. Run with --experimental-vm-modules (see package.json).
  transform: {},
  // Money tests share one database, so they must not run in parallel with each other.
  // (npm test already passes --runInBand.)
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js'],
  coverageThreshold: {
    // The domain layer holds the money logic — it earns the strictest bar.
    './src/domain/': { statements: 85, branches: 75, functions: 90, lines: 85 },
  },
};
