import { useEffect, useState } from 'react';
import { api, formatPaisa } from './api.js';
import { Field, Message } from './components/ui.jsx';

/**
 * The student side of a counter payment.
 *
 * Two genuinely different flows, because the deployment mode changes who moves the money:
 *
 *   zero_float (production)  The student already paid — or is about to — from their own
 *                            bKash / Nagad / bank app, by scanning the outlet's Bangla QR.
 *                            This screen is a LOOKUP: what am I being charged, by whom, and
 *                            what reference proves it. There is deliberately no Pay button,
 *                            because this system cannot move money and must not imply it can.
 *
 *   closed_loop (demo only)  The legacy flow: confirm, and the balance moves internally.
 *
 * The mode comes from the API rather than a build flag, so a single build behaves correctly
 * against either deployment and the two can never silently disagree.
 */
export default function PayCharge({ balancePaisa, onPaid, onCancel }) {
  const [code, setCode] = useState('');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [holdsBalance, setHoldsBalance] = useState(null); // null = not yet known

  useEffect(() => {
    // If this fails, assume the safe answer: no internal balance, so no Pay button.
    api.mode().then((m) => setHoldsBalance(Boolean(m.holds_balance))).catch(() => setHoldsBalance(false));
  }, []);

  async function look(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Accept a pasted deep link as well as a bare code.
      const token = code.trim().replace(/^campuswallet:\/\/pay\//, '');
      const o = holdsBalance ? await api.charge(token) : await api.order(token);
      if (o.status === 'expired') throw new Error('This order has expired. Ask the counter to raise it again.');
      setOrder({ ...o, token });
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
      onPaid(await api.payCharge(order.token));
    } catch (err) {
      setError(err.message);
      setOrder(null);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------- zero-float: lookup only */
  if (order && !holdsBalance) {
    const settled = order.status === 'paid';
    return (
      <div className="card" style={{ maxWidth: 460 }} data-testid="order-detail">
        <div className="label-eyebrow">{order.merchant_name}</div>
        <div className="hero-figure" data-testid="pay-amount">{formatPaisa(order.amount_paisa)}</div>
        {order.memo && <p className="card-note">{order.memo}</p>}

        {settled ? (
          <Message kind="success" testid="order-settled">
            <strong>Paid.</strong> Recorded against reference <code>{order.order_ref}</code>.
          </Message>
        ) : (
          <>
            <Message kind="info">
              <strong>Pay from your own app.</strong> Scan the Bangla QR on the counter screen
              with bKash, Nagad, Rocket, upay or any bank app. The university does not hold a
              balance for you, so there is nothing to pay from here.
            </Message>
            {/*
              The reference is the student's protection. If a payment goes astray, this is
              what the accounts office matches against — so it is shown prominently rather
              than buried, and it is the one thing worth writing down.
            */}
            <div className="rows" style={{ marginTop: 'var(--s5)' }}>
              <div className="row">
                <span className="row-meta">Reference</span>
                <span className="row-main" style={{ textAlign: 'right', fontWeight: 550 }}>
                  <code data-testid="order-ref">{order.order_ref}</code>
                </span>
              </div>
            </div>
            <p className="field-hint">
              Payments are confirmed against the bank&rsquo;s settlement file, usually by the
              next morning. Your own banking app is your immediate receipt.
            </p>
          </>
        )}

        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => setOrder(null)} disabled={busy}>Back</button>
        </div>
        {error && <Message kind="error" testid="pay-error">{error}</Message>}
      </div>
    );
  }

  /* --------------------------------------------- closed-loop demo: confirm and pay */
  if (order) {
    const short = balancePaisa < order.amount_paisa;
    return (
      <div className="card" style={{ maxWidth: 460 }} data-testid="pay-confirm">
        <div className="label-eyebrow">{order.merchant_name}</div>
        <div className="hero-figure" data-testid="pay-amount">{formatPaisa(order.amount_paisa)}</div>
        {order.memo && <p className="card-note">{order.memo}</p>}

        <div className="rows" style={{ marginTop: 'var(--s5)' }}>
          <div className="row">
            <span className="row-meta">Balance after</span>
            <span className="row-main" style={{ textAlign: 'right', fontWeight: 550 }}>
              {formatPaisa(balancePaisa - order.amount_paisa)}
            </span>
          </div>
        </div>

        {short && <Message kind="warn">Not enough balance — top up first.</Message>}

        <div className="btn-row">
          <button className="btn" onClick={pay} disabled={busy || short} data-testid="btn-pay-confirm">
            {busy ? 'Paying…' : `Pay ${formatPaisa(order.amount_paisa)}`}
          </button>
          <button className="btn btn-ghost" onClick={() => setOrder(null)} disabled={busy}>Back</button>
        </div>
        {error && <Message kind="error" testid="pay-error">{error}</Message>}
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 460 }}>
      <form onSubmit={look}>
        <Field id="code" label={holdsBalance ? 'Bill code' : 'Order code'} data-testid="input-charge-code"
               value={code} onChange={(e) => setCode(e.target.value)}
               placeholder="Scan the QR, or type the code"
               hint={holdsBalance
                 ? 'The counter shows a code under the QR.'
                 : 'The counter shows a reference under the QR — look up what you are being charged.'}
               required />
        <div className="btn-row">
          <button className="btn" disabled={busy || holdsBalance === null} data-testid="btn-lookup-charge">
            {busy ? 'Looking up…' : 'Continue'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
      {error && <Message kind="error" testid="pay-error">{error}</Message>}
    </div>
  );
}
