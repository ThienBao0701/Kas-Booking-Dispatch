/**
 * CLI: Phase D.1 restore DRILL.
 *
 *   npm.cmd run d1:drill -- --confirm-destructive
 *
 * A backup file existing is not evidence that a restore works. This rehearses
 * the whole loop against the disposable D.1 database and proves it:
 *
 *   1. back up the current kas_dev_cn1 (pg_dump custom format + manifest),
 *   2. verify the archive's checksums and table of contents,
 *   3. DROP and recreate the schema — a genuinely empty database,
 *   4. pg_restore into it,
 *   5. re-count every table and re-check the C.3.8 invariants.
 *
 * Step 3 destroys data, so it needs `--confirm-destructive` AND the target
 * must be `kas_dev_cn1`. `kas_production` and `kas_d1_test` — the live
 * production database — are refused by the guard regardless of any flag.
 */
// MUST be first: makes config/env loadable for a CLI that starts no server.
import '../d1/bootstrapEnv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDatabaseUrl } from '../config/databaseUrl';
import { DatabaseGuardError, assertSafeWriteTarget } from '../d1/guard';
import { resolveD1TargetUrl } from '../d1/localEnv';
import { createTargetClient } from '../d1/transfer';
import { createBackup, verifyBackup } from '../production/backup';
import { restoreBackup } from '../production/restore';

/* eslint-disable no-console */

function stringArg(name: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm-destructive');
  const keep = process.argv.includes('--keep');

  const targetUrl = resolveD1TargetUrl(stringArg('target-url') ?? null);
  assertSafeWriteTarget(targetUrl, { operation: 'diễn tập khôi phục' });

  const backupRoot =
    stringArg('backup-root') ?? path.join(os.tmpdir(), `kas-d1-drill-${Date.now()}`);
  const uploadRoot = path.join(backupRoot, 'live-uploads');
  const uploadDirs = [
    { name: 'booking-proofs', dir: path.join(uploadRoot, 'booking-proofs') },
    { name: 'issue-photos', dir: path.join(uploadRoot, 'issue-photos') },
  ];
  for (const upload of uploadDirs) fs.mkdirSync(upload.dir, { recursive: true });
  // A representative file, so the drill also proves uploads survive the loop.
  fs.writeFileSync(path.join(uploadDirs[0]!.dir, 'drill-proof.txt'), 'drill', 'utf8');

  console.log(`Đích  : ${redactDatabaseUrl(targetUrl)}`);
  console.log(`Sao lưu: ${backupRoot}`);

  if (!confirmed) {
    console.error(
      '\nDiễn tập này sẽ XÓA schema của cơ sở dữ liệu đích rồi khôi phục lại.\n' +
        'Chạy lại với --confirm-destructive nếu đây đúng là ý định.\n',
    );
    process.exitCode = 2;
    return;
  }

  const client = createTargetClient(targetUrl);
  try {
    // --- 1. Backup ---------------------------------------------------------
    const backup = await createBackup({
      backupRoot,
      databaseUrl: targetUrl,
      uploadDirs,
      client,
      releaseRef: 'd1-drill',
    });
    console.log(`\n[1] Sao lưu xong: ${path.basename(backup.backupDir)}`);
    console.log(`    ${backup.manifest.database.bytes} bytes, sha256 ${backup.manifest.database.sha256.slice(0, 16)}…`);
    console.log(`    Số bản ghi: ${JSON.stringify(backup.manifest.counts)}`);

    // --- 2. Verify ---------------------------------------------------------
    const verified = await verifyBackup(backup.backupDir);
    console.log(`[2] Kiểm tra archive: ${verified.ok ? 'ĐẠT' : 'LỖI'}`);
    if (!verified.ok) {
      for (const p of verified.problems) console.error(`    - ${p}`);
      process.exitCode = 1;
      return;
    }

    // --- 3+4. Reset and restore -------------------------------------------
    const result = await restoreBackup({
      backupDir: backup.backupDir,
      confirmed: true,
      targetUrl,
      resetSchema: true,
      targetUploadDirs: uploadDirs,
      // The drill's own backup already IS the pre-restore state.
      safetyCopy: false,
      client,
    });
    console.log('[3] Đã DROP + tạo lại schema.');
    console.log('[4] pg_restore xong.');

    // --- 5. Verify restored data ------------------------------------------
    console.log('[5] Đối chiếu dữ liệu sau khôi phục:');
    for (const check of result.verification) {
      console.log(`    ${check.ok ? '✔' : '✘'} ${check.name}: ${check.actual} (mong đợi ${check.expected})`);
    }
    for (const upload of result.restoredUploads) {
      console.log(`    tệp ${upload.name}: ${upload.files}`);
    }
    for (const warning of result.warnings) console.log(`    ⚠️  ${warning}`);

    console.log(`\n${result.verified ? '✔ DIỄN TẬP KHÔI PHỤC THÀNH CÔNG' : '✘ DIỄN TẬP THẤT BẠI'}`);
    process.exitCode = result.verified ? 0 : 1;
  } finally {
    await client.$disconnect();
    if (!keep) fs.rmSync(backupRoot, { recursive: true, force: true });
    else console.log(`\n(giữ lại ${backupRoot})`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof DatabaseGuardError ? `\n${message}\n` : `\nLỖI: ${message}\n`);
  process.exitCode = 1;
});
