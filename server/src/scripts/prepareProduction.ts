/**
 * CLI wrapper for the official-launch reset (`npm run data:prepare-production`).
 *
 * It requires an interactive confirmation phrase and, in production, an explicit
 * `--allow-production` flag. It takes a pg_dump archive of the database + a copy
 * of the uploads before deleting ALL operational data, preserving the schema,
 * the 8 branches, the Admin account and configuration. NEVER run this against
 * data you want to keep.
 */
import path from 'node:path';
import readline from 'node:readline';
import { prisma } from '../db/prisma';
import { isProduction, PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR } from '../config/env';
import { prepareForProduction } from '../devtest/prepareProduction';
import { OFFICIAL_RESET_PHRASE } from '../devtest/constants';

const repoRoot = path.resolve(__dirname, '../../..');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main(): Promise<void> {
  const allowProduction = process.argv.includes('--allow-production');
  if (isProduction && !allowProduction) {
    // eslint-disable-next-line no-console
    console.error('Từ chối chạy trong môi trường production. Thêm cờ --allow-production nếu thực sự muốn.');
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log('\n⚠️  CHUẨN BỊ KAS CHO VẬN HÀNH THẬT');
  // eslint-disable-next-line no-console
  console.log('Thao tác này sẽ XÓA toàn bộ dữ liệu vận hành (booking, proof, OCR, đối chiếu, sự cố, thông báo, phiên đăng nhập).');
  // eslint-disable-next-line no-console
  console.log('Giữ lại: 8 chi nhánh, tài khoản Admin, cấu hình. Sẽ sao lưu trước khi xóa.\n');

  const answer = await ask(`Gõ chính xác "${OFFICIAL_RESET_PHRASE}" để tiếp tục: `);
  if (answer.trim() !== OFFICIAL_RESET_PHRASE) {
    // eslint-disable-next-line no-console
    console.error('Cụm từ xác nhận không đúng. Đã hủy.');
    process.exitCode = 1;
    return;
  }

  const manifest = await prepareForProduction({
    confirmed: true,
    // Defaults to env.DATABASE_URL; pg_dump takes the pre-reset archive.
    uploadDirs: [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR],
    backupRoot: path.join(repoRoot, 'backups'),
    doBackup: true,
    productionOverride: allowProduction,
  });

  // eslint-disable-next-line no-console
  console.log('\n✅ Hoàn tất. Bản sao lưu:', manifest.backupDir);
  // eslint-disable-next-line no-console
  console.log('Trước:', manifest.before);
  // eslint-disable-next-line no-console
  console.log('Sau:', manifest.after);
  // eslint-disable-next-line no-console
  console.log(`Chi nhánh giữ lại: ${manifest.branchesPreserved} · Admin giữ lại: ${manifest.adminsPreserved} · reception_test: ${manifest.testReceptionist}`);
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Reset thất bại:', err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
