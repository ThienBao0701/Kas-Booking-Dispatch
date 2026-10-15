/**
 * CLI: `npm run prod:restore -- --backup=<dir> [--target-url=<url>] [--reset-schema]`
 *
 * Restores a verified PostgreSQL backup. It NEVER selects a backup for you,
 * always verifies checksums and the archive's table of contents first, and
 * requires a typed confirmation before it writes anything.
 *
 * `--target-url` is how a restore DRILL is rehearsed: point it at a disposable
 * database (`kas_dev_cn1`) and the live data is never touched. `kas_production`
 * and `kas_d1_test` — the live production database — are refused outright by
 * the guard, whatever is passed.
 */
import path from 'node:path';
import readline from 'node:readline';
import { prisma } from '../db/prisma';
import { BACKUP_DIR, ISSUE_UPLOAD_DIR, PROOF_UPLOAD_DIR, env } from '../config/env';
import { redactDatabaseUrl } from '../config/databaseUrl';
import { D1_APPROVED_DATABASE, DatabaseGuardError } from '../d1/guard';
import { listBackups, verifyBackup } from '../production/backup';
import { restoreBackup } from '../production/restore';
import { safeRestore } from '../production/safeRestore';
import { createAppControl } from '../production/appControl';
import { openLogs, stamp } from '../service/logs';

/* eslint-disable no-console */

const CONFIRM_PHRASE = 'RESTORE KAS DATA';
const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'logs');

function stringArg(name: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw?.slice(name.length + 3);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    const backups = await listBackups(BACKUP_DIR);
    console.log(backups.length === 0 ? '(chưa có bản sao lưu nào)' : backups.join('\n'));
    return;
  }

  const selected = stringArg('backup');
  if (!selected) {
    console.error('❌ Bắt buộc chọn bản sao lưu: --backup=<thư mục>. Xem danh sách với --list.');
    process.exitCode = 1;
    return;
  }
  const backupDir = path.isAbsolute(selected) ? selected : path.join(BACKUP_DIR, selected);

  const verification = await verifyBackup(backupDir);
  if (!verification.ok) {
    console.error('❌ Bản sao lưu KHÔNG hợp lệ, không khôi phục:');
    for (const problem of verification.problems) console.error(`   - ${problem}`);
    process.exitCode = 1;
    return;
  }
  const manifest = verification.manifest!;

  const targetUrl = stringArg('target-url') ?? env.DATABASE_URL;
  const allowDatabase = stringArg('allow-database');
  const resetSchema = process.argv.includes('--reset-schema');

  console.log(`\nBản sao lưu: ${backupDir}`);
  console.log(`Tạo lúc:     ${manifest.createdAt}`);
  console.log(`Nguồn:       ${manifest.database.name} (PostgreSQL ${manifest.database.serverVersion ?? '?'})`);
  console.log(`Phiên bản:   ${manifest.releaseRef ?? '(không ghi)'}`);
  console.log(`Số bản ghi:  ${JSON.stringify(manifest.counts)}`);
  console.log(`\nĐích:        ${redactDatabaseUrl(targetUrl)}`);
  console.log(
    resetSchema
      ? '⚠️  --reset-schema: schema đích sẽ bị XÓA rồi tạo lại trước khi khôi phục.'
      : 'Chế độ: khôi phục đè lên schema hiện có (không xóa schema).',
  );

  const answer = await ask(`\nGõ chính xác "${CONFIRM_PHRASE}" để khôi phục: `);
  if (answer !== CONFIRM_PHRASE) {
    console.error('Cụm từ xác nhận không đúng. Đã hủy.');
    process.exitCode = 1;
    return;
  }

  const allowed = allowDatabase
    ? ([D1_APPROVED_DATABASE, allowDatabase] as const)
    : undefined;

  // `--safe` is the whole loop: stop Kas, take a verified rollback point,
  // restore, bring it back up, prove it is healthy, and put everything back if
  // any of that fails. Without the flag this stays the original tool, which
  // touches data and nothing else — some operators restore into a database
  // nothing is serving, and stopping an application that is not running to
  // restore a database that is not live is ceremony, not safety.
  if (process.argv.includes('--safe')) {
    await runSafeRestore({ backupDir, targetUrl, resetSchema, allowed });
    return;
  }

  const result = await restoreBackup({
    backupDir,
    confirmed: true,
    targetUrl,
    resetSchema,
    ...(allowed ? { allowedDatabases: allowed } : {}),
  });

  console.log('\n✅ Khôi phục xong.');
  console.log(`   Cơ sở dữ liệu: ${result.targetDatabase}`);
  for (const upload of result.restoredUploads) {
    console.log(`   ${upload.name}: ${upload.files} tệp`);
  }
  if (result.safetyCopyFile) {
    console.log(`   Bản sao trước khôi phục: ${result.safetyCopyFile}`);
  }

  console.log('\nĐỐI CHIẾU SAU KHÔI PHỤC:');
  for (const check of result.verification) {
    console.log(`   ${check.ok ? '✔' : '✘'} ${check.name}: ${check.actual} (mong đợi ${check.expected})`);
  }
  if (!result.verified) {
    console.error('\n❌ DỮ LIỆU SAU KHÔI PHỤC KHÔNG KHỚP MANIFEST.');
    process.exitCode = 1;
  }

  for (const warning of result.warnings) console.log(`\n⚠️  ${warning}`);

  console.log('\nDANH SÁCH KIỂM TRA SAU KHÔI PHỤC:');
  for (const item of result.checklist) console.log(`   [ ] ${item}`);
}

/**
 * The supervised restore: application down, rollback point taken, restore,
 * application up, health proven — and everything put back if it is not.
 *
 * Every step is echoed to the console AND to restore.log, because the console
 * belongs to whoever ran it and the log belongs to whoever asks a fortnight
 * later what happened to the data.
 */
async function runSafeRestore(input: {
  backupDir: string;
  targetUrl: string;
  resetSchema: boolean;
  allowed: readonly string[] | undefined;
}): Promise<void> {
  const logs = openLogs(LOG_DIR);
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);

  const result = await safeRestore({
    backupDir: input.backupDir,
    targetUrl: input.targetUrl,
    confirmed: true,
    resetSchema: input.resetSchema,
    ...(input.allowed ? { allowedDatabases: input.allowed } : {}),
    app: createAppControl({ port }),
    uploadDirs: [
      { name: 'booking-proofs', dir: PROOF_UPLOAD_DIR },
      { name: 'issue-photos', dir: ISSUE_UPLOAD_DIR },
    ],
  });

  for (const step of result.steps) {
    console.log(`   ${step}`);
    logs.restore.append(stamp(step));
  }

  console.log('\nKIỂM TRA SAU KHÔI PHỤC:');
  for (const check of result.validations) {
    const line = `${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}`;
    console.log(`   ${line}`);
    logs.restore.append(stamp(line));
  }

  for (const problem of result.problems) {
    console.error(`   ⚠️  ${problem}`);
    logs.restore.append(stamp(`VẤN ĐỀ: ${problem}`));
  }

  logs.restore.append(stamp(`Kết quả: ${result.outcome}`));
  logs.verification.append(
    stamp(`RESTORE ${result.outcome} from=${input.backupDir} rollback=${result.rollbackPoint ?? '-'}`),
  );

  switch (result.outcome) {
    case 'SUCCEEDED':
      console.log('\n✅ Khôi phục thành công và ứng dụng đã hoạt động trở lại.');
      return;
    case 'RESTORED_WITH_WARNINGS':
      console.log('\n⚠️  Đã khôi phục nhưng có cảnh báo ở trên. Dữ liệu hiện tại LÀ dữ liệu mới.');
      process.exitCode = 1;
      return;
    case 'FAILED_ROLLED_BACK':
      console.error('\n❌ Khôi phục thất bại. Đã hoàn tác — dữ liệu như trước khi chạy lệnh này.');
      process.exitCode = 1;
      return;
    case 'FAILED_ROLLBACK_FAILED':
      console.error('\n❌❌ Khôi phục THẤT BẠI và hoàn tác cũng thất bại.');
      console.error(`    Điểm khôi phục còn nguyên tại: ${result.rollbackPoint ?? '(không có)'}`);
      console.error('    KHÔNG chạy lại lệnh này. Hãy đọc logs/restore.log trước.');
      process.exitCode = 1;
      return;
    case 'ABORTED':
      console.error('\n❌ Đã hủy trước khi thay đổi bất cứ thứ gì.');
      process.exitCode = 1;
      return;
  }
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        error instanceof DatabaseGuardError ? `\n${message}\n` : `Khôi phục thất bại: ${message}`,
      );
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
