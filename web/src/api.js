const TOKEN_KEY = 'cw_token';

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

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data.error ?? {};
    // An expired token should log the user out rather than leave them stuck on a dead screen.
    if (res.status === 401 && err.code === 'TOKEN_EXPIRED') clearToken();
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
