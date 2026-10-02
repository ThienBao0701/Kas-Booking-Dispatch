/**
 * CLI: `npm run prod:create-admin`
 *
 * Creates the FIRST production administrator. Interactive by design:
 *   - no username or password is hardcoded or defaulted,
 *   - the password is typed twice and never echoed to the terminal,
 *   - it is validated against the Admin password policy,
 *   - it is never printed, and never written to a log or audit row,
 *   - a second Admin is refused unless --allow-additional is passed.
 *
 * The account is created with "must change password", so the bootstrap value is
 * rotated at first login.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { prisma } from '../db/prisma';
import { createInitialAdmin } from '../production/createAdmin';

/* eslint-disable no-console */

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/**
 * Reads a line with echo suppressed. The muted stream swallows everything the
 * readline interface would otherwise write back, so the password never appears
 * on screen, in a scrollback buffer or in a terminal recording.
 */
function askSecret(question: string): Promise<string> {
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(question);
  return new Promise((resolve) =>
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    }),
  );
}

async function main(): Promise<void> {
  const allowAdditional = process.argv.includes('--allow-additional');

  console.log('\n=== Tạo tài khoản quản trị viên đầu tiên ===');
  console.log('Mật khẩu sẽ KHÔNG hiển thị khi bạn gõ và KHÔNG được ghi vào log.\n');

  const username = await ask('Tên đăng nhập: ');
  const fullName = await ask('Họ tên hiển thị: ');
  const password = await askSecret('Mật khẩu: ');
  const confirm = await askSecret('Nhập lại mật khẩu: ');

  if (password !== confirm) {
    console.error('❌ Hai lần nhập mật khẩu không giống nhau. Đã hủy.');
    process.exitCode = 1;
    return;
  }

  const outcome = await createInitialAdmin({
    username,
    password,
    fullName,
    allowAdditional,
  });

  if (!outcome.created) {
    if (outcome.reason === 'admin-exists') {
      console.error(
        `❌ Đã có tài khoản quản trị viên ("${outcome.username}"). ` +
          'Dùng --allow-additional nếu thực sự cần thêm một Admin nữa.',
      );
    } else {
      console.error(`❌ Tên đăng nhập "${outcome.username}" đã tồn tại.`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Đã tạo quản trị viên "${outcome.username}" (id ${outcome.adminId}).`);
  console.log('   Tài khoản bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên.');
  console.log('   Hãy đăng nhập và đổi mật khẩu NGAY, rồi xóa mật khẩu tạm khỏi mọi nơi bạn đã lưu.');
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      // Only the message — an error object could carry the input in a stack frame.
      console.error('Tạo Admin thất bại:', error instanceof Error ? error.message : 'lỗi không xác định');
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
