/**
 * CLI: generate the deterministic fixture SQLite database used to develop and
 * test the D.1 transfer tool.
 *
 *   npm.cmd run d1:fixture -- --out server/.tmp/d1-fixture.db
 *
 * Phase D.1 never reads a real pilot database: the fixture carries the same
 * schema (replayed from the archived migrations) and the same awkward shapes,
 * without any real guest's personal data.
 */

/* eslint-disable no-console */
import path from 'node:path';
import { buildFixtureSqlite } from '../d1/fixtureSqlite';
import { REPO_ROOT } from '../d1/localEnv';

function parseOut(argv: string[]): string {
  const index = argv.indexOf('--out');
  const value = index >= 0 ? argv[index + 1] : undefined;
  const target = value ?? path.join('server', '.tmp', 'd1-fixture.db');
  return path.isAbsolute(target) ? target : path.join(REPO_ROOT, target);
}

const out = parseOut(process.argv.slice(2));
const summary = buildFixtureSqlite(out, REPO_ROOT);

console.log(`Đã tạo fixture SQLite: ${summary.file}`);
for (const [key, value] of Object.entries(summary)) {
  if (key === 'file') continue;
  console.log(`  ${key.padEnd(22)} ${String(value).padStart(5)}`);
}
