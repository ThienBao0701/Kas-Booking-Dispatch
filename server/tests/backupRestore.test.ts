import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seedBranches } from '../src/db/seed';
import {
  BACKUP_MANIFEST_NAME,
  BACKUP_DB_NAME,
  LEGACY_SQLITE_FORMAT_VERSION,
  createBackup,
  listBackups,
  pruneBackups,
  verifyBackup,
} from '../src/production/backup';
import { restoreBackup } from '../src/production/restore';
import { describeDatabaseUrl } from '../src/config/databaseUrl';
import { resolveTestBaseUrl, withSchema } from '../src/d1/testDatabase';

/**
 * Backup and restore run against a THROWAWAY SCHEMA created per test inside
 * the disposable kas_dev_cn1 database — never a production database, never a
 * real volume, never live data, and never the schema the rest of the suite is
 * using.
 *
 * On the SQLite pilot this isolation came free from using a throwaway FILE.
 * The PostgreSQL equivalent is a throwaway schema, which is why every test
 * here creates one, migrates into it, and drops it afterwards.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE_URL = resolveTestBaseUrl();
const TEST_DATABASE = describeDatabaseUrl(BASE_URL).database!;

let workspace: string;
let schemaName: string;
let schemaUrl: string;
let proofDir: string;
let issueDir: string;
let backupRoot: string;
let client: PrismaClient;
let admin: PrismaClient;

/** A tiny valid PNG-signature buffer, so upload files are realistic bytes. */
function pngBytes(marker: number): Buffer {
  const buf = Buffer.alloc(32, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

/**
 * Applies the committed migrations to a brand-new schema using exactly the
 * production command (`prisma migrate deploy`). The CLI is invoked through its
 * JS entry point with the current Node binary, so there is no shell and no
 * platform-specific `.cmd` wrapper involved.
 */
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

beforeAll(() => {
  admin = new PrismaClient({ datasourceUrl: BASE_URL });
});

afterAll(async () => {
  await admin.$disconnect();
});

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-backup-'));
  proofDir = path.join(workspace, 'uploads', 'booking-proofs');
  issueDir = path.join(workspace, 'uploads', 'issue-photos');
  backupRoot = path.join(workspace, 'backups');
  fs.mkdirSync(proofDir, { recursive: true });
  fs.mkdirSync(issueDir, { recursive: true });

  schemaName = `kas_bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  schemaUrl = withSchema(BASE_URL, schemaName);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  migrateInto(schemaUrl);

  client = new PrismaClient({ datasourceUrl: schemaUrl });
  await seedBranches(client);
});

afterEach(async () => {
  await client.$disconnect();
  // The throwaway schema is always removed, even if a test failed.
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  fs.rmSync(workspace, { recursive: true, force: true });
});

const uploadDirs = (): { name: string; dir: string }[] => [
  { name: 'booking-proofs', dir: proofDir },
  { name: 'issue-photos', dir: issueDir },
];

const backupOptions = () => ({
  backupRoot,
  databaseUrl: schemaUrl,
  uploadDirs: uploadDirs(),
  client,
});

describe('backup', () => {
  it('23. creates a consistent snapshot of a LIVE database plus every upload', async () => {
    await fsp.writeFile(path.join(proofDir, 'proof-1.png'), pngBytes(0x11));
    await fsp.writeFile(path.join(issueDir, 'issue-1.png'), pngBytes(0x22));

    // Writing while the backup runs is the point of a consistent snapshot:
    // pg_dump works inside a single transaction, so it captures a coherent
    // state rather than a torn one.
    const writing = client.branch.updateMany({ data: { note: 'while backing up' } });
    const [result] = await Promise.all([createBackup(backupOptions()), writing]);

    expect(fs.existsSync(path.join(result.backupDir, BACKUP_DB_NAME))).toBe(true);
    expect(fs.statSync(path.join(result.backupDir, BACKUP_DB_NAME)).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(result.backupDir, 'uploads', 'booking-proofs', 'proof-1.png'))).toBe(true);
    expect(fs.existsSync(path.join(result.backupDir, 'uploads', 'issue-photos', 'issue-1.png'))).toBe(true);

    // The archive must be a readable custom-format dump, not just bytes.
    const verified = await verifyBackup(result.backupDir);
    expect(verified.ok, verified.problems.join('; ')).toBe(true);
  });

  it('24. writes a manifest with checksums, counts, timestamp and release', async () => {
    await fsp.writeFile(path.join(proofDir, 'proof-1.png'), pngBytes(0x11));

    const now = new Date('2026-07-31T04:05:06.000Z');
    const result = await createBackup({ ...backupOptions(), now, releaseRef: 'v1.2.3' });
    const manifest = JSON.parse(
      await fsp.readFile(path.join(result.backupDir, BACKUP_MANIFEST_NAME), 'utf8'),
    );

    expect(manifest.formatVersion).toBe(2);
    expect(manifest.createdAt).toBe(now.toISOString());
    expect(manifest.releaseRef).toBe('v1.2.3');
    expect(manifest.database.engine).toBe('postgresql');
    expect(manifest.database.dumpFormat).toBe('custom');
    expect(manifest.database.name).toBe(TEST_DATABASE);
    expect(manifest.database.schema).toBe(schemaName);
    expect(manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.database.serverVersion).toMatch(/^\d+/);
    expect(manifest.counts.branches).toBeGreaterThan(0);
    expect(manifest.uploads.map((u: { name: string }) => u.name)).toEqual([
      'booking-proofs', 'issue-photos',
    ]);

    // The manifest must never carry a credential or a connection string.
    const raw = await fsp.readFile(path.join(result.backupDir, BACKUP_MANIFEST_NAME), 'utf8');
    expect(raw).not.toMatch(/postgres(ql)?:\/\//i);
    expect(raw).not.toMatch(/password/i);
    expect(raw).not.toContain('kas_app');
  });

  it('24b. retention keeps the newest N and never deletes by default', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await createBackup({ ...backupOptions(), now: new Date(`2026-07-0${i}T00:00:00.000Z`) });
    }
    expect(await listBackups(backupRoot)).toHaveLength(3);

    // Default retention (0) keeps everything.
    await createBackup({ ...backupOptions(), now: new Date('2026-07-04T00:00:00.000Z') });
    expect(await listBackups(backupRoot)).toHaveLength(4);

    const pruned = await pruneBackups(backupRoot, 2);
    expect(pruned).toHaveLength(2);
    const remaining = await listBackups(backupRoot);
    expect(remaining).toHaveLength(2);
    // Newest first, and the two oldest are the ones that went.
    expect(remaining[0]).toContain('2026-07-04');
    expect(remaining[1]).toContain('2026-07-03');
    expect(pruned.sort()).toEqual(
      expect.arrayContaining([expect.stringContaining('2026-07-01')]),
    );
  });

  it('24c. a failed pg_dump leaves no half-written backup directory behind', async () => {
    // Point at a database that does not exist: pg_dump must fail, and the
    // partial directory must be removed so it can never look like a backup.
    const brokenUrl = withSchema(
      BASE_URL.replace(`/${TEST_DATABASE}`, '/kas_d1_test_does_not_exist'),
      schemaName,
    );
    await expect(
      createBackup({ ...backupOptions(), databaseUrl: brokenUrl }),
    ).rejects.toThrow(/pg_dump/i);
    expect(await listBackups(backupRoot)).toHaveLength(0);
  });
});

describe('restore', () => {
  it('25/26/27. restores database AND uploads into a throwaway schema', async () => {
    await fsp.writeFile(path.join(proofDir, 'proof-1.png'), pngBytes(0x11));
    await fsp.writeFile(path.join(issueDir, 'issue-1.png'), pngBytes(0x22));
    const branchesBefore = await client.branch.count();

    const backup = await createBackup(backupOptions());

    // Destroy the live data so the restore has something real to prove.
    await client.branch.deleteMany();
    await fsp.rm(path.join(proofDir, 'proof-1.png'));
    expect(await client.branch.count()).toBe(0);

    const restoreProofDir = path.join(workspace, 'restored', 'booking-proofs');
    const restoreIssueDir = path.join(workspace, 'restored', 'issue-photos');

    const result = await restoreBackup({
      backupDir: backup.backupDir,
      confirmed: true,
      targetUrl: schemaUrl,
      allowedDatabases: [TEST_DATABASE],
      resetSchema: true,
      targetUploadDirs: [
        { name: 'booking-proofs', dir: restoreProofDir },
        { name: 'issue-photos', dir: restoreIssueDir },
      ],
      safetyCopy: false,
      client,
    });

    expect(result.targetDatabase).toBe(TEST_DATABASE);
    expect(fs.existsSync(path.join(restoreProofDir, 'proof-1.png'))).toBe(true);
    expect(fs.existsSync(path.join(restoreIssueDir, 'issue-1.png'))).toBe(true);

    // The restored database really holds the data again.
    const restoredClient = new PrismaClient({ datasourceUrl: schemaUrl });
    try {
      expect(await restoredClient.branch.count()).toBe(branchesBefore);
    } finally {
      await restoredClient.$disconnect();
    }

    // And the restore verified ITSELF against the manifest.
    expect(result.verified, JSON.stringify(result.verification)).toBe(true);
    expect(result.verification.some((c) => c.name === 'count:branches')).toBe(true);
    expect(
      result.verification.find((c) => c.name === 'invariant:one-active-version-per-branch')?.ok,
    ).toBe(true);
  });

  it('25b. a restore is refused unless explicitly confirmed', async () => {
    const backup = await createBackup(backupOptions());
    await expect(
      restoreBackup({
        backupDir: backup.backupDir,
        confirmed: false,
        targetUrl: schemaUrl,
        allowedDatabases: [TEST_DATABASE],
        client,
      }),
    ).rejects.toThrow(/chưa được xác nhận/i);

    // Nothing was touched.
    expect(await client.branch.count()).toBeGreaterThan(0);
  });

  it('25c. the pre-restore state is preserved so a mistaken restore is reversible', async () => {
    const backup = await createBackup(backupOptions());
    await client.branch.updateMany({ data: { note: 'state we must be able to get back' } });

    const result = await restoreBackup({
      backupDir: backup.backupDir,
      confirmed: true,
      targetUrl: schemaUrl,
      allowedDatabases: [TEST_DATABASE],
      resetSchema: true,
      targetUploadDirs: uploadDirs(),
      client,
    });

    expect(result.safetyCopyFile).not.toBeNull();
    expect(fs.existsSync(result.safetyCopyFile!)).toBe(true);
    expect(fs.statSync(result.safetyCopyFile!).size).toBeGreaterThan(0);
  });

  it('25d. a restore into the WRONG schema is refused before anything is written', async () => {
    const backup = await createBackup(backupOptions());
    const otherSchema = `${schemaName}_other`;
    await expect(
      restoreBackup({
        backupDir: backup.backupDir,
        confirmed: true,
        targetUrl: withSchema(BASE_URL, otherSchema),
        allowedDatabases: [TEST_DATABASE],
        client,
      }),
    ).rejects.toThrow(/schema/i);
  });

  it('25e. a restore targeting a reserved database is refused outright', async () => {
    const backup = await createBackup(backupOptions());
    await expect(
      restoreBackup({
        backupDir: backup.backupDir,
        confirmed: true,
        targetUrl: 'postgresql://kas_app:x@127.0.0.1:5432/kas_production',
        client,
      }),
    ).rejects.toThrow(/bảo lưu|kas_production/i);
  });

  it('28. an invalid, corrupted or incomplete backup is rejected', async () => {
    // (a) no manifest at all
    const empty = path.join(workspace, 'empty-backup');
    fs.mkdirSync(empty, { recursive: true });
    expect((await verifyBackup(empty)).ok).toBe(false);

    // (b) manifest present, database archive corrupted.
    // Distinct `now` values: two backups in the same second would collide, and
    // createBackup deliberately refuses to overwrite an existing directory.
    const backup = await createBackup({
      ...backupOptions(),
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    await fsp.writeFile(path.join(backup.backupDir, BACKUP_DB_NAME), 'not a dump at all');
    const corrupted = await verifyBackup(backup.backupDir);
    expect(corrupted.ok).toBe(false);
    expect(corrupted.problems.join(' ')).toMatch(/checksum/i);

    await expect(
      restoreBackup({
        backupDir: backup.backupDir,
        confirmed: true,
        targetUrl: schemaUrl,
        allowedDatabases: [TEST_DATABASE],
        client,
      }),
    ).rejects.toThrow(/không hợp lệ/i);

    // (c) an upload directory tampered with after the manifest was written
    const second = await createBackup({
      ...backupOptions(),
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    await fsp.writeFile(
      path.join(second.backupDir, 'uploads', 'booking-proofs', 'sneaked-in.png'),
      pngBytes(0x33),
    );
    const tampered = await verifyBackup(second.backupDir);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems.join(' ')).toMatch(/booking-proofs/);
  });

  it('28b. a SQLite-era (format 1) backup is refused with an actionable message', async () => {
    // Rolling forward from D.0 must not silently "succeed" against PostgreSQL.
    const legacy = path.join(workspace, 'legacy-backup');
    fs.mkdirSync(legacy, { recursive: true });
    await fsp.writeFile(
      path.join(legacy, BACKUP_MANIFEST_NAME),
      JSON.stringify({
        formatVersion: LEGACY_SQLITE_FORMAT_VERSION,
        database: { file: 'database.sqlite', sha256: '0'.repeat(64), bytes: 1, engine: 'sqlite' },
        uploads: [],
        counts: {},
      }),
    );

    const verified = await verifyBackup(legacy);
    expect(verified.ok).toBe(false);
    expect(verified.problems.join(' ')).toMatch(/D\.0/);
  });
});
