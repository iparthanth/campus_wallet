import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Field, Message } from './components/ui.jsx';

/**
 * Phone verification.
 *
 * This is the wallet's OWN OTP — proving the student holds the SIM — and is unrelated to
 * the PIN/OTP bKash or a bank asks for during a payment. Those belong to the payment
 * provider and never pass through this system.
 */
export default function PhoneVerify() {
  const [status, setStatus] = useState(null);
  const [stage, setStage] = useState('enter');      // enter | code
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [provider, setProvider] = useState('');
  const [devCode, setDevCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.phoneStatus().then(setStatus).catch(() => setStatus({ verified: false })); }, []);

  // Resend timer. The server enforces the cooldown; this only stops the student from
  // hammering a button that is going to be refused anyway.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send(e) {
    e?.preventDefault();
    setError(''); setOk(''); setBusy(true);
    try {
      const res = await api.phoneStart(phone);
      setSentTo(res.sent_to);
      setProvider(res.provider);
      setDevCode(res.dev_code ?? '');
      setStage('code');
      setCooldown(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const res = await api.phoneVerify(code);
      setStatus({ verified: true, phone: res.phone });
      setOk('Number verified.');
      setStage('enter');
      setCode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (status?.verified && stage === 'enter') {
    return (
      <div className="card" style={{ maxWidth: 460 }} data-testid="phone-verified">
        <div className="label-eyebrow">Mobile number</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
          <span style={{ fontSize: 'var(--t-h3)', fontWeight: 620 }}>{status.phone}</span>
          <span className="chip" style={{ background: '#e9f6e9', color: '#0a5c0a', borderColor: 'rgba(12,163,12,.3)' }}>
            verified
          </span>
        </div>
        <p className="field-hint">
          Used to recover your account and to confirm large transfers.
        </p>
        {ok && <Message kind="ok" testid="phone-ok">{ok}</Message>}
        <button className="btn btn-ghost" style={{ width: 'auto', marginTop: 'var(--s4)' }}
                onClick={() => { setStatus({ verified: false }); setPhone(''); setOk(''); }}>
          Change number
        </button>
      </div>
    );
  }

  if (stage === 'code') {
    return (
      <div className="card" style={{ maxWidth: 460 }} data-testid="phone-code-stage">
        <div className="label-eyebrow">Enter the code</div>
        <p className="card-note" style={{ marginTop: 4 }}>
          We sent a 6-digit code to <strong>{sentTo}</strong>. It expires in 5 minutes.
        </p>

        {provider === 'console' && (
          <Message kind="warn" testid="dev-hint">
            Development mode — no SMS was sent (no gateway configured).
            {devCode && (
              <> Your code is <strong data-testid="dev-code" style={{ fontFamily: 'monospace', fontSize: '15px' }}>{devCode}</strong>.{' '}
              <button type="button" className="btn-link" onClick={() => setCode(devCode)} data-testid="btn-usecode">Use it</button>.</>
            )}{' '}Add an SMS key to deliver to a real SIM instead.
          </Message>
        )}

        <form onSubmit={verify} style={{ marginTop: 'var(--s4)' }}>
          <Field id="otp" label="6-digit code" inputMode="numeric" maxLength={6}
                 data-testid="input-otp" value={code} autoComplete="one-time-code"
                 onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                 placeholder="••••••" required />
          <div className="btn-row">
            <button className="btn" disabled={busy || code.length < 6} data-testid="btn-verify-otp">
              {busy ? 'Checking…' : 'Verify'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy || cooldown > 0}
                    onClick={send} data-testid="btn-resend">
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
        </form>

        <button className="btn-link" style={{ marginTop: 'var(--s4)' }}
                onClick={() => { setStage('enter'); setError(''); }}>
          Use a different number
        </button>
        {error && <Message kind="error" testid="phone-error">{error}</Message>}
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 460 }}>
      <div className="label-eyebrow">Verify your mobile number</div>
      <p className="card-note" style={{ marginTop: 4 }}>
        Proves the account is yours. Any Bangladeshi operator — GP, Robi, Banglalink, Teletalk, Airtel.
      </p>
      <form onSubmit={send} style={{ marginTop: 'var(--s4)' }}>
        <Field id="phone" label="Mobile number" inputMode="tel" data-testid="input-phone"
               value={phone} onChange={(e) => setPhone(e.target.value)}
               placeholder="01712345678" hint="With or without +880 — both work." required />
        <button className="btn btn-block" disabled={busy} data-testid="btn-send-otp">
          {busy ? 'Sending…' : 'Send code'}
        </button>
      </form>
      {ok && <Message kind="ok" testid="phone-ok">{ok}</Message>}
      {error && <Message kind="error" testid="phone-error">{error}</Message>}
    </div>
  );
}
