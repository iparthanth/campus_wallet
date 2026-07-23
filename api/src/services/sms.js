import { config } from '../config.js';

/**
 * SMS delivery for Bangladeshi numbers.
 *
 * Real A2P SMS in Bangladesh must go through a BTRC-enlisted aggregator — there is no
 * legal direct-to-operator path, and international CPaaS is both ~180x the price and
 * commonly barred from carrying local OTP traffic. So this speaks the two documented
 * local shapes, selectable by config, plus a console provider for development.
 *
 * A non-masking account needs only an NID (no trade licence), which is why a student can
 * legally send real OTPs today; a branded sender ID ("masking") requires a trade licence.
 */

/** Normalises anything a student might type into the form the gateways expect. */
export function normalizeBdPhone(input) {
  const digits = String(input ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  let local;
  if (/^880\d{10}$/.test(digits)) local = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) local = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) local = digits;
  else return null;

  // 013/017 GP · 014/019 Banglalink · 015 Teletalk · 016 Airtel · 018 Robi.
  // Anything else is a typo, not a Bangladeshi SIM — reject before spending an SMS.
  if (!/^1[3-9]\d{8}$/.test(local)) return null;
  return `880${local}`;
}

/**
 * BTRC requires bulk SMS templates to be in Bengali (memorandum effective 7 March 2022);
 * digits, OTPs and URLs may remain in English. Composing the message here keeps that
 * compliance decision in one place instead of scattered through the domain code.
 */
export function otpMessage(code, minutes) {
  return `ক্যাম্পাস ওয়ালেট: আপনার ভেরিফিকেশন কোড ${code}। মেয়াদ ${minutes} মিনিট।`;
}

const consoleProvider = {
  name: 'console',
  async send(to, message) {
    console.log(JSON.stringify({ level: 'info', msg: 'SMS (console provider)', to, message }));
    return { ok: true, provider: 'console', id: `console-${Date.now()}` };
  },
};

/** Alpha SMS — sms.net.bd. POST form; success is error === 0. */
const alphaProvider = {
  name: 'alpha',
  async send(to, message) {
    const body = new URLSearchParams({ api_key: config.sms.apiKey, msg: message, to });
    if (config.sms.senderId) body.set('sender_id', config.sms.senderId);

    const res = await fetch('https://api.sms.net.bd/sendsms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    // 0 = submitted. 410 expired account, 411 reseller, 412 insufficient balance, 413 invalid.
    if (data.error !== 0) {
      throw new Error(`Alpha SMS error ${data.error}: ${data.msg ?? 'unknown'}`);
    }
    return { ok: true, provider: 'alpha', id: String(data.data?.request_id ?? '') };
  },
};

/** BulkSMSBD — GET query string; success is response code 202. */
const bulkSmsBdProvider = {
  name: 'bulksmsbd',
  async send(to, message) {
    const url = new URL('http://bulksmsbd.net/api/smsapi');
    url.searchParams.set('api_key', config.sms.apiKey);
    url.searchParams.set('type', 'text');
    url.searchParams.set('number', to);
    url.searchParams.set('senderid', config.sms.senderId);
    url.searchParams.set('message', message);

    const res = await fetch(url);
    const text = await res.text();
    if (!/202/.test(text)) {
      throw new Error(`BulkSMSBD rejected the message: ${text.slice(0, 120)}`);
    }
    return { ok: true, provider: 'bulksmsbd', id: text.trim().slice(0, 60) };
  },
};

const PROVIDERS = { alpha: alphaProvider, bulksmsbd: bulkSmsBdProvider, console: consoleProvider };

export const smsProvider = config.sms.enabled
  ? (PROVIDERS[config.sms.provider] ?? alphaProvider)
  : consoleProvider;

export async function sendSms(to, message) {
  return smsProvider.send(to, message);
}
