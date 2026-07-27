import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatPaisa } from './api.js';
import { EmptyState, Message, SkeletonRows, StatTile } from './components/ui.jsx';

/**
 * What a student sees instead of a balance.
 *
 * The balance had to go: holding one means the university is issuing a prepaid payment
 * instrument, which it may not do. But deleting it and leaving an empty screen would be a
 * downgrade dressed up as compliance, so this answers the questions that actually matter
 * when you are standing at a counter or arguing with the accounts office:
 *
 *   what have I paid · to whom · when · and what reference proves it.
 *
 * A balance never answered the last one, which is the one a dispute turns on.
 */
export default function Payments({ onPay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.myPayments());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /*
   * Poll only while a payment is actually in flight, and stop when it settles.
   *
   * On Bangladeshi mobile data the gateway's redirect frequently never arrives, so a
   * student who has paid can be left staring at a screen that still says "awaiting
   * payment". The server-to-server IPN resolves it within seconds — this is what surfaces
   * that without a manual refresh.
   *
   * Polling stops the moment nothing is pending: a timer that runs forever on a phone is
   * battery and mobile data someone else pays for.
   */
  const inFlight = data?.totals?.in_flight_count ?? 0;
  const timer = useRef(null);
  useEffect(() => {
    if (inFlight === 0) return undefined;
    timer.current = setInterval(load, 4000);
    return () => clearInterval(timer.current);
  }, [inFlight, load]);

  if (loading) return <SkeletonRows rows={4} />;

  const payments = data?.payments ?? [];
  const totals = data?.totals ?? {};

  return (
    <div className="stack">
      {error && <Message kind="error">{error}</Message>}

      <div className="grid grid-3">
        <StatTile label="Paid through this system" value={formatPaisa(totals.paid_paisa ?? 0)}
                  foot={`${totals.paid_count ?? 0} payment(s)`} testid="paid-total" />
        <StatTile label="Awaiting confirmation" value={totals.in_flight_count ?? 0}
                  foot={inFlight > 0 ? 'checking…' : 'nothing pending'} />
        <StatTile label="Balance held for you" value="৳0.00"
                  foot="by design — see below" />
      </div>

      {/*
        Said plainly rather than left as an absence. A student who remembers a balance and
        finds it gone should learn why here, not conclude their money vanished.
      */}
      <Message kind="info" testid="zero-float-note">
        <strong>This app never holds your money.</strong> You pay each outlet directly from
        your own bKash, Nagad, Rocket, upay or bank app, and the university records what you
        paid. There is no balance to top up and nothing of yours to lose if you stop using it.
      </Message>

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Your payments</h2>
          <button className="btn btn-ghost" onClick={() => onPay?.()} style={{ width: 'auto' }}>
            Pay a bill
          </button>
        </div>

        {payments.length === 0 ? (
          <EmptyState
            mark="⌗"
            title="No payments yet"
            text="Scan the QR at a campus counter, or enter the order code shown beside it."
          />
        ) : (
          <div className="rows" data-testid="payment-rows">
            {payments.map((p) => {
              const settled = p.status === 'PAID';
              const pending = p.status === 'INITIATED';
              return (
                <div className="row" key={p.tran_id}>
                  <div className="row-main">
                    <div className="row-title">
                      {p.merchant_name}
                      {p.memo && <span className="muted"> · {p.memo}</span>}
                    </div>
                    <div className="row-meta">
                      {/*
                        The reference is the student's protection: it is what the accounts
                        office matches against if a payment goes astray, so it is shown on
                        every row rather than hidden behind a detail view.
                      */}
                      <code>{p.order_ref}</code>
                      {' · '}
                      {settled ? `paid${p.method ? ` by ${p.method}` : ''}` : pending ? 'awaiting confirmation' : p.status.toLowerCase()}
                      {' · '}
                      {new Date(p.paid_at ?? p.created_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <div className={`row-amount ${settled ? 'amt-debit' : ''}`}>
                    {formatPaisa(p.gateway_amount_paisa ?? p.amount_paisa)}
                    {pending && <div className="row-meta" style={{ textAlign: 'right' }}>pending</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
