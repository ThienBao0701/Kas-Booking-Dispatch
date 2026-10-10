/**
 * The configuration snapshot that travels inside a backup.
 *
 * THE PROPERTY THIS FILE PROTECTS: a backup never contains a credential.
 *
 * Backups travel — that is what they are for. They get copied onto a USB stick,
 * a network share, a colleague's laptop. If one of them contains DATABASE_URL
 * with its password, then whoever holds any backup holds the database, and the
 * hotel would have no way of knowing it had happened.
 *
 * So the allow-list fails CLOSED, and that direction is the point: a secret
 * added to .env next year is protected on the day it is introduced, rather than
 * leaking until someone remembers to add it to a redaction list.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_KEYS,
  REDACTED,
  buildConfigSnapshot,
  containsLikelySecret,
  isPublicKey,
  parseEnvKeys,
} from '../src/production/configSnapshot';

const NOW = new Date('2026-08-05T22:00:00.000Z');

/** A realistic .env, secrets and all. */
const REAL_ENV = [
  '# Kas configuration',
  'NODE_ENV=production',
  'PORT=3001',
  'DATABASE_URL=postgresql://kas_app:s3cr3t-p4ss@localhost:5432/kas_production?schema=public',
  'SESSION_SECRET=8f4b2c9e1d7a6350bc8e2f1a9d4c7b0e5a3f6d2c8b1e4a7f',
  'INITIAL_ADMIN_PASSWORD=Kh4chSan!2026',
  'APP_ORIGIN=https://kasbookingapp.com',
  'PROOF_UPLOAD_DIR=D:/KasData/booking-proofs',
  '',
].join('\n');

/* ================================================================== */
/* Nothing secret survives                                             */
/* ================================================================== */
describe('secrets never reach the backup', () => {
  const snapshot = buildConfigSnapshot(REAL_ENV, NOW);
  const serialised = JSON.stringify(snapshot);

  it('withholds the database password', () => {
    expect(serialised).not.toContain('s3cr3t-p4ss');
    expect(serialised).not.toContain('postgresql://kas_app');
  });

  it('withholds the session secret', () => {
    expect(serialised).not.toContain('8f4b2c9e1d7a6350bc8e2f1a9d4c7b0e5a3f6d2c8b1e4a7f');
  });

  it('withholds the bootstrap admin password', () => {
    expect(serialised).not.toContain('Kh4chSan!2026');
  });

  it('records that the key existed, which is the point of the file', () => {
    // An operator rebuilding a machine needs to know DATABASE_URL was set, and
    // then takes the value from their own password store.
    const keys = snapshot.entries.map((e) => e.key);
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('SESSION_SECRET');
    expect(keys).toContain('INITIAL_ADMIN_PASSWORD');
  });

  it('marks each withheld value as withheld rather than leaving it blank', () => {
    // A blank value reads as "this was not configured", which would send an
    // operator down entirely the wrong path.
    const secret = snapshot.entries.find((e) => e.key === 'DATABASE_URL');
    expect(secret?.redacted).toBe(true);
    expect(secret?.value).toBe(REDACTED);
  });

  it('keeps the operational values that are safe to keep', () => {
    const byKey = Object.fromEntries(snapshot.entries.map((e) => [e.key, e.value]));
    expect(byKey.NODE_ENV).toBe('production');
    expect(byKey.PORT).toBe('3001');
    expect(byKey.APP_ORIGIN).toBe('https://kasbookingapp.com');
    expect(byKey.PROOF_UPLOAD_DIR).toBe('D:/KasData/booking-proofs');
  });
});

/* ================================================================== */
/* The allow-list fails closed                                         */
/* ================================================================== */
describe('the allow-list', () => {
  it('withholds a key nobody has thought about yet', () => {
    // The whole design: a new secret is protected on the day it is added,
    // without anyone having to remember this file exists.
    const snapshot = buildConfigSnapshot('STRIPE_API_KEY=sk_live_abc123\n', NOW);
    expect(snapshot.entries[0]!.redacted).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('sk_live_abc123');
  });

  it('contains no key that could hold a credential', () => {
    // Guards the list itself against a careless future addition.
    for (const key of PUBLIC_KEYS) {
      expect(key, key).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY$|CREDENTIAL|DATABASE_URL/i);
    }
  });

  it('answers for keys on and off the list', () => {
    expect(isPublicKey('PORT')).toBe(true);
    expect(isPublicKey('SESSION_SECRET')).toBe(false);
    expect(isPublicKey('port')).toBe(false); // case-sensitive: env vars are
  });
});

/* ================================================================== */
/* Parsing                                                             */
/* ================================================================== */
describe('reading .env', () => {
  it('ignores comments and blank lines', () => {
    expect(parseEnvKeys('# note\n\nPORT=3001\n')).toEqual([{ key: 'PORT', value: '3001' }]);
  });

  it('strips surrounding quotes', () => {
    expect(parseEnvKeys('PORT="3001"')).toEqual([{ key: 'PORT', value: '3001' }]);
    expect(parseEnvKeys("APP_ORIGIN='https://x'")).toEqual([
      { key: 'APP_ORIGIN', value: 'https://x' },
    ]);
  });

  it('keeps a value containing an equals sign intact', () => {
    // Connection strings and base64 secrets both contain "=".
    const [entry] = parseEnvKeys('DATABASE_URL=postgresql://u:p@h/db?schema=public');
    expect(entry!.value).toBe('postgresql://u:p@h/db?schema=public');
  });

  it('never expands a variable reference', () => {
    // dotenv would interpolate this. Recording the literal is correct here —
    // and expanding it could pull a secret from the environment into the file.
    const [entry] = parseEnvKeys('APP_ORIGIN=$OTHER_VALUE');
    expect(entry!.value).toBe('$OTHER_VALUE');
  });

  it('skips a malformed line rather than failing the backup', () => {
    expect(parseEnvKeys('this is not a setting\nPORT=3001')).toEqual([
      { key: 'PORT', value: '3001' },
    ]);
  });

  it('records the last value when a key is repeated, as dotenv would', () => {
    const snapshot = buildConfigSnapshot('PORT=3001\nPORT=4000\n', NOW);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.value).toBe('4000');
  });

  it('sorts keys so two snapshots can be diffed', () => {
    const snapshot = buildConfigSnapshot('PORT=1\nAPP_ORIGIN=x\nNODE_ENV=production\n', NOW);
    expect(snapshot.entries.map((e) => e.key)).toEqual(['APP_ORIGIN', 'NODE_ENV', 'PORT']);
  });
});

/* ================================================================== */
/* The last line of defence                                            */
/* ================================================================== */
describe('the secret detector', () => {
  it('recognises a connection string with credentials', () => {
    expect(containsLikelySecret('postgresql://kas_app:pw@localhost:5432/kas')).toBe(true);
    expect(containsLikelySecret('postgres://u:p@h/db')).toBe(true);
  });

  it('recognises a long opaque token', () => {
    expect(containsLikelySecret('8f4b2c9e1d7a6350bc8e2f1a9d4c7b0e5a3f6d2c8b1e4a7f9012')).toBe(true);
  });

  it('passes an ordinary redacted snapshot', () => {
    expect(containsLikelySecret(JSON.stringify(buildConfigSnapshot(REAL_ENV, NOW)))).toBe(false);
  });

  it('passes a connection string with no credentials in it', () => {
    // The manifest legitimately records a database NAME.
    expect(containsLikelySecret('database: kas_production, host: localhost')).toBe(false);
  });
});

/* ================================================================== */
/* The artefact explains itself                                        */
/* ================================================================== */
describe('the snapshot file', () => {
  it('says that restore will not rewrite .env', () => {
    // Otherwise an operator restores a backup and assumes their configuration
    // came back with it.
    const snapshot = buildConfigSnapshot(REAL_ENV, NOW);
    expect(snapshot.note).toContain('KHÔNG ghi đè .env');
    expect(snapshot.note).toContain('bí mật');
  });

  it('records when it was taken and from where', () => {
    const snapshot = buildConfigSnapshot(REAL_ENV, NOW, '.env');
    expect(snapshot.capturedAt).toBe('2026-08-05T22:00:00.000Z');
    expect(snapshot.source).toBe('.env');
  });
});
