import { useState } from 'react';
import { api, formatPaisa, takaToPaisa } from './api.js';
import { Field, Message } from './components/ui.jsx';

/**
 * Two-step send. The confirm screen restates the amount, the recipient, and the
 * balance that will remain — because a mis-typed amount is unrecoverable once the
 * money has moved, and "are you sure?" with no numbers in it prevents nothing.
 */
export default function Send({ balancePaisa, onDone, onCancel }) {
  const [toEmail, setToEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState('form');
  const [paisa, setPaisa] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per send attempt: a double-click or a retry cannot debit twice.
  const [idemKey] = useState(() => `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  function review(e) {
    e.preventDefault();
    setError('');
    try {
      const p = takaToPaisa(amount);
      if (p > balancePaisa) throw new Error(`You only have ${formatPaisa(balancePaisa)} available`);
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
      onDone(await api.transfer(toEmail.trim().toLowerCase(), paisa, idemKey));
    } catch (err) {
      setError(err.message);
      setStage('form');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'confirm') {
    return (
      <div className="card" data-testid="send-confirm" style={{ maxWidth: 460 }}>
        <div className="label-eyebrow">Confirm transfer</div>
        <div className="hero-figure" data-testid="confirm-amount">{formatPaisa(paisa)}</div>

        <div className="rows" style={{ marginTop: 'var(--s5)' }}>
          <div className="row">
            <span className="row-meta">To</span>
            <span className="row-main" style={{ textAlign: 'right', fontWeight: 550 }} data-testid="confirm-recipient">{toEmail}</span>
          </div>
          <div className="row">
            <span className="row-meta">Balance after</span>
            <span className="row-main" style={{ textAlign: 'right', fontWeight: 550 }}>{formatPaisa(balancePaisa - paisa)}</span>
          </div>
        </div>

        <div className="btn-row">
          <button className="btn" onClick={confirm} disabled={busy} data-testid="btn-confirm">
            {busy ? 'Sending…' : 'Confirm and send'}
          </button>
          <button className="btn btn-ghost" onClick={() => setStage('form')} disabled={busy}>Back</button>
        </div>
        {error && <Message kind="error" testid="send-error">{error}</Message>}
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 460 }}>
      <form onSubmit={review} noValidate>
        <Field id="to" label="Send to" type="email" data-testid="input-to" value={toEmail}
               onChange={(e) => setToEmail(e.target.value)} placeholder="friend@puc.ac.bd" required />
        <Field id="amt" label="Amount" inputMode="decimal" prefix="৳" data-testid="input-amount"
               value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
               hint={`${formatPaisa(balancePaisa)} available`} required />
        <div className="btn-row">
          <button className="btn" type="submit" data-testid="btn-review">Review transfer</button>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
      {error && <Message kind="error" testid="send-error">{error}</Message>}
    </div>
  );
}
