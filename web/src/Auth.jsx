import { useState } from 'react';
import { api, setToken } from './api.js';
import { Field, Message } from './components/ui.jsx';

export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = isRegister
        ? await api.register(name, email, password)
        : await api.login(email, password);
      setToken(res.token);
      onSignedIn(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="brand" style={{ justifyContent: 'center' }}>
            <span className="brand-mark" aria-hidden="true">CW</span>
          </div>
          <h1 className="auth-title">Campus Wallet</h1>
          <p className="auth-sub">Premier University, Chattogram</p>
        </div>

        <div className="card">
          <div className="seg" role="tablist" aria-label="Sign in or create an account">
            <button role="tab" aria-selected={!isRegister} onClick={() => { setMode('login'); setError(''); }} data-testid="tab-login">
              Sign in
            </button>
            <button role="tab" aria-selected={isRegister} onClick={() => { setMode('register'); setError(''); }} data-testid="tab-register">
              Create account
            </button>
          </div>

          <form onSubmit={submit} noValidate>
            {isRegister && (
              <Field id="name" label="Full name" data-testid="input-name" value={name}
                     onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            )}
            <Field id="email" label="University email" type="email" data-testid="input-email"
                   value={email} onChange={(e) => setEmail(e.target.value)}
                   placeholder="you@puc.ac.bd" autoComplete="email" required />
            <Field id="password" label="Password" type="password" data-testid="input-password"
                   value={password} onChange={(e) => setPassword(e.target.value)}
                   autoComplete={isRegister ? 'new-password' : 'current-password'}
                   hint={isRegister ? 'At least 8 characters.' : undefined} required />

            <button className="btn btn-block" type="submit" disabled={busy} data-testid="btn-submit">
              {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>

          {error && <Message kind="error" testid="auth-error">{error}</Message>}

          {!isRegister && (
            <div className="demo-note">
              Demo account — <code>partha@puc.ac.bd</code> / <code>password123</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
