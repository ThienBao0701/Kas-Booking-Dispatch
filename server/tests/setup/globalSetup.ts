/**
 * Rebuilds the test database from the committed migrations before the suite
 * runs.
 *
 * Since Phase D.1 this targets real PostgreSQL rather than a throwaway SQLite
 * file, because production runs on PostgreSQL and a test suite that proves
 * behaviour on a different engine proves the wrong thing — enum handling,
 * concurrent writes, partial unique indexes and sequence allocation all differ.
 *
 * The suite gets its OWN SCHEMA inside kas_d1_test, which is dropped and
 * recreated here. That is the PostgreSQL equivalent of deleting test.db: total,
 * fast, and unable to touch the `public` schema that the D.1 transfer and
 * restore drill use.
 *
 * `migrate deploy` (not `db push`) is used deliberately: the tests exercise the
 * real migration files, so a broken migration fails the suite.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertLiveIdentity, isReservedDatabaseName } from '../../src/d1/guard';
import { describeDatabaseUrl } from '../../src/config/databaseUrl';
import {
  APPROVED_TEST_DATABASE,
  TEST_SCHEMA,
  UnsafeTestDatabaseError,
  resolveTestBaseUrl,
  resolveTestDatabaseUrl,
} from '../../src/d1/testDatabase';

const serverRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(serverRoot, '..');
const tmpDir = path.join(serverRoot, '.tmp');

/**
 * Resolves Prisma's JavaScript entry point so it can be run with the current
 * node binary. Spawning the `npx.cmd` shim instead fails with EINVAL on
 * Windows under Node 22+, which blocks .cmd files from spawnSync.
 */
function resolvePrismaEntry(): string {
  const packageJsonPath = require.resolve('prisma/package.json', { paths: [repoRoot] });
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const relativeBin =
    typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.prisma;

  if (!relativeBin) {
    throw new Error('Could not resolve the prisma CLI entry point from prisma/package.json');
  }

  return path.join(path.dirname(packageJsonPath), relativeBin);
}

export default async function setup(): Promise<void> {
  fs.mkdirSync(tmpDir, { recursive: true });

  // Start each run with empty upload dirs so uploaded fixtures never accumulate
  // between runs (must match PROOF_UPLOAD_DIR / ISSUE_UPLOAD_DIR in vitest.config).
  for (const dir of ['proof-uploads', 'issue-photos']) {
    const p = path.join(tmpDir, dir);
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
  }

  // Resolution itself is a guard: it requires KAS_TEST_DATABASE_URL, refuses
  // every reserved name, and refuses anything that is not the approved test
  // database. It never falls back to a file or to DATABASE_URL.
  const baseUrl = resolveTestBaseUrl();
  const databaseUrl = resolveTestDatabaseUrl();

  // SAFETY: this function drops a schema. Re-assert the static rules here too,
  // so the destructive step is protected even if resolution ever changes.
  const target = describeDatabaseUrl(baseUrl);
  if (target.kind !== 'postgresql' || !target.database) {
    throw new UnsafeTestDatabaseError('KAS_TEST_DATABASE_URL phải là postgresql:// URL.');
  }
  if (isReservedDatabaseName(target.database)) {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: bộ kiểm thử không bao giờ được chạy trên "${target.database}".`,
    );
  }
  if (target.database !== APPROVED_TEST_DATABASE) {
    throw new UnsafeTestDatabaseError(
      `TỪ CHỐI: bộ kiểm thử chỉ được chạy trên "${APPROVED_TEST_DATABASE}", ` +
        `nhưng đích là "${target.database}".`,
    );
  }
  if (TEST_SCHEMA === 'public') {
    throw new UnsafeTestDatabaseError('TỪ CHỐI: schema kiểm thử không được là "public".');
  }

  // Drop + recreate the suite's own schema through a client bound to the base
  // URL, so the DDL runs regardless of whether the test schema exists yet.
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    // The URL is not trusted on its own. Ask the SERVER who it is BEFORE any
    // DDL runs, so a pg_service file, a PGDATABASE variable or a connection
    // string that resolves elsewhere is caught while nothing has been written.
    await assertLiveIdentity(admin, APPROVED_TEST_DATABASE);

    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  } finally {
    await admin.$disconnect();
  }

  execFileSync(
    process.execPath,
    [
      resolvePrismaEntry(),
      'migrate',
      'deploy',
      '--schema',
      path.join(repoRoot, 'prisma', 'schema.prisma'),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );
}
