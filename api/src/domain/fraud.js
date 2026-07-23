import { config } from '../config.js';
import { formatPaisa } from './money.js';

/**
 * Fraud rules are PURE functions: (facts) -> flag | null.
 * No database, no clock, no I/O. That is why they are trivial to unit-test and why
 * an interviewer can read them in ten seconds. The route gathers the facts; the rules judge.
 */

/** R1 — too many transfers from one wallet in a short window. */
export function ruleVelocity({ recentTransferCount }) {
  const { velocityMaxTransfers: max, velocityWindowSeconds: win } = config.fraud;
  if (recentTransferCount > max) {
    return {
      rule_name: 'VELOCITY',
      detail: `${recentTransferCount} transfers in ${win}s (limit ${max})`,
    };
  }
  return null;
}

/**
 * R2 — a single transfer that is both large in absolute terms AND far above this
 * user's own normal behaviour. Both conditions must hold, so a habitually large
 * sender is not flagged on every transfer.
 */
export function ruleThreshold({ amountPaisa, avgTransferPaisa }) {
  const { thresholdMinPaisa: min, thresholdAvgMultiplier: mult } = config.fraud;
  if (amountPaisa <= min) return null;
  if (!avgTransferPaisa || avgTransferPaisa <= 0) return null; // no history yet — not suspicious
  if (amountPaisa > avgTransferPaisa * mult) {
    return {
      rule_name: 'THRESHOLD',
      detail: `${formatPaisa(amountPaisa)} exceeds ${mult}x the user's average of ${formatPaisa(Math.round(avgTransferPaisa))}`,
    };
  }
  return null;
}

/** Run every rule, return all that tripped. */
export function evaluateRules(facts) {
  return [ruleVelocity(facts), ruleThreshold(facts)].filter(Boolean);
}
