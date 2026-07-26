import { describe, test, expect } from '@jest/globals';
import { readWalletMode } from '../src/config.js';

/**
 * WALLET_MODE resolution.
 *
 * The single most consequential setting in the system: it decides whether the deployment
 * holds student money, which decides whether the deployment is lawful. So it gets its own
 * tests rather than being trusted to a ternary nobody re-reads.
 *
 * readWalletMode takes the environment as an argument precisely so this can be tested
 * without re-importing modules or mutating process.env — each case passes the environment
 * it wants and nothing leaks between them.
 */

describe('the default', () => {
  /**
   * The whole compliance posture in one assertion. If this ever flips back to closed_loop,
   * a deployment that simply forgets the variable becomes an unlicensed e-money issuer.
   */
  test('is zero_float when WALLET_MODE is unset', () => {
    expect(readWalletMode({})).toBe('zero_float');
    expect(readWalletMode({ NODE_ENV: 'production' })).toBe('zero_float');
  });

  test('an empty string is not treated as a choice', () => {
    // An unset variable in a container platform often arrives as "" rather than undefined.
    expect(() => readWalletMode({ WALLET_MODE: '' })).toThrow(/must be/);
  });
});

describe('production refuses the unlawful combination', () => {
  const prod = { WALLET_MODE: 'closed_loop', NODE_ENV: 'production' };

  test('closed_loop + production throws at boot', () => {
    expect(() => readWalletMode(prod)).toThrow(/REFUSING TO START/);
  });

  test('the refusal cites the statute, so whoever hits it can act on it', () => {
    expect(() => readWalletMode(prod)).toThrow(/s\.15\(1\)/);
    expect(() => readWalletMode(prod)).toThrow(/non-bailable/);
  });

  test('the refusal says how to fix it', () => {
    expect(() => readWalletMode(prod)).toThrow(/WALLET_MODE=zero_float/);
  });

  test('zero_float in production is allowed', () => {
    expect(readWalletMode({ WALLET_MODE: 'zero_float', NODE_ENV: 'production' })).toBe('zero_float');
  });
});

describe('closed_loop outside production', () => {
  /** Still available for demonstration — which is what makes the production stop credible. */
  test('is permitted in development', () => {
    expect(readWalletMode({ WALLET_MODE: 'closed_loop', NODE_ENV: 'development' })).toBe('closed_loop');
  });

  test('is permitted in test', () => {
    expect(readWalletMode({ WALLET_MODE: 'closed_loop', NODE_ENV: 'test' })).toBe('closed_loop');
  });

  /**
   * An unset NODE_ENV must NOT be read as production — otherwise a developer running
   * `node src/server.js` with no environment at all would be blocked from the demo.
   */
  test('is permitted when NODE_ENV is unset', () => {
    expect(readWalletMode({ WALLET_MODE: 'closed_loop' })).toBe('closed_loop');
  });
});

describe('rejecting nonsense', () => {
  test('a typo fails loudly rather than falling back to a mode nobody chose', () => {
    for (const bad of ['zerofloat', 'ZERO_FLOAT', 'closed-loop', 'zero_float ish', 'yes', 'true', '0']) {
      expect(() => readWalletMode({ WALLET_MODE: bad })).toThrow(/must be "zero_float" or "closed_loop"/);
    }
  });

  test('the error repeats the bad value back, so the typo is obvious', () => {
    expect(() => readWalletMode({ WALLET_MODE: 'zerofloat' })).toThrow(/got "zerofloat"/);
  });

  /**
   * A trailing space is the classic .env / Render dashboard mistake. Refusing to boot over
   * invisible whitespace would be a miserable failure to debug, so trim first.
   */
  test('surrounding whitespace is tolerated', () => {
    expect(readWalletMode({ WALLET_MODE: '  zero_float  ' })).toBe('zero_float');
    expect(readWalletMode({ WALLET_MODE: '\tclosed_loop\n' })).toBe('closed_loop');
  });
});
