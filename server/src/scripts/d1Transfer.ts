/**
 * CLI: SQLite → PostgreSQL data transfer (Phase D.1).
 *
 *   npm.cmd run d1:transfer -- --source <file.db> --dry-run
 *   npm.cmd run d1:transfer -- --source <file.db> --execute
 *   npm.cmd run d1:transfer -- --source <file.db> --execute --resume
 *
 * The target defaults to whatever `.env.d1.local` holds, and `--target-url`
 * overrides it. Nothing here ever prints the URL: only the database NAME is
 * shown, which is what an operator needs and is not a secret.
 */

/* eslint-disable no-console */
import { redactDatabaseUrl } from '../config/databaseUrl';
import { D1_APPROVED_DATABASE, DatabaseGuardError } from '../d1/guard';
import { resolveD1TargetUrl } from '../d1/localEnv';
import { runTransfer, type TransferMode, type TransferReport } from '../d1/transfer';

interface Args {
  source: string | null;
  targetUrl: string | null;
  mode: TransferMode | null;
  resume: boolean;
  allowDatabase: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: null,
    targetUrl: null,
    mode: null,
    resume: false,
    allowDatabase: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source':
        args.source = argv[++i] ?? null;
        break;
      case '--target-url':
        args.targetUrl = argv[++i] ?? null;
        break;
      case '--allow-database':
        args.allowDatabase = argv[++i] ?? null;
        break;
      case '--dry-run':
        args.mode = 'dry-run';
        break;
      case '--execute':
        args.mode = 'execute';
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const USAGE = `
Chuyển dữ liệu SQLite → PostgreSQL (Phase D.1)

  --source <file>        Bắt buộc. Tệp SQLite nguồn (chỉ đọc, không bao giờ bị sửa).
  --dry-run              Đọc và kiểm tra toàn bộ, KHÔNG ghi gì.
  --execute              Thực hiện chuyển dữ liệu thật.
  --resume               Cho phép ghi vào đích đã có dữ liệu (chạy tiếp).
  --target-url <url>     Ghi đè đích. Mặc định đọc từ .env.d1.local.
  --allow-database <db>  Thêm một tên CSDL được phép (mặc định chỉ kas_dev_cn1).
                         Tên bị bảo lưu (production) luôn bị từ chối.
  --json                 In báo cáo JSON.

Phải chọn đúng một trong --dry-run hoặc --execute.
kas_production luôn bị từ chối.
`.trim();

function printHuman(report: TransferReport): void {
  const width = Math.max(...report.tables.map((t) => t.table.length), 10);
  console.log('');
  console.log(`Chế độ      : ${report.mode}`);
  console.log(`Đích        : ${report.target.database} / ${report.target.user} (PostgreSQL ${report.target.serverVersion})`);
  console.log(`Nguồn       : ${report.source.file}`);
  console.log(`Nguồn nguyên vẹn: ${report.source.unchanged ? 'CÓ' : 'KHÔNG — CẢNH BÁO'}`);
  console.log('');
  console.log(`${'Bảng'.padEnd(width)}  ${'nguồn'.padStart(7)}  ${'đã ghi'.padStart(7)}  ${'đích'.padStart(7)}`);
  for (const t of report.tables) {
    const flag = t.ok ? '' : '  ← LỖI';
    console.log(
      `${t.table.padEnd(width)}  ${String(t.sourceRows).padStart(7)}  ${String(t.inserted).padStart(7)}  ${String(t.targetRowsAfter).padStart(7)}${flag}`,
    );
  }
  if (report.sequences.length > 0) {
    console.log('');
    console.log('Sequence:');
    for (const s of report.sequences) {
      console.log(`  ${s.table}.${s.column}: max=${s.maxId ?? '—'} → next=${s.nextValue} ${s.ok ? 'OK' : 'LỖI'}`);
    }
  }
  if (report.problems.length > 0) {
    console.log('');
    console.log('VẤN ĐỀ:');
    for (const p of report.problems) console.log(`  - ${p}`);
  }
  console.log('');
  console.log(report.ok ? '✔ HOÀN TẤT' : '✘ THẤT BẠI');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.source || !args.mode) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let targetUrl: string;
  try {
    targetUrl = resolveD1TargetUrl(args.targetUrl);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }

  console.log(`Đích: ${redactDatabaseUrl(targetUrl)}`);

  try {
    const report = await runTransfer({
      sourceFile: args.source,
      targetUrl,
      mode: args.mode,
      resume: args.resume,
      ...(args.allowDatabase
        ? { allowedDatabases: [D1_APPROVED_DATABASE, args.allowDatabase] as const }
        : {}),
      logger: (line) => console.log(`  ${line}`),
    });

    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    // A guard refusal is an expected, well-understood outcome — print it
    // plainly. Anything else keeps its message but never its stack, which can
    // contain the connection URL.
    const message = (error as Error).message;
    console.error(error instanceof DatabaseGuardError ? `\n${message}\n` : `\nLỖI: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
