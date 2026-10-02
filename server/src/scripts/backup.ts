/**
 * CLI: `npm run prod:backup [-- --retain=30] [--scheduled]`
 *
 * Writes a consistency-aware snapshot (database + uploads + logs + redacted
 * configuration + manifest) into BACKUP_DIR. Prints no secrets. Exit code 0 on
 * success, 1 on failure — so the scheduled task can alert on it.
 *
 * `--scheduled` is what Windows runs at 22:00. It differs in exactly two ways:
 * output goes to the log files rather than a console nobody is watching, and a
 * failure is recorded loudly instead of returning a message to a caller who
 * does not exist. It never touches the running application either way —
 * pg_dump takes a consistent snapshot of a live database, so a scheduled backup
 * needs no downtime and cannot capture a half-written booking.
 */
import path from 'node:path';
import { prisma } from '../db/prisma';
import { BACKUP_DIR } from '../config/env';
import { createBackup } from '../production/backup';
import { openLogs, stamp } from '../service/logs';

/* eslint-disable no-console */

/**
 * How many backups to keep when nothing says otherwise.
 *
 * 30 daily backups is a month of recoverable history, which is longer than it
 * takes anyone to notice a problem. It is a real default rather than "keep
 * everything" because an unbounded backup directory on the machine that also
 * runs PostgreSQL ends as a full disk, and a full disk takes the hotel down.
 */
export const DEFAULT_RETAIN = 30;

const LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'logs');

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function main(): Promise<void> {
  const scheduled = process.argv.includes('--scheduled');
  const retain = numberArg('retain', Number(process.env.BACKUP_RETAIN ?? DEFAULT_RETAIN));
  const logs = openLogs(LOG_DIR);

  const say = (line: string): void => {
    logs.backup.append(stamp(line));
    if (!scheduled) console.log(line);
  };

  say(scheduled ? '--- Sao lưu theo lịch ---' : '--- Sao lưu thủ công ---');

  try {
    const result = await createBackup({ retain });

    say('Sao lưu hoàn tất.');
    say(`  Thư mục:       ${result.backupDir}`);
    say(`  Cơ sở dữ liệu: ${result.manifest.database.bytes} bytes`);
    for (const upload of result.manifest.uploads) {
      say(`  ${upload.name}: ${upload.files} tệp, ${upload.bytes} bytes`);
    }
    if (result.manifest.logs) {
      say(`  nhật ký: ${result.manifest.logs.files} tệp, ${result.manifest.logs.bytes} bytes`);
    }
    if (result.manifest.config) {
      say(
        `  cấu hình: ${result.manifest.config.keys} khoá ` +
          `(${result.manifest.config.redactedKeys} khoá đã ẩn giá trị)`,
      );
    }
    say(`  Tổng dung lượng: ${result.manifest.totalBytes ?? 0} bytes`);
    say(`  Số bản ghi: ${JSON.stringify(result.manifest.counts)}`);

    // The verification record is kept apart, because it is what gets consulted
    // when a backup is doubted and it must not be rotated away by daily chatter.
    logs.verification.append(
      stamp(
        `OK ${result.backupDir} db=${result.manifest.database.sha256.slice(0, 12)} ` +
          `total=${result.manifest.totalBytes ?? 0}`,
      ),
    );

    if (result.prunedBackups.length > 0) {
      say(`  Đã xóa theo chính sách giữ lại (${retain}): ${result.prunedBackups.join(', ')}`);
    }
    if (!scheduled) {
      console.log(
        `\nNhắc: sao chép ${BACKUP_DIR} sang một máy khác — ` +
          'bản sao cùng máy không chống được hỏng ổ đĩa.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // ONE WRITER PER FILE. This used to also append to error.log, which the
    // runner owns and writes to from a different process. Two processes doing
    // read-size / rename / append on one file can interleave, and can both
    // decide to rotate — losing a generation of exactly the log somebody is
    // about to read. The failure is recorded in the two files this process
    // owns, and `Kas.cmd --diagnose` surfaces the last verification line, so
    // nothing is hidden by the change.
    logs.backup.append(stamp(`THẤT BẠI: ${message}`));
    logs.verification.append(stamp(`FAILED ${message}`));
    if (!scheduled) console.error('Sao lưu thất bại:', message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error('Sao lưu thất bại:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
