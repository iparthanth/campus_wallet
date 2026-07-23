import { config } from '../config.js';

/**
 * SSLCommerz — Bangladesh's largest payment gateway.
 *
 * Chosen over integrating each wallet directly because one SSLCommerz session offers
 * bKash, Nagad, Rocket, upay, TAP and every major local bank. The sandbox runs on
 * published test credentials (store `testbox`), so this integration works end to end
 * without a merchant agreement — unlike bKash direct, which needs onboarding.
 *
 * Flow: initiate() → student pays on SSLCommerz's hosted page → gateway redirects back
 * AND posts an IPN → validate() confirms with SSLCommerz before a single paisa is credited.
 */

const form = (obj) => new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));

/** Opens a payment session and returns the URL to send the student to. */
export async function initiatePayment({ amountPaisa, tranId, customer, callbackBase }) {
  const res = await fetch(`${config.ssl.baseUrl}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      store_id: config.ssl.storeId,
      store_passwd: config.ssl.storePassword,
      // SSLCommerz speaks taka with two decimals; paisa never crosses this boundary.
      total_amount: (amountPaisa / 100).toFixed(2),
      currency: 'BDT',
      tran_id: tranId,
      success_url: `${callbackBase}/topup/ssl/return`,
      fail_url: `${callbackBase}/topup/ssl/return`,
      cancel_url: `${callbackBase}/topup/ssl/return`,
      ipn_url: `${callbackBase}/topup/ssl/ipn`,
      cus_name: customer.name,
      cus_email: customer.email,
      cus_phone: customer.phone ?? '01700000000',
      cus_add1: 'Premier University',
      cus_city: 'Chattogram',
      cus_postcode: '4000',
      cus_country: 'Bangladesh',
      product_name: 'Campus Wallet top-up',
      product_category: 'topup',
      product_profile: 'non-physical-goods',
      shipping_method: 'NO',
    }),
  });

  const data = await res.json();
  if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
    const err = new Error(`SSLCommerz refused the session: ${data.failedreason ?? data.status}`);
    err.gatewayStatus = data.status;
    throw err;
  }
  return {
    gatewayUrl: data.GatewayPageURL,
    sessionKey: data.sessionkey,
    // What the student will actually see as options — handy for the UI copy.
    methods: (data.desc ?? []).map((d) => d.name),
  };
}

/**
 * Confirm a payment with SSLCommerz directly.
 *
 * THIS IS THE SECURITY BOUNDARY. The browser is redirected back with parameters that a
 * user can edit; trusting them would let anyone top up by hand-crafting a success URL.
 * Only this server-to-server response decides whether money is credited.
 */
export async function validatePayment(valId) {
  const url = new URL(`${config.ssl.baseUrl}/validator/api/validationserverAPI.php`);
  url.searchParams.set('val_id', valId);
  url.searchParams.set('store_id', config.ssl.storeId);
  url.searchParams.set('store_passwd', config.ssl.storePassword);
  url.searchParams.set('format', 'json');

  const res = await fetch(url);
  const data = await res.json();

  return {
    // VALID = paid. VALIDATED = paid and already confirmed once before (a replay).
    ok: data.status === 'VALID' || data.status === 'VALIDATED',
    status: data.status,
    tranId: data.tran_id,
    amountTaka: Number(data.amount ?? 0),
    currency: data.currency,
    method: data.card_type ?? data.card_issuer ?? null,
    bankTranId: data.bank_tran_id ?? null,
    raw: data,
  };
}
