import { useState } from 'react';

/**
 * The three words a student is allowed to see about a payment.
 *
 * Used verbatim on every surface — list row, tile, receipt — because a student who learns
 * what "Awaiting confirmation" means on one screen must not meet "Processing" on the next
 * and have to work out whether it is the same thing.
 *
 * Deliberately NOT the internal statuses. The database distinguishes INITIATED, FAILED,
 * CANCELLED, MISMATCH and DUPLICATE because reconciliation needs that detail; a student
 * needs to know only whether their money is accounted for.
 *
 * Three words are banned outright:
 *   "Failed"     — blames the student for a bank's silence
 *   "Success"    — claims settlement before a ledger posting exists
 *   "Processing" — implies someone is working on it right now; nobody is, a batch runs at 06:00
 */
export const PAYMENT_STATE = {
  INITIATED: { label: 'Awaiting confirmation', cls: 'state-wait' },
  PAID:      { label: 'Confirmed',             cls: 'state-ok' },
  FAILED:    { label: 'Not received',          cls: 'state-none' },
  CANCELLED: { label: 'Not received',          cls: 'state-none' },
  // Real money arrived that we cannot attribute cleanly. Never hidden from the student —
  // it is their refund.
  MISMATCH:  { label: 'Needs review',          cls: 'state-none' },
  DUPLICATE: { label: 'Refund due',            cls: 'state-none' },
};

export function StatePill({ status }) {
  const s = PAYMENT_STATE[status] ?? { label: String(status ?? '').toLowerCase(), cls: 'state-wait' };
  return <span className={`state ${s.cls}`}>{s.label}</span>;
}

/**
 * The order reference, built to be copied rather than admired.
 *
 * This is the string a student quotes when a payment goes astray, so it is a 44px tap
 * target with the reason written next to it — not a tiny icon nobody presses. The label
 * says why it matters rather than naming it: "quote this if you need to ask" beats
 * "your reference is".
 */
export function ReferenceChip({ reference, hint = true }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(reference);
    } catch {
      // Clipboard is blocked over plain http and in some in-app browsers. Selecting the
      // text is the fallback that always works, and is better than a silent no-op.
      const r = document.createRange();
      r.selectNodeContents(document.getElementById(`ref-${reference}`));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="stack-sm">
      <button type="button" className="ref-chip" onClick={copy}
              aria-label={`Copy reference ${reference}`} data-testid="ref-chip">
        <span id={`ref-${reference}`}>{reference}</span>
        <span className="ref-hint">{copied ? 'Copied ✓' : 'Tap to copy'}</span>
      </button>
      {hint && (
        <p className="field-hint">Quote this reference if you need to ask about this payment.</p>
      )}
    </div>
  );
}

/**
 * The marks students actually scan for.
 *
 * Recognised far faster than the words "mobile banking", and seeing them is what makes a
 * pay button feel like it leads somewhere real rather than to a card form. Rendered as
 * text on brand-coloured chips: the genuine logos are trademarks we hold no licence to
 * embed, and the Content-Security-Policy forbids loading them from a CDN anyway.
 */
export function MethodMarks({ extra = 33 }) {
  return (
    <div className="methods" aria-label="Accepted payment methods">
      <span className="method method-bkash">bKash</span>
      <span className="method method-nagad">Nagad</span>
      <span className="method method-rocket">Rocket</span>
      <span className="method method-upay">upay</span>
      <span className="method method-card">Cards</span>
      <span className="method method-more">+{extra} more</span>
    </div>
  );
}
