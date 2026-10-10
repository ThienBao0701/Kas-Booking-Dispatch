/**
 * SQLite → PostgreSQL transfer suite (Phase D.1 §19C, §19D).
 *
 * Everything here runs against a GENERATED fixture SQLite database and a
 * throwaway PostgreSQL schema. No real pilot database and no real guest data
 * is involved at any point.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  FIXTURE_BRANCH_COUNT,
  FIXTURE_CLASS_COUNTS,
  buildFixtureSqlite,
} from '../src/d1/fixtureSqlite';
import { planTable, runTransfer } from '../src/d1/transfer';
import { runVerification } from '../src/d1/verify';
import { checkSequences } from '../src/d1/sequences';
import {
  introspectTarget,
  sequenceColumns,
  type TargetColumn,
  type TargetSchema,
} from '../src/d1/targetSchema';
import { SqliteSource, checkSourceCompatibility } from '../src/d1/sqliteSource';
import { DatabaseGuardError, isReservedDatabaseName } from '../src/d1/guard';
import { describeDatabaseUrl } from '../src/config/databaseUrl';
import { resolveTestBaseUrl, withSchema } from '../src/d1/testDatabase';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = resolveTestBaseUrl();
const TEST_DATABASE = describeDatabaseUrl(BASE_URL).database!;
const ALLOWED = [TEST_DATABASE] as const;

let workspace: string;
let fixtureFile: string;
let schemaName: string;
let schemaUrl: string;
let client: PrismaClient;
let admin: PrismaClient;

function migrateInto(url: string): void {
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
      'migrate', 'deploy', '--schema', 'prisma/schema.prisma',
    ],
    { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
  );
}

const transferOptions = (mode: 'dry-run' | 'execute', extra: Record<string, unknown> = {}) => ({
  sourceFile: fixtureFile,
  targetUrl: schemaUrl,
  mode,
  allowedDatabases: ALLOWED,
  client,
  ...extra,
});

beforeAll(() => {
  admin = new PrismaClient({ datasourceUrl: BASE_URL });
});

afterAll(async () => {
  await admin.$disconnect();
});

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-transfer-'));
  fixtureFile = path.join(workspace, 'fixture.db');
  buildFixtureSqlite(fixtureFile, REPO_ROOT);

  schemaName = `kas_tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  schemaUrl = withSchema(BASE_URL, schemaName);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  migrateInto(schemaUrl);
  client = new PrismaClient({ datasourceUrl: schemaUrl });
}, 60_000);

afterEach(async () => {
  await client.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('C. transfer', () => {
  it('C1. the SQLite source is never modified', async () => {
    const before = fs.readFileSync(fixtureFile);
    const beforeMtime = fs.statSync(fixtureFile).mtimeMs;

    const report = await runTransfer(transferOptions('execute'));

    expect(report.ok, report.problems.join('; ')).toBe(true);
    expect(report.source.unchanged).toBe(true);
    expect(report.source.sha256After).toBe(report.source.sha256Before);
    // Byte-for-byte, not just by hash bookkeeping.
    expect(fs.readFileSync(fixtureFile).equals(before)).toBe(true);
    expect(fs.statSync(fixtureFile).mtimeMs).toBe(beforeMtime);
  });

  it('C2. a read-only source rejects writes at the driver level', () => {
    const source = SqliteSource.open(fixtureFile);
    try {
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (source as any).db.exec('CREATE TABLE should_not_exist (x INTEGER)');
      }).toThrow();
    } finally {
      source.close();
    }
    const check = SqliteSource.open(fixtureFile);
    try {
      expect(check.tables()).not.toContain('should_not_exist');
    } finally {
      check.close();
    }
  });

  it('C3. row counts, ids and relationships are preserved', async () => {
    await runTransfer(transferOptions('execute'));

    const source = SqliteSource.open(fixtureFile);
    try {
      for (const table of ['Branch', 'User', 'Booking', 'BookingRoom', 'BookingGuest', 'BranchRoomClass']) {
        const expected = source.count(table);
        const actual = await client.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "${table}"`,
        );
        expect(Number(actual[0]!.n), table).toBe(expected);
      }
      // Explicit integer ids survive verbatim — this is what makes every
      // foreign key in the transferred data still point at the right row.
      const range = source.idRange('Branch', 'id');
      const branches = await client.branch.findMany({ orderBy: { id: 'asc' } });
      expect(branches[0]!.id).toBe(range.min);
      expect(branches.at(-1)!.id).toBe(range.max);
      expect(branches).toHaveLength(FIXTURE_BRANCH_COUNT);
    } finally {
      source.close();
    }

    // Relationships, not just counts.
    const orphans = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "BookingRoom" r
         LEFT JOIN "Booking" b ON b.id = r."bookingId" WHERE b.id IS NULL`,
    );
    expect(Number(orphans[0]!.n)).toBe(0);
  });

  it('C4. mixed SQLite datetime representations land on the same instant', async () => {
    // The fixture stores some rows' createdAt as INTEGER epoch-ms (how Prisma
    // writes) and others as TEXT "YYYY-MM-DD HH:MM:SS" (how the C.3.8 backfill
    // wrote). Both must arrive as the UTC instant they represented; handling
    // only one would shift half the rows by the local UTC offset.
    await runTransfer(transferOptions('execute'));

    const rows = await client.$queryRawUnsafe<{ id: number; iso: string }[]>(
      `SELECT id, to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso
         FROM "Branch" WHERE id IN (1,2) ORDER BY id`,
    );
    // Branch 1 was TEXT, branch 2 INTEGER, one fixture day apart.
    expect(rows[0]!.iso).toBe('2026-06-02T06:00:00Z');
    expect(rows[1]!.iso).toBe('2026-06-03T06:00:00Z');
  });

  it('C5. a dry run writes nothing but still validates every row', async () => {
    const report = await runTransfer(transferOptions('dry-run'));
    expect(report.ok, report.problems.join('; ')).toBe(true);
    // It reports what WOULD move...
    expect(report.tables.find((t) => t.table === 'Branch')!.inserted).toBe(FIXTURE_BRANCH_COUNT);
    // ...while the target is still completely empty.
    expect(await client.branch.count()).toBe(0);
    expect(await client.booking.count()).toBe(0);
  });

  it('C6. a non-empty target is refused unless --resume is explicit', async () => {
    await runTransfer(transferOptions('execute'));

    await expect(runTransfer(transferOptions('execute'))).rejects.toThrow(/rỗng|resume/i);

    // With resume it is safe to re-run and nothing is duplicated.
    const resumed = await runTransfer(transferOptions('execute', { resume: true }));
    expect(resumed.ok, resumed.problems.join('; ')).toBe(true);
    expect(await client.branch.count()).toBe(FIXTURE_BRANCH_COUNT);
  });

  it('C7. an incompatible source schema fails clearly and writes nothing', async () => {
    // Simulate a source from a future/unknown schema version.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(fixtureFile);
    db.exec(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ('future','future', '2099-01-01 00:00:00', '20990101000000_from_the_future', '2099-01-01 00:00:00', 1)`,
    );
    db.close();

    await expect(runTransfer(transferOptions('execute'))).rejects.toThrow(/không tương thích/i);
    expect(await client.branch.count()).toBe(0);
  });

  it('C8. a missing source file is refused', async () => {
    await expect(
      runTransfer({ ...transferOptions('dry-run'), sourceFile: path.join(workspace, 'nope.db') }),
    ).rejects.toThrow(/Không tìm thấy/i);
  });

  it('C9. kas_production is refused before a connection is even opened', async () => {
    for (const database of ['kas_production', 'KAS_PRODUCTION', 'kas_production_copy']) {
      expect(isReservedDatabaseName(database)).toBe(true);
      await expect(
        runTransfer({
          ...transferOptions('dry-run'),
          targetUrl: `postgresql://kas_app:x@127.0.0.1:5432/${database}`,
          allowedDatabases: undefined,
        }),
      ).rejects.toBeInstanceOf(DatabaseGuardError);
    }
  });

  /*
    C10a-d. THE COLUMN-COMPATIBILITY RULE, asserted directly.

    A target column the legacy source lacks is only a problem when the INSERT
    would fail without it. The database can supply a value three ways —
    nullable, sequence-backed, or DEFAULT — and the third was missing, so every
    new `NOT NULL DEFAULT` column silently broke the gate against the frozen
    pilot source. `Booking.claimCycle` was the one that surfaced it.

    These use a synthetic schema so the rule is tested as a rule, rather than
    through whichever columns today's schema happens to contain.
  */
  function column(over: Partial<TargetColumn> & { name: string }): TargetColumn {
    return {
      kind: 'integer',
      udtName: 'int4',
      nullable: false,
      hasDefault: false,
      enumValues: [],
      sequence: null,
      ...over,
    };
  }

  /** A source that reports exactly the given column names for any table. */
  function sourceWith(names: string[]): SqliteSource {
    return {
      columns: () => names.map((name) => ({ name })),
      count: () => 0,
    } as unknown as SqliteSource;
  }

  function planWith(columns: TargetColumn[], sourceNames: string[]) {
    const schema: TargetSchema = new Map([
      ['T', { name: 'T', columns, sequenceColumns: [] }],
    ]);
    return planTable('T', sourceWith(sourceNames), schema);
  }

  it('C10a. ALLOWS a NOT NULL column missing from the source when it has a DEFAULT', () => {
    const plan = planWith(
      [column({ name: 'id' }), column({ name: 'claimCycle', hasDefault: true })],
      ['id'],
    );
    expect(plan.problems).toEqual([]);
    // And it is not transferred — PostgreSQL fills it.
    expect(plan.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('C10b. still REJECTS a NOT NULL column missing from the source with NO default', () => {
    const plan = planWith([column({ name: 'id' }), column({ name: 'mandatory' })], ['id']);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatch(/mandatory/);
  });

  it('C10c. the sequence exemption still works', () => {
    const plan = planWith(
      [column({ name: 'id', sequence: 'public.T_id_seq' }), column({ name: 'keep' })],
      ['keep'],
    );
    expect(plan.problems).toEqual([]);
  });

  it('C10d. a source column missing from the TARGET is still a data-loss refusal', () => {
    // The opposite direction is unchanged: dropping data is never acceptable.
    const plan = planWith([column({ name: 'id' })], ['id', 'goneFromTarget']);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatch(/goneFromTarget/);
  });

  it('C10. the compatibility gate accepts exactly the expected pilot schema', () => {
    const source = SqliteSource.open(fixtureFile);
    try {
      const check = checkSourceCompatibility(source);
      expect(check.ok, check.problems.join('; ')).toBe(true);
      expect(check.lastMigration).toBe('20260728093914_c38_branch_room_class_versioning');
      expect(check.appliedMigrations.length).toBeGreaterThanOrEqual(10);
    } finally {
      source.close();
    }
  });
});

describe('C. sequence synchronisation', () => {
  it('C11. every sequence is advanced past the highest imported id', async () => {
    const report = await runTransfer(transferOptions('execute'));

    const schema = await introspectTarget(client);
    const columns = sequenceColumns(schema);
    // The three Int @id @default(autoincrement()) tables, and no others.
    expect(columns.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
      'Branch.id', 'BranchSourceAlias.id', 'User.id',
    ]);

    for (const check of await checkSequences(client, schema)) {
      expect(check.ok, `${check.table}.${check.column}`).toBe(true);
      expect(check.nextValue).toBeGreaterThan(check.maxId ?? 0);
    }
    expect(report.sequences.every((s) => s.ok)).toBe(true);
  });

  it('C12. the next inserted row does not collide with an imported id', async () => {
    await runTransfer(transferOptions('execute'));

    // THE FAILURE THIS PINS: without a setval after explicit-id inserts, this
    // create() would try id = 1 and fail on the primary key, in production, on
    // the first branch an Admin adds after the cutover.
    const created = await client.branch.create({
      data: { code: 'AFTER_TRANSFER', hotelName: 'Mới', address: 'Mới' },
    });
    expect(created.id).toBeGreaterThan(FIXTURE_BRANCH_COUNT);

    const user = await client.user.create({
      data: { username: 'after-transfer', passwordHash: 'x', fullName: 'X', role: 'ADMIN' },
    });
    expect(user.id).toBeGreaterThan(0);

    const alias = await client.branchSourceAlias.create({
      data: { branchId: created.id, source: 'MANUAL', alias: 'A', normalizedAlias: 'a' },
    });
    expect(alias.id).toBeGreaterThan(0);
  });
});

describe('D. snapshot immutability after transfer', () => {
  it('D1. LEGACY and UNRESOLVED snapshots survive exactly as they were', async () => {
    await runTransfer(transferOptions('execute'));

    const source = SqliteSource.open(fixtureFile);
    try {
      const rows = source.page('BookingRoom', 100000, 0);
      for (const status of ['LEGACY', 'UNRESOLVED', 'RESOLVED', 'MANUAL'] as const) {
        const expected = rows.filter((r) => String(r.roomClassStatus ?? '') === status).length;
        const actual = await client.bookingRoom.count({ where: { roomClassStatus: status } });
        expect(actual, status).toBe(expected);
      }
      // The count must be non-trivial, or this test would pass vacuously.
      expect(await client.bookingRoom.count({ where: { roomClassStatus: 'LEGACY' } })).toBeGreaterThan(0);

      // A LEGACY row keeps its verbatim source text and its ABSENT pms code —
      // the transfer must never invent one (D.1 §10).
      const legacy = await client.bookingRoom.findMany({ where: { roomClassStatus: 'LEGACY' } });
      for (const room of legacy) {
        expect(room.roomClassPmsCode).toBeNull();
        expect(room.roomClassSourceText).not.toBeNull();
      }
    } finally {
      source.close();
    }
  });

  it('D2. the transferred data satisfies every deterministic verification check', async () => {
    await runTransfer(transferOptions('execute'));

    const report = await runVerification({
      sourceFile: fixtureFile,
      client,
      expectedBranches: FIXTURE_BRANCH_COUNT,
      expectedAliases: 24,
      expectedActiveClasses: 48,
      expectedClassCounts: FIXTURE_CLASS_COUNTS,
    });

    const failures = report.checks.filter((c) => c.status === 'fail');
    expect(failures.map((f) => `${f.name}: ${f.source} vs ${f.target}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary.total).toBeGreaterThan(50);
  });

  it('D3. the verification report contains no personal data', async () => {
    await runTransfer(transferOptions('execute'));
    const report = await runVerification({ sourceFile: fixtureFile, client });
    const serialised = JSON.stringify(report);

    // Values present in the fixture that must never reach a report.
    for (const secret of ['Khách Hàng', 'Khách phụ', '0900000', 'Raw booking text', 'letan', '@example.invalid']) {
      expect(serialised, secret).not.toContain(secret);
    }
    expect(serialised).not.toMatch(/postgres(ql)?:\/\//i);

    // Sensitive columns ARE still compared — by digest, and they match.
    const digests = report.checks.filter((c) => c.name.startsWith('sensitive-digest:'));
    expect(digests.length).toBeGreaterThan(0);
    for (const check of digests) {
      expect(check.status).toBe('pass');
      expect(String(check.source)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('D4. verification actually FAILS when the data differs', async () => {
    await runTransfer(transferOptions('execute'));

    // A verification that cannot fail proves nothing. Rewrite one LEGACY
    // snapshot the way a careless migration would, and require detection.
    const victim = await client.bookingRoom.findFirstOrThrow({
      where: { roomClassStatus: 'LEGACY' },
    });
    await client.bookingRoom.update({
      where: { id: victim.id },
      data: { roomClassStatus: 'RESOLVED', roomClassPmsCode: 'GUESSED' },
    });

    const report = await runVerification({ sourceFile: fixtureFile, client });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.name);
    expect(failed).toContain('snapshot-status:LEGACY');
    expect(failed).toContain('room-snapshot-digest');
  });
});
