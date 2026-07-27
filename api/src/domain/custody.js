import { config } from '../config.js';

/**
 * The single rule that decides whether this deployment may hold student money.
 *
 * WHY THIS FILE EXISTS
 *
 * The zero-float architecture was added ALONGSIDE the closed-loop one rather than
 * replacing it, and only two paths ever checked the mode. In production — with
 * WALLET_MODE=zero_float and a handover document promising "the university never holds
 * student money at any point" — a student could still top up a balance, hold it, and
 * transfer it to another student. That is issuing a prepaid payment instrument under the
 * Payment and Settlement Systems Act 2024 s.15(1), and it was live.
 *
 * The boot guard in config.js refuses to START in closed_loop. That is necessary but not
 * sufficient: it stops the wrong MODE, not the wrong OPERATIONS. Every function that
 * credits, debits or moves an internally-held balance has to ask this question, and asking
 * it in one place is what stops the next such function from forgetting.
 *
 * It belongs in the domain layer, not the UI. Hiding a button is presentation; a route
 * still reachable by curl is not controlled by what the browser chose to render.
 */

/** True when this deployment is permitted to hold a student balance at all. */
export const holdsBalances = () => config.walletMode === 'closed_loop';

/**
 * Refuse an operation that would move internally-held money.
 *
 * @param {Function} ErrorClass  the caller's domain error, so the HTTP layer maps it as usual
 * @param {string}   instead     what the student should do in this deployment
 */
export function refuseCustody(ErrorClass, instead) {
  if (holdsBalances()) return;
  throw new ErrorClass(409, 'ZERO_FLOAT',
    `This deployment does not hold balances — ${instead}`);
}
