/**
 * Bangla QR — EMVCo Merchant-Presented QR Code (MPQR) payload construction.
 *
 * WHY THIS EXISTS
 * ---------------
 * Bangladesh Bank made the interoperable "Bangla QR" compulsory from 1 July 2026 and
 * required anyone running a proprietary QR to replace it. The `campuswallet://pay/<token>`
 * scheme this project shipped before is exactly the proprietary QR that directive outlaws:
 * only the Campus Wallet app could read it, so a student holding bKash, Nagad or a bank app
 * — which is every student — could not pay with the app they already have.
 *
 * A Bangla QR is an EMVCo MPQR payload. Any participating bank or MFS app in Bangladesh can
 * scan it, so the outlet is paid over licensed rails and this system never touches the money.
 *
 * WHAT THIS MODULE IS AND IS NOT
 * ------------------------------
 * It BUILDS and VERIFIES the payload string. It does NOT make a payload payable: the
 * merchant account identifier in tag 26+ is issued by the outlet's acquiring bank or MFS
 * when the outlet is onboarded as a merchant. Until PUC completes that onboarding, this
 * module can only emit payloads carrying a placeholder identifier, which will parse and
 * verify correctly but will be declined by the acquirer. That boundary is deliberate and
 * enforced by requireAcquirerIssued() — silently emitting an unpayable QR at a canteen
 * counter would be worse than emitting none.
 *
 * FORMAT (EMVCo MPQR v1.1)
 * ------------------------
 * The payload is a flat sequence of TLV (tag-length-value) triples:
 *
 *     "00"  "02"  "01"          ← tag 00, length 02, value "01"
 *      ^tag  ^len  ^value
 *
 * Tag and length are always exactly two ASCII digits. Length counts CHARACTERS, not bytes.
 * Tags appear in ascending order, and tag 63 (CRC) is always last.
 */

/** Field length limits from the EMVCo MPQR specification. */
const LIMITS = {
  merchantName: 25, // tag 59
  merchantCity: 15, // tag 60
  postalCode: 10, // tag 61
  amount: 13, // tag 54
  billNumber: 25, // tag 62 sub-tag 01
  referenceLabel: 25, // tag 62 sub-tag 05
  terminalLabel: 25, // tag 62 sub-tag 07
};

/** Merchant Category Code — 8220 is "Colleges, Universities, Professional Schools". */
export const MCC_EDUCATION = '8220';
/** ISO 4217 numeric code for the Bangladeshi Taka. */
export const CURRENCY_BDT = '050';
/** ISO 3166-1 alpha-2. */
export const COUNTRY_BD = 'BD';

/** Point of Initiation Method (tag 01). */
export const STATIC_QR = '11'; // reusable, no amount — printed and stuck to a counter
export const DYNAMIC_QR = '12'; // one bill, carries the amount — regenerated per sale

/**
 * CRC-16/CCITT-FALSE — polynomial 0x1021, initial value 0xFFFF, no input or output
 * reflection, no final XOR. This is the variant EMVCo mandates; the several other
 * "CRC-16 CCITT" variants in circulation (XMODEM with init 0x0000, KERMIT with
 * reflection) produce different digests and are silently wrong here, which is why this
 * is verified against the specification's own test vector in the test suite.
 *
 * Operates on UTF-8 bytes rather than UTF-16 code units, so a payload containing
 * non-ASCII text (tag 64, alternate-language merchant name) still checksums the bytes a
 * scanner actually receives.
 */
export function crc16ccitt(input) {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export class BanglaQrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'BanglaQrError';
  }
}

/**
 * Encode one TLV triple.
 *
 * The length prefix is two digits, so a value longer than 99 characters cannot be
 * represented at all. Throwing beats emitting a truncated length that makes every
 * following tag parse as garbage — a corrupted QR fails at the counter, in front of a
 * student, with no diagnostic.
 */
export function tlv(tag, value) {
  const v = String(value);
  if (!/^\d{2}$/.test(tag)) {
    throw new BanglaQrError('BAD_TAG', `Tag must be exactly two digits, got "${tag}"`);
  }
  if (v.length > 99) {
    throw new BanglaQrError('VALUE_TOO_LONG', `Tag ${tag} value is ${v.length} chars; the 2-digit length prefix caps it at 99`);
  }
  return `${tag}${String(v.length).padStart(2, '0')}${v}`;
}

function requireWithin(name, value, max) {
  const v = String(value ?? '').trim();
  if (!v) throw new BanglaQrError('MISSING_FIELD', `${name} is required`);
  if (v.length > max) {
    throw new BanglaQrError('FIELD_TOO_LONG', `${name} is ${v.length} chars; EMVCo allows at most ${max}`);
  }
  return v;
}

/**
 * Format integer paisa as the EMVCo transaction amount (tag 54).
 *
 * Money stays in integer paisa everywhere else in this codebase; this is the one boundary
 * where it becomes a decimal string, because that is what the specification requires.
 * The conversion is integer division, never floating point.
 */
export function amountFromPaisa(paisa) {
  if (!Number.isInteger(paisa) || paisa <= 0) {
    throw new BanglaQrError('BAD_AMOUNT', 'Amount must be a positive whole number of paisa');
  }
  const taka = Math.floor(paisa / 100);
  const remainder = paisa % 100;
  const formatted = remainder === 0 ? String(taka) : `${taka}.${String(remainder).padStart(2, '0')}`;
  if (formatted.length > LIMITS.amount) {
    throw new BanglaQrError('BAD_AMOUNT', `Amount ${formatted} exceeds the ${LIMITS.amount}-character field`);
  }
  return formatted;
}

/**
 * Build the Merchant Account Information template (tags 26–51).
 *
 * Each template nests its own TLV sequence, whose sub-tag 00 is a globally unique
 * identifier naming the scheme, and whose remaining sub-tags carry the acquirer's own
 * merchant identifier. The exact GUID and sub-tag layout is issued by the acquiring bank
 * or MFS during merchant onboarding — it is not something an application may invent,
 * which is the whole reason acquirerIssued exists as an explicit flag on the outlet.
 */
export function merchantAccountTemplate({ tag, globallyUniqueIdentifier, merchantId, extra = {} }) {
  const tagNumber = Number(tag);
  if (!Number.isInteger(tagNumber) || tagNumber < 26 || tagNumber > 51) {
    throw new BanglaQrError('BAD_TEMPLATE_TAG', `Merchant account template tag must be 26–51, got ${tag}`);
  }
  const guid = requireWithin('globallyUniqueIdentifier', globallyUniqueIdentifier, 32);
  const mid = requireWithin('merchantId', merchantId, 32);

  let inner = tlv('00', guid) + tlv('01', mid);
  for (const [subTag, subValue] of Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))) {
    inner += tlv(subTag, subValue);
  }
  return tlv(String(tagNumber).padStart(2, '0'), inner);
}

/**
 * Build the Additional Data Field Template (tag 62).
 *
 * The campus order reference goes in sub-tag 05 (Reference Label). This is how a payment
 * arriving in the outlet's bank settlement file is matched back to an order in this
 * system — it is the hook the whole reconciliation engine hangs on, so it is worth
 * understanding that a QR without it can be paid but cannot be automatically reconciled.
 */
export function additionalDataTemplate({ billNumber, referenceLabel, terminalLabel } = {}) {
  let inner = '';
  if (billNumber) inner += tlv('01', requireWithin('billNumber', billNumber, LIMITS.billNumber));
  if (referenceLabel) inner += tlv('05', requireWithin('referenceLabel', referenceLabel, LIMITS.referenceLabel));
  if (terminalLabel) inner += tlv('07', requireWithin('terminalLabel', terminalLabel, LIMITS.terminalLabel));
  return inner ? tlv('62', inner) : '';
}

/**
 * Assemble a complete, CRC-signed Bangla QR payload.
 *
 * Tag 63 is appended as the literal "6304" and the CRC is computed over the whole string
 * INCLUDING that prefix — a detail that is easy to get wrong and produces a payload every
 * scanner rejects. The specification is explicit that the checksum covers its own tag and
 * length, and the round-trip test proves this implementation does that.
 */
export function buildBanglaQr({
  merchantAccounts,
  merchantName,
  merchantCity,
  amountPaisa = null,
  mcc = MCC_EDUCATION,
  currency = CURRENCY_BDT,
  countryCode = COUNTRY_BD,
  postalCode = null,
  additionalData = null,
}) {
  if (!Array.isArray(merchantAccounts) || merchantAccounts.length === 0) {
    throw new BanglaQrError('NO_MERCHANT_ACCOUNT', 'At least one merchant account template is required');
  }

  // A dynamic QR carries the amount; a static one is scanned and the payer types it in.
  const initiation = amountPaisa === null ? STATIC_QR : DYNAMIC_QR;

  let payload = tlv('00', '01') + tlv('01', initiation);

  // Templates must appear in ascending tag order, so sort rather than trusting the caller.
  const templates = [...merchantAccounts].sort((a, b) => Number(a.tag) - Number(b.tag));
  const seen = new Set();
  for (const account of templates) {
    if (seen.has(String(account.tag))) {
      throw new BanglaQrError('DUPLICATE_TEMPLATE', `Merchant account tag ${account.tag} appears twice`);
    }
    seen.add(String(account.tag));
    payload += merchantAccountTemplate(account);
  }

  if (!/^\d{4}$/.test(mcc)) throw new BanglaQrError('BAD_MCC', 'MCC must be four digits');
  payload += tlv('52', mcc);

  if (!/^\d{3}$/.test(currency)) throw new BanglaQrError('BAD_CURRENCY', 'Currency must be a three-digit ISO 4217 code');
  payload += tlv('53', currency);

  if (amountPaisa !== null) payload += tlv('54', amountFromPaisa(amountPaisa));

  if (!/^[A-Z]{2}$/.test(countryCode)) throw new BanglaQrError('BAD_COUNTRY', 'Country code must be two uppercase letters');
  payload += tlv('58', countryCode);

  payload += tlv('59', requireWithin('merchantName', merchantName, LIMITS.merchantName));
  payload += tlv('60', requireWithin('merchantCity', merchantCity, LIMITS.merchantCity));
  if (postalCode) payload += tlv('61', requireWithin('postalCode', postalCode, LIMITS.postalCode));

  if (additionalData) payload += additionalDataTemplate(additionalData);

  // CRC covers "6304" itself — hence appending the prefix before computing.
  const withCrcPrefix = `${payload}6304`;
  return `${withCrcPrefix}${crc16ccitt(withCrcPrefix)}`;
}

/**
 * Parse any TLV sequence into a tag map, validating structure as it goes.
 *
 * Deliberately separate from parseBanglaQr: the value of a template tag (26–51, 62, 64)
 * is itself a TLV sequence, and a nested sequence has no CRC of its own. Requiring one
 * here would make every nested template unparseable.
 */
export function parseTlv(input) {
  if (typeof input !== 'string') {
    throw new BanglaQrError('MALFORMED', 'TLV input must be a string');
  }

  const tags = {};
  let i = 0;
  while (i < input.length) {
    if (i + 4 > input.length) {
      throw new BanglaQrError('MALFORMED', `Truncated TLV header at offset ${i}: need 4 chars for tag+length, ${input.length - i} remain`);
    }
    const tag = input.slice(i, i + 2);
    const lenRaw = input.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenRaw)) {
      throw new BanglaQrError('MALFORMED', `Non-numeric tag or length at offset ${i}`);
    }
    const len = Number(lenRaw);
    const start = i + 4;
    const end = start + len;
    if (end > input.length) {
      throw new BanglaQrError('MALFORMED', `Tag ${tag} declares ${len} chars but only ${input.length - start} remain`);
    }
    tags[tag] = input.slice(start, end);
    i = end;
  }
  return tags;
}

/**
 * Parse a COMPLETE payload back into a tag map.
 *
 * Used to verify our own output round-trips, and to read a QR supplied by an acquiring
 * bank so its merchant identifier can be stored against the outlet — an outlet's real
 * Bangla QR arrives as a printed code or an image, and this is how its contents are
 * extracted rather than retyped by hand.
 */
export function parseBanglaQr(payload) {
  if (typeof payload !== 'string' || payload.length < 8) {
    throw new BanglaQrError('MALFORMED', 'Payload is too short to be a QR');
  }
  const tags = parseTlv(payload);
  if (!tags['63']) throw new BanglaQrError('NO_CRC', 'Payload has no CRC (tag 63)');
  return tags;
}

/**
 * Verify a payload's checksum.
 *
 * Returns a result object rather than throwing, because the caller is usually validating
 * untrusted input (a scanned code, a value pasted from an acquirer's onboarding email)
 * and a boolean plus a reason is more useful there than an exception.
 */
export function verifyBanglaQr(payload) {
  let tags;
  try {
    tags = parseBanglaQr(payload);
  } catch (err) {
    if (!(err instanceof BanglaQrError)) throw err;
    return { valid: false, reason: err.message, tags: null };
  }

  const crcIndex = payload.lastIndexOf('6304');
  if (crcIndex === -1) return { valid: false, reason: 'No CRC tag found', tags };

  const body = payload.slice(0, crcIndex + 4);
  const expected = crc16ccitt(body);
  const actual = tags['63'].toUpperCase();

  return actual === expected
    ? { valid: true, reason: null, tags }
    : { valid: false, reason: `CRC mismatch: payload carries ${actual}, computed ${expected}`, tags };
}

/**
 * Guard against emitting a QR that cannot actually be paid.
 *
 * An outlet only becomes payable once its acquiring bank or MFS issues it a merchant
 * identifier. Before that, this system can produce a structurally perfect payload that
 * every scanner will read and every acquirer will decline. Failing loudly here, at the
 * point of generation, is the difference between a blocked deployment step and a queue of
 * students at a canteen counter whose payments all fail.
 */
export function requireAcquirerIssued(merchant) {
  if (!merchant?.acquirer_issued) {
    throw new BanglaQrError(
      'NOT_ONBOARDED',
      `Outlet "${merchant?.name ?? 'unknown'}" has no acquirer-issued merchant identifier yet. ` +
      'A payable Bangla QR is issued by the outlet\'s bank or MFS during merchant onboarding; ' +
      'it cannot be generated by this system.'
    );
  }
  return merchant;
}
