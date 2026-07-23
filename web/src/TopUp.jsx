import { useState } from 'react';
import { api, formatPaisa, takaToPaisa } from './api.js';

/**
 * bKash top-up.
 *
 * The "I already paid" button is the important one. In Bangladesh a payment frequently
 * completes while the callback never arrives — the app is backgrounded, the network
 * drops, the tab is closed. Without a way to ask bKash what really happened, that
 * student's money is simply gone. This button calls the reconcile endpoint.
 */
export default function TopUp({ onCredited, onCancel }) {
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(null); // { paymentID, bkashURL }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const paisa = takaToPaisa(amount);
      const res = await api.topupCreate(paisa);
      setPending(res);
      // The real flow sends the user to bKash; the window is opened rather than
      // redirected so the wallet keeps its state for the return.
      if (res.bkashURL) window.open(res.bkashURL, '_blank', 'noopener');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function finish(mode) {
    setBusy(true);
    setError('');
    try {
      const res = mode === 'execute'
        ? await api.topupExecute(pending.paymentID)
        : await api.topupReconcile(pending.paymentID);

      if (res.credited) onCredited(pending.amountPaisa ?? 0);
      else setError('That payment has not completed yet on bKash’s side.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="card" data-testid="topup-pending">
        <p className="balance-label">Waiting for bKash</p>
        <p className="hint">Payment reference: <strong>{pending.paymentID}</strong></p>
        <p className="hint">Complete the payment in the bKash window, then confirm below.</p>
        <button onClick={() => finish('execute')} disabled={busy} data-testid="btn-topup-confirm">
          {busy ? 'Checking…' : 'I have paid — credit my wallet'}
        </button>
        <button className="ghost" onClick={() => finish('reconcile')} disabled={busy} data-testid="btn-topup-recover">
          Payment went through but nothing happened
        </button>
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        {error && <div className="msg error" data-testid="topup-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <form onSubmit={start}>
        <label htmlFor="topup-amt">Top up with bKash (৳)</label>
        <input id="topup-amt" data-testid="input-topup" inputMode="decimal" value={amount}
               onChange={(e) => setAmount(e.target.value)} placeholder="500.00" required />
        <p className="hint">Sandbox only — no real money moves.</p>
        <button type="submit" disabled={busy} data-testid="btn-topup-start">
          {busy ? 'Contacting bKash…' : 'Continue to bKash'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </form>
      {error && <div className="msg error" data-testid="topup-error">{error}</div>}
    </div>
  );
}
