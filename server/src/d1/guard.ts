/**
 * Phase D.1 database safety guard.
 *
 * Every D.1 tool that can WRITE — the transfer, the sequence resync, the
 * restore drill, the destructive schema reset — routes through here first.
 * The rules are deliberately absolute and are not overridable by a flag:
 *
 *   1. `kas_production` and `kas_d1_test` are reserved and untouchable. So is
 *      any database whose name contains "production", because the cost of
 *      refusing a legitimately-named database is a one-line override in a
 *      later phase, while the cost of writing to the wrong one is
 *      unrecoverable.
 *
 *      `kas_d1_test` is NOT a test database despite its name: it is the LIVE
 *      PRODUCTION database serving https://kasbookingapp.com. It was
 *      previously the approved D.1 write target, which made the documented
 *      `npm test` command write to production. It is now reserved by name so
 *      that no allow-list, flag or environment variable can re-enable it.
 *   2. A write target must be PostgreSQL and must name a database explicitly.
 *   3. The only approved write target is `kas_dev_cn1`.
 *   4. The URL is not trusted on its own. `assertLiveIdentity` re-asks the
 *      server `SELECT current_database(), current_user` after connecting, so a
 *      pg_service file, a PGDATABASE variable or a connection-string typo that
 *      lands somewhere else is caught before any row is written.
 *
 * Guard failures never include the connection URL — only the database name,
 * which is not a secret and is exactly what an operator needs to see.
 */
import type { PrismaClient } from '@prisma/client';
import { describeDatabaseUrl, type DatabaseTarget } from '../config/databaseUrl';

/**
 * Databases that may never be touched, in any mode, for any reason.
 *
 * `kas_d1_test` is on this list because it is the LIVE PRODUCTION database —
 * the name is a historical accident from the D.1 pilot, not a description.
 */
export const RESERVED_DATABASES = ['kas_production', 'kas_d1_test'] as const;

/** The only database this tooling is approved to write to. */
export const D1_APPROVED_DATABASE = 'kas_dev_cn1';

export class DatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseGuardError';
  }
}

/** True when a name is reserved. Case-insensitive and substring-defensive. */
export function isReservedDatabaseName(name: string | null): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  if ((RESERVED_DATABASES as readonly string[]).includes(lower)) return true;
  return lower.includes('production');
}

export interface TargetGuardOptions {
  /**
   * Which database names are acceptable. Defaults to the single approved D.1
   * target. Passing an explicit list is how the automated tests point at their
   * own database without weakening the reserved-name rule, which is applied
   * before this list is even consulted.
   */
  allowedDatabases?: readonly string[];
  /** Describes the operation in the error message, e.g. "chuyển dữ liệu". */
  operation?: string;
}

/**
 * Static guard: validates a URL before a connection is opened.
 *
 * Returns the parsed, password-free target so callers can report the database
 * name they are about to act on.
 */
export function assertSafeWriteTarget(
  url: string,
  options: TargetGuardOptions = {},
): DatabaseTarget {
  const operation = options.operation ?? 'thao tác ghi';
  const target = describeDatabaseUrl(url);

  if (target.kind !== 'postgresql') {
    throw new DatabaseGuardError(
      `${operation}: đích phải là PostgreSQL (postgresql://). Nhận được: ${target.kind}.`,
    );
  }
  if (target.malformed || !target.database) {
    throw new DatabaseGuardError(
      `${operation}: DATABASE_URL không hợp lệ hoặc thiếu tên cơ sở dữ liệu. ` +
        'Ký tự đặc biệt trong mật khẩu phải được percent-encode.',
    );
  }

  // Rule 1 — absolute, checked before anything else and never overridable.
  if (isReservedDatabaseName(target.database)) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: "${target.database}" là cơ sở dữ liệu được bảo lưu và không được phép ` +
        `trong Phase D.1. Chỉ được dùng "${D1_APPROVED_DATABASE}".`,
    );
  }

  const allowed = options.allowedDatabases ?? [D1_APPROVED_DATABASE];
  if (!allowed.includes(target.database)) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: ${operation} chỉ được phép trên [${allowed.join(', ')}], ` +
        `nhưng đích là "${target.database}".`,
    );
  }

  return target;
}

export interface LiveIdentity {
  database: string;
  user: string;
  serverVersion: string;
  schema: string;
}

/**
 * Runtime guard: asks the SERVER who it is, after connecting.
 *
 * This is the check that catches a URL which parses as one database but
 * resolves to another. It runs before every destructive or bulk-write D.1
 * operation, not once at startup.
 */
export async function assertLiveIdentity(
  client: Pick<PrismaClient, '$queryRawUnsafe'>,
  expectedDatabase: string,
  expectedUser?: string,
): Promise<LiveIdentity> {
  const rows = await client.$queryRawUnsafe<
    { database: string; usr: string; version: string; schema: string }[]
  >(
    'SELECT current_database() AS database, current_user AS usr, ' +
      "current_setting('server_version') AS version, current_schema() AS schema",
  );

  const row = rows[0];
  if (!row) throw new DatabaseGuardError('Không xác định được danh tính cơ sở dữ liệu.');

  const identity: LiveIdentity = {
    database: row.database,
    user: row.usr,
    serverVersion: row.version,
    schema: row.schema,
  };

  if (isReservedDatabaseName(identity.database)) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: đã kết nối tới cơ sở dữ liệu được bảo lưu "${identity.database}". Dừng ngay.`,
    );
  }
  if (identity.database !== expectedDatabase) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: current_database() = "${identity.database}" nhưng mong đợi "${expectedDatabase}".`,
    );
  }
  if (expectedUser && identity.user !== expectedUser) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: current_user = "${identity.user}" nhưng mong đợi "${expectedUser}".`,
    );
  }

  return identity;
}

/**
 * The gate in front of an operation that DESTROYS data (schema reset, restore
 * over an existing database).
 *
 * Three independent things must all be true — the name must be the approved
 * disposable target, the live identity must already have been verified, and
 * the caller must pass an explicit opt-in flag. None of them defaults to true,
 * and the flag alone is never sufficient.
 */
export function assertDestructiveAllowed(
  identity: LiveIdentity,
  explicitlyConfirmed: boolean,
  options: { allowedDatabases?: readonly string[]; operation: string },
): void {
  const allowed = options.allowedDatabases ?? [D1_APPROVED_DATABASE];

  if (isReservedDatabaseName(identity.database)) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: ${options.operation} trên cơ sở dữ liệu được bảo lưu "${identity.database}".`,
    );
  }
  if (!allowed.includes(identity.database)) {
    throw new DatabaseGuardError(
      `TỪ CHỐI: ${options.operation} chỉ được phép trên [${allowed.join(', ')}], ` +
        `nhưng đang ở "${identity.database}".`,
    );
  }
  if (!explicitlyConfirmed) {
    throw new DatabaseGuardError(
      `${options.operation} sẽ XÓA dữ liệu trong "${identity.database}". ` +
        'Thao tác này không bao giờ chạy mặc định — hãy truyền cờ xác nhận rõ ràng.',
    );
  }
}
