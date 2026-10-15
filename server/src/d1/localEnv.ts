/**
 * Explicit loader for the untracked Phase D.1 local secret file.
 *
 * WHY THIS IS NOT `dotenv.config()` ON THE APP'S `.env`:
 * `.env.d1.local` holds a real PostgreSQL password for the D.1 *test* database.
 * It is deliberately NOT auto-loaded by the application — only the D.1 CLI
 * tooling (transfer, verify, backup drill) asks for it, and only when a target
 * URL was not passed explicitly. That keeps a development server from ever
 * silently connecting to the D.1 database because a file happened to exist.
 *
 * The file is git-ignored by the `.env.*` rule in .gitignore. Nothing in this
 * module logs, returns or formats the value it reads except as a connection
 * URL handed straight to a driver; use `redactDatabaseUrl` for any output.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repository root, derived locally rather than imported from `config/env`.
 *
 * `config/env` validates the WHOLE application environment as a module
 * side-effect, so importing it here would make every D.1 CLI refuse to start
 * unless SESSION_SECRET and friends happened to be set — which is exactly the
 * situation the operator is using these tools to get out of.
 */
export const REPO_ROOT = path.resolve(__dirname, '../../..');

export const D1_LOCAL_ENV_FILE = '.env.d1.local';

/** Absolute path of the local D.1 secret file. */
export function d1LocalEnvPath(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, D1_LOCAL_ENV_FILE);
}

/**
 * Minimal `KEY=value` parser.
 *
 * Deliberately tiny and strict rather than a full dotenv implementation: it
 * strips a UTF-8 BOM (PowerShell 5.1's `Set-Content -Encoding utf8` writes
 * one, which would otherwise corrupt the first key), ignores blank lines and
 * `#` comments, and unwraps a single layer of matching quotes. Values are
 * never expanded or interpolated — a `$` in a password must survive verbatim.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  // \uFEFF as an escape, not as a literal character: a raw BOM in source is
  // invisible, and linters flag it as irregular whitespace for good reason.
  for (const rawLine of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export class MissingLocalEnvError extends Error {
  constructor(file: string) {
    super(
      `Không tìm thấy tệp cấu hình D.1 cục bộ: ${file}\n` +
        'Tạo tệp đó với đúng một dòng DATABASE_URL trỏ tới một cơ sở dữ liệu ' +
        'dùng-một-lần (kas_dev_cn1), hoặc truyền --target-url. ' +
        'Không bao giờ trỏ tới cơ sở dữ liệu production. Không bao giờ commit tệp này.',
    );
    this.name = 'MissingLocalEnvError';
  }
}

/**
 * Reads `DATABASE_URL` out of `.env.d1.local`.
 *
 * Throws with the FILE PATH only — never with the file's contents — so a
 * missing-configuration failure cannot become a credential disclosure in a
 * terminal transcript or a CI log.
 */
export function loadD1DatabaseUrl(repoRoot: string = REPO_ROOT): string {
  const file = d1LocalEnvPath(repoRoot);
  if (!fs.existsSync(file)) throw new MissingLocalEnvError(file);

  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const url = parsed.DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(`Tệp ${file} không chứa DATABASE_URL.`);
  }
  return url;
}

/**
 * The D.1 target URL: an explicit `--target-url` always wins, then the
 * process environment, then the local file. Returning the explicit value first
 * is what lets the automated tests run without the secret file existing.
 */
export function resolveD1TargetUrl(
  explicit?: string | null,
  environment: NodeJS.ProcessEnv = process.env,
  repoRoot: string = REPO_ROOT,
): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = environment.D1_DATABASE_URL ?? environment.DATABASE_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return loadD1DatabaseUrl(repoRoot);
}
