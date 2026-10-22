/**
 * The deployment verdict: what counts as broken, and what merely counts as
 * worth knowing.
 *
 * THE PROPERTY THIS FILE PROTECTS: FAIL means Kas cannot serve a booking.
 * Nothing else may claim it. A diagnostic that reports "not Administrator" as a
 * failure sends an operator chasing a permission problem on a working system;
 * one that reports a full disk as a warning lets the hotel run until PostgreSQL
 * cannot write. Getting that boundary right is the entire value of the tool,
 * and it is the part a mock-heavy test would never touch.
 *
 * The second property is ORDER: failures print before warnings before passes.
 * A report that buries one FAIL under twelve PASS lines has technically
 * reported the fault and practically hidden it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_STALE_HOURS,
  MIN_FREE_DISK_BYTES,
  MIN_NODE_MAJOR,
  evaluateDeployment,
  formatReport,
  unconfiguredReport,
  verdictLine,
  type DeploymentFacts,
} from '../src/production/deploymentCheck';
import type { VersionInfo } from '../src/production/version';

const NOW = new Date('2026-08-05T22:00:00.000Z');

/** A machine where everything is right. */
const healthy = (over: Partial<DeploymentFacts> = {}): DeploymentFacts => ({
  nodeMajor: MIN_NODE_MAJOR,
  windowsRelease: '10.0.19045',
  administrator: true,
  databaseConnected: true,
  migrationsApplied: true,
  serverBuildPresent: true,
  clientBuildPresent: true,
  uploadDirWritable: true,
  backupDirWritable: true,
  logDirWritable: true,
  startupTaskRegistered: true,
  backupTaskRegistered: true,
  freeDiskBytes: 50 * 1024 * 1024 * 1024,
  portInUse: true,
  healthOk: true,
  healthAnswered: true,
  servedClientIsBuild: true,
  environment: 'production',
  lastBackupAt: '2026-08-05T21:00:00.000Z',
  lastVerification: 'OK backup-20260805T2100',
  port: 3001,
  ...over,
});

const check = (facts: DeploymentFacts, name: string) =>
  evaluateDeployment(facts, NOW).checks.find((c) => c.name === name);

const VERSION: VersionInfo = {
  appVersion: '0.1.0',
  gitCommit: 'abcdef1234567890',
  buildDate: '2026-08-05T10:00:00.000Z',
  environment: 'production',
  nodeVersion: '22.0.0',
};

/* ================================================================== */
/* A healthy machine                                                   */
/* ================================================================== */
describe('a correct deployment', () => {
  it('passes everything', () => {
    const report = evaluateDeployment(healthy(), NOW);
    expect(report.overall).toBe('PASS');
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warning).toBe(0);
  });

  it('checks every area the phase asked for', () => {
    const names = evaluateDeployment(healthy(), NOW).checks.map((c) => c.name);
    for (const expected of [
      'node',
      'windows',
      'administrator',
      'database',
      'migrations',
      'serverBuild',
      'clientBuild',
      'servedClient',
      'environment',
      'uploads',
      'logs',
      'backups',
      'disk',
      'health',
      'startupTask',
      'backupTask',
      'lastBackup',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

/* ================================================================== */
/* What is genuinely fatal                                             */
/* ================================================================== */
describe('failures', () => {
  const fatal: [string, Partial<DeploymentFacts>][] = [
    ['node', { nodeMajor: MIN_NODE_MAJOR - 1 }],
    ['serverBuild', { serverBuildPresent: false }],
    ['clientBuild', { clientBuildPresent: false }],
    ['database', { databaseConnected: false }],
    ['migrations', { migrationsApplied: false }],
    ['uploads', { uploadDirWritable: false }],
    ['logs', { logDirWritable: false }],
    ['backups', { backupDirWritable: false }],
    ['disk', { freeDiskBytes: MIN_FREE_DISK_BYTES - 1 }],
  ];

  it.each(fatal)('reports %s as FAIL when broken', (name, broken) => {
    expect(check(healthy(broken), name)?.severity).toBe('FAIL');
  });

  it('makes the whole report FAIL when any single check fails', () => {
    expect(evaluateDeployment(healthy({ databaseConnected: false }), NOW).overall).toBe('FAIL');
  });

  it('names the command that fixes a missing build', () => {
    expect(check(healthy({ serverBuildPresent: false }), 'serverBuild')?.detail).toContain('npm run build');
  });

  it('sends a database failure to services.msc, not to Kas', () => {
    // Restarting Kas does not start PostgreSQL, and that is the first thing
    // anyone tries unless told otherwise.
    expect(check(healthy({ databaseConnected: false }), 'database')?.detail).toContain('services.msc');
  });

  it('says what an unwritable uploads directory costs', () => {
    expect(check(healthy({ uploadDirWritable: false }), 'uploads')?.detail).toContain('ảnh');
  });
});

/* ================================================================== */
/* What must NOT be fatal                                              */
/* ================================================================== */
describe('things that are not failures', () => {
  it('treats missing Administrator as a warning, because Kas runs without it', () => {
    // Only registering the boot task needs elevation. Calling this a failure
    // would send someone chasing permissions on a working system.
    const result = check(healthy({ administrator: false }), 'administrator');
    expect(result?.severity).toBe('WARNING');
    expect(result?.detail).toContain('vẫn chạy bình thường');
  });

  it('treats Kas not running as a warning', () => {
    // --diagnose is run PRECISELY when Kas is down. Reporting that as a
    // failure would bury the reason underneath it.
    const facts = healthy({ healthOk: false, healthAnswered: false, portInUse: false });
    expect(check(facts, 'health')?.severity).toBe('WARNING');
  });

  it('treats an unregistered boot task as a warning', () => {
    expect(check(healthy({ startupTaskRegistered: false }), 'startupTask')?.severity).toBe('WARNING');
  });

  it('treats an unregistered backup task as a warning, and says what it costs', () => {
    const result = check(healthy({ backupTaskRegistered: false }), 'backupTask');
    expect(result?.severity).toBe('WARNING');
    expect(result?.detail).toContain('sao lưu');
  });

  it('warns rather than fails when a measurement could not be taken', () => {
    // An unread figure is not a bad figure. Guessing either way is worse.
    expect(check(healthy({ freeDiskBytes: null }), 'disk')?.severity).toBe('WARNING');
    expect(check(healthy({ windowsRelease: null }), 'windows')?.severity).toBe('WARNING');
    expect(check(healthy({ migrationsApplied: null }), 'migrations')?.severity).toBe('WARNING');
  });

  it('makes the report WARNING, not FAIL, when only warnings exist', () => {
    const report = evaluateDeployment(healthy({ administrator: false }), NOW);
    expect(report.overall).toBe('WARNING');
    expect(report.summary.fail).toBe(0);
  });
});

/* ================================================================== */
/* Running, but not serving                                            */
/* ================================================================== */
describe('the health check distinguishes three different problems', () => {
  it('fails when the app answers but its database does not', () => {
    const facts = healthy({ healthOk: false, healthAnswered: true });
    const result = check(facts, 'health');
    expect(result?.severity).toBe('FAIL');
    expect(result?.detail).toContain('503');
  });

  it('fails when something else holds the port', () => {
    // A different program on 3001 is a real fault with a different remedy from
    // "Kas is not running".
    const facts = healthy({ healthOk: false, healthAnswered: false, portInUse: true });
    const result = check(facts, 'health');
    expect(result?.severity).toBe('FAIL');
    expect(result?.detail).toContain('không phải Kas');
  });

  it('names the port, so the remedy is actionable', () => {
    const facts = healthy({ healthOk: false, healthAnswered: false, portInUse: true, port: 3999 });
    expect(check(facts, 'health')?.detail).toContain('3999');
  });
});

/* ================================================================== */
/* Recovery readiness                                                  */
/* ================================================================== */
describe('backup age', () => {
  it('passes a recent backup', () => {
    expect(check(healthy(), 'lastBackup')?.severity).toBe('PASS');
  });

  it('warns when the newest backup is older than the schedule implies', () => {
    // The nightly task silently not running is invisible otherwise: everything
    // works, right up until somebody needs a backup.
    const old = new Date(NOW.getTime() - (BACKUP_STALE_HOURS + 1) * 3_600_000).toISOString();
    const result = check(healthy({ lastBackupAt: old }), 'lastBackup');
    expect(result?.severity).toBe('WARNING');
    expect(result?.detail).toContain('lịch sao lưu');
  });

  it('warns when there is no backup at all, and names the command', () => {
    const result = check(healthy({ lastBackupAt: null }), 'lastBackup');
    expect(result?.severity).toBe('WARNING');
    expect(result?.detail).toContain('KasBackup.cmd');
  });
});

/* ================================================================== */
/* Presentation                                                        */
/* ================================================================== */
describe('the printed report', () => {
  it('prints failures before warnings before passes', () => {
    const facts = healthy({ databaseConnected: false, administrator: false });
    const lines = formatReport(evaluateDeployment(facts, NOW), VERSION);
    const firstFail = lines.findIndex((l) => l.startsWith('[FAIL]'));
    const firstWarn = lines.findIndex((l) => l.startsWith('[WARN]'));
    const firstPass = lines.findIndex((l) => l.startsWith('[ OK ]'));
    expect(firstFail).toBeLessThan(firstWarn);
    expect(firstWarn).toBeLessThan(firstPass);
  });

  it('leads with the version, so a report can be attributed to a build', () => {
    const lines = formatReport(evaluateDeployment(healthy(), NOW), VERSION).join('\n');
    expect(lines).toContain('0.1.0');
    expect(lines).toContain('abcdef12');
  });

  it('ends with a verdict that carries the counts', () => {
    const report = evaluateDeployment(healthy({ databaseConnected: false }), NOW);
    expect(verdictLine(report)).toContain('FAIL');
    expect(verdictLine(report)).toContain('1');
  });

  it('says the system is ready only when nothing is wrong', () => {
    expect(verdictLine(evaluateDeployment(healthy(), NOW))).toContain('sẵn sàng');
  });

  it('carries no connection string in any message', () => {
    const facts = healthy({ databaseConnected: false, migrationsApplied: false });
    const lines = formatReport(evaluateDeployment(facts, NOW), VERSION).join('\n');
    expect(lines).not.toContain('postgresql://');
    expect(lines).not.toMatch(/:\/\/[^\s]*:[^\s]*@/);
  });
});

/* ================================================================== */
/* 6.4.2 — production running the DEVELOPMENT server                   */
/* ================================================================== */
describe('the client the origin actually serves', () => {
  it('fails when a dev server is answering instead of the build', () => {
    // THE PRODUCTION FAULT THIS EXISTS TO CATCH. The tunnel pointed at Vite on
    // 5173, Vite proxied /api to the real backend, and everything worked —
    // logins, dispatch, bookings. Health was 200 throughout. The only casualty
    // was that no manifest and no service worker were ever served, so the app
    // could not be installed and nothing said why.
    const result = check(healthy({ servedClientIsBuild: false }), 'servedClient');
    expect(result?.severity).toBe('FAIL');
  });

  it('names the remedy, not just the fault', () => {
    const detail = check(healthy({ servedClientIsBuild: false }), 'servedClient')?.detail ?? '';
    expect(detail).toContain('npm run dev');
    expect(detail).toContain('3001');
    expect(detail).toContain('KasService.cmd');
  });

  it('explains that the app still works, which is what hid it', () => {
    const detail = check(healthy({ servedClientIsBuild: false }), 'servedClient')?.detail ?? '';
    expect(detail).toContain('vẫn chạy');
    expect(detail).toContain('KHÔNG cài được');
  });

  it('passes when the built manifest is being served', () => {
    expect(check(healthy({ servedClientIsBuild: true }), 'servedClient')?.severity).toBe('PASS');
  });

  it('warns rather than fails when nothing is running to ask', () => {
    // Not the same as a No. Kas being down is reported by the health check.
    expect(check(healthy({ servedClientIsBuild: null }), 'servedClient')?.severity).toBe('WARNING');
  });

  it('makes the whole report FAIL, so it cannot be scrolled past', () => {
    expect(evaluateDeployment(healthy({ servedClientIsBuild: false }), NOW).overall).toBe('FAIL');
  });
});

/* ================================================================== */
/* 6.4.2 — the setting the whole deployment hangs on                   */
/* ================================================================== */
describe('NODE_ENV', () => {
  it('fails when the machine is running as development', () => {
    // THE ROOT CAUSE, as data. `serveClient` is `SERVE_CLIENT ?? isProduction`,
    // so a development machine never mounts express.static and answers every
    // non-API request with a 404 — while the API keeps working perfectly.
    // That combination cost a whole deployment.
    expect(check(healthy({ environment: 'development' }), 'environment')?.severity).toBe('FAIL');
  });

  it('fails when it was never set at all', () => {
    // The shipped template used to omit it entirely, and the schema defaults
    // to development — so "unset" and "development" are the same fault.
    const result = check(healthy({ environment: '' }), 'environment');
    expect(result?.severity).toBe('FAIL');
    expect(result?.detail).toContain('chưa đặt');
  });

  it('names the two lines that fix it, and the file they go in', () => {
    const detail = check(healthy({ environment: 'development' }), 'environment')?.detail ?? '';
    expect(detail).toContain('NODE_ENV=production');
    expect(detail).toContain('SERVE_CLIENT=true');
    expect(detail).toContain('.env');
  });

  it('says what the symptom looks like, so it is recognisable', () => {
    const detail = check(healthy({ environment: 'development' }), 'environment')?.detail ?? '';
    expect(detail).toContain('404');
    expect(detail).toContain('API vẫn chạy');
  });

  it('passes in production', () => {
    expect(check(healthy(), 'environment')?.severity).toBe('PASS');
  });
});

/* ================================================================== */
/* 6.4.2 — the shipped template must declare production               */
/* ================================================================== */
describe('the configuration template an install receives', () => {
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.env.production.example'),
    'utf8',
  );
  /** Settings, not the prose around them: a commented line sets nothing. */
  const active = template
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('sets NODE_ENV=production as a real line, not a comment', () => {
    // It appeared ONLY inside comments, because the Docker compose file used
    // to supply it. On Windows there is no compose file and nothing else set
    // it, so every install ran as development.
    expect(active).toContain('NODE_ENV=production');
  });

  it('sets SERVE_CLIENT=true, so the built client is actually served', () => {
    expect(active).toContain('SERVE_CLIENT=true');
  });

  it('pins the one port the proxy must target', () => {
    expect(active).toContain('PORT=3001');
  });
});

describe('the diagnostic still reports when it cannot measure anything', () => {
  // A fresh install has a template .env, so config/env throws on import and
  // every probe in diagnose.ts is unreachable. Installing from the release
  // package ended in a bare "Lỗi không mong đợi: Invalid environment
  // configuration" — the diagnostic failing in the exact state it exists for.
  const loaderMessage =
    'Invalid environment configuration:\n' +
    '  - DATABASE_URL: Required\n' +
    '  - SESSION_SECRET: String must contain at least 32 character(s)\n\n' +
    'Copy .env.example to .env (or .env.production.example for a server) and fill in the values.';

  it('names every variable the loader rejected', () => {
    const lines = unconfiguredReport(loaderMessage);
    expect(lines.join('\n')).toContain('DATABASE_URL');
    expect(lines.join('\n')).toContain('SESSION_SECRET');
  });

  it('calls it a FAIL, not a warning — Kas cannot serve a booking like this', () => {
    const text = unconfiguredReport(loaderMessage).join('\n');
    expect(text).toContain('[FAIL]');
    expect(text).toContain('LỖI NGHIÊM TRỌNG');
  });

  it('tells the operator the command to run once .env is fixed', () => {
    expect(unconfiguredReport(loaderMessage).join('\n')).toContain('Kas.cmd --diagnose');
  });

  it('leaks nothing: the loader names variables, never their values', () => {
    // The message is reproduced verbatim, so the guarantee has to come from
    // the loader reporting names only. Pinned here because this report is the
    // text an operator is asked to send to whoever is helping them.
    const text = unconfiguredReport(loaderMessage).join('\n');
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});
