/**
 * WEB PUSH, ON THE WIRE — RFC 8291 (message encryption, "aes128gcm") and
 * RFC 8292 (VAPID), with Node's own crypto. No dependency: the whole protocol
 * is one ECDH, three HKDFs, one AES-GCM and one ES256 signature, and the unit
 * test pins it to the RFC's own test vector.
 *
 * THE PRIVATE VAPID KEY STAYS HERE. The browser only ever receives the public
 * key (to subscribe); the private key signs the request that proves to the push
 * service that this server is the one the subscription was made for.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export interface SubscriptionKeys {
  /** The browser's P-256 public key, uncompressed, base64url (65 bytes). */
  p256dh: string;
  /** The browser's authentication secret, base64url (16 bytes). */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url — the one the browser subscribes with. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** "mailto:…" or an https URL — who to contact about this sender. */
  subject: string;
}

const RECORD_SIZE = 4096;
/** The largest payload one record carries (record − delimiter − GCM tag), kept well under. */
export const MAX_PAYLOAD_BYTES = 3000;

const fromB64u = (value: string): Buffer => Buffer.from(value, 'base64url');
const toB64u = (value: Buffer): string => value.toString('base64url');

/** Whether a subscription's keys have the shapes RFC 8291 requires. */
export function validKeys(keys: SubscriptionKeys): boolean {
  const pub = fromB64u(keys.p256dh);
  return pub.length === 65 && pub[0] === 0x04 && fromB64u(keys.auth).length === 16;
}

/**
 * Encrypts one push message (RFC 8291 §3–4, one record). `salt` and
 * `serverPrivateKey` are for the RFC test vector only; a real message always
 * gets a fresh salt and a fresh ephemeral key.
 */
export function encryptPayload(
  plaintext: Buffer,
  keys: SubscriptionKeys,
  testing: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
  if (!validKeys(keys)) throw new Error('Push subscription keys are malformed.');
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error('Push payload is too large.');
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);

  const ecdh = createECDH('prime256v1');
  if (testing.serverPrivateKey) ecdh.setPrivateKey(testing.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const salt = testing.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  // One record: the plaintext, then the 0x02 "last record" delimiter, no padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) || rs (uint32 BE) || idlen (1) || keyid (as_public).
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

/** A fresh VAPID key pair, for the operator to put in the server's environment. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  return {
    publicKey: toB64u(ecdh.getPublicKey()),
    privateKey: toB64u(Buffer.concat([Buffer.alloc(32 - d.length), d])),
  };
}

/** The VAPID `Authorization` header (RFC 8292 §2–3) for one push service origin. */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowMs: number = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const header = toB64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toB64u(
    Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const pub = fromB64u(vapid.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      // A scalar written without its leading zero byte is still the same key.
      d: toB64u(Buffer.concat([Buffer.alloc(Math.max(0, 32 - fromB64u(vapid.privateKey).length)), fromB64u(vapid.privateKey)])),
      x: toB64u(pub.subarray(1, 33)),
      y: toB64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${toB64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * THE PUSH SERVICES A SUBSCRIPTION MAY POINT AT. The endpoint comes from a
 * browser, so the server never posts to an address it does not recognise as a
 * real push service — an arbitrary "endpoint" would let any account make this
 * server send requests into its own network.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === 'fcm.googleapis.com' ||
    host === 'android.googleapis.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.push.services.mozilla.com') ||
    host.endsWith('.notify.windows.com')
  );
}

/** Sends one encrypted message; resolves to the push service's HTTP status. */
export async function sendWebPush(
  subscription: { endpoint: string } & SubscriptionKeys,
  payload: Buffer,
  vapid: VapidKeys,
): Promise<number> {
  if (!isPushServiceEndpoint(subscription.endpoint)) return 410;
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(24 * 3600),
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidAuthorization(subscription.endpoint, vapid),
    },
    body: encryptPayload(payload, subscription),
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}
