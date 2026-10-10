/**
 * CLI: verify a completed SQLite → PostgreSQL transfer (Phase D.1 §9).
 *
 *   npm.cmd run d1:verify -- --source server/.tmp/d1-fixture.db
 *   npm.cmd run d1:verify -- --source <file> --json --out report.json
 *
 * Exit code 0 only when every check passes. The report contains no guest
 * names, phone numbers, e-mail addresses, identity numbers or raw booking
 * text — sensitive columns are compared by SHA-256 digest.
 */

/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { redactDatabaseUrl } from '../config/databaseUrl';
import { assertSafeWriteTarget } from '../d1/guard';
import { resolveD1TargetUrl } from '../d1/localEnv';
import { createTargetClient } from '../d1/transfer';
import { runVerification, type VerificationReport } from '../d1/verify';
import { FIXTURE_CLASS_COUNTS } from '../d1/fixtureSqlite';

interface Args {
  source: string | null;
  targetUrl: string | null;
  json: boolean;
  out: string | null;
  expectProduction: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { source: null, targetUrl: null, json: false, out: null, expectProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--source':
        args.source = argv[++i] ?? null;
        break;
      case '--target-url':
        args.targetUrl = argv[++i] ?? null;
        break;
      case '--out':
        args.out = argv[++i] ?? null;
        break;
      case '--json':
        args.json = true;
        break;
      case '--expect-production-shape':
        args.expectProduction = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function printHuman(report: VerificationReport): void {
  const byCategory = new Map<string, typeof report.checks>();
  for (const check of report.checks) {
    const list = byCategory.get(check.category) ?? [];
    list.push(check);
    byCategory.set(check.category, list);
  }

  console.log('');
  console.log(`Đích  : ${report.target.database} / ${report.target.user} (PostgreSQL ${report.target.serverVersion})`);
  console.log(`Nguồn : ${report.source.file}`);
  console.log('');

  for (const [category, list] of byCategory) {
    const failed = list.filter((c) => c.status === 'fail');
    console.log(`[${category}] ${list.length - failed.length}/${list.length} đạt`);
    for (const check of failed) {
      console.log(`   ✘ ${check.name}: nguồn=${check.source} đích=${check.target}${check.detail ? ` (${check.detail})` : ''}`);
    }
  }

  console.log('');
  console.log(`Tổng: ${report.summary.passed}/${report.summary.total} đạt, ${report.summary.failed} lỗi`);
  console.log(report.ok ? '✔ DỮ LIỆU KHỚP' : '✘ CÓ SAI LỆCH');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error('Bắt buộc: --source <tệp SQLite nguồn>');
    process.exitCode = 2;
    return;
  }

  let targetUrl: string;
  try {
    targetUrl = resolveD1TargetUrl(args.targetUrl);
    // Verification only reads, but it must still never be pointed at a
    // reserved database — the guard is the same one the writers use.
    assertSafeWriteTarget(targetUrl, { operation: 'đối chiếu dữ liệu' });
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }

  console.log(`Đích: ${redactDatabaseUrl(targetUrl)}`);
  const client = createTargetClient(targetUrl);

  try {
    const report = await runVerification({
      sourceFile: args.source,
      client,
      ...(args.expectProduction
        ? {
            expectedBranches: 8,
            expectedAliases: 24,
            expectedActiveClasses: 48,
            expectedClassCounts: FIXTURE_CLASS_COUNTS,
          }
        : {}),
    });

    if (args.out) {
      const file = path.resolve(args.out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Báo cáo JSON: ${file}`);
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`\nLỖI: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

void main();
