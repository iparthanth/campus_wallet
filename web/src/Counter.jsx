import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, formatPaisa, takaToPaisa } from './api.js';
import { Field, Message, StatTile, EmptyState } from './components/ui.jsx';

/**
 * The counter view — what canteen or photocopy staff use.
 *
 * Deliberately one screen: type the amount, show the QR, done. Counter staff are
 * serving a queue at lunchtime, so anything requiring navigation would not be used.
 */
export default function Counter() {
  const [summary, setSummary] = useState(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [charge, setCharge] = useState(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.merchantSummary().then(setSummary).catch((e) =>
    setError(e.status === 403 ? 'This account does not operate a campus outlet.' : e.message));

  useEffect(() => { load(); }, []);

  // Poll while a bill is open so the counter sees "paid" without touching anything —
  // staff have their hands full; they should not have to refresh.
  useEffect(() => {
    if (!charge) return undefined;
    const t = setInterval(async () => {
      try {
        const c = await api.charge(charge.token);
        if (c.status === 'paid') { setCharge(null); setQr(''); setAmount(''); setMemo(''); load(); }
        else if (c.status === 'expired') { setCharge(null); setQr(''); }
      } catch { /* transient — keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [charge]);

  async function raise(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const c = await api.createCharge(takaToPaisa(amount), memo.trim() || undefined);
      setCharge(c);
      setQr(await QRCode.toDataURL(c.qr_payload, { width: 260, margin: 1, color: { dark: '#0b0b0b', light: '#fcfcfb' } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !summary) return <Message kind="error" testid="counter-error">{error}</Message>;

  return (
    <>
      {summary && (
        <div className="grid grid-3" data-testid="counter-kpis">
          <StatTile label="Taken today" value={formatPaisa(Number(summary.stats.today_paisa))}
                    foot={`${summary.stats.today_count} sale(s)`} testid="counter-today" />
          <StatTile label="Open bills" value={summary.stats.open_count} foot="awaiting a scan" />
          <StatTile label="Outlet balance" value={formatPaisa(summary.merchant.balance_paisa)}
                    foot={summary.merchant.name} />
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">{charge ? 'Waiting for the student to scan' : 'New bill'}</h2>
            <p className="card-note">{charge ? 'The screen clears itself once it is paid' : 'Enter the amount and show the code'}</p>
          </div>
        </div>

        {charge ? (
          <div style={{ textAlign: 'center' }} data-testid="charge-qr">
            <div className="hero-figure">{formatPaisa(charge.amount_paisa)}</div>
            {charge.memo && <p className="card-note">{charge.memo}</p>}
            {qr && <img src={qr} alt={`QR code for a ${formatPaisa(charge.amount_paisa)} bill`}
                        style={{ margin: '16px auto', display: 'block', borderRadius: 8 }} />}
            <p className="field-hint">
              Or the student can type this code: <strong data-testid="charge-token">{charge.token}</strong>
            </p>
            <button className="btn btn-ghost" style={{ marginTop: 16, width: 'auto' }}
                    onClick={() => { setCharge(null); setQr(''); }}>Cancel this bill</button>
          </div>
        ) : (
          <form onSubmit={raise} style={{ maxWidth: 380 }}>
            <Field id="camt" label="Amount" prefix="৳" inputMode="decimal" data-testid="input-charge-amount"
                   value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
            <Field id="cmemo" label="What for (optional)" data-testid="input-charge-memo"
                   value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Rice, dal, egg" />
            <button className="btn btn-block" disabled={busy} data-testid="btn-raise-charge">
              {busy ? 'Creating…' : 'Show QR code'}
            </button>
          </form>
        )}
        {error && <Message kind="error" testid="counter-error">{error}</Message>}
      </div>

      {summary && (
        <div className="card">
          <div className="card-head"><h2 className="card-title">Recent bills</h2></div>
          {summary.recent.length === 0
            ? <EmptyState mark="◎" title="No bills yet" text="Raised bills appear here." />
            : (
              <div className="rows">
                {summary.recent.map((c) => (
                  <div className="row" key={c.token}>
                    <div className="row-main">
                      <div className="row-title">{c.memo || 'Counter sale'}</div>
                      <div className="row-meta">
                        {c.status === 'paid' ? `paid by ${c.paid_by_email}` : c.status}
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
