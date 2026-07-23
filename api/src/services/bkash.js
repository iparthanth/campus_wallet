import { config } from '../config.js';

/**
 * bKash Tokenized Checkout client (sandbox).
 *
 * Flow: Grant Token -> Create Payment -> user pays in bKash -> Execute Payment.
 * Query Payment exists for the case that matters most in Bangladesh: the user completed
 * the payment but the callback never reached us (dropped connection, closed tab, flaky
 * mobile network). Without Query, that money is taken and never credited.
 *
 * Credentials come from the environment and never leave the server.
 */

let cachedToken = null; // { token, expiresAt }

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${config.bkash.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry bKash's own status code so callers can distinguish "you sent a bad paymentID"
    // (a client error) from "bKash is down" (a genuine 502). Collapsing both into a 500
    // makes real outages indistinguishable from typos in the logs.
    const err = new Error(`bKash ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    err.httpStatus = res.status;
    err.bkashStatusCode = data.statusCode;
    throw err;
  }
  return data;
}

/**
 * bKash locks the account if you request tokens too often, so the token is cached for
 * slightly less than its stated lifetime rather than fetched per request.
 */
export async function grantToken({ force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const data = await post('/tokenized/checkout/token/grant', {
    app_key: config.bkash.appKey,
    app_secret: config.bkash.appSecret,
  }, {
    username: config.bkash.username,
    password: config.bkash.password,
  });

  const token = data.id_token;
  if (!token) throw new Error(`bKash token grant returned no id_token: ${JSON.stringify(data).slice(0, 200)}`);

  // expires_in is seconds (typically 3600). Refresh 5 minutes early.
  const ttlMs = (Number(data.expires_in ?? 3600) - 300) * 1000;
  cachedToken = { token, expiresAt: Date.now() + Math.max(ttlMs, 60_000) };
  return token;
}

const authHeaders = (token) => ({ Authorization: token, 'X-App-Key': config.bkash.appKey });

/** Amounts cross the bKash boundary as taka strings; internally we stay in paisa. */
export async function createPayment({ amountPaisa, invoiceNumber, callbackURL }) {
  const token = await grantToken();
  return post('/tokenized/checkout/create', {
    mode: '0011',
    payerReference: invoiceNumber,
    callbackURL,
    amount: (amountPaisa / 100).toFixed(2),
    currency: 'BDT',
    intent: 'sale',
    merchantInvoiceNumber: invoiceNumber,
  }, authHeaders(token));
}

export async function executePayment(paymentID) {
  const token = await grantToken();
  return post('/tokenized/checkout/execute', { paymentID }, authHeaders(token));
}

/** Source of truth when a callback is missing or ambiguous. */
export async function queryPayment(paymentID) {
  const token = await grantToken();
  return post('/tokenized/checkout/payment/status', { paymentID }, authHeaders(token));
}

/** Test seam so the suite can reset the module between cases. */
export const __clearTokenCache = () => { cachedToken = null; };
