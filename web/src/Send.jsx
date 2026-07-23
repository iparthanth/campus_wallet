import { useState } from 'react';
import { api, formatPaisa, takaToPaisa } from './api.js';

/**
 * Two-step send: enter details, then confirm. The confirm step exists because a
 * mis-typed amount is unrecoverable once money moves.
 */
export default function Send({ balancePaisa, onDone, onCancel }) {
  const [toEmail, setToEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState('form'); // form | confirm
  const [paisa, setPaisa] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Generated once per send attempt so a double-submit cannot debit twice.
  const [idemKey] = useState(() => `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  function review(e) {
    e.preventDefault();
    setError('');
    try {
      const p = takaToPaisa(amount);
      if (p > balancePaisa) throw new Error(`You only have ${formatPaisa(balancePaisa)}`);
      setPaisa(p);
      setStage('confirm');
    } catch (err) {
      setError(err.message);
    }
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await api.transfer(toEmail.trim().toLowerCase(), paisa, idemKey);
      onDone(res);
    } catch (err) {
      setError(err.message);
      setStage('form');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'confirm') {
    return (
      <div className="card" data-testid="send-confirm">
        <p className="balance-label">Confirm transfer</p>
        <p className="balance" data-testid="confirm-amount">{formatPaisa(paisa)}</p>
        <p className="hint">to <strong data-testid="confirm-recipient">{toEmail}</strong></p>
        <p className="hint">Balance after: {formatPaisa(balancePaisa - paisa)}</p>
        <button onClick={confirm} disabled={busy} data-testid="btn-confirm">
          {busy ? 'Sending…' : 'Confirm and send'}
        </button>
        <button className="ghost" onClick={() => setStage('form')} disabled={busy}>Back</button>
        {error && <div className="msg error" data-testid="send-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <form onSubmit={review}>
        <label htmlFor="to">Send to (university email)</label>
        <input id="to" data-testid="input-to" type="email" value={toEmail}
               onChange={(e) => setToEmail(e.target.value)} placeholder="friend@puc.ac.bd" required />

        <label htmlFor="amt">Amount (৳)</label>
        <input id="amt" data-testid="input-amount" inputMode="decimal" value={amount}
               onChange={(e) => setAmount(e.target.value)} placeholder="50.00" required />

        <button type="submit" data-testid="btn-review">Review</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </form>
      {error && <div className="msg error" data-testid="send-error">{error}</div>}
    </div>
  );
}
