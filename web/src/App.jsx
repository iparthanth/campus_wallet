import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, formatPaisa, getToken } from './api.js';
import Auth from './Auth.jsx';
import Send from './Send.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [balance, setBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const [flags, setFlags] = useState([]);
  const [view, setView] = useState('wallet'); // wallet | send | history | flags
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(getToken()));

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [w, t] = await Promise.all([api.wallet(), api.transactions()]);
      setBalance(w.balance_paisa);
      setTxs(t.transactions);
    } catch (err) {
      if (err.status === 401) { clearToken(); setUser(null); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // A stored token means a returning user — restore the session instead of showing login.
  useEffect(() => {
    if (getToken() && !user) {
      setUser({ restored: true });
      refresh();
    } else {
      setLoading(false);
    }
  }, [user, refresh]);

  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  async function openFlags() {
    setView('flags');
    setError('');
    try {
      setFlags((await api.flags()).flags);
    } catch (err) {
      setError(err.status === 403 ? 'Admin access required.' : err.message);
      setFlags([]);
    }
  }

  function signOut() {
    clearToken();
    setUser(null);
    setBalance(null);
    setTxs([]);
    setView('wallet');
  }

  if (!user) return <Auth onSignedIn={(u) => { setUser(u); setView('wallet'); }} />;
  if (loading) return <div className="shell"><p className="empty">Loading…</p></div>;

  return (
    <div className="shell">
      <header className="top">
        <h1>Campus Wallet</h1>
        <button className="link" onClick={signOut} data-testid="btn-signout">Sign out</button>
      </header>

      <div className="card">
        <p className="balance-label">Available balance</p>
        <p className="balance" data-testid="balance">
          {balance === null ? '—' : formatPaisa(balance)}
        </p>
      </div>

      <div className="tabs">
        <button className={view === 'wallet' ? 'on' : ''} onClick={() => setView('wallet')} data-testid="tab-wallet">Wallet</button>
        <button className={view === 'send' ? 'on' : ''} onClick={() => { setView('send'); setNotice(''); }} data-testid="tab-send">Send</button>
        <button className={view === 'history' ? 'on' : ''} onClick={() => setView('history')} data-testid="tab-history">History</button>
        <button className={view === 'flags' ? 'on' : ''} onClick={openFlags} data-testid="tab-flags">Flags</button>
      </div>

      {notice && <div className="msg ok" data-testid="notice">{notice}</div>}
      {error && <div className="msg error" data-testid="app-error">{error}</div>}

      {view === 'send' && (
        <Send
          balancePaisa={balance ?? 0}
          onCancel={() => setView('wallet')}
          onDone={(res) => {
            const flagged = res.transaction.status === 'flagged';
            setNotice(flagged
              ? `Sent ${formatPaisa(res.transaction.amount_paisa)} — flagged for review (${res.flags.map((f) => f.rule_name).join(', ')})`
              : `Sent ${formatPaisa(res.transaction.amount_paisa)}`);
            setView('wallet');
            refresh();
          }}
        />
      )}

      {(view === 'wallet' || view === 'history') && (
        <div className="card">
          <p className="balance-label">{view === 'wallet' ? 'Recent activity' : 'All transactions'}</p>
          {txs.length === 0 ? (
            <p className="empty" data-testid="tx-empty">No transactions yet.</p>
          ) : (
            <div data-testid="tx-list">
              {(view === 'wallet' ? txs.slice(0, 5) : txs).map((t) => (
                <div className="tx" key={t.id} data-testid="tx-row">
                  <div>
                    <div className="who">
                      {t.direction === 'credit' ? 'From' : 'To'} {t.counterparty_email}
                      {t.status === 'flagged' && <span className="chip" data-testid="tx-flagged">flagged</span>}
                    </div>
                    <div className="when">{new Date(t.created_at).toLocaleString()}</div>
                  </div>
                  <div className={`amt ${t.direction}`} data-testid="tx-amount">
                    {t.direction === 'credit' ? '+' : '−'}{formatPaisa(t.amount_paisa)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'flags' && (
        <div className="card">
          <p className="balance-label">Fraud flags (admin)</p>
          {flags.length === 0 ? (
            <p className="empty" data-testid="flags-empty">No flags to review.</p>
          ) : (
            <div data-testid="flag-list">
              {flags.map((f) => (
                <div className="flag" key={f.id} data-testid="flag-row">
                  <span className="rule">{f.rule_name}</span> — {f.detail}
                  <div className="when">{f.sender_email} → {f.recipient_email} · {formatPaisa(f.amount_paisa)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
