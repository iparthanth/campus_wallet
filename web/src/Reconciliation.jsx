import { useCallback, useEffect, useState } from 'react';
import { api, formatPaisa } from './api.js';
import { EmptyState, Message, StatTile, SkeletonRows } from './components/ui.jsx';

/**
 * The reconciliation desk — what replaces reading accounts@puc.ac.bd by hand.
 *
 * Designed around one question an accounts officer actually asks each morning:
 * "does what the bank sent us match what we sold, and if not, exactly where?"
 *
 * So the exceptions are the headline, not a footnote. A dashboard that leads with
 * "৳48,300 collected ✓" and buries three unmatched payments in a tab is the same
 * spreadsheet problem in nicer colours.
 */
export default function Reconciliation() {
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [csv, setCsv] = useState('');
  const [acquirer, setAcquirer] = useState('UCB');
  const [statementDate, setStatementDate] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    setError('');
    try {
      const [exceptions, auditRun] = await Promise.all([
        api.reconciliationExceptions(),
        // A FAILing audit answers 409. That is the alarm, not a crash — read it either way.
        api.auditRun().catch((e) => (e.status === 409 ? e.body ?? { result: 'FAIL' } : null)),
      ]);
      setData(exceptions);
      setAudit(auditRun);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Parse a settlement CSV in the browser.
   *
   * Expected columns: transaction id, order reference, gross, fee. Amounts are entered
   * in TAKA (that is what a bank statement shows) and converted to integer paisa here,
   * once, rather than letting decimal taka leak into the API.
   */
  function parseCsv(text) {
    const rows = text.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length === 0) throw new Error('The statement is empty');

    // Skip an obvious header row.
    const start = /txn|transaction|ref|amount|gross/i.test(rows[0]) ? 1 : 0;
    const lines = [];

    for (let i = start; i < rows.length; i += 1) {
      const cells = rows[i].split(',').map((c) => c.trim());
      if (cells.length < 3) throw new Error(`Line ${i + 1}: expected at least 3 columns, got ${cells.length}`);

      const [txnId, orderRef, grossTaka, feeTaka] = cells;
      const gross = Math.round(Number(grossTaka) * 100);
      const fee = feeTaka ? Math.round(Number(feeTaka) * 100) : 0;

      if (!Number.isInteger(gross) || gross <= 0) {
        throw new Error(`Line ${i + 1}: "${grossTaka}" is not a valid amount`);
      }
      lines.push({
        acquirer_txn_id: txnId,
        order_ref: orderRef || null,
        gross_paisa: gross,
        fee_paisa: fee,
      });
    }
    return lines;
  }

  async function importStatement(e) {
    e.preventDefault();
    setError('');
    setImportResult(null);
    setImporting(true);
    try {
      const lines = parseCsv(csv);
      const result = await api.importSettlement({
        acquirer,
        source_ref: `pasted-${new Date().toISOString().slice(0, 19)}`,
        statement_date: statementDate,
        // The exact bytes, so re-importing the same statement is refused rather than
        // double-counted. This is the guard against the most likely operator mistake.
        raw_content: csv,
        lines,
      });
      setImportResult(result);
      setCsv('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <SkeletonRows rows={5} />;

  const totals = data?.totals ?? {};
  const hasExceptions =
    (data?.unmatched_receipts?.length ?? 0) > 0 || (data?.unsettled_orders?.length ?? 0) > 0;

  return (
    <div className="stack">
      <header className="stack-sm">
        <h2>Reconciliation</h2>
        <p className="muted">
          Matching what the bank collected against what the campus sold. Everything that does
          not match is listed below — those are the ones that need a person.
        </p>
      </header>

      {error && <Message kind="error">{error}</Message>}

      {/* The audit verdict leads, because it is the one-line answer. */}
      {audit && (
        <Message kind={audit.result === 'PASS' ? 'success' : audit.result === 'WARN' ? 'warn' : 'error'}>
          <strong>
            {audit.result === 'PASS' && 'Books balance.'}
            {audit.result === 'WARN' && 'Books balance, with items needing attention.'}
            {audit.result === 'FAIL' && 'The books do not reconcile.'}
          </strong>{' '}
          {audit.result === 'FAIL' ? (
            <>
              Ledger drift {formatPaisa(audit.trial_balance_drift_paisa ?? 0)};{' '}
              {audit.cross_check_discrepancies ?? 0} outlet(s) disagree with the ledger.
              Investigate before trading resumes.
            </>
          ) : (
            <>Total debits equal total credits. Drift {formatPaisa(audit.trial_balance_drift_paisa ?? 0)}.</>
          )}
        </Message>
      )}

      <div className="tiles">
        <StatTile label="Awaiting payment" value={formatPaisa(totals.unsettled_paisa ?? 0)} />
        <StatTile label="Orders unsettled" value={totals.unsettled_order_count ?? 0} />
        <StatTile label="Unexplained receipts" value={totals.unmatched_receipt_count ?? 0} />
        <StatTile label="Aged over 48h" value={audit?.aged_count ?? 0} />
      </div>

      {/* ------------------------------------------------------------ import */}
      <section className="card stack-sm">
        <h3>Import a settlement statement</h3>
        <p className="muted small">
          Paste the acquirer&rsquo;s statement as CSV:{' '}
          <code>transaction id, order reference, gross (৳), fee (৳)</code>. Re-importing the
          same statement is refused, so a double upload cannot double the books.
        </p>

        <form onSubmit={importStatement} className="stack-sm">
          <div className="row">
            <label className="field">
              <span>Acquirer</span>
              <input value={acquirer} onChange={(e) => setAcquirer(e.target.value)} required maxLength={40} />
            </label>
            <label className="field">
              <span>Statement date</span>
              <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} required />
            </label>
          </div>

          <label className="field">
            <span>Statement (CSV)</span>
            <textarea
              rows={6}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={'UCB-88213,PUC-3-K9F2QT7M,85.00,1.70\nUCB-88214,PUC-3-M4R8ZX1P,120.00,2.40'}
              spellCheck={false}
              required
            />
          </label>

          <button type="submit" disabled={importing || !csv.trim()}>
            {importing ? 'Reconciling…' : 'Import and reconcile'}
          </button>
        </form>

        {importResult && (
          <Message kind={importResult.exception_count > 0 ? 'warn' : 'success'}>
            Imported {importResult.line_count} line(s): <strong>{importResult.matched_count} settled</strong>
            {importResult.exception_count > 0 && <>, {importResult.exception_count} need attention</>}.
          </Message>
        )}
      </section>

      {/* ------------------------------------------------- exceptions come first */}
      {!hasExceptions ? (
        <EmptyState
          title="Nothing outstanding"
          body="Every order has a matching payment, and every payment has a matching order."
        />
      ) : (
        <>
          {data.unmatched_receipts.length > 0 && (
            <section className="card stack-sm">
              <h3>Money received that no order explains ({data.unmatched_receipts.length})</h3>
              <p className="muted small">
                Someone paid the university and we cannot tell what for — usually a static QR
                where the payer typed the amount, or a mistyped reference.
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Transaction</th><th>Reference</th><th className="num">Amount</th>
                    <th>Status</th><th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unmatched_receipts.map((r) => (
                    <tr key={r.id}>
                      <td><code>{r.acquirer_txn_id}</code></td>
                      <td>{r.order_ref ?? <span className="muted">— none —</span>}</td>
                      <td className="num">{formatPaisa(r.gross_paisa)}</td>
                      <td><span className={`pill pill-${r.status === 'AMOUNT_MISMATCH' ? 'warn' : 'muted'}`}>{r.status}</span></td>
                      <td className="muted small">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.unsettled_orders.length > 0 && (
            <section className="card stack-sm">
              <h3>Sold, but no payment received ({data.unsettled_orders.length})</h3>
              <p className="muted small">
                Goods left the counter. Anything older than about a day means something upstream
                is broken — a QR that was never scanned, or a statement not yet imported.
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Reference</th><th>Outlet</th><th className="num">Amount</th>
                    <th className="num">Age</th><th>Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unsettled_orders.map((o) => (
                    <tr key={o.id} className={Number(o.age_hours) > 48 ? 'row-warn' : undefined}>
                      <td><code>{o.order_ref}</code></td>
                      <td>{o.merchant_name}</td>
                      <td className="num">{formatPaisa(o.amount_paisa)}</td>
                      <td className="num">{Number(o.age_hours).toFixed(1)}h</td>
                      <td className="muted small">{o.memo ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------------------------ per outlet */}
      {data?.by_outlet?.length > 0 && (
        <section className="card stack-sm">
          <h3>By outlet</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Outlet</th><th className="num">Orders</th><th className="num">Settled</th>
                <th className="num">Collected</th><th className="num">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {data.by_outlet.map((m) => (
                <tr key={m.merchant_id}>
                  <td>{m.merchant_name}</td>
                  <td className="num">{m.orders_total}</td>
                  <td className="num">{m.orders_settled}</td>
                  <td className="num">{formatPaisa(m.settled_paisa)}</td>
                  <td className="num">{formatPaisa(m.unsettled_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
