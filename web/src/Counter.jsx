import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, formatPaisa, takaToPaisa } from './api.js';
import { Field, Message, StatTile, EmptyState } from './components/ui.jsx';
import { ReferenceChip, MethodMarks } from './components/payment.jsx';

/**
 * The counter view — what canteen or photocopy staff use.
 *
 * Deliberately one screen: type the amount, show the QR, done. Counter staff are serving a
 * queue at lunchtime, so anything requiring navigation would not be used.
 *
 * The QR shown here is the outlet's **Bangla QR**, which the student pays from their own
 * bKash / Nagad / bank app. The money goes to the university's bank account over licensed
 * rails and never touches this system. The previous version of this screen minted a
 * proprietary `campuswallet://` code — exactly the kind of QR Bangladesh Bank ordered
 * replaced on 1 July 2026, and payable only from a balance the university may not lawfully
 * hold.
 */
export default function Counter() {
  const [summary, setSummary] = useState(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [order, setOrder] = useState(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.outletSummary().then(setSummary).catch((e) =>
    setError(e.status === 403 || e.code === 'NOT_AN_OPERATOR'
      ? 'This account does not operate a campus outlet.'
      : e.message)), []);

  useEffect(() => { load(); }, [load]);

  /**
   * Poll while an order is open so the counter sees "settled" without touching anything.
   *
   * Worth being honest about what this can and cannot show: settlement files arrive from
   * the acquirer on a daily cycle, so in production an order usually clears the following
   * morning, not while the student is standing there. The student's own banking app is
   * their immediate receipt. This poll exists so the screen resets on its own and so the
   * demo — where a settlement can be imported straight away — behaves correctly.
   */
  useEffect(() => {
    if (!order) return undefined;
    const t = setInterval(async () => {
      try {
        const o = await api.order(order.token);
        if (o.status === 'paid') { clear(); load(); }
        else if (o.status === 'expired') { clear(); }
      } catch { /* transient — keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [order, load]);

  function clear() {
    setOrder(null);
    setQr('');
    setAmount('');
    setMemo('');
  }

  async function raise(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const o = await api.raiseOrder(takaToPaisa(amount), memo.trim() || undefined);
      setOrder(o);
      setQr(await QRCode.toDataURL(o.bangla_qr_payload, {
        width: 260,
        margin: 1,
        // Payment QRs get scanned in bad canteen lighting by cheap phone cameras. Higher
        // error correction survives a smudged or partly-obscured screen.
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0b0b', light: '#fcfcfb' },
      }));
    } catch (err) {
      setError(err.code === 'NOT_ONBOARDED'
        ? `${err.message} Until the acquiring bank issues this outlet a merchant ID, it cannot take payment.`
        : err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !summary) return <Message kind="error" testid="counter-error">{error}</Message>;

  const outlet = summary?.outlet;
  const notLive = outlet && !outlet.acquirer_issued;

  return (
    <>
      {/*
        An outlet that has not been onboarded by an acquiring bank cannot collect. Say so
        up front rather than letting staff type an amount and hit a wall — and say who
        unblocks it, because it is not a support ticket, it is the Registrar.
      */}
      {notLive && (
        <Message kind="warn" testid="not-onboarded">
          <strong>{outlet.name} is not live yet.</strong> The acquiring bank has not issued
          this outlet a merchant ID, so it cannot take payment. That step needs the
          university&rsquo;s EIIN, a board resolution and the Registrar&rsquo;s
          recommendation — see the handover document, §5.1.
        </Message>
      )}

      {summary && (
        <div className="grid grid-3" data-testid="counter-kpis">
          <StatTile label="Settled today" value={formatPaisa(Number(summary.stats.settled_today_paisa))}
                    foot={`${summary.stats.settled_today_count} order(s)`} testid="counter-today" />
          <StatTile label="Awaiting payment" value={formatPaisa(Number(summary.stats.awaiting_paisa))}
                    foot={`${summary.stats.awaiting_count} order(s)`} />
          <StatTile label="Outlet" value={outlet?.name ?? '—'}
                    foot={outlet?.acquirer_issued ? `via ${outlet.acquirer_name}` : 'not onboarded'} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">{order ? 'Waiting for the student to pay' : 'New order'}</h2>
            <p className="card-note">
              {order
                ? 'The screen clears itself once the payment is recorded'
                : 'Enter the amount and show the code'}
            </p>
          </div>
        </div>

        {order ? (
          <div style={{ textAlign: 'center' }} data-testid="order-qr">
            <div className="hero-figure">{formatPaisa(order.amount_paisa)}</div>
            {order.memo && <p className="card-note">{order.memo}</p>}

            {/* Framed: a bare QR on a white card reads as decoration, not the instrument. */}
            {qr && (
              <div className="qr-frame" style={{ margin: '16px auto' }}>
                <img src={qr} alt={`Bangla QR for a ${formatPaisa(order.amount_paisa)} order`}
                     style={{ display: 'block' }} />
              </div>
            )}

            <p className="card-note">Scan with any bank or MFS app</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--s2)' }}>
              <MethodMarks />
            </div>

            {/*
              The reference is shown because it is what makes a payment traceable if
              anything goes wrong. Crockford base32 — no I, L, O or U — so a reference read
              aloud across a noisy counter cannot be heard as a different valid one.
            */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <ReferenceChip reference={order.order_ref} hint={false} />
            </div>

            <button className="btn btn-ghost" style={{ marginTop: 16, width: 'auto' }}
                    onClick={clear}>Cancel this order</button>
          </div>
        ) : (
          <form onSubmit={raise} style={{ maxWidth: 380 }}>
            <Field id="camt" label="Amount" prefix="৳" inputMode="decimal" data-testid="input-charge-amount"
                   value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
            <Field id="cmemo" label="What for (optional)" data-testid="input-charge-memo"
                   value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Rice, dal, egg" />
            <button className="btn btn-block" disabled={busy || notLive} data-testid="btn-raise-charge">
              {busy ? 'Creating…' : 'Show QR code'}
            </button>
          </form>
        )}
        {error && <Message kind="error" testid="counter-error">{error}</Message>}
      </div>

      {summary && (
        <div className="card">
          <div className="card-head"><h2 className="card-title">Recent orders</h2></div>
          {summary.recent.length === 0
            ? <EmptyState mark="◎" title="No orders yet" text="Raised orders appear here." />
            : (
              <div className="rows">
                {summary.recent.map((c) => (
                  <div className="row" key={c.token}>
                    <div className="row-main">
                      <div className="row-title">{c.memo || 'Counter sale'}</div>
                      <div className="row-meta">
                        <code>{c.order_ref}</code>
                        {' · '}{c.status === 'paid' ? 'settled' : c.status}
                        {' · '}{new Date(c.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className={`row-amount ${c.status === 'paid' ? 'amt-credit' : ''}`}>
                      {c.status === 'paid' ? '+' : ''}{formatPaisa(c.amount_paisa)}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </>
  );
}
