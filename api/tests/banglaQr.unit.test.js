import { describe, test, expect } from '@jest/globals';
import {
  crc16ccitt,
  tlv,
  amountFromPaisa,
  merchantAccountTemplate,
  additionalDataTemplate,
  buildBanglaQr,
  parseTlv,
  parseBanglaQr,
  verifyBanglaQr,
  requireAcquirerIssued,
  BanglaQrError,
  MCC_EDUCATION,
  CURRENCY_BDT,
  STATIC_QR,
  DYNAMIC_QR,
} from '../src/domain/banglaQr.js';

/**
 * Pure functions, no database — these run in milliseconds.
 *
 * A Bangla QR that is wrong by one character is not "slightly wrong": every scanner
 * rejects it, at a counter, in front of a queue. So the checksum is pinned to the
 * algorithm's published check value rather than to whatever this implementation happens
 * to produce, which would only prove it is consistent with itself.
 */

describe('CRC-16/CCITT-FALSE', () => {
  /**
   * THE authoritative test. "123456789" -> 0x29B1 is the published check value for
   * CRC-16/CCITT-FALSE in the CRC catalogue. Several other variants are also called
   * "CRC-16 CCITT" — XMODEM (init 0x0000) and KERMIT (reflected) among them — and they
   * produce different digests from the same input. This single assertion is what
   * distinguishes the correct variant from the three plausible wrong ones.
   */
  test('matches the published check value for the algorithm', () => {
    expect(crc16ccitt('123456789')).toBe('29B1');
  });

  test('is four uppercase hex characters, zero-padded', () => {
    for (const input of ['', 'A', 'test', '00020101', 'x'.repeat(500)]) {
      expect(crc16ccitt(input)).toMatch(/^[0-9A-F]{4}$/);
    }
  });

  test('initial value is 0xFFFF, not 0x0000 (the XMODEM confusion)', () => {
    // With init 0x0000 the empty string checksums to 0000; with init 0xFFFF it does not.
    expect(crc16ccitt('')).toBe('FFFF');
  });

  test('a single changed character changes the checksum', () => {
    expect(crc16ccitt('PREMIER UNIVERSITY')).not.toBe(crc16ccitt('PREMIER UNIVERSITX'));
  });
});

describe('TLV encoding', () => {
  test('encodes tag, two-digit length, then value', () => {
    expect(tlv('00', '01')).toBe('000201');
    expect(tlv('53', '050')).toBe('5303050');
  });

  test('zero-pads lengths below ten', () => {
    expect(tlv('54', '85')).toBe('540285');
  });

  test('handles a length of exactly 99', () => {
    const v = 'x'.repeat(99);
    expect(tlv('59', v)).toBe(`5999${v}`);
  });

  test('refuses a value longer than the 2-digit length prefix can express', () => {
    expect(() => tlv('59', 'x'.repeat(100))).toThrow(BanglaQrError);
  });

  test('refuses a malformed tag', () => {
    expect(() => tlv('5', 'x')).toThrow(/two digits/);
    expect(() => tlv('abc', 'x')).toThrow(/two digits/);
  });
});

describe('amount formatting (integer paisa -> EMVCo decimal string)', () => {
  test('whole taka carries no decimal part', () => {
    expect(amountFromPaisa(8500)).toBe('85');
    expect(amountFromPaisa(100)).toBe('1');
  });

  test('paisa render as exactly two decimals', () => {
    expect(amountFromPaisa(8550)).toBe('85.50');
    expect(amountFromPaisa(10005)).toBe('100.05');
    expect(amountFromPaisa(1)).toBe('0.01');
  });

  test('conversion is integer arithmetic — no float drift at awkward values', () => {
    // 0.1 + 0.2 territory: these are the values a float implementation gets wrong.
    expect(amountFromPaisa(1010)).toBe('10.10');
    expect(amountFromPaisa(2020)).toBe('20.20');
    expect(amountFromPaisa(70007)).toBe('700.07');
  });

  test('rejects non-positive and non-integer amounts', () => {
    for (const bad of [0, -100, 85.5, NaN, Infinity, '85', null]) {
      expect(() => amountFromPaisa(bad)).toThrow(BanglaQrError);
    }
  });
});

describe('merchant account template (tags 26-51)', () => {
  const account = {
    tag: '29',
    globallyUniqueIdentifier: 'BD.COM.EXAMPLEBANK',
    merchantId: 'PUC-CANTEEN-001',
  };

  test('nests GUID as sub-tag 00 and merchant id as sub-tag 01', () => {
    const out = merchantAccountTemplate(account);
    const inner = tlv('00', 'BD.COM.EXAMPLEBANK') + tlv('01', 'PUC-CANTEEN-001');
    expect(out).toBe(tlv('29', inner));
  });

  test('the declared length matches the nested content exactly', () => {
    const out = merchantAccountTemplate(account);
    const declared = Number(out.slice(2, 4));
    expect(out.slice(4).length).toBe(declared);
  });

  test('rejects a template tag outside the 26-51 range', () => {
    for (const tag of ['25', '52', '00', '99']) {
      expect(() => merchantAccountTemplate({ ...account, tag })).toThrow(/26/);
    }
  });
});

describe('additional data template (tag 62)', () => {
  test('puts the campus order reference in sub-tag 05', () => {
    const out = additionalDataTemplate({ referenceLabel: 'ORD-4821' });
    expect(out).toBe(tlv('62', tlv('05', 'ORD-4821')));
  });

  test('emits nothing when there is nothing to say', () => {
    expect(additionalDataTemplate({})).toBe('');
    expect(additionalDataTemplate()).toBe('');
  });

  test('orders sub-tags ascending: bill (01), reference (05), terminal (07)', () => {
    const out = additionalDataTemplate({
      terminalLabel: 'TERM-AB4',
      billNumber: 'B-1',
      referenceLabel: 'ORD-9',
    });
    const inner = out.slice(4);
    expect(inner.indexOf('01')).toBeLessThan(inner.indexOf('05'));
    expect(inner.indexOf('05')).toBeLessThan(inner.indexOf('07'));
  });
});

describe('building a full Bangla QR payload', () => {
  const base = {
    merchantAccounts: [
      { tag: '29', globallyUniqueIdentifier: 'BD.COM.EXAMPLEBANK', merchantId: 'PUC-CANTEEN-001' },
    ],
    merchantName: 'PREMIER UNIVERSITY',
    merchantCity: 'Chattogram',
  };

  test('round-trips: what we build, we can verify', () => {
    const payload = buildBanglaQr({ ...base, amountPaisa: 8500 });
    const result = verifyBanglaQr(payload);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  test('carries the mandatory tags with the right values', () => {
    const payload = buildBanglaQr({ ...base, amountPaisa: 8500 });
    const tags = parseBanglaQr(payload);

    expect(tags['00']).toBe('01'); // payload format indicator
    expect(tags['52']).toBe(MCC_EDUCATION); // colleges & universities
    expect(tags['53']).toBe(CURRENCY_BDT); // BDT
    expect(tags['54']).toBe('85'); // ৳85.00
    expect(tags['58']).toBe('BD');
    expect(tags['59']).toBe('PREMIER UNIVERSITY');
    expect(tags['60']).toBe('Chattogram');
  });

  test('an amount makes it a DYNAMIC qr; no amount makes it STATIC', () => {
    expect(parseBanglaQr(buildBanglaQr({ ...base, amountPaisa: 8500 }))['01']).toBe(DYNAMIC_QR);
    expect(parseBanglaQr(buildBanglaQr({ ...base }))['01']).toBe(STATIC_QR);
  });

  test('a static qr omits the amount entirely rather than sending zero', () => {
    // "540200" would mean a ৳0 bill, which some acquirers reject outright.
    expect(parseBanglaQr(buildBanglaQr(base))['54']).toBeUndefined();
  });

  test('tag 63 is last and the CRC covers its own "6304" prefix', () => {
    const payload = buildBanglaQr({ ...base, amountPaisa: 8500 });
    expect(payload.slice(-8, -4)).toBe('6304');

    const body = payload.slice(0, -4);
    expect(payload.slice(-4)).toBe(crc16ccitt(body));

    // And the naive mistake — checksumming without the prefix — must NOT match.
    expect(payload.slice(-4)).not.toBe(crc16ccitt(payload.slice(0, -8)));
  });

  test('emits merchant account templates in ascending tag order', () => {
    const payload = buildBanglaQr({
      ...base,
      merchantAccounts: [
        { tag: '31', globallyUniqueIdentifier: 'BD.COM.B', merchantId: 'M2' },
        { tag: '29', globallyUniqueIdentifier: 'BD.COM.A', merchantId: 'M1' },
      ],
    });
    expect(payload.indexOf('29')).toBeLessThan(payload.indexOf('31'));
    expect(verifyBanglaQr(payload).valid).toBe(true);
  });

  test('carries the order reference so a settlement can be matched back', () => {
    const payload = buildBanglaQr({
      ...base,
      amountPaisa: 8500,
      additionalData: { referenceLabel: 'ORD-4821' },
    });
    // The template's value is itself a TLV sequence, and a nested sequence carries no
    // CRC of its own — so it is read with parseTlv, not parseBanglaQr.
    const inner = parseBanglaQr(payload)['62'];
    expect(parseTlv(inner)['05']).toBe('ORD-4821');
  });

  test('rejects a merchant name longer than EMVCo allows', () => {
    expect(() => buildBanglaQr({ ...base, merchantName: 'X'.repeat(26) })).toThrow(/at most 25/);
  });

  test('rejects a merchant city longer than EMVCo allows', () => {
    expect(() => buildBanglaQr({ ...base, merchantCity: 'X'.repeat(16) })).toThrow(/at most 15/);
  });

  test('rejects a payload with no merchant account at all', () => {
    expect(() => buildBanglaQr({ ...base, merchantAccounts: [] })).toThrow(/merchant account/i);
  });

  test('rejects duplicate merchant account tags', () => {
    expect(() => buildBanglaQr({
      ...base,
      merchantAccounts: [
        { tag: '29', globallyUniqueIdentifier: 'BD.COM.A', merchantId: 'M1' },
        { tag: '29', globallyUniqueIdentifier: 'BD.COM.B', merchantId: 'M2' },
      ],
    })).toThrow(/twice/);
  });
});

describe('verifying an untrusted payload', () => {
  const payload = buildBanglaQr({
    merchantAccounts: [{ tag: '29', globallyUniqueIdentifier: 'BD.COM.EXAMPLEBANK', merchantId: 'PUC-CANTEEN-001' }],
    merchantName: 'PREMIER UNIVERSITY',
    merchantCity: 'Chattogram',
    amountPaisa: 8500,
  });

  /**
   * The attack this defends against: a student photographs the canteen's QR, edits the
   * amount from ৳850 to ৳8, reprints it and sticks it over the original. The CRC is what
   * makes that tampering detectable rather than silently accepted.
   */
  test('detects a tampered amount', () => {
    const tampered = payload.replace('540285', '540208');
    expect(tampered).not.toBe(payload);
    const result = verifyBanglaQr(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/CRC mismatch/);
  });

  test('detects a tampered merchant id', () => {
    const tampered = payload.replace('PUC-CANTEEN-001', 'PUC-CANTEEN-002');
    expect(verifyBanglaQr(tampered).valid).toBe(false);
  });

  test('returns a reason instead of throwing on structural garbage', () => {
    for (const junk of ['', 'not a qr', '00', '0002', '00020101021Z']) {
      const result = verifyBanglaQr(junk);
      expect(result.valid).toBe(false);
      expect(typeof result.reason).toBe('string');
    }
  });

  test('rejects a TLV whose declared length overruns the payload', () => {
    // Tag 00 declares 99 characters but only 8 follow. Long enough to clear the
    // minimum-length guard, so it reaches the overrun check that is under test.
    expect(() => parseTlv('0099shorter!')).toThrow(/only 8 remain/);
  });

  test('rejects a truncated TLV header', () => {
    // One complete triple (00/02/"01") then a dangling "01" — two characters, which is
    // not enough for the four a tag+length header needs.
    expect(() => parseTlv('00020101')).toThrow(/Truncated TLV header/);
  });

  test('rejects a payload with no CRC tag', () => {
    expect(() => parseBanglaQr('000201010212')).toThrow(/no CRC/i);
  });
});

describe('acquirer onboarding guard', () => {
  /**
   * This is a deployment gate, not a validation nicety. Until PUC's outlet is onboarded
   * by an acquiring bank or MFS, this system can produce a structurally perfect payload
   * that every acquirer declines. Failing at generation beats failing at the counter.
   */
  test('refuses to treat a non-onboarded outlet as payable', () => {
    expect(() => requireAcquirerIssued({ name: 'Canteen', acquirer_issued: false }))
      .toThrow(/NOT_ONBOARDED|no acquirer-issued/);
  });

  test('names the outlet so the error is actionable', () => {
    expect(() => requireAcquirerIssued({ name: 'AB4 Photocopy', acquirer_issued: null }))
      .toThrow(/AB4 Photocopy/);
  });

  test('passes an onboarded outlet through unchanged', () => {
    const m = { name: 'Canteen', acquirer_issued: true };
    expect(requireAcquirerIssued(m)).toBe(m);
  });
});
