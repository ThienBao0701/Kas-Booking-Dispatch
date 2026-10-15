/**
 * Measuring the machine, so `deploymentCheck` can judge it.
 *
 * READ-ONLY, without exception. Diagnostics run when something is already
 * wrong, and a tool that repairs as it inspects destroys the evidence of what
 * was broken — the operator ends up with a working system and no idea why it
 * had stopped, which guarantees a second incident.
 *
 * Every probe is individually defensive. A diagnostic that throws on its third
 * check has told the operator less than one that reports "could not read this"
 * and carries on to the other nine.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BACKUP_DIR, ISSUE_UPLOAD_DIR, PROOF_UPLOAD_DIR } from '../config/env';
import { checkDatabase, checkMigrationsApplied } from '../db/prisma';
import { readHealth } from '../service/control';
import { LOG_FILES } from '../service/plan';
import { BACKUP_MANIFEST_NAME, listBackups } from './backup';
import { versionInfo, type VersionInfo } from './version';
import { evaluateDeployment, type DeploymentFacts, type DeploymentReport } from './deploymentCheck';

/** Repository root, from `server/src/production/` or `server/dist/production/`. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'logs');

/** The two Windows tasks the installer registers. */
export const STARTUP_TASK = 'Kas';
export const BACKUP_TASK = 'Kas Backup';

/**
 * Could the application write here? Never creates anything.
 *
 * A MISSING DIRECTORY IS NOT A FAILURE. The runner creates its upload, log and
 * backup directories on demand, so `server/uploads/issue-photos` legitimately
 * does not exist on a machine where nobody has reported an issue yet. A
 * read-only check that called that "cannot write" would report a FAIL on a
 * perfectly healthy system — which this did, until running it caught the
 * mistake.
 *
 * So the question asked is the one that matters: walk up to the nearest
 * directory that DOES exist, and ask whether that is writable. If it is, the
 * application can create what it needs.
 */
function writable(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = fs.statSync(current);
      if (!stat.isDirectory()) return false;
      fs.accessSync(current, fs.constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      // Reached the volume root without finding anything: nothing to write to.
      if (parent === current) return false;
      current = parent;
    }
  }
}

/** True when a scheduled task of this name exists. */
export function taskRegistered(name: string): boolean {
  try {
    // stdio ignored: schtasks writes its own table to stdout and its own error
    // text to stderr, and the exit code is the whole answer.
    execFileSync('schtasks.exe', ['/Query', '/TN', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this process can do the things elevation is needed for.
 *
 * Probed by asking, not by inspecting tokens: `net session` requires
 * administrator and touches nothing. A failure is a plain "no", which is the
 * safe direction — reporting a non-elevated process as elevated would make the
 * scheduled-task advice wrong.
 */
export function isAdministrator(): boolean {
  try {
    execFileSync('net.exe', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freeDiskBytes(root: string): number | null {
  try {
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** True when anything accepts a TCP connection on the port. */
async function portInUse(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Is the origin serving the BUILT client, or a development server?
 *
 * Asked by fetching the one file that only exists in a build. A Vite dev server
 * answers every unknown path with its index.html, so the reply comes back as
 * HTML rather than JSON — which is precisely how an entire deployment ran in
 * development mode without anyone noticing: the app worked, because Vite
 * proxies /api to the real backend, and the only casualty was installability.
 *
 * Null means the question could not be asked, which is not the same as a No.
 */
export async function servedClientIsBuild(port: number): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`http://localhost:${port}/manifest.webmanifest`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return false;

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('html')) return false;
    // Content type alone is not enough — a static host may serve the file as
    // octet-stream. The body is the evidence: a manifest is a JSON object.
    const body = (await response.text()).trimStart();
    return body.startsWith('{');
  } catch {
    return null;
  }
}

/** When the newest COMPLETE backup was taken, from its own manifest. */
async function lastBackupAt(backupRoot: string): Promise<string | null> {
  for (const name of await listBackups(backupRoot)) {
    try {
      const raw = await fsp.readFile(path.join(backupRoot, name, BACKUP_MANIFEST_NAME), 'utf8');
      const parsed = JSON.parse(raw) as { createdAt?: string };
      if (parsed.createdAt) return parsed.createdAt;
    } catch {
      // Incomplete or corrupt: keep looking at older ones. This is exactly the
      // case where reporting the NEXT backup down is the useful answer.
    }
  }
  return null;
}

/** The last line of verification.log — the record of the most recent outcome. */
export function lastVerificationLine(logDir: string): string | null {
  try {
    const lines = fs
      .readFileSync(path.join(logDir, LOG_FILES.verification), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    return lines[lines.length - 1] ?? null;
  } catch {
    return null;
  }
}

export interface DiagnoseOptions {
  port?: number;
  root?: string;
  now?: Date;
}

/** Measures everything, judging nothing. */
export async function gatherFacts(options: DiagnoseOptions = {}): Promise<DeploymentFacts> {
  const root = options.root ?? REPO_ROOT;
  const port = options.port ?? Number.parseInt(process.env.PORT ?? '3001', 10);

  const databaseConnected = await checkDatabase();
  const health = await readHealth(port);

  return {
    nodeMajor: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
    windowsRelease: os.platform() === 'win32' ? os.release() : null,
    administrator: isAdministrator(),
    databaseConnected,
    migrationsApplied: databaseConnected ? await checkMigrationsApplied() : null,
    serverBuildPresent: fs.existsSync(path.join(root, 'server', 'dist', 'index.js')),
    clientBuildPresent: fs.existsSync(path.join(root, 'client', 'dist', 'index.html')),
    uploadDirWritable: writable(PROOF_UPLOAD_DIR) && writable(ISSUE_UPLOAD_DIR),
    backupDirWritable: writable(BACKUP_DIR),
    logDirWritable: writable(path.join(root, 'logs')),
    startupTaskRegistered: taskRegistered(STARTUP_TASK),
    backupTaskRegistered: taskRegistered(BACKUP_TASK),
    freeDiskBytes: freeDiskBytes(root),
    portInUse: health !== null ? true : await portInUse(port),
    healthOk: health?.status === 200 && health.databaseOk,
    healthAnswered: health !== null,
    // Only worth asking when something is actually answering the port.
    servedClientIsBuild: health !== null ? await servedClientIsBuild(port) : null,
    environment: process.env.NODE_ENV ?? '',
    lastBackupAt: await lastBackupAt(BACKUP_DIR),
    lastVerification: lastVerificationLine(path.join(root, 'logs')),
    port,
  };
}

export interface Diagnosis {
  version: VersionInfo;
  facts: DeploymentFacts;
  report: DeploymentReport;
}

export async function diagnose(options: DiagnoseOptions = {}): Promise<Diagnosis> {
  const facts = await gatherFacts(options);
  return {
    version: versionInfo(options.root),
    facts,
    report: evaluateDeployment(facts, options.now),
  };
}

/* ------------------------------------------------------------------ */
/* The deployment report                                               */
/* ------------------------------------------------------------------ */

/**
 * The machine-readable form, written beside the logs.
 *
 * Deliberately the SAME facts the console prints: two views of one measurement
 * cannot disagree, whereas a report assembled separately from the diagnostic
 * eventually will.
 *
 * It carries no secret — the database is reported as reachable or not, never by
 * URL — because this file is exactly the thing an operator emails to whoever is
 * helping them.
 */
export function buildDeploymentReport(diagnosis: Diagnosis, now: Date): Record<string, unknown> {
  const { version, facts, report } = diagnosis;
  return {
    generatedAt: now.toISOString(),
    application: {
      version: version.appVersion,
      gitCommit: version.gitCommit,
      buildDate: version.buildDate,
      environment: version.environment,
    },
    platform: {
      node: version.nodeVersion,
      windows: facts.windowsRelease,
      administrator: facts.administrator,
    },
    database: {
      connected: facts.databaseConnected,
      migrationsApplied: facts.migrationsApplied,
    },
    components: {
      serverBuild: facts.serverBuildPresent,
      clientBuild: facts.clientBuildPresent,
      uploadsWritable: facts.uploadDirWritable,
      logsWritable: facts.logDirWritable,
      backupsWritable: facts.backupDirWritable,
    },
    service: {
      port: facts.port,
      running: facts.healthAnswered,
      healthy: facts.healthOk,
      startupTaskRegistered: facts.startupTaskRegistered,
      backupTaskRegistered: facts.backupTaskRegistered,
    },
    backup: {
      lastBackupAt: facts.lastBackupAt,
      lastVerification: facts.lastVerification,
    },
    disk: { freeBytes: facts.freeDiskBytes },
    result: { overall: report.overall, summary: report.summary, checks: report.checks },
  };
}

/** Writes the report and returns where it went. */
export async function writeDeploymentReport(
  diagnosis: Diagnosis,
  now: Date = new Date(),
  dir: string = LOG_DIR,
): Promise<string> {
  const file = path.join(dir, 'deployment-report.json');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(buildDeploymentReport(diagnosis, now), null, 2)}\n`, 'utf8');
  return file;
}
