import { useState } from 'react';
import { api, formatPaisa, takaToPaisa } from './api.js';
import { Field, Message } from './components/ui.jsx';

const QUICK = [100, 200, 500, 1000];

/**
 * Top up through SSLCommerz — one session covers bKash, Nagad, Rocket, upay and cards,
 * which is why it is preferred over integrating each wallet separately.
 *
 * The student leaves for the gateway and comes back to `/?topup=…`. Nothing here decides
 * whether money arrived: the server validates with SSLCommerz directly, because every
 * parameter on the return trip is editable by the person holding the browser.
 */
export default function TopUp({ onCancel }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = await api.sslCreate(takaToPaisa(amount));
      // Full-page navigation, not a popup: mobile browsers block popups, and the
      // gateway must own the tab for the bank's 3-D Secure step to work.
      window.location.href = session.gatewayUrl;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 460 }}>
      <form onSubmit={start}>
        <Field id="topup-amt" label="Amount" prefix="৳" inputMode="decimal" data-testid="input-topup"
               value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />

        <div className="btn-row" style={{ marginTop: 0, flexWrap: 'wrap' }}>
          {QUICK.map((t) => (
            <button key={t} type="button" className="btn btn-ghost" style={{ flex: '1 0 auto' }}
                    onClick={() => setAmount(String(t))} data-testid={`quick-${t}`}>
              ৳{t}
            </button>
          ))}
        </div>

        <p className="field-hint" style={{ marginTop: 'var(--s4)' }}>
          You will be taken to SSLCommerz to pay with <strong>bKash, Nagad, Rocket, upay</strong> or a card.
          This is the <strong>sandbox</strong> — no real money moves.
        </p>

        <div className="btn-row">
          <button className="btn" disabled={busy} data-testid="btn-topup-start">
            {busy ? 'Opening gateway…' : 'Continue to payment'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
      {error && <Message kind="error" testid="topup-error">{error}</Message>}
    </div>
  );
}
