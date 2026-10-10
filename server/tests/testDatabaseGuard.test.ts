/**
 * Regression suite for the test-database safety guard.
 *
 * WHY THIS EXISTS: `kas_d1_test` is not a test database — it is the LIVE
 * PRODUCTION database serving https://kasbookingapp.com. The suite used to
 * resolve its target from `.env.d1.local`, which pointed there, so the
 * documented `npm test` command dropped and recreated a schema inside
 * production. These tests pin every rule that now makes that impossible.
 *
 * Everything here is pure: no connection is opened, and the only mutated state
 * is `process.env[KAS_TEST_DATABASE_URL]`, which is saved and restored around
 * each case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  D1_APPROVED_DATABASE,
  RESERVED_DATABASES,
  assertSafeWriteTarget,
  isReservedDatabaseName,
} from '../src/d1/guard';
import {
  APPROVED_TEST_DATABASE,
  TEST_DATABASE_ENV_VAR,
  TEST_SCHEMA,
  UnsafeTestDatabaseError,
  assertApprovedTestDatabase,
  resolveTestBaseUrl,
  resolveTestDatabaseUrl,
} from '../src/d1/testDatabase';

/** A syntactically valid URL for a named database. The password is fake. */
const urlFor = (database: string): string =>
  `postgresql://kas_app:not-a-real-password@127.0.0.1:5432/${database}`;

const PRODUCTION_DATABASE = 'kas_d1_test';
const SECRET = 'not-a-real-password';

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[TEST_DATABASE_ENV_VAR];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[TEST_DATABASE_ENV_VAR];
  else process.env[TEST_DATABASE_ENV_VAR] = savedEnv;
});

/* ================================================================== */
/* Reserved names                                                      */
/* ================================================================== */

describe('isReservedDatabaseName', () => {
  it('rejects kas_d1_test — the live production database', () => {
    expect(isReservedDatabaseName('kas_d1_test')).toBe(true);
  });

  it('rejects kas_production', () => {
    expect(isReservedDatabaseName('kas_production')).toBe(true);
  });

  it('rejects any name containing "production"', () => {
    for (const name of ['production', 'kas_production_2', 'my-Production-copy', 'PRODUCTION']) {
      expect(isReservedDatabaseName(name)).toBe(true);
    }
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isReservedDatabaseName('  KAS_D1_TEST  ')).toBe(true);
  });

  it('accepts the approved disposable database', () => {
    expect(isReservedDatabaseName(APPROVED_TEST_DATABASE)).toBe(false);
  });

  it('lists both production databases as reserved', () => {
    expect(RESERVED_DATABASES).toContain('kas_production');
    expect(RESERVED_DATABASES).toContain(PRODUCTION_DATABASE);
  });
});

/* ================================================================== */
/* Write-target guard                                                  */
/* ================================================================== */

describe('assertSafeWriteTarget', () => {
  it('refuses kas_d1_test EVEN when it is explicitly allow-listed', () => {
    // The reserved check runs before the allow-list is consulted, so no flag,
    // argument or configuration can re-enable production as a write target.
    expect(() =>
      assertSafeWriteTarget(urlFor(PRODUCTION_DATABASE), {
        allowedDatabases: [PRODUCTION_DATABASE],
      }),
    ).toThrow(/bảo lưu/);
  });

  it('refuses kas_production even when explicitly allow-listed', () => {
    expect(() =>
      assertSafeWriteTarget(urlFor('kas_production'), { allowedDatabases: ['kas_production'] }),
    ).toThrow(/bảo lưu/);
  });

  /*
    THESE TWO CONSTANTS USED TO BE THE SAME DATABASE, AND THAT WAS THE BUG.

    `D1_APPROVED_DATABASE` is where the D.1 transfer/restore tooling may WRITE.
    `APPROVED_TEST_DATABASE` is the disposable database the automated suite
    drops and recreates a schema in. While both read `kas_dev_cn1` — which
    turned out to be the live database serving kasbookingapp.com — running the
    documented `npm test` dropped a schema inside production.

    They are now deliberately DIFFERENT, and this test pins that apart rather
    than asserting they match. The D.1 target is a separate decision: restoring
    a production backup into production is a legitimate operation, so that
    constant is not simply pointed at the test database.
  */
  it('defaults its allow-list to the D.1 write target, not the test database', () => {
    const target = assertSafeWriteTarget(urlFor(D1_APPROVED_DATABASE));
    expect(target.database).toBe(D1_APPROVED_DATABASE);
  });

  it('keeps the D.1 write target and the test database distinct', () => {
    expect(D1_APPROVED_DATABASE).not.toBe(APPROVED_TEST_DATABASE);
  });

  it('refuses the test database as a D.1 write target by default', () => {
    // The suite's database is not somewhere the transfer tooling may write.
    expect(() => assertSafeWriteTarget(urlFor(APPROVED_TEST_DATABASE))).toThrow();
  });

  it('never puts the password in the error message', () => {
    try {
      assertSafeWriteTarget(urlFor(PRODUCTION_DATABASE));
      throw new Error('expected the guard to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('postgresql://');
      // The database NAME is not a secret and is what an operator needs.
      expect(message).toContain(PRODUCTION_DATABASE);
    }
  });
});

/* ================================================================== */
/* Test-target resolution — fails closed                               */
/* ================================================================== */

describe('resolveTestBaseUrl', () => {
  it('fails closed when KAS_TEST_DATABASE_URL is not set', () => {
    delete process.env[TEST_DATABASE_ENV_VAR];
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('fails closed when KAS_TEST_DATABASE_URL is blank', () => {
    process.env[TEST_DATABASE_ENV_VAR] = '   ';
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('does NOT fall back to .env.d1.local, .env or DATABASE_URL', () => {
    delete process.env[TEST_DATABASE_ENV_VAR];
    // DATABASE_URL is always set while the suite runs; resolution must ignore
    // it completely rather than quietly adopting it.
    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('names no production database in its missing-variable guidance', () => {
    delete process.env[TEST_DATABASE_ENV_VAR];
    try {
      resolveTestBaseUrl();
      throw new Error('expected resolution to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(PRODUCTION_DATABASE);
      expect(message).not.toContain('kas_production');
      // It must point the operator at the disposable database instead.
      expect(message).toContain(APPROVED_TEST_DATABASE);
      expect(message).toContain(TEST_DATABASE_ENV_VAR);
    }
  });

  it('rejects a URL pointing at kas_d1_test', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor(PRODUCTION_DATABASE);
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects a URL pointing at kas_production', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor('kas_production');
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects a database that is merely unreserved but not the approved one', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor('some_other_db');
    expect(() => resolveTestBaseUrl()).toThrow(/kas_test/);
  });

  it('rejects kas_dev_cn1 — it is production, and was once wrongly the target', () => {
    // The regression this whole file exists for: kas_dev_cn1 was the approved
    // test database while it was serving kasbookingapp.com, so `npm test`
    // dropped and recreated a schema inside production. It must now be refused
    // like any other non-approved database.
    process.env[TEST_DATABASE_ENV_VAR] = urlFor('kas_dev_cn1');
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects the development database — dev data is not a test target either', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor('kas_dev');
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects a non-postgresql URL', () => {
    process.env[TEST_DATABASE_ENV_VAR] = 'file:./test.db';
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects a postgresql URL with no database name', () => {
    process.env[TEST_DATABASE_ENV_VAR] = 'postgresql://kas_app:pw@127.0.0.1:5432/';
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('accepts kas_test when explicitly provided', () => {
    const url = urlFor(APPROVED_TEST_DATABASE);
    process.env[TEST_DATABASE_ENV_VAR] = url;
    expect(resolveTestBaseUrl()).toBe(url);
  });

  it('never leaks the password when refusing a URL', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor(PRODUCTION_DATABASE);
    try {
      resolveTestBaseUrl();
      throw new Error('expected resolution to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('postgresql://');
    }
  });
});

describe('assertApprovedTestDatabase', () => {
  it('returns the database name for the approved target', () => {
    expect(assertApprovedTestDatabase(urlFor(APPROVED_TEST_DATABASE))).toBe(APPROVED_TEST_DATABASE);
  });

  it('refuses every reserved name', () => {
    for (const name of [PRODUCTION_DATABASE, 'kas_production', 'anything_production']) {
      expect(() => assertApprovedTestDatabase(urlFor(name))).toThrow(UnsafeTestDatabaseError);
    }
  });
});

/* ================================================================== */
/* Schema isolation                                                    */
/* ================================================================== */

describe('test schema isolation', () => {
  it('pins the suite to its own schema, never public', () => {
    expect(TEST_SCHEMA).toBe('kas_vitest');
    expect(TEST_SCHEMA).not.toBe('public');
  });

  it('resolveTestDatabaseUrl pins the approved database to the test schema', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor(APPROVED_TEST_DATABASE);
    const url = resolveTestDatabaseUrl();
    expect(url).toContain(`/${APPROVED_TEST_DATABASE}`);
    expect(url).toContain(`schema=${TEST_SCHEMA}`);
  });

  it('refuses to build a schema-pinned URL for a production database', () => {
    process.env[TEST_DATABASE_ENV_VAR] = urlFor(PRODUCTION_DATABASE);
    expect(() => resolveTestDatabaseUrl()).toThrow(UnsafeTestDatabaseError);
  });

  it('the destructive setup path is unreachable once resolution has thrown', () => {
    // globalSetup calls resolveTestBaseUrl() BEFORE it opens a client or issues
    // DROP SCHEMA. Proving resolution throws proves no DDL can run: there is no
    // code path from a thrown resolution to a connection.
    process.env[TEST_DATABASE_ENV_VAR] = urlFor(PRODUCTION_DATABASE);
    expect(() => resolveTestBaseUrl()).toThrow(UnsafeTestDatabaseError);
    expect(() => resolveTestDatabaseUrl()).toThrow(UnsafeTestDatabaseError);
  });
});
