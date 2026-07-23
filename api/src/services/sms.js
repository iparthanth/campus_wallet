import { config } from '../config.js';

/**
 * SMS delivery, behind one interface.
 *
 * Bangladeshi gateways all expose the same shape — a GET or POST with an api key, a
 * recipient and a message — so swapping provider is a config change, not a rewrite.
 * Without credentials the console provider runs instead, which means phone verification
 * works end to end in development and in CI without spending a paisa or sending a real
 * message to a real person.
 */

/** Normalises anything a student might type into the E.164 form gateways expect. */
export function normalizeBdPhone(input) {
  const digits = String(input ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  // 01712345678 | 8801712345678 | 1712345678  ->  8801712345678
  let local;
  if (/^880\d{10}$/.test(digits)) local = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) local = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) local = digits;
  else return null;

  // Operator prefixes in use: 013 GP, 014 Banglalink, 015 Teletalk, 016 Airtel,
  // 017 GP, 018 Robi, 019 Banglalink. Anything else is a typo, not a Bangladeshi SIM.
  if (!/^1[3-9]\d{8}$/.test(local)) return null;
  return `880${local}`;
}

/** Development / CI: no network, no cost, and the code is visible in the log. */
const consoleProvider = {
  name: 'console',
  async send(to, message) {
    console.log(JSON.stringify({ level: 'info', msg: 'SMS (console provider)', to, message }));
    return { ok: true, provider: 'console', id: `console-${Date.now()}` };
  },
};

/**
 * Generic Bangladeshi bulk-SMS provider (sms.net.bd, MiMSMS, BulkSMSBD and friends all
 * accept this form). Configure SMS_API_URL, SMS_API_KEY and SMS_SENDER_ID.
 */
const httpProvider = {
  name: 'http',
  async send(to, message) {
    const res = await fetch(config.sms.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: config.sms.apiKey,
        senderid: config.sms.senderId,
        msg: message,
        contacts: to,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SMS gateway HTTP ${res.status}: ${text.slice(0, 120)}`);
    return { ok: true, provider: 'http', id: text.slice(0, 60) };
  },
};

export const smsProvider = config.sms.enabled ? httpProvider : consoleProvider;

export async function sendSms(to, message) {
  return smsProvider.send(to, message);
}
