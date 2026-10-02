/**
 * The single place that interprets a database connection URL.
 *
 * SECURITY CONTRACT — the whole reason this module exists:
 * nothing here ever returns, logs, throws or stringifies the password. The
 * parsed shape deliberately has no password field at all, so a caller cannot
 * leak one by accident (e.g. by putting the parse result in an error message,
 * a health payload, a backup manifest or a verification report). Use
 * `redactDatabaseUrl` whenever a URL itself has to appear in operator output.
 *
 * Phase D.1 moved production from SQLite to PostgreSQL 17. Both shapes are
 * still understood: PostgreSQL is what the application runs on, and `file:`
 * URLs remain meaningful only as the READ-ONLY SOURCE of the one-off
 * SQLite→PostgreSQL transfer.
 */

export type DatabaseKind = 'postgresql' | 'sqlite' | 'unknown';

/** A connection target with every secret component removed by construction. */
export interface DatabaseTarget {
  kind: DatabaseKind;
  /** PostgreSQL only. */
  host: string | null;
  port: number | null;
  /** The database name — what every D.1 safety guard keys off. */
  database: string | null;
  user: string | null;
  /** The `?schema=` parameter, defaulting to `public` for PostgreSQL. */
  schema: string | null;
  /** SQLite only: the raw path portion of a `file:` URL. */
  file: string | null;
  /** True when the URL could not be parsed at all. */
  malformed: boolean;
}

const EMPTY: DatabaseTarget = {
  kind: 'unknown',
  host: null,
  port: null,
  database: null,
  user: null,
  schema: null,
  file: null,
  malformed: true,
};

/**
 * Describes a connection URL without exposing its credentials.
 *
 * Never throws: a malformed URL returns `{ malformed: true }` so callers can
 * report "invalid DATABASE_URL" without echoing the value they were given.
 */
export function describeDatabaseUrl(url: string): DatabaseTarget {
  const trimmed = url.trim();

  if (trimmed.startsWith('file:')) {
    const raw = trimmed.slice('file:'.length);
    return { ...EMPTY, kind: 'sqlite', file: raw, malformed: raw.length === 0 };
  }

  if (!/^postgres(ql)?:\/\//i.test(trimmed)) return EMPTY;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ...EMPTY, kind: 'postgresql' };
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;

  return {
    kind: 'postgresql',
    host: parsed.hostname || null,
    port: Number.isFinite(port) ? port : null,
    database: database.length > 0 ? database : null,
    user: parsed.username ? decodeURIComponent(parsed.username) : null,
    schema: parsed.searchParams.get('schema') ?? 'public',
    file: null,
    malformed: database.length === 0,
  };
}

/**
 * A form of the URL that is safe to print in an operator-facing log or report.
 * The password is replaced with a fixed marker — never with a length hint, a
 * prefix or a hash, all of which leak information about the real value.
 */
export function redactDatabaseUrl(url: string): string {
  const target = describeDatabaseUrl(url);

  if (target.kind === 'sqlite') return `file:${target.file ?? ''}`;
  if (target.kind !== 'postgresql' || target.malformed) return '<invalid-database-url>';

  const user = target.user ? `${target.user}:***@` : '';
  const schema = target.schema && target.schema !== 'public' ? `?schema=${target.schema}` : '';
  return `postgresql://${user}${target.host ?? ''}:${target.port ?? ''}/${target.database ?? ''}${schema}`;
}

/**
 * Strips anything that looks like a connection URL out of arbitrary text.
 *
 * Driver and CLI errors (`pg_dump`, `psql`, Prisma) sometimes embed the URL
 * they were handed. Every path that forwards such a message to a log, an HTTP
 * response or a report runs it through this first, so a leak takes a
 * deliberate act rather than a forgotten one.
 */
export function scrubConnectionSecrets(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"'<>]+/gi, '<redacted-database-url>')
    .replace(/\bPG(PASSWORD|PASSFILE)\s*=\s*\S+/gi, 'PG$1=<redacted>');
}

/** True when the URL names a PostgreSQL server. */
export function isPostgresUrl(url: string): boolean {
  return describeDatabaseUrl(url).kind === 'postgresql';
}

/**
 * The database name a URL points at, or null. Every destructive-operation
 * guard in the D.1 tooling is built on this.
 */
export function databaseNameOf(url: string): string | null {
  return describeDatabaseUrl(url).database;
}
