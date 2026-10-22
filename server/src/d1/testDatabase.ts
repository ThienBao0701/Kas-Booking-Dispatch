/**
 * Resolves the PostgreSQL URL the automated test suite runs against.
 *
 * FAIL-CLOSED BY DESIGN.
 *
 * This module used to resolve the suite's target from `.env.d1.local`, falling
 * back to whatever that file happened to contain. That file pointed at
 * `kas_d1_test` — which is the LIVE PRODUCTION database, not a test database —
 * so the documented `npm test` command dropped and recreated a schema inside
 * production. The fallback is gone: the target now comes from ONE explicit
 * source and is validated by name before a connection is ever opened.
 *
 *   - The URL must come from `KAS_TEST_DATABASE_URL`. There is no fallback to
 *     `.env.d1.local`, to `.env`, or to `DATABASE_URL`.
 *   - The database it names must not be reserved (`kas_production`,
 *     `kas_d1_test`, anything containing "production").
 *   - It must be exactly {@link APPROVED_TEST_DATABASE}.
 *
 * ISOLATION MODEL: the suite does NOT share the `public` schema of the approved
 * database. It gets its own schema ({@link TEST_SCHEMA}), which means dropping
 * the whole test schema between runs is cheap and total — the PostgreSQL
 * equivalent of deleting the old SQLite test.db — while `public` is left alone.
 *
 * Nothing here ever logs, throws or returns the URL or its password: every
 * message names the DATABASE only, which is not a secret and is exactly what an
 * operator needs to see.
 */
import { describeDatabaseUrl } from '../config/databaseUrl';
import { isReservedDatabaseName } from './guard';

/**
 * Typed as `string`, not as the literal, on purpose: it is a configuration
 * value that a future change could point at something dangerous, and the
 * safety check in globalSetup ("must not be public") has to stay reachable
 * rather than being compiled away as provably-impossible.
 */
export const TEST_SCHEMA: string = 'kas_vitest';

/**
 * The only database the automated suite may ever run against. Typed as
 * `string` for the same reason as {@link TEST_SCHEMA}.
 *
 * `kas_test` is a DEDICATED, DISPOSABLE database that exists for nothing else.
 * It replaced `kas_dev_cn1`, which was named as the approved target back when
 * that database was believed to be development — and which is in fact the live
 * database serving kasbookingapp.com. The suite drops and recreates a schema on
 * every run, so pointing it at a database that also holds real data was one
 * mistaken constant away from destroying production.
 *
 * Development now uses `kas_dev` and the suite uses `kas_test`; neither shares a
 * database with production, and the schema isolation below is kept on top of
 * that as a second layer rather than as the only one.
 */
export const APPROVED_TEST_DATABASE: string = 'kas_test';

/** The one environment variable that selects the suite's target. */
export const TEST_DATABASE_ENV_VAR = 'KAS_TEST_DATABASE_URL';

/**
 * Adds or replaces the `schema` parameter of a PostgreSQL URL.
 *
 * `URL` preserves the percent-encoding of the password verbatim, so a password
 * containing reserved characters survives the round trip unchanged.
 */
export function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

/**
 * Raised whenever the suite's target is missing, unparseable, reserved or not
 * the approved database. The message never contains the URL or the password.
 */
export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTestDatabaseError';
  }
}

function missingVariableMessage(): string {
  return [
    `Bộ kiểm thử cần biến môi trường ${TEST_DATABASE_ENV_VAR}.`,
    '',
    'KHÔNG có giá trị mặc định và KHÔNG có cơ chế dự phòng: bộ kiểm thử sẽ',
    'DROP/CREATE schema và ghi dữ liệu, nên đích phải được chỉ định rõ ràng.',
    '',
    `Hãy trỏ tới cơ sở dữ liệu dùng-một-lần "${APPROVED_TEST_DATABASE}":`,
    `  PowerShell:  $env:${TEST_DATABASE_ENV_VAR} = '<url tới ${APPROVED_TEST_DATABASE}>'`,
    `  bash:        export ${TEST_DATABASE_ENV_VAR}='<url tới ${APPROVED_TEST_DATABASE}>'`,
    '',
    'Không bao giờ trỏ bộ kiểm thử tới cơ sở dữ liệu production.',
    'Ký tự đặc biệt trong mật khẩu phải được percent-encode.',
  ].join('\n');
}

/**
 * Validates a candidate test URL and returns the database name it targets.
 *
 * Exported so the guard can be unit-tested directly, without a connection and
 * without mutating the process environment.
 */
export function assertApprovedTestDatabase(url: string): string {
  const target = describeDatabaseUrl(url);

  if (target.kind !== 'postgresql') {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: ${TEST_DATABASE_ENV_VAR} phải là một URL postgresql://.`,
    );
  }
  if (target.malformed || !target.database) {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: ${TEST_DATABASE_ENV_VAR} không hợp lệ hoặc thiếu tên cơ sở dữ liệu. ` +
        'Ký tự đặc biệt trong mật khẩu phải được percent-encode.',
    );
  }

  // Reserved first, and never overridable: kas_production, kas_d1_test (the
  // live production database) and anything containing "production".
  if (isReservedDatabaseName(target.database)) {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: "${target.database}" là cơ sở dữ liệu được bảo lưu (production) ` +
        'và không bao giờ được dùng cho kiểm thử. Bộ kiểm thử đã dừng trước khi ghi bất cứ thứ gì.',
    );
  }

  if (target.database !== APPROVED_TEST_DATABASE) {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: bộ kiểm thử chỉ được chạy trên "${APPROVED_TEST_DATABASE}", ` +
        `nhưng ${TEST_DATABASE_ENV_VAR} trỏ tới "${target.database}".`,
    );
  }

  return target.database;
}

/**
 * The base URL (no schema override) the suite should use.
 *
 * Throws a long, actionable message rather than failing deep inside Prisma —
 * and throws rather than falling back to any file or other variable.
 */
export function resolveTestBaseUrl(): string {
  const raw = process.env[TEST_DATABASE_ENV_VAR];
  if (!raw || raw.trim().length === 0) {
    throw new UnsafeTestDatabaseError(missingVariableMessage());
  }
  const url = raw.trim();
  assertApprovedTestDatabase(url);
  return url;
}

/** The URL the suite connects with: the base URL pinned to the test schema. */
export function resolveTestDatabaseUrl(schema: string = TEST_SCHEMA): string {
  return withSchema(resolveTestBaseUrl(), schema);
}
