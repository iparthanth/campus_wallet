import { useMemo, useState } from 'react';
import { api, setToken } from './api.js';
import { Field, Message } from './components/ui.jsx';

/** Cheap, honest password strength — length + variety, no false "Strong!" on `Password1`. */
function scorePassword(pw) {
  if (!pw) return { score: 0, label: '', hint: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  // Obvious ones never rate above weak, whatever their length.
  if (/^(password|12345678|qwerty|11111111)/i.test(pw)) score = 1;
  const label = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Strong'][score];
  const hint = pw.length < 8 ? 'At least 8 characters.'
    : score < 3 ? 'Add a capital, a number, or a symbol.' : '';
  return { score, label, hint };
}

export default function Auth({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';
  const strength = useMemo(() => scorePassword(password), [password]);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const mismatch = isRegister && confirm.length > 0 && confirm !== password;

  const canSubmit = isRegister
    ? name.trim() && emailValid && password.length >= 8 && password.length <= 72 && confirm === password
    : emailValid && password.length > 0;

  function switchMode(next) {
    setMode(next); setError(''); setConfirm(''); setPassword('');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = isRegister
        ? await api.register(name.trim(), email, password)
        : await api.login(email, password);
      setToken(res.token);
      // New accounts are nudged to verify their phone straight after — passed through so
      // the app can surface the prompt rather than burying it in a settings tab.
      onSignedIn(res.user, { justRegistered: isRegister });
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
            <button role="tab" aria-selected={!isRegister} onClick={() => switchMode('login')} data-testid="tab-login">
              Sign in
            </button>
            <button role="tab" aria-selected={isRegister} onClick={() => switchMode('register')} data-testid="tab-register">
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
                   placeholder="you@puc.ac.bd" autoComplete="email"
                   hint={email && !emailValid ? 'Enter a valid email address.' : undefined} required />

            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="field-prefix">
                <input id="password" type={showPw ? 'text' : 'password'} data-testid="input-password"
                       value={password} onChange={(e) => setPassword(e.target.value)}
                       autoComplete={isRegister ? 'new-password' : 'current-password'}
                       maxLength={72} style={{ paddingLeft: '10px', paddingRight: '52px' }} required />
                <button type="button" className="btn-link" onClick={() => setShowPw((v) => !v)}
                        style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 12 }}
                        data-testid="btn-showpw" aria-pressed={showPw}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>

              {isRegister && password && (
                <div style={{ marginTop: 8 }} data-testid="pw-strength">
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} style={{
                        flex: 1, height: 4, borderRadius: 2,
                        background: i < Math.min(strength.score, 4)
                          ? (strength.score >= 4 ? 'var(--good)' : strength.score >= 3 ? 'var(--accent)' : 'var(--warning)')
                          : 'var(--surface-sunk)',
                      }} />
                    ))}
                  </div>
                  <p className="field-hint" style={{ marginTop: 5 }}>
                    <strong>{strength.label}</strong>{strength.hint ? ` — ${strength.hint}` : ''}
                  </p>
                </div>
              )}
            </div>

            {isRegister && (
              <Field id="confirm" label="Confirm password" type={showPw ? 'text' : 'password'}
                     data-testid="input-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                     autoComplete="new-password" maxLength={72}
                     hint={mismatch ? 'Passwords do not match.' : undefined} required />
            )}

            <button className="btn btn-block" type="submit" disabled={busy || !canSubmit} data-testid="btn-submit">
              {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>

          {error && <Message kind="error" testid="auth-error">{error}</Message>}

          <p className="demo-note">
            {isRegister
              ? 'After creating your account you can verify your mobile number to secure it.'
              : 'Use your university email and password.'}
          </p>
        </div>
      </div>
    </div>
  );
}
