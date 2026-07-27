const TOKEN_KEY = 'cw_token';

/**
 * Where the API lives.
 *
 * Defaults to the same-origin `/api` prefix, which is what development uses (the Vite
 * proxy forwards it and strips the prefix) and what a host with rewrites uses — the
 * browser never makes a cross-origin request, so nothing preflights.
 *
 * VITE_API_BASE overrides it with an absolute URL, for hosts that cannot rewrite to a
 * sibling service. Render fills this in from the API service's own URL at build time, so
 * there is no hostname to paste by hand and nothing to get wrong — the API's CORS_ORIGINS
 * is wired from the frontend's URL the same way, and the two always agree.
 *
 * Note the API mounts its routes at the root (`/auth`, `/wallet`), so the base is a
 * prefix in both cases and the call sites below are identical either way.
 */
const API_BASE = (import.meta.env?.VITE_API_BASE ?? '/api').replace(/\/$/, '');

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Thrown for any non-2xx response, carrying the API's machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects on a network-level failure — DNS, offline, or the backend
    // not deployed yet. Turn that into a clear message instead of a raw "Failed to
    // fetch", so a frontend-only preview says why it cannot sign in.
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. The backend may not be running.');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data.error ?? {};
    // An expired token should log the user out rather than leave them stuck on a dead screen.
    if (res.status === 401 && err.code === 'TOKEN_EXPIRED') clearToken();
    // A non-JSON 404/5xx (no err.code) is the platform, not our API — e.g. the frontend
    // is deployed but /api isn't wired to a backend yet. Say that plainly.
    if (!err.code && (res.status === 404 || res.status >= 500)) {
      throw new ApiError(res.status, 'NO_BACKEND', 'The server is not connected yet. Deploy the API and point /api at it.');
    }
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? 'Request failed');
  }
  return data;
}

export const api = {
  register: (name, email, password) => call('/auth/register', { method: 'POST', body: { name, email, password }, auth: false }),
  login: (email, password) => call('/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  wallet: () => call('/wallet'),
  transfer: (to_email, amount_paisa, idempotency_key) =>
    call('/transfers', { method: 'POST', body: { to_email, amount_paisa, idempotency_key } }),
  transactions: (cursor) => call(`/transactions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  flags: () => call('/admin/flags'),
  analytics: () => call('/admin/analytics'),
  topupAvailable: () => call('/topup/available', { auth: false }),
  topupCreate: (amount_paisa) => call('/topup/create', { method: 'POST', body: { amount_paisa } }),
  topupExecute: (paymentID) => call('/topup/execute', { method: 'POST', body: { paymentID } }),
  topupReconcile: (paymentID) => call('/topup/reconcile', { method: 'POST', body: { paymentID } }),
  // SSLCommerz — one session covers bKash, Nagad, Rocket, upay and cards
  sslCreate: (amount_paisa) => call('/topup/ssl/create', { method: 'POST', body: { amount_paisa } }),
  // Which mode this deployment runs in. Production is always zero_float — the API refuses
  // to boot otherwise — so the UI asks rather than assuming.
  mode: () => call('/mode', { auth: false }),
  // campus outlets
  merchants: () => call('/merchants'),
  merchantSummary: () => call('/merchant/summary'),
  createCharge: (amount_paisa, memo) => call('/merchant/charges', { method: 'POST', body: { amount_paisa, memo } }),
  charge: (token) => call(`/charges/${encodeURIComponent(token)}`),
  payCharge: (token) => call(`/charges/${encodeURIComponent(token)}/pay`, { method: 'POST' }),
  // phone verification (the wallet's own OTP, not the payment provider's)
  phoneStatus: () => call('/phone/status'),
  phoneStart: (phone) => call('/phone/start', { method: 'POST', body: { phone } }),
  phoneVerify: (code) => call('/phone/verify', { method: 'POST', body: { code } }),

  // ---------------------------------------------------------------- zero-float orders
  // The student pays the outlet's Bangla QR from their own bank or MFS app; this system
  // records the order and later matches the acquirer's settlement to it.
  raiseOrder: (amount_paisa, memo) => call('/orders', { method: 'POST', body: { amount_paisa, memo } }),
  order: (token) => call(`/orders/${encodeURIComponent(token)}`),
  outletSummary: () => call('/outlet/summary'),
  // Pay ONE order through the gateway. Returns the hosted checkout URL to send the
  // student to — the money goes to PUC's merchant account, never to a balance here.
  payOrderOnline: (token) => call(`/orders/${encodeURIComponent(token)}/pay/ssl`, { method: 'POST' }),
  orderPayments: (token) => call(`/orders/${encodeURIComponent(token)}/payments`),

  // ---------------------------------------------------------------- reconciliation (admin)
  importSettlement: (payload) => call('/admin/settlements/import', { method: 'POST', body: payload }),
  reconciliationExceptions: () => call('/admin/reconciliation/exceptions'),
  // 409 here is not an error to swallow — it means the two tables disagree.
  crossCheck: () => call('/admin/reconciliation/cross-check'),
  auditRun: () => call('/admin/audit/run'),
  auditRecord: (business_date) => call('/admin/audit/run', { method: 'POST', body: { business_date } }),
  auditHistory: () => call('/admin/audit/history'),
  trialBalance: () => call('/admin/ledger/trial-balance'),
  ledgerAccount: (code) => call(`/admin/ledger/accounts/${encodeURIComponent(code)}`),
};

/**
 * Reads the role claim out of the JWT so the UI can hide admin-only controls.
 *
 * This is a DISPLAY convenience only. The token is not verified here and a user can
 * trivially edit their own localStorage — authorisation is enforced server-side by
 * requireAdmin, which is the only check that counts. Hiding the tab is courtesy;
 * the 403 is the security.
 */
export function getRole() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role ?? null;
  } catch {
    return null;
  }
}

/** 10050 -> "৳100.50". Display only — never feed back into arithmetic. */
export const formatPaisa = (paisa) => {
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  return `${sign}৳${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
};

/** "100.50" -> 10050, refusing anything with sub-paisa precision. */
export function takaToPaisa(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid amount');
  const paisa = Math.round(n * 100);
  if (Math.abs(n * 100 - paisa) > 1e-6) throw new Error('Amount cannot be smaller than 1 paisa');
  return paisa;
}
