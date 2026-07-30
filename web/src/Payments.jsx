import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatPaisa } from './api.js';
import { EmptyState, Message, SkeletonRows, StatTile } from './components/ui.jsx';
import { StatePill, ReferenceChip, MethodMarks } from './components/payment.jsx';

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
   * Poll ONLY while a gateway session is open, and give up after two minutes.
   *
   * The first version polled whenever anything was in flight. That is right for a
   * gateway payment — the server-to-server IPN lands within seconds — but wrong for
   * anything confirmed by the next morning's settlement file: it would poll a student's
   * phone all night, on mobile data they pay for by the megabyte, to learn nothing.
   *
   * Two minutes is the honest bound. If the IPN has not arrived by then it is not
   * arriving on this screen, and the answer comes tomorrow.
   */
  const gatewayPending = (data?.in_flight ?? []).filter((p) => p.gateway).length;
  const timer = useRef(null);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (gatewayPending === 0 || gaveUp) return undefined;
    timer.current = setInterval(load, 4000);
    const stop = setTimeout(() => setGaveUp(true), 120_000);
    return () => { clearInterval(timer.current); clearTimeout(stop); };
  }, [gatewayPending, gaveUp, load]);

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
                  foot={gatewayPending > 0 && !gaveUp ? 'checking…' : 'nothing pending'} />
        <StatTile label="Balance held by the university" value="৳0.00"
                  foot="by design — you hold your own money" />
      </div>

      {/*
        Said plainly rather than left as an absence. A student who remembers a balance and
        finds it gone should learn why here, not conclude their money vanished.
      */}
      {/*
        The single most important thing this screen says, and only when it applies. A
        student staring at an unconfirmed payment needs to know their money is safe BEFORE
        they conclude the system ate it and pay a second time — which is a manual refund
        and about a week of someone's attention.
      */}
      {(data?.in_flight?.length ?? 0) > 0 && (
        <Message kind="warn" testid="pending-explainer">
          <strong>Waiting for the bank to confirm.</strong> Campus payments are matched
          against the bank&rsquo;s settlement file, which arrives each morning — we cannot
          see your payment before the bank tells us about it.{' '}
          <strong>If your bKash, Nagad or bank app shows it went through, your money is
          safe;</strong> that app is your receipt until we confirm.{' '}
          <strong>Do not pay this order again</strong> — a second payment has to be refunded
          by hand.
        </Message>
      )}

      <Message kind="info" testid="zero-float-note">
        <strong>This app never holds your money.</strong> You pay each outlet directly from
        your own bKash, Nagad, Rocket, upay or bank app, and the university records what you
        paid. There is no balance to top up and nothing of yours to lose if you stop using it.
      </Message>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Your payments</h2>
            <MethodMarks />
          </div>
          <button className="btn" onClick={() => onPay?.()} style={{ width: 'auto' }}>
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
              return (
                <div className="row" key={p.tran_id}>
                  <div className="row-main">
                    <div className="row-title">
                      {p.merchant_name}
                      {p.memo && <span className="muted"> · {p.memo}</span>}
                    </div>
                    <div className="row-meta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', flexWrap: 'wrap' }}>
                      {/*
                        The reference is the student's protection — what the accounts office
                        matches against if a payment goes astray — so it is on every row in
                        a monospace face, not hidden behind a detail view.
                      */}
                      <span className="ref-inline">{p.order_ref}</span>
                      <StatePill status={p.status} />
                      <span>
                        {/* Year and time always: "27 Jul" is ambiguous on a disputed charge. */}
                        {new Date(p.paid_at ?? p.created_at).toLocaleString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                        {settled && p.method ? ` · ${p.method}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="row-amount money">
                    {formatPaisa(p.gateway_amount_paisa ?? p.amount_paisa)}
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
