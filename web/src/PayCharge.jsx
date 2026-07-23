import { useState } from 'react';
import { api, formatPaisa } from './api.js';
import { Field, Message } from './components/ui.jsx';

/**
 * The student side of a counter payment.
 *
 * A phone camera opens the QR's `campuswallet://pay/<token>` link; on a laptop the code
 * is typed instead. Either way the student sees the outlet and the amount BEFORE
 * confirming — scanning a code should never move money on its own.
 */
export default function PayCharge({ balancePaisa, onPaid, onCancel }) {
  const [code, setCode] = useState('');
  const [charge, setCharge] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function look(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Accept a pasted deep link as well as a bare code.
      const token = code.trim().replace(/^campuswallet:\/\/pay\//, '');
      const c = await api.charge(token);
      if (c.status !== 'pending') throw new Error(`This bill is ${c.status}.`);
      setCharge({ ...c, token });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError('');
    try {
      onPaid(await api.payCharge(charge.token));
    } catch (err) {
      setError(err.message);
      setCharge(null);
    } finally {
      setBusy(false);
    }
  }

  if (charge) {
    const short = balancePaisa < charge.amount_paisa;
    return (
      <div className="card" style={{ maxWidth: 460 }} data-testid="pay-confirm">
        <div className="label-eyebrow">{charge.merchant_name}</div>
        <div className="hero-figure" data-testid="pay-amount">{formatPaisa(charge.amount_paisa)}</div>
        {charge.memo && <p className="card-note">{charge.memo}</p>}

        <div className="rows" style={{ marginTop: 'var(--s5)' }}>
          <div className="row">
            <span className="row-meta">Balance after</span>
            <span className="row-main" style={{ textAlign: 'right', fontWeight: 550 }}>
              {formatPaisa(balancePaisa - charge.amount_paisa)}
            </span>
          </div>
        </div>

        {short && <Message kind="warn">Not enough balance — top up first.</Message>}

        <div className="btn-row">
          <button className="btn" onClick={pay} disabled={busy || short} data-testid="btn-pay-confirm">
            {busy ? 'Paying…' : `Pay ${formatPaisa(charge.amount_paisa)}`}
          </button>
          <button className="btn btn-ghost" onClick={() => setCharge(null)} disabled={busy}>Back</button>
        </div>
        {error && <Message kind="error" testid="pay-error">{error}</Message>}
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 460 }}>
      <form onSubmit={look}>
        <Field id="code" label="Bill code" data-testid="input-charge-code" value={code}
               onChange={(e) => setCode(e.target.value)} placeholder="Scan the QR, or type the code"
               hint="The counter shows a code under the QR." required />
        <div className="btn-row">
          <button className="btn" disabled={busy} data-testid="btn-lookup-charge">
            {busy ? 'Looking up…' : 'Continue'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
      {error && <Message kind="error" testid="pay-error">{error}</Message>}
    </div>
  );
}
