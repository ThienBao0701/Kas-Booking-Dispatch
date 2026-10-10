/**
 * Spawning `pg_dump` / `pg_restore` / `psql` safely.
 *
 * THE PASSWORD PROBLEM, AND HOW IT IS HANDLED HERE:
 * the obvious way to invoke pg_dump is to hand it the connection URI as an
 * argument. That puts the password in the process command line, where any
 * other process on the machine can read it (Task Manager's command-line
 * column, `wmic process`, `ps`), and where it lands in shell history and in
 * any log that echoes the command.
 *
 * So the connection is split instead: host/port/user/database go in argv where
 * they are harmless, and the password goes in the CHILD process's environment
 * as `PGPASSWORD`, which is not visible in argv and does not survive the
 * child. It is never written to disk, never logged, and never returned.
 *
 * Every captured stdout/stderr is passed through `scrubConnectionSecrets`
 * before it can reach a log, a report or an exception message, because these
 * tools do sometimes echo a connection string back in an error.
 */
import { execFile } from 'node:child_process';
import { describeDatabaseUrl, scrubConnectionSecrets } from '../config/databaseUrl';

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Held only long enough to hand to a child process's environment. */
  password: string | null;
}

/**
 * Splits a URL into connection parts.
 *
 * This is the ONE place in the codebase that reads the password out of a URL,
 * deliberately kept next to the only code that legitimately needs it. The
 * result must never be logged, serialised or put in an Error.
 */
export function connectionFromUrl(url: string): PgConnection {
  const target = describeDatabaseUrl(url);
  if (target.kind !== 'postgresql' || !target.database) {
    throw new Error('Cần một postgresql:// URL hợp lệ cho pg_dump/pg_restore.');
  }
  let password: string | null = null;
  try {
    password = new URL(url).password || null;
    if (password) password = decodeURIComponent(password);
  } catch {
    password = null;
  }
  return {
    host: target.host ?? '127.0.0.1',
    port: target.port ?? 5432,
    user: target.user ?? '',
    database: target.database,
    password,
  };
}

export interface RunResult {
  ok: boolean;
  exitCode: number;
  /** Already scrubbed of anything resembling a connection URL. */
  stdout: string;
  stderr: string;
}

/**
 * Runs a PostgreSQL client binary with the password supplied out-of-band.
 *
 * `maxBuffer` is raised because pg_restore is chatty on large archives, and a
 * truncated buffer would turn a successful restore into an unexplained crash.
 */
export function runPgTool(
  tool: 'pg_dump' | 'pg_restore' | 'psql',
  args: string[],
  connection: PgConnection,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (connection.password) env.PGPASSWORD = connection.password;
  // A stray PGSERVICE/PGDATABASE in the operator's environment could silently
  // redirect the tool at a different database than the one we validated.
  delete env.PGSERVICE;
  delete env.PGDATABASE;

  return new Promise((resolve) => {
    execFile(
      tool,
      args,
      { env, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? 1
              : 0;
        resolve({
          ok: !error,
          exitCode: code,
          stdout: scrubConnectionSecrets(String(stdout ?? '')),
          stderr: scrubConnectionSecrets(String(stderr ?? '')),
        });
      },
    );
  });
}

/** Standard connection flags. The password is deliberately absent. */
export function connectionArgs(connection: PgConnection): string[] {
  return [
    '--host', connection.host,
    '--port', String(connection.port),
    '--username', connection.user,
    '--no-password',
  ];
}

/** Reads `pg_dump --version`, for the manifest and compatibility warnings. */
export async function pgToolVersion(tool: 'pg_dump' | 'pg_restore'): Promise<string | null> {
  const result = await runPgTool(tool, ['--version'], {
    host: '',
    port: 0,
    user: '',
    database: '',
    password: null,
  });
  if (!result.ok) return null;
  const match = /(\d+)\.(\d+)/.exec(result.stdout);
  return match ? match[0] : result.stdout.trim() || null;
}

/** Major version number, used to compare a dump against a restore target. */
export function majorVersion(version: string | null): number | null {
  if (!version) return null;
  const match = /^(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}
