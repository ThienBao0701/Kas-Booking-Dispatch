/**
 * Restore from a verified PostgreSQL backup (Phase D.1).
 *
 * Deliberately unfriendly by design — a restore overwrites live data, so it:
 *   - never runs automatically and never picks a backup for you,
 *   - refuses any backup whose manifest or checksums do not verify, and any
 *     archive `pg_restore --list` cannot parse,
 *   - refuses `kas_production` outright during D.1, and re-asks the server
 *     `SELECT current_database()` rather than trusting the URL,
 *   - refuses to overwrite anything unless `confirmed` is passed,
 *   - refuses to DROP a schema unless a SECOND, separate flag is passed,
 *   - takes its own pg_dump of whatever it is about to replace, so a mistaken
 *     restore is itself reversible,
 *   - restores database and uploads together, never one without the other,
 *   - verifies the restored data against the manifest afterwards, because a
 *     backup file existing is not evidence that a restore worked,
 *   - and prints a verification checklist instead of restarting anything.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { BACKUP_DB_NAME, verifyBackup, type BackupManifest } from './backup';
import { connectionArgs, connectionFromUrl, majorVersion, runPgTool } from './pgTools';
import { ISSUE_UPLOAD_DIR, PROOF_UPLOAD_DIR } from '../config/env';
import { describeDatabaseUrl } from '../config/databaseUrl';
import {
  assertDestructiveAllowed,
  assertLiveIdentity,
  assertSafeWriteTarget,
  type LiveIdentity,
} from '../d1/guard';

export interface RestoreOptions {
  /** The backup directory to restore. Always explicit — never auto-selected. */
  backupDir: string;
  /** Must be true to write anything. */
  confirmed: boolean;
  /** Target connection. Always explicit: a restore never guesses a database. */
  targetUrl: string;
  /** Database names this restore may touch. Defaults to kas_d1_test only. */
  allowedDatabases?: readonly string[];
  /**
   * Drop and recreate the target schema first, giving the clean empty database
   * that §14 requires. Separate from `confirmed` on purpose: confirming a
   * restore is not the same as consenting to destroy the current schema.
   */
  resetSchema?: boolean;
  /** Where each upload set is written. Defaults to the live upload directories. */
  targetUploadDirs?: { name: string; dir: string }[];
  /** pg_dump the current state before overwriting it. Default true. */
  safetyCopy?: boolean;
  /** Client bound to the TARGET, used for post-restore verification. */
  client?: PrismaClient;
  now?: Date;
}

export interface RestoreVerification {
  name: string;
  expected: number | string;
  actual: number | string;
  ok: boolean;
}

export interface RestoreResult {
  targetDatabase: string;
  restoredUploads: { name: string; dir: string; files: number }[];
  manifest: BackupManifest;
  /** Where the pre-restore state was preserved, or null when nothing existed. */
  safetyCopyFile: string | null;
  /** Post-restore data verification — the evidence the restore actually worked. */
  verification: RestoreVerification[];
  verified: boolean;
  warnings: string[];
  checklist: string[];
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

/**
 * Does the archive's table of contents include a CREATE SCHEMA for this schema?
 *
 * `pg_restore --list` reads only the archive header, so this is cheap and
 * changes nothing. A failure to read is treated as "no", which is the safe
 * direction: we then create the schema ourselves and pg_restore would surface
 * any real problem with `--exit-on-error`.
 */
async function archiveCreatesSchema(archive: string, schema: string): Promise<boolean> {
  const listed = await runPgTool('pg_restore', ['--list', archive], {
    host: '', port: 0, user: '', database: '', password: null,
  });
  if (!listed.ok) return false;
  return new RegExp(`SCHEMA\\s+-\\s+${schema}\\b`).test(listed.stdout);
}

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
      else total += 1;
    }
  };
  await walk(dir);
  return total;
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  // --- 1. The backup must be valid BEFORE anything else happens ------------
  const verification = await verifyBackup(options.backupDir);
  if (!verification.ok || !verification.manifest) {
    throw new RestoreError(
      `Bản sao lưu không hợp lệ, đã hủy khôi phục:\n  - ${verification.problems.join('\n  - ')}`,
    );
  }
  const manifest = verification.manifest;

  // --- 2. Target guards ----------------------------------------------------
  const staticTarget = assertSafeWriteTarget(options.targetUrl, {
    ...(options.allowedDatabases ? { allowedDatabases: options.allowedDatabases } : {}),
    operation: 'khôi phục dữ liệu',
  });

  if (!options.confirmed) {
    throw new RestoreError(
      `Khôi phục vào "${staticTarget.database}" chưa được xác nhận (confirmed = false). Đã hủy.`,
    );
  }

  const ownsClient = !options.client;
  const { PrismaClient: Client } = await import('@prisma/client');
  const client: PrismaClient = options.client ?? new Client({ datasourceUrl: options.targetUrl });

  try {
    const identity: LiveIdentity = await assertLiveIdentity(client, staticTarget.database!);

    // --- 3. Version compatibility ------------------------------------------
    const dumpMajor = majorVersion(manifest.database.serverVersion);
    const targetMajor = majorVersion(identity.serverVersion);
    if (dumpMajor && targetMajor && dumpMajor > targetMajor) {
      warnings.push(
        `Bản sao lưu tạo trên PostgreSQL ${dumpMajor} nhưng đích là ${targetMajor}. ` +
          'Khôi phục xuống phiên bản thấp hơn KHÔNG được hỗ trợ.',
      );
    } else if (dumpMajor && targetMajor && dumpMajor < targetMajor) {
      warnings.push(
        `Bản sao lưu từ PostgreSQL ${dumpMajor} đang khôi phục vào ${targetMajor} (nâng cấp phiên bản).`,
      );
    }

    const connection = connectionFromUrl(options.targetUrl);
    const schemaName = describeDatabaseUrl(options.targetUrl).schema ?? 'public';

    // A custom-format archive names every object schema-qualified, so
    // pg_restore can only put them back into a schema of the SAME name.
    // Catching that here gives a clear message instead of a pile of
    // "schema does not exist" errors from pg_restore.
    const dumpSchema = manifest.database.schema;
    if (dumpSchema && dumpSchema !== schemaName) {
      throw new RestoreError(
        `Bản sao lưu chứa schema "${dumpSchema}" nhưng đích trỏ tới schema "${schemaName}". ` +
          'pg_restore không đổi tên schema được — hãy trỏ đích tới đúng schema đó.',
      );
    }

    const archivePath = path.join(options.backupDir, manifest.database.file);

    const targetUploads = options.targetUploadDirs ?? [
      { name: 'booking-proofs', dir: PROOF_UPLOAD_DIR },
      { name: 'issue-photos', dir: ISSUE_UPLOAD_DIR },
    ];

    // --- 4. Preserve whatever is about to be replaced ----------------------
    let safetyCopyFile: string | null = null;
    if (options.safetyCopy !== false) {
      const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
      const dir = path.join(path.dirname(options.backupDir), `pre-restore-${stamp}`);
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, BACKUP_DB_NAME);
      const dumped = await runPgTool(
        'pg_dump',
        [
          ...connectionArgs(connection),
          '--dbname', connection.database,
          '--format=custom', '--no-owner', '--no-privileges',
          '--file', file,
        ],
        connection,
      );
      if (!dumped.ok) {
        throw new RestoreError(
          `Không tạo được bản sao an toàn trước khi khôi phục — đã hủy: ${dumped.stderr.trim()}`,
        );
      }
      for (const upload of targetUploads) {
        if (!fs.existsSync(upload.dir)) continue;
        await fsp.cp(upload.dir, path.join(dir, 'uploads', upload.name), { recursive: true });
      }
      safetyCopyFile = file;
    }

    // --- 5. Clean the target (second, separate consent) --------------------
    if (options.resetSchema) {
      assertDestructiveAllowed(identity, options.confirmed, {
        ...(options.allowedDatabases ? { allowedDatabases: options.allowedDatabases } : {}),
        operation: `DROP SCHEMA "${schemaName}" CASCADE`,
      });
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

      // Whether WE recreate the schema depends on whether the archive already
      // contains a CREATE SCHEMA for it. pg_dump emits one for a named schema
      // but not for `public`, which it assumes exists. Creating it ourselves in
      // the first case makes pg_restore fail with "schema already exists"; not
      // creating it in the second leaves nothing to restore into. Rather than
      // guess from the schema name, ask the archive's table of contents.
      if (!(await archiveCreatesSchema(archivePath, schemaName))) {
        await client.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
      }
    }

    // --- 6. Restore the database -------------------------------------------
    const archive = archivePath;
    const restored = await runPgTool(
      'pg_restore',
      [
        ...connectionArgs(connection),
        '--dbname', connection.database,
        '--no-owner', '--no-privileges',
        // A restore that partially fails must fail the command, not leave a
        // half-populated database behind that looks like a success.
        '--exit-on-error',
        '--single-transaction',
        archive,
      ],
      connection,
    );
    if (!restored.ok) {
      throw new RestoreError(
        `pg_restore thất bại (mã ${restored.exitCode}): ${restored.stderr.trim()}`,
      );
    }

    // --- 7. Uploads: replace wholesale so a deleted file does not survive ---
    const restoredUploads: RestoreResult['restoredUploads'] = [];
    for (const upload of targetUploads) {
      const source = path.join(options.backupDir, 'uploads', upload.name);
      await fsp.rm(upload.dir, { recursive: true, force: true });
      await fsp.mkdir(upload.dir, { recursive: true });
      if (fs.existsSync(source)) {
        await fsp.cp(source, upload.dir, { recursive: true });
      }
      restoredUploads.push({ ...upload, files: await countFiles(upload.dir) });
    }

    // --- 8. Prove it worked -------------------------------------------------
    const checks = await verifyRestoredData(client, manifest);
    const verified = checks.every((c) => c.ok);

    return {
      targetDatabase: identity.database,
      restoredUploads,
      manifest,
      safetyCopyFile,
      verification: checks,
      verified,
      warnings,
      checklist: [
        'Chạy `npm.cmd run db:migrate` để chắc chắn schema khớp mã nguồn đang chạy.',
        'Gọi /api/health và /api/ready — cả hai phải trả 200.',
        `Đối chiếu số bản ghi với manifest: ${JSON.stringify(manifest.counts)}.`,
        'Đăng nhập bằng tài khoản Admin và mở danh sách chi nhánh.',
        'Mở một đơn có ảnh chứng minh và xác nhận ảnh hiển thị được.',
        'Kiểm tra quyền: lễ tân chỉ thấy chi nhánh của mình.',
        safetyCopyFile
          ? `Giữ bản sao trước khi khôi phục tại: ${safetyCopyFile}`
          : 'Không tạo bản sao trước khi khôi phục (đã tắt).',
      ],
    };
  } finally {
    if (ownsClient) await client.$disconnect();
  }
}

/**
 * Post-restore verification: the restored database must match the manifest's
 * recorded counts, and the C.3.8 invariants must still hold.
 *
 * This is what turns "pg_restore exited 0" into evidence.
 */
export async function verifyRestoredData(
  client: PrismaClient,
  manifest: BackupManifest,
): Promise<RestoreVerification[]> {
  const checks: RestoreVerification[] = [];
  const add = (name: string, expected: number | string, actual: number | string): void => {
    checks.push({ name, expected, actual, ok: String(expected) === String(actual) });
  };

  const actual = {
    branches: await client.branch.count(),
    aliases: await client.branchSourceAlias.count(),
    users: await client.user.count(),
    bookings: await client.booking.count(),
    proofs: await client.bookingCreationProof.count(),
    issues: await client.hotelIssue.count(),
    notifications: await client.notification.count(),
    roomClasses: await client.branchRoomClass.count(),
    activeVersions: await client.branchRoomMappingVersion.count({ where: { status: 'ACTIVE' } }),
    guests: await client.bookingGuest.count(),
  };

  for (const [key, expected] of Object.entries(manifest.counts)) {
    if (key in actual) add(`count:${key}`, expected, actual[key as keyof typeof actual]);
  }

  // Invariants, not just counts: a restore that produced two ACTIVE versions
  // for one branch would satisfy every count above and still be broken.
  const multiActive = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (
      SELECT "branchId" FROM "BranchRoomMappingVersion"
       WHERE status = 'ACTIVE' GROUP BY "branchId" HAVING count(*) > 1
    ) x`;
  add('invariant:one-active-version-per-branch', 0, Number(multiActive[0]?.n ?? 0n));

  const orphanRooms = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "BookingRoom" r
      LEFT JOIN "Booking" b ON b.id = r."bookingId" WHERE b.id IS NULL`;
  add('invariant:no-orphan-booking-rooms', 0, Number(orphanRooms[0]?.n ?? 0n));

  return checks;
}
