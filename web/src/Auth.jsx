import { useState } from 'react';
import { api, setToken } from './api.js';

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
    <div className="shell">
      <header className="top">
        <h1>Campus Wallet</h1>
        <span className="who">Premier University</span>
      </header>

      <div className="card">
        <div className="tabs">
          <button type="button" className={!isRegister ? 'on' : ''} onClick={() => { setMode('login'); setError(''); }} data-testid="tab-login">
            Sign in
          </button>
          <button type="button" className={isRegister ? 'on' : ''} onClick={() => { setMode('register'); setError(''); }} data-testid="tab-register">
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {isRegister && (
            <>
              <label htmlFor="name">Full name</label>
              <input id="name" data-testid="input-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </>
          )}

          <label htmlFor="email">University email</label>
          <input id="email" data-testid="input-email" type="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} placeholder="you@puc.ac.bd" required />

          <label htmlFor="password">Password</label>
          <input id="password" data-testid="input-password" type="password" value={password}
                 onChange={(e) => setPassword(e.target.value)} minLength={8} required />

          <button type="submit" disabled={busy} data-testid="btn-submit">
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {error && <div className="msg error" data-testid="auth-error">{error}</div>}
        {isRegister && <p className="hint">Password must be at least 8 characters.</p>}
      </div>
    </div>
  );
}
