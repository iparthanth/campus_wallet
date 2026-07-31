import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, formatPaisa, getRole, getToken } from './api.js';
import Auth from './Auth.jsx';
import Send from './Send.jsx';
import TopUp from './TopUp.jsx';
import Analytics from './Analytics.jsx';
import PayCharge from './PayCharge.jsx';
import Payments from './Payments.jsx';
import Counter from './Counter.jsx';
import Reconciliation from './Reconciliation.jsx';
import PhoneVerify from './PhoneVerify.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { useToast } from './components/Toasts.jsx';
import { Avatar, EmptyState, Message, SkeletonRows } from './components/ui.jsx';

/**
 * `needs: 'custody'` marks a screen that only makes sense when this deployment holds
 * student balances — sending money to another student, and topping one up.
 *
 * In zero-float (production, and the only lawful mode) those screens are gone, because the
 * balance behind them does not exist. They are hidden here AND refused by the API, since a
 * hidden button is presentation and the route is still reachable by curl.
 */
const NAV = [
  { key: 'wallet',  label: 'Payments',   icon: '◎' },
  { key: 'pay',     label: 'Pay a bill', icon: '⌗' },
  { key: 'send',    label: 'Send',       icon: '↗', needs: 'custody' },
  { key: 'history', label: 'History',    icon: '≡', needs: 'custody' },
  { key: 'topup',   label: 'Top up',     icon: '+', needs: 'topup' },
  { key: 'counter', label: 'Counter',    icon: '▤', needs: 'operator' },
  { key: 'account', label: 'Account',    icon: '☺' },
  { key: 'admin',   label: 'Dashboard',  icon: '◫', needs: 'admin' },
  { key: 'recon',   label: 'Reconcile',  icon: '⇄', needs: 'admin' },
];

export default function App() {
  const toast = useToast();
  const [user, setUser] = useState(null);
  const [balance, setBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const [view, setView] = useState('wallet');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [topupOk, setTopupOk] = useState(false);
  // Whether this deployment holds balances at all. Asked of the server rather than assumed:
  // production is always zero_float (the API refuses to boot otherwise), but the demo mode
  // still exists and the UI must match whichever is running. Defaults to false so a failed
  // lookup hides the balance screens rather than offering money that may not exist.
  const [holdsBalance, setHoldsBalance] = useState(false);
  const [isOperator, setIsOperator] = useState(false);

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

  useEffect(() => {
    if (getToken() && !user) { setUser({ restored: true }); refresh(); }
    else setLoading(false);
  }, [user, refresh]);

  useEffect(() => { if (user) refresh(); }, [user, refresh]);
  useEffect(() => { api.topupAvailable().then((r) => setTopupOk(r.available)).catch(() => setTopupOk(false)); }, []);
  useEffect(() => { api.mode().then((m) => setHoldsBalance(Boolean(m.holds_balance))).catch(() => setHoldsBalance(false)); }, []);

  // Ask the server, not the token: operating an outlet is a database fact, and the
  // endpoint answers 403 for everyone else.
  useEffect(() => {
    if (!user) return;
    // outletSummary, not the legacy merchantSummary: both resolve by operator_id, but this
    // one is the zero-float route the Counter screen itself uses.
    api.outletSummary().then(() => setIsOperator(true)).catch(() => setIsOperator(false));
  }, [user]);

  // Coming back from the SSLCommerz gateway.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('topup');
    if (!t) return;
    if (t === 'success') toast('Top-up received — your balance has been updated.');
    if (t && t !== 'success') setError(
      t === 'cancelled' ? 'Top-up cancelled.' :
      t === 'failed' ? 'The payment did not go through.' :
      'We could not confirm that payment. If money left your account, contact the office with your transaction id.');
    window.history.replaceState({}, '', window.location.pathname);
    refresh();
  }, [refresh, toast]);

  function signOut() {
    clearToken(); setUser(null); setBalance(null); setTxs([]); setView('wallet');
  }

  if (!user) return (
    <Auth onSignedIn={(u, opts) => {
      setUser(u);
      // Send a brand-new account straight to phone verification; returning users land
      // on their wallet. Verification is encouraged, never a hard wall — the account
      // already exists and works.
      setView(opts?.justRegistered ? 'account' : 'wallet');
    }} />
  );

  const isAdmin = getRole() === 'admin';
  const visible = NAV.filter((n) => {
    if (!n.needs) return true;
    if (n.needs === 'admin') return isAdmin;
    if (n.needs === 'operator') return isOperator;
    if (n.needs === 'custody') return holdsBalance;
    // Top-up is a balance operation too, so it needs custody as well as a working gateway.
    return holdsBalance && topupOk;
  });
  const shown = view === 'history' ? txs : txs.slice(0, 6);

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">CW</span>
          <div>
            <div className="brand-name">Campus Wallet</div>
            <div className="brand-sub">Premier University</div>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          {visible.map((n) => (
            <button
              key={n.key}
              aria-current={view === n.key ? 'page' : undefined}
              onClick={() => setView(n.key)}
              data-testid={`tab-${n.key === 'admin' ? 'flags' : n.key}`}
            >
              <span className="ico" aria-hidden="true">{n.icon}</span>{n.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ThemeToggle />
          <div>
            <div className="who-name">{isAdmin ? 'Administrator' : 'Signed in'}</div>
          </div>
          <button className="btn btn-ghost" onClick={signOut} data-testid="btn-signout">Sign out</button>
        </div>
      </aside>

      <main className="main" id="main">
        <div className="main-inner view" key={view}>
          {view === 'recon' ? (
            <>
              <header className="page-head">
                <h1 className="page-title">Reconciliation</h1>
                <p className="page-sub">Match the bank&rsquo;s settlement against what the campus sold.</p>
              </header>
              <Reconciliation />
            </>
          ) : view === 'admin' ? (
            <>
              <header className="page-head">
                <h1 className="page-title">Dashboard</h1>
                <p className="page-sub">Volume, senders, and everything the fraud rules held for review.</p>
              </header>
              <Analytics />
            </>
          ) : (
            <>
              <header className="page-head">
                <h1 className="page-title">
                  {view === 'send' ? 'Send money' : view === 'topup' ? 'Top up'
                    : view === 'pay' ? 'Pay a bill' : view === 'counter' ? 'Counter'
                    : view === 'account' ? 'Account'
                    : view === 'history' ? 'Transaction history'
                    : holdsBalance ? 'Wallet' : 'Payments'}
                </h1>
                <p className="page-sub">
                  {view === 'send' ? 'Transfer balance to another student.'
                    : view === 'topup' ? 'Add balance with bKash, Nagad, Rocket or a card.'
                    : view === 'pay' ? 'Enter the reference shown on the counter screen to see what you are being charged.'
                    : view === 'counter' ? 'Raise a bill for a student to scan.'
                    : view === 'account' ? 'Verify the mobile number tied to this account.'
                    : view === 'history' ? 'Every transfer in and out of this wallet.'
                    : holdsBalance ? 'Your balance and recent activity.'
                    : 'What you have paid on campus, and the reference that proves it.'}
                </p>
              </header>

              {holdsBalance && view !== 'send' && view !== 'topup' && view !== 'pay' && view !== 'counter' && view !== 'account' && (
                <div className="card">
                  <div className="hero-row">
                    <div>
                      <div className="label-eyebrow">Available balance</div>
                      {loading
                        ? <div className="skel" style={{ width: 180, height: 44, marginTop: 8 }} />
                        : <div className="hero-figure" data-testid="balance">{formatPaisa(balance ?? 0)}</div>}
                    </div>
                    <div className="btn-row" style={{ marginTop: 0 }}>
                      <button className="btn" onClick={() => setView('send')}>Send money</button>
                      <button className="btn btn-ghost" onClick={() => setView('pay')}>Pay a bill</button>
                      {topupOk && <button className="btn btn-ghost" onClick={() => setView('topup')}>Top up</button>}
                    </div>
                  </div>
                </div>
              )}

              {error && <Message kind="error" testid="app-error">{error}</Message>}

              {view === 'send' && (
                <Send
                  balancePaisa={balance ?? 0}
                  onCancel={() => setView('wallet')}
                  onDone={(res) => {
                    const flagged = res.transaction.status === 'flagged';
                    toast(flagged
                      ? `Sent ${formatPaisa(res.transaction.amount_paisa)} — held for review (${res.flags.map((f) => f.rule_name).join(', ')})`
                      : `Sent ${formatPaisa(res.transaction.amount_paisa)}`);
                    setView('wallet'); refresh();
                  }}
                />
              )}

              {view === 'pay' && (
                <PayCharge
                  balancePaisa={balance ?? 0}
                  onCancel={() => setView('wallet')}
                  onPaid={(res) => {
                    toast(`Paid ${formatPaisa(res.amount_paisa)} to ${res.merchant_name}`);
                    setView('wallet'); refresh();
                  }}
                />
              )}

              {view === 'counter' && <Counter />}

              {view === 'account' && <PhoneVerify />}

              {view === 'topup' && (
                <TopUp onCancel={() => setView('wallet')} />
              )}

              {/*
                Zero-float: the home screen IS the payment record. Peer-to-peer transfers do
                not exist here, so a "recent activity" list of them would be permanently
                empty and would imply a feature the deployment does not offer.
              */}
              {view === 'wallet' && !holdsBalance && (
                <Payments onPay={() => setView('pay')} />
              )}

              {((view === 'wallet' && holdsBalance) || view === 'history') && (
                <div className="card">
                  <div className="card-head">
                    <h2 className="card-title">{view === 'wallet' ? 'Recent activity' : 'All transactions'}</h2>
                    {view === 'wallet' && txs.length > 6 && (
                      <button className="btn-link" onClick={() => setView('history')}>View all</button>
                    )}
                  </div>

                  {loading ? <SkeletonRows count={3} />
                    : txs.length === 0 ? (
                      <EmptyState mark="◎" title="No transactions yet"
                        text="Money you send or receive will appear here." testid="tx-empty" />
                    ) : (
                      <div className="rows" data-testid="tx-list">
                        {shown.map((t) => (
                          <div className="row" key={t.id} data-testid="tx-row">
                            <Avatar email={t.counterparty_email} />
                            <div className="row-main">
                              <div className="row-title">
                                {t.counterparty_email}
                                {t.status === 'flagged' && <> <span className="chip" data-testid="tx-flagged">flagged</span></>}
                              </div>
                              <div className="row-meta">
                                {t.direction === 'credit' ? 'Received' : 'Sent'} · {new Date(t.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </div>
                            <div className={`row-amount ${t.direction === 'credit' ? 'amt-credit' : 'amt-debit'}`} data-testid="tx-amount">
                              {t.direction === 'credit' ? '+' : '−'}{formatPaisa(t.amount_paisa)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
