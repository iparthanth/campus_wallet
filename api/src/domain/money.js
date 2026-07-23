/**
 * Money is ALWAYS integer paisa. These helpers exist so no other file is tempted
 * to do `amount * 100` with a float and introduce a rounding bug.
 */

export const MAX_TRANSFER_PAISA = 100_000_000; // ৳10,00,000 — sanity cap on a campus wallet

/** True only for a safe, positive, whole number of paisa within the cap. */
export function isValidPaisa(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TRANSFER_PAISA
  );
}

/** 10050 -> "৳100.50" (display only — never feed this back into arithmetic). */
export function formatPaisa(paisa) {
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  return `${sign}৳${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "100.50" | 100.5 -> 10050. Throws rather than silently rounding money. */
export function toPaisa(taka) {
  const n = typeof taka === 'string' ? Number(taka) : taka;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Invalid taka amount');
  const paisa = Math.round(n * 100);
  if (Math.abs(n * 100 - paisa) > 1e-6) throw new Error('Taka amount has sub-paisa precision');
  return paisa;
}
