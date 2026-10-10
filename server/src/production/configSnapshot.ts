/**
 * What the machine was configured with, WITHOUT the credentials.
 *
 * A backup travels. It gets copied to a USB stick, a network share, a
 * colleague's laptop — that is the entire point of taking one. So the rule here
 * is absolute: a backup artefact never contains a secret. Anyone who obtains a
 * backup must not thereby obtain the database.
 *
 * THE ALLOW-LIST IS THE MECHANISM, and it fails closed. Only keys named in
 * `PUBLIC_KEYS` have their VALUE recorded; every other key is recorded by NAME
 * with its value replaced. That direction matters: a redaction list would mean
 * that a secret added to .env next year leaks until somebody remembers to add
 * it to the list, whereas an allow-list means it is protected on the day it is
 * introduced and someone has to make a deliberate decision to expose it.
 *
 * Recording the key NAMES is the point of the file. An operator rebuilding a
 * machine after a disk failure needs to know which settings existed — that
 * APP_ORIGIN was set, that PROOF_UPLOAD_DIR had been moved off the default —
 * and can then take the values from their own password manager. A backup that
 * silently omitted the names would leave them guessing.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The marker written in place of a secret. Never a partial value, never a hash. */
export const REDACTED = '(đã ẩn — lấy từ nơi lưu trữ bí mật của bạn)';

/**
 * Keys whose values are safe to record.
 *
 * Every one is either a path, a port, a mode or a boolean — operational facts
 * that describe how the machine was set up and reveal nothing that grants
 * access. Anything not listed is redacted, including keys that do not exist
 * yet.
 */
export const PUBLIC_KEYS: readonly string[] = [
  'NODE_ENV',
  'PORT',
  'APP_ORIGIN',
  'PROOF_UPLOAD_DIR',
  'ISSUE_UPLOAD_DIR',
  'BACKUP_DIR',
  'BACKUP_RETAIN',
  'LOG_LEVEL',
  'SESSION_COOKIE_SECURE',
  'ENABLE_DEV_TEST_TOOLS',
  'APP_RELEASE_REF',
  'TZ',
  // Tuning values. Numbers and booleans that change how the app behaves and
  // grant access to nothing — an operator rebuilding a machine needs these back
  // or the rebuilt system behaves differently from the one that was lost.
  'SESSION_MAX_AGE_HOURS',
  'LOGIN_RATE_LIMIT_MAX',
  'LOGIN_RATE_LIMIT_WINDOW_MINUTES',
  'PROOF_OCR_ENABLED',
  'PROOF_OCR_LANGUAGE',
];

export interface ConfigEntry {
  key: string;
  /** The real value for a public key; the redaction marker otherwise. */
  value: string;
  /** True when the value was withheld. Makes the snapshot self-describing. */
  redacted: boolean;
}

export interface ConfigSnapshot {
  capturedAt: string;
  /** Where the configuration was read from, as a bare file name. */
  source: string;
  entries: ConfigEntry[];
  /**
   * Stated in the artefact itself, so nobody reading a backup has to infer it.
   * A restore prints this rather than writing .env.
   */
  note: string;
}

/**
 * Parses .env well enough to enumerate its keys.
 *
 * Deliberately not dotenv: this must never EXPAND anything, never resolve a
 * variable reference and never execute. It reads names, and values only for
 * keys already judged safe. Quotes are stripped because an operator writing
 * PORT="3001" means 3001.
 */
export function parseEnvKeys(contents: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    entries.push({ key, value });
  }
  return entries;
}

/** True when this key's value may be written into a backup. */
export function isPublicKey(key: string): boolean {
  return PUBLIC_KEYS.includes(key);
}

/** Builds the snapshot from raw .env contents. Pure — no filesystem, no env. */
export function buildConfigSnapshot(contents: string, now: Date, source = '.env'): ConfigSnapshot {
  const seen = new Set<string>();
  const entries: ConfigEntry[] = [];
  for (const { key, value } of parseEnvKeys(contents)) {
    // A key repeated in .env takes its LAST value at load time; record the same
    // one, so the snapshot describes what the app actually ran with.
    if (seen.has(key)) {
      const existing = entries.findIndex((e) => e.key === key);
      if (existing >= 0) entries.splice(existing, 1);
    }
    seen.add(key);
    const publicKey = isPublicKey(key);
    entries.push({ key, value: publicKey ? value : REDACTED, redacted: !publicKey });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));

  return {
    capturedAt: now.toISOString(),
    source,
    entries,
    note:
      'Giá trị bí mật KHÔNG được lưu trong bản sao lưu. Tệp này chỉ liệt kê những ' +
      'khoá đã được cấu hình để bạn dựng lại .env; hãy lấy giá trị thật từ nơi lưu ' +
      'trữ bí mật của bạn. Khôi phục sẽ KHÔNG ghi đè .env.',
  };
}

/** Reads .env from disk and snapshots it. Returns null when there is no file. */
export function readConfigSnapshot(envFile: string, now: Date): ConfigSnapshot | null {
  try {
    const contents = fs.readFileSync(envFile, 'utf8');
    return buildConfigSnapshot(contents, now, path.basename(envFile));
  } catch {
    // No .env is a legitimate state — the machine may be configured entirely
    // through real environment variables. Recording nothing is honest; an
    // invented snapshot would not be.
    return null;
  }
}

/**
 * A last line of defence, applied to the serialised snapshot before it is
 * written.
 *
 * The allow-list should already have prevented this, so anything found here is
 * a bug — but the cost of the check is a regular expression and the cost of
 * missing it is a database password on a USB stick.
 */
export function containsLikelySecret(serialised: string): boolean {
  return (
    /postgres(ql)?:\/\/[^\s"]*:[^\s"]*@/i.test(serialised) ||
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/.test(serialised)
  );
}
