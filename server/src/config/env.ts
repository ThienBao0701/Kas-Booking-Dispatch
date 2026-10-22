import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { describeDatabaseUrl } from './databaseUrl';

// The single .env lives at the repository root, while this code runs with the
// server workspace as cwd (src in dev, dist in production) — resolve explicitly.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Parses the string forms an environment variable can take for a boolean
 * ("true"/"false"/"1"/"0") without z.coerce.boolean()'s trap of treating the
 * literal string "false" as truthy.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

/**
 * Secrets that may be supplied as a file instead of a plain environment value.
 *
 * `SESSION_SECRET_FILE=/run/secrets/session_secret` makes the loader read that
 * file and use its (trimmed) contents as `SESSION_SECRET`. This is what Docker
 * secrets and systemd credentials provide, and it keeps the value out of
 * `docker inspect`, the process environment and any log of it. An explicit
 * plain variable always wins, so nothing existing changes.
 */
export const FILE_BACKED_SECRETS = [
  'SESSION_SECRET',
  'INITIAL_ADMIN_PASSWORD',
  'DATABASE_URL',
  'CARD_ENCRYPTION_KEY',
] as const;

/**
 * Expands `NAME_FILE` into `NAME` for the secrets above. Pure: it returns a new
 * object and never mutates `process.env`. A missing or unreadable file is a hard
 * error — silently falling back to "no secret" would be far worse.
 */
export function expandFileSecrets(
  raw: NodeJS.ProcessEnv,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...raw };
  for (const name of FILE_BACKED_SECRETS) {
    const filePath = raw[`${name}_FILE`];
    if (!filePath || raw[name]) continue;
    try {
      out[name] = readFile(filePath).trim();
    } catch {
      // The path is safe to show; the contents are never read into the message.
      throw new Error(`${name}_FILE is set but could not be read: ${filePath}`);
    }
  }
  return out;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3001),

    /**
     * PostgreSQL connection URL, e.g.
     * `postgresql://kas_app:<encoded>@127.0.0.1:5432/kas`.
     *
     * Reserved characters in the password (`@ : / ? # % [ ] &` and space) MUST
     * be percent-encoded, otherwise the URL parses into a different host or
     * database and fails with a confusing "database does not exist" rather
     * than an authentication error.
     *
     * A `file:` URL is still accepted outside production so the legacy SQLite
     * pilot database can be opened by the transfer tool, but production
     * refuses to boot on anything but PostgreSQL (checked below).
     */
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required (example: postgresql://user:pass@127.0.0.1:5432/kas)'),

    /**
     * Optional un-pooled connection used only by schema migrations. It exists
     * for a future deployment behind PgBouncer; with PostgreSQL running
     * directly on the Windows host there is no pooler, so leaving this unset
     * is correct and `DATABASE_URL` is used for migrations too.
     */
    DIRECT_DATABASE_URL: z.string().min(1).optional(),

    /**
     * The exact public origin the app is served from, e.g.
     * "https://dispatch.example.com". Required in production: it is the single
     * declared origin for the same-origin check, and it is what an operator
     * must keep in sync with the Caddy site address and DNS.
     */
    APP_ORIGIN: z.string().url('APP_ORIGIN must be a full URL, e.g. https://example.com').optional(),

    /**
     * How many reverse proxies sit in front of the app, for Express `trust proxy`.
     * Behind the bundled Caddy this is exactly 1. Never set it higher than the
     * number of proxies you actually control: each extra hop lets a client forge
     * one more X-Forwarded-For entry and evade the login rate limiter.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

    /** Where backup archives are written. Must be a persistent volume in production. */
    BACKUP_DIR: z.string().min(1).default('backups'),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

    /**
     * The git commit or release tag being run, recorded on every dispatched
     * booking so an extraction can be traced to the exact code that produced
     * it. `parserVersion` says which RULES applied; this says which BUILD.
     * Optional: unset simply records nothing rather than inventing a value.
     */
    APP_RELEASE_REF: z.string().min(1).max(200).optional(),

    /** Maximum accepted upload size in megabytes (proof screenshots, issue photos). */
    MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(10),

    /**
     * Serve the built client (client/dist) from the API process, making the whole
     * app a single same-origin container. Defaults on in production, off
     * elsewhere (the Vite dev server owns the frontend during development).
     */
    SERVE_CLIENT: booleanFromEnv.optional(),

    /** Where the built client lives, relative to the repository root by default. */
    CLIENT_DIST_DIR: z.string().min(1).default('client/dist'),

    // Sessions. SESSION_SECRET signs the session cookie; a weak or shared
    // secret undermines every login, so it is required everywhere and must be
    // reasonably long.
    SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
    // Send the session cookie only over HTTPS. False in local development; set
    // true in production when the app is served over TLS.
    SESSION_COOKIE_SECURE: booleanFromEnv.default(false),
    // Session lifetime. Also the rolling window that each request refreshes.
    SESSION_MAX_AGE_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),

    // Initial administrator, created once at startup when no admin exists.
    // Optional here so a fresh checkout can boot; enforced in production below.
    INITIAL_ADMIN_USERNAME: z.string().min(1).optional(),
    INITIAL_ADMIN_PASSWORD: z.string().min(1).optional(),
    INITIAL_ADMIN_FULL_NAME: z.string().min(1).optional(),

    // Login rate limiting. Kept configurable so an operator can loosen or
    // tighten it without a code change.
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(1000).default(10),
    LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

    // bcrypt work factor. 10 is a sound default for production; the test suite
    // lowers it so the pure-JS implementation does not dominate run time.
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(10),

    /**
     * AES-256-GCM key for card numbers in the Chứng từ module: 32 random bytes,
     * base64. Also accepted as CARD_ENCRYPTION_KEY_FILE (Docker/systemd secret).
     *
     * DEDICATED, NEVER DERIVED FROM SESSION_SECRET. Rotating the session secret
     * is a routine action that merely logs everyone out; if card numbers hung
     * off it, that same routine action would destroy every stored PAN with no
     * error until someone tried to read one. The two also belong to different
     * trust domains — cookie integrity and cardholder data at rest.
     *
     * Optional here so every existing command (migrations, backups, the parser
     * tests) still boots without it. The charge module refuses to encrypt or
     * decrypt when it is absent, rather than falling back to anything weaker.
     *
     * LOSING THIS KEY MAKES EVERY STORED CARD NUMBER UNRECOVERABLE. It belongs
     * in the backup procedure beside the database, and production must have its
     * own key — never the development one.
     */
    CARD_ENCRYPTION_KEY: z.string().min(1).optional(),

    // Where proof-of-creation screenshots are stored on the server filesystem.
    // Only metadata + a safe relative path live in the database; never the
    // image bytes. Relative values are resolved against the repository root.
    PROOF_UPLOAD_DIR: z.string().min(1).default('server/uploads/booking-proofs'),
    // Where receptionist issue-report photos are stored (same rules as proofs).
    ISSUE_UPLOAD_DIR: z.string().min(1).default('server/uploads/issue-photos'),
    // Where Chứng từ attachments are stored (same rules again: private disk,
    // server-generated names, never served as static content).
    CHARGE_UPLOAD_DIR: z.string().min(1).default('server/uploads/charge-documents'),
    // Where Chat box message images are stored (same rules once more).
    CHAT_UPLOAD_DIR: z.string().min(1).default('server/uploads/chat-attachments'),

    // --- Developer test tools (demo data + branch switch + reset) ---
    // Gates every /api/dev-test endpoint and the demo/reset UI. MUST stay false in
    // production; even when true the tools additionally refuse to run in production.
    ENABLE_DEV_TEST_TOOLS: booleanFromEnv.default(false),

    // --- Proof OCR (advisory extraction only) ---
    // When false (the safe default), proof upload still works and the Admin reads
    // the screenshot manually; every analysis is recorded as DISABLED. When true,
    // the server attempts local OCR with Tesseract.js (an optional dependency —
    // install it separately). OCR never approves/rejects and never compares.
    PROOF_OCR_ENABLED: booleanFromEnv.default(false),
    // Tesseract language packs to load (e.g. "eng+vie"). Only used when enabled.
    PROOF_OCR_LANGUAGE: z.string().min(1).default('eng+vie'),
  })
  .superRefine((value, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    // Applies in EVERY environment: a URL we cannot parse is a configuration
    // bug, and the message must describe the shape without echoing the value
    // (it carries the password).
    const target = describeDatabaseUrl(value.DATABASE_URL);
    if (target.kind === 'unknown') {
      fail('DATABASE_URL', 'DATABASE_URL must be a postgresql:// URL (or a file: URL outside production)');
    } else if (target.malformed) {
      fail(
        'DATABASE_URL',
        target.kind === 'postgresql'
          ? 'DATABASE_URL is missing a database name, or reserved characters in the password are not percent-encoded'
          : 'DATABASE_URL is not a usable file: path',
      );
    }

    if (value.NODE_ENV !== 'production') return;

    // Production runs on PostgreSQL 17. The SQLite pilot shape must not boot a
    // production process by accident after the D.1 cutover — a `file:` URL
    // there would silently start the app on an empty local database.
    if (target.kind !== 'postgresql') {
      fail('DATABASE_URL', 'DATABASE_URL must be a postgresql:// URL in production (SQLite is pilot-only)');
    }

    // A missing initial-admin variable must never silently create a predictable
    // default account, so fail configuration validation instead.
    for (const key of ['INITIAL_ADMIN_USERNAME', 'INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_FULL_NAME'] as const) {
      if (!value[key]) fail(key, `${key} is required in production`);
    }

    // The developer test tools (demo data, reception_test branch switching,
    // demo clear) must be unreachable in production. They already refuse to run
    // there, but a deployment that *asks* for them is a configuration mistake we
    // refuse to boot with rather than silently ignore.
    if (value.ENABLE_DEV_TEST_TOOLS) {
      fail('ENABLE_DEV_TEST_TOOLS', 'ENABLE_DEV_TEST_TOOLS must be false in production');
    }

    // Production is served over HTTPS behind Caddy; a session cookie without the
    // Secure attribute could be sent over a downgraded connection.
    if (!value.SESSION_COOKIE_SECURE) {
      fail('SESSION_COOKIE_SECURE', 'SESSION_COOKIE_SECURE must be true in production (HTTPS only)');
    }

    if (!value.APP_ORIGIN) {
      fail('APP_ORIGIN', 'APP_ORIGIN is required in production (e.g. https://dispatch.example.com)');
    } else if (!value.APP_ORIGIN.startsWith('https://')) {
      fail('APP_ORIGIN', 'APP_ORIGIN must use https:// in production');
    }

    // A short or placeholder secret invalidates every session in the system.
    if (value.SESSION_SECRET.length < 32) {
      fail('SESSION_SECRET', 'SESSION_SECRET must be at least 32 characters in production');
    }
    if (/^(change-me|changeme|secret|password|test)/i.test(value.SESSION_SECRET)) {
      fail('SESSION_SECRET', 'SESSION_SECRET still looks like the example placeholder');
    }
    if (value.INITIAL_ADMIN_PASSWORD && /^(change-me|changeme|admin|password)/i.test(value.INITIAL_ADMIN_PASSWORD)) {
      fail('INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_PASSWORD still looks like the example placeholder');
    }

    // Uploads and backups must live on persistent volumes, never inside the
    // disposable container filesystem.
    //
    // CHARGE_UPLOAD_DIR belongs here for a sharper reason than the others: a
    // relative value resolves inside the application directory, which a release
    // REPLACES. Charge documents are financial evidence, so a deployment would
    // quietly destroy them — and nothing would report it, because writing them
    // there succeeds. Refusing to boot is the only safe response.
    for (const key of [
      'PROOF_UPLOAD_DIR',
      'ISSUE_UPLOAD_DIR',
      'CHARGE_UPLOAD_DIR',
      'CHAT_UPLOAD_DIR',
      'BACKUP_DIR',
    ] as const) {
      if (!path.isAbsolute(value[key])) {
        fail(key, `${key} must be an absolute path in production (a persistent volume)`);
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export type EnvParseResult =
  | { success: true; env: Env }
  | { success: false; errors: string[] };

/**
 * Pure validator: takes a raw environment, expands `*_FILE` secrets and applies
 * every rule (including the production-only ones). Exported so the production
 * configuration contract can be tested without booting the process or mutating
 * `process.env`, and so a deployment can be checked before it is started.
 *
 * Error strings are `KEY: message` and never contain a secret's value.
 */
export function parseEnvironment(
  raw: NodeJS.ProcessEnv,
  readFile?: (p: string) => string,
): EnvParseResult {
  let expanded: NodeJS.ProcessEnv;
  try {
    expanded = expandFileSecrets(raw, readFile);
  } catch (error) {
    return { success: false, errors: [(error as Error).message] };
  }

  const parsed = envSchema.safeParse(expanded);
  if (parsed.success) return { success: true, env: parsed.data };

  return {
    success: false,
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

function loadEnv(): Env {
  const result = parseEnvironment(process.env);

  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
        'Copy .env.example to .env (or .env.production.example for a server) and fill in the values.',
    );
  }

  return result.env;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/**
 * Pure gate: the developer test tools require the explicit flag AND a
 * non-production environment. Exposed for unit testing the production refusal.
 */
export function computeDevToolsEnabled(flag: boolean, nodeEnv: string): boolean {
  return flag && nodeEnv !== 'production';
}

/**
 * Whether the developer test tools (demo data, branch switch, reset) are active.
 * They can never be reached in production even if the flag is mistakenly set.
 */
export const devToolsEnabled = computeDevToolsEnabled(env.ENABLE_DEV_TEST_TOOLS, env.NODE_ENV);

// Absolute writable directories. A relative value is resolved from the
// repository root (this file lives at server/src/config, so up three levels).
// In production every one of these must already be absolute (enforced above),
// because they have to point at persistent volumes rather than at anything
// inside the disposable container filesystem.
export const REPO_ROOT = path.resolve(__dirname, '../../..');
const absolute = (value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);

export const PROOF_UPLOAD_DIR = absolute(env.PROOF_UPLOAD_DIR);
export const ISSUE_UPLOAD_DIR = absolute(env.ISSUE_UPLOAD_DIR);
/** Where Chứng từ attachments are stored. Same rules as proofs: private disk. */
export const CHARGE_UPLOAD_DIR = absolute(env.CHARGE_UPLOAD_DIR);
/** Where Chat box images are stored. Same rules again: private disk, never served. */
export const CHAT_UPLOAD_DIR = absolute(env.CHAT_UPLOAD_DIR);
export const BACKUP_DIR = absolute(env.BACKUP_DIR);
export const CLIENT_DIST_DIR = absolute(env.CLIENT_DIST_DIR);

/** Maximum upload size in bytes, derived from MAX_UPLOAD_MB. */
export const MAX_UPLOAD_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

/** Whether this process also serves the built client (single-container mode). */
export const serveClient = env.SERVE_CLIENT ?? isProduction;

/**
 * Absolute path of a SQLite database file, or null when the URL is not a
 * `file:` URL. Prisma resolves a relative `file:` path from the schema's own
 * directory (`prisma/`), so the same rule is applied here.
 *
 * Since Phase D.1 this is LEGACY-ONLY: production runs on PostgreSQL and the
 * backup/restore path is pg_dump/pg_restore. The single remaining caller is
 * the SQLite→PostgreSQL transfer tool, which opens the pilot database
 * READ-ONLY as a migration source.
 */
export function sqliteFilePath(databaseUrl: string = env.DATABASE_URL): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  const raw = databaseUrl.slice('file:'.length);
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, 'prisma', raw);
}

/** The connection target of the running process, with no credentials in it. */
export const databaseTarget = describeDatabaseUrl(env.DATABASE_URL);

/** Whether this process is talking to PostgreSQL (as production always does). */
export const isPostgres = databaseTarget.kind === 'postgresql';
