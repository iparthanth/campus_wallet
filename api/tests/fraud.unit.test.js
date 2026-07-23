import { ruleVelocity, ruleThreshold, evaluateRules } from '../src/domain/fraud.js';
import { isValidPaisa, formatPaisa, toPaisa, MAX_TRANSFER_PAISA } from '../src/domain/money.js';

/** Pure functions: no database, no async, milliseconds to run. */

describe('fraud rule: VELOCITY', () => {
  test.each([
    [1, null], [3, null], [4, 'VELOCITY'], [50, 'VELOCITY'],
  ])('%i transfers in window -> %s', (recentTransferCount, expected) => {
    const flag = ruleVelocity({ recentTransferCount });
    expect(flag?.rule_name ?? null).toBe(expected);
  });
});

describe('fraud rule: THRESHOLD', () => {
  test('large AND unusual for this user -> flagged', () => {
    expect(ruleThreshold({ amountPaisa: 600_00, avgTransferPaisa: 50_00 })?.rule_name).toBe('THRESHOLD');
  });
  test('large but normal for a habitually big sender -> not flagged', () => {
    expect(ruleThreshold({ amountPaisa: 600_00, avgTransferPaisa: 500_00 })).toBeNull();
  });
  test('unusual but small -> not flagged', () => {
    expect(ruleThreshold({ amountPaisa: 400_00, avgTransferPaisa: 1_00 })).toBeNull();
  });
  test('no history -> not flagged (a first transfer is not suspicious)', () => {
    expect(ruleThreshold({ amountPaisa: 900_00, avgTransferPaisa: 0 })).toBeNull();
  });
});

describe('evaluateRules', () => {
  test('returns every rule that trips', () => {
    const flags = evaluateRules({ recentTransferCount: 9, amountPaisa: 900_00, avgTransferPaisa: 10_00 });
    expect(flags.map((f) => f.rule_name).sort()).toEqual(['THRESHOLD', 'VELOCITY']);
  });
  test('clean transfer produces no flags', () => {
    expect(evaluateRules({ recentTransferCount: 1, amountPaisa: 100, avgTransferPaisa: 100 })).toEqual([]);
  });
});

describe('money helpers', () => {
  test.each([
    [100, true], [1, true], [MAX_TRANSFER_PAISA, true],
    [0, false], [-1, false], [10.5, false], ['100', false], [NaN, false], [MAX_TRANSFER_PAISA + 1, false],
  ])('isValidPaisa(%p) === %p', (v, expected) => expect(isValidPaisa(v)).toBe(expected));

  test('formatPaisa renders taka and paisa correctly', () => {
    expect(formatPaisa(10050)).toBe('৳100.50');
    expect(formatPaisa(5)).toBe('৳0.05');
    expect(formatPaisa(0)).toBe('৳0.00');
  });

  test('toPaisa converts without float drift', () => {
    expect(toPaisa(100.5)).toBe(10050);
    expect(toPaisa('0.07')).toBe(7);
    expect(toPaisa(19.99)).toBe(1999);
  });

  test('toPaisa refuses sub-paisa precision instead of silently rounding money', () => {
    expect(() => toPaisa(1.005)).toThrow();
  });
});
