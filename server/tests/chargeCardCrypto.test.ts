/**
 * Card-number protection at rest.
 *
 * The assertions that matter most are the NEGATIVE ones: that a card number
 * cannot be read out of what we store, and that nothing anywhere in this module
 * has a place to put a CVV.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENT_CARD_KEY_VERSION,
  decryptCardNumber,
  encryptCardNumber,
  isPlausibleCardNumber,
  last4Of,
  maskedCardNumber,
  normalizeCardNumber,
  sameSecret,
} from '../src/charge/cardCrypto';

/** A Luhn-valid test number. Not a real card. */
const PAN = '4111111111111111';

describe('encryption', () => {
  it('round-trips the number', () => {
    const { cipher } = encryptCardNumber(PAN);
    expect(sameSecret(decryptCardNumber(cipher), PAN)).toBe(true);
  });

  it('stores nothing that contains the number', () => {
    // The whole point: what lands in the database must not reveal the PAN,
    // in whole or in part, in any obvious encoding.
    const { cipher } = encryptCardNumber(PAN);
    expect(cipher).not.toContain(PAN);
    expect(cipher).not.toContain('4111');
    expect(Buffer.from(cipher, 'utf8').toString('hex')).not.toContain(
      Buffer.from(PAN, 'utf8').toString('hex'),
    );
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per encryption: two identical cards must not look identical
    // in the database, or the store leaks which rows share a number.
    const a = encryptCardNumber(PAN).cipher;
    const b = encryptCardNumber(PAN).cipher;
    expect(a).not.toBe(b);
    expect(decryptCardNumber(a)).toBe(decryptCardNumber(b));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    // GCM is authenticated: flipping a byte must fail, not decrypt to nonsense
    // that could be mistaken for a card number.
    const { cipher } = encryptCardNumber(PAN);
    const parts = cipher.split('.');
    const payload = Buffer.from(parts[3]!, 'base64');
    payload[0] = payload[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], payload.toString('base64')].join('.');
    expect(() => decryptCardNumber(tampered)).toThrow();
  });

  it('refuses a ciphertext from a different key', () => {
    const { cipher } = encryptCardNumber(PAN);
    const swapped = cipher.split('.');
    swapped[2] = Buffer.alloc(16).toString('base64'); // wrong auth tag
    expect(() => decryptCardNumber(swapped.join('.'))).toThrow();
  });

  it('never puts card data in the failure message', () => {
    try {
      decryptCardNumber('v1.aaa.bbb.ccc');
      throw new Error('should have thrown');
    } catch (err) {
      const message = String((err as Error).message);
      expect(message).not.toContain(PAN);
      expect(message).not.toContain('aaa');
      expect(message).toContain('Không giải mã được số thẻ');
    }
  });

  it('records the key version, so a rotation is possible later', () => {
    expect(encryptCardNumber(PAN).keyVersion).toBe(CURRENT_CARD_KEY_VERSION);
  });
});

describe('masking and normalisation', () => {
  it('keeps only digits', () => {
    expect(normalizeCardNumber('4111 1111-1111 1111')).toBe(PAN);
  });

  it('masks to the last four', () => {
    expect(last4Of(PAN)).toBe('1111');
    expect(maskedCardNumber('1111')).toBe('•••• 1111');
    expect(maskedCardNumber('1111')).not.toContain(PAN);
  });

  it('rejects an implausible number without echoing it', () => {
    expect(isPlausibleCardNumber('4111111111111112')).toBe(false);
    expect(isPlausibleCardNumber('123')).toBe(false);
    expect(isPlausibleCardNumber(PAN)).toBe(true);
  });
});

/* ================================================================== */
/* The absolute rule                                                   */
/* ================================================================== */

describe('there is no CVV anywhere', () => {
  /** Every file that makes up the charge module, plus its schema. */
  const files = [
    ...fs
      .readdirSync(path.join(__dirname, '..', 'src', 'charge'))
      .map((f) => path.join(__dirname, '..', 'src', 'charge', f)),
    path.join(__dirname, '..', 'src', 'routes', 'chargeDocuments.ts'),
    path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
  ];

  it('no source file defines a CVV/CVC/CID field', () => {
    // Deliberately broad: a security code must not exist even as an unused
    // column, a type member or a form field.
    const forbidden = /\b(cvv|cvc|cid|securityCode|cardSecurityCode)\b/i;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // The word may appear in a comment SAYING we do not store it; a field
      // declaration may not. Check for anything that looks like a binding.
      const declarations = text.match(new RegExp(`(\\w*)(cvv|cvc|securityCode)(\\w*)\\s*[:=?]`, 'gi'));
      expect(declarations, `${path.basename(file)}: ${declarations?.join(', ')}`).toBeNull();
      expect(forbidden.test(text.replace(/\/\/.*|\/\*[\s\S]*?\*\/|\/\/\/.*/g, '')), path.basename(file))
        .toBe(false);
    }
  });

  it('the ChargeDocument model has no security-code column', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const model = /model ChargeDocument \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
    expect(model.length).toBeGreaterThan(0);
    expect(/cvv|cvc|securityCode/i.test(model)).toBe(false);
    // …and it does hold the things it is supposed to.
    expect(model).toContain('cardNumberCipher');
    expect(model).toContain('cardLast4');
    expect(model).toContain('cardKeyVersion');
  });
});
