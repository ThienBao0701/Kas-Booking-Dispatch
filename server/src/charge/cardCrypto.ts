/**
 * Card-number encryption for the Chứng từ module.
 *
 * AES-256-GCM — authenticated encryption, so a tampered ciphertext fails to
 * decrypt rather than returning plausible garbage. The key comes from
 * CARD_ENCRYPTION_KEY (or CARD_ENCRYPTION_KEY_FILE via the existing
 * file-backed-secret loader) and lives nowhere else: not in the database, not
 * in source, not derived from another secret.
 *
 * WHY NOT DERIVED FROM SESSION_SECRET. Rotating the session secret is routine —
 * it merely logs everyone out. If card numbers hung off it, that same routine
 * action would destroy every stored number, with no error until someone tried
 * to read one. They are also different trust domains.
 *
 * WHAT THIS MODULE WILL NOT DO:
 *   - It never logs a card number, a key, or a ciphertext.
 *   - Its errors name the failure and nothing else: no PAN fragment, no key
 *     material, no ciphertext, so an error reaching a log or an HTTP response
 *     cannot leak card data.
 *   - There is no CVV/CVC/CID anything here, and there must never be. A card
 *     security code is Sensitive Authentication Data and may not be retained
 *     after authorization, encrypted or otherwise.
 *
 * Stored format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64. The version
 * prefix travels with the value so a future algorithm change can be detected on
 * read; `cardKeyVersion` on the row records which KEY was used, so rotating the
 * key is a re-encryption job rather than a schema change.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for
const KEY_BYTES = 32; // AES-256
const FORMAT_VERSION = 'v1';

/** The key version new rows are written with. Bump only alongside re-encryption. */
export const CURRENT_CARD_KEY_VERSION = 1;

/**
 * The configured key, decoded and length-checked.
 *
 * Throws a configuration error naming ONLY the variable — never its value, and
 * never a fragment of it. A module that cannot encrypt must refuse loudly; the
 * one thing it may not do is fall back to storing the number in the clear.
 */
function loadKey(): Buffer {
  const raw = env.CARD_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw ApiError.internal(
      'Chưa cấu hình CARD_ENCRYPTION_KEY nên không thể xử lý số thẻ.',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw ApiError.internal('CARD_ENCRYPTION_KEY không hợp lệ (phải là base64).');
  }
  if (key.length !== KEY_BYTES) {
    throw ApiError.internal(
      `CARD_ENCRYPTION_KEY phải là ${KEY_BYTES} byte (base64 của 32 byte ngẫu nhiên).`,
    );
  }
  return key;
}

/** Whether card handling is available at all. Lets callers fail early and clearly. */
export function cardEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/** Digits only. Card numbers are entered with spaces and dashes all the time. */
export function normalizeCardNumber(input: string): string {
  return input.replace(/[^\d]/g, '');
}

/**
 * Luhn check. Used to reject an obvious typo at entry — never as a claim that
 * the card exists or is chargeable.
 */
export function isPlausibleCardNumber(digits: string): boolean {
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The last four digits, which is all any ordinary screen or export ever sees. */
export function last4Of(digits: string): string {
  return digits.slice(-4);
}

/** The display form used everywhere except an authorised reveal: "•••• 1234". */
export function maskedCardNumber(last4: string): string {
  return `•••• ${last4}`;
}

/**
 * Encrypts a full card number.
 *
 * Takes the already-normalised digits. The plaintext is never returned, logged
 * or echoed; the caller gets only the ciphertext and the last four digits.
 */
export function encryptCardNumber(digits: string): { cipher: string; last4: string; keyVersion: number } {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(digits, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipher: [
      FORMAT_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.'),
    last4: last4Of(digits),
    keyVersion: CURRENT_CARD_KEY_VERSION,
  };
}

/**
 * Decrypts a stored card number. ONLY the authorised reveal flow may call this.
 *
 * A failure here is reported as a generic decryption failure: a message that
 * distinguished "wrong key" from "tampered ciphertext" would be an oracle, and
 * neither variant may carry any part of the value.
 */
export function decryptCardNumber(stored: string): string {
  const key = loadKey();
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw ApiError.internal('Không giải mã được số thẻ.');
  }
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const authTag = Buffer.from(parts[2]!, 'base64');
    const payload = Buffer.from(parts[3]!, 'base64');
    if (iv.length !== IV_BYTES) throw new Error('iv');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque, and deliberately carries nothing from `stored`.
    throw ApiError.internal('Không giải mã được số thẻ.');
  }
}

/**
 * Constant-time comparison, exported for tests that assert a round trip without
 * putting the number through a logging assertion helper.
 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
