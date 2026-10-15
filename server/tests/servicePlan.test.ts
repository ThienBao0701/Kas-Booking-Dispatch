/**
 * What the production runner decides while nobody is watching.
 *
 * THE PROPERTY THIS FILE PROTECTS: Kas never restarts itself in a loop. A
 * supervisor that reacts to every fault by restarting turns one clear failure —
 * "PostgreSQL is not answering" — into a process that dies and respawns every
 * few seconds, filling the disk with the log lines that would have explained
 * it. So a restart is attempted only for the two faults a restart can actually
 * fix, and only once, and the budget is never renewed.
 *
 * The second property is that a second copy of Kas never starts a second
 * server, and that a lock file left behind by a power cut cannot lock the hotel
 * out of its own application.
 */
import { describe, expect, it } from 'vitest';
import {
  LOG_FILES,
  MAX_LOG_BYTES,
  MAX_LOG_GENERATIONS,
  MAX_RESTARTS,
  clientServingFault,
  clientServingMessage,
  MIN_FREE_DISK_BYTES,
  decideLock,
  evaluateHealth,
  expiredGeneration,
  fatalMessage,
  healthFaultMessage,
  isProductionRuntime,
  lockMessage,
  parseMode,
  rotationPlan,
  shouldOpenBrowser,
  shouldRotate,
  startupBanner,
  type HealthFault,
  type HealthSample,
  type LockFile,
  type LockState,
} from '../src/service/plan';

/** A machine where everything is fine. */
const healthy = (over: Partial<HealthSample> = {}): HealthSample => ({
  serverProcessAlive: true,
  healthEndpointOk: true,
  databaseOk: true,
  uploadsWritable: true,
  freeDiskBytes: 50 * 1024 * 1024 * 1024,
  ...over,
});

const lock = (over: Partial<LockFile> = {}): LockFile => ({
  pid: 4242,
  port: 3001,
  startedAt: '2026-08-05T01:00:00.000Z',
  mode: 'SERVICE',
  ...over,
});

const lockState = (over: Partial<LockState> = {}): LockState => ({
  lock: null,
  lockPidAlive: false,
  portServesKas: false,
  ...over,
});

/* ================================================================== */
/* Run mode                                                            */
/* ================================================================== */
describe('how the runner was started', () => {
  it('is a service run only when asked', () => {
    expect(parseMode(['--service'])).toBe('SERVICE');
    expect(parseMode([])).toBe('INTERACTIVE');
  });

  it('treats anything unrecognised as an operator run', () => {
    // A typo in the scheduled task must not silently produce a background
    // process that also opens browsers.
    expect(parseMode(['--serivce'])).toBe('INTERACTIVE');
    expect(parseMode(['--verbose'])).toBe('INTERACTIVE');
  });

  it('never opens a browser in service mode', () => {
    // At boot there may be no logged-in session at all; and if there is, a
    // browser appearing on an unattended reception PC at 6am is not a feature.
    expect(shouldOpenBrowser('SERVICE')).toBe(false);
    expect(shouldOpenBrowser('INTERACTIVE')).toBe(true);
  });
});

/* ================================================================== */
/* Single instance                                                     */
/* ================================================================== */
describe('the lock', () => {
  it('starts when nothing is running and no lock exists', () => {
    expect(decideLock(lockState())).toEqual({ kind: 'PROCEED' });
  });

  it('attaches when Kas is already serving', () => {
    expect(decideLock(lockState({ portServesKas: true })).kind).toBe('ATTACH');
  });

  it('starts nothing while another runner is still starting up', () => {
    // Lock held, PID alive, port not answering yet — Prisma's first connection
    // takes a moment. Starting now would race it and lose with EADDRINUSE.
    const decision = decideLock(lockState({ lock: lock(), lockPidAlive: true }));
    expect(decision.kind).toBe('ALREADY_STARTING');
  });

  it('clears a lock whose process is gone', () => {
    // A power cut leaves the file behind. Obeying it would lock the hotel out
    // of its own application until someone found and deleted a file.
    const decision = decideLock(lockState({ lock: lock(), lockPidAlive: false }));
    expect(decision.kind).toBe('CLEAR_STALE_LOCK');
  });

  it('lets a live server win over a stale lock', () => {
    // The port is the authority. A file can outlive the process that wrote it;
    // a health response cannot.
    const decision = decideLock(lockState({ lock: lock(), lockPidAlive: false, portServesKas: true }));
    expect(decision.kind).toBe('ATTACH');
  });

  it('attaches even when the lock claims a different live process', () => {
    const decision = decideLock(lockState({ lock: lock({ pid: 1 }), lockPidAlive: true, portServesKas: true }));
    expect(decision.kind).toBe('ATTACH');
  });

  it('never decides to start a second server while one is up', () => {
    for (const state of [
      lockState({ portServesKas: true }),
      lockState({ portServesKas: true, lock: lock(), lockPidAlive: true }),
      lockState({ lock: lock(), lockPidAlive: true }),
    ]) {
      expect(decideLock(state).kind).not.toBe('PROCEED');
    }
  });

  it('explains each outcome to the operator', () => {
    expect(lockMessage({ kind: 'ATTACH' })).toContain('đã chạy sẵn');
    expect(lockMessage({ kind: 'ALREADY_STARTING' })).toContain('Không khởi động thêm');
    expect(lockMessage({ kind: 'CLEAR_STALE_LOCK' })).toContain('khoá cũ');
  });
});

/* ================================================================== */
/* Health                                                              */
/* ================================================================== */
describe('health detection', () => {
  it('is healthy when everything answers', () => {
    expect(evaluateHealth(healthy(), 0)).toEqual({ kind: 'HEALTHY' });
  });

  it('restarts a server process that has died', () => {
    const verdict = evaluateHealth(healthy({ serverProcessAlive: false }), 0);
    expect(verdict).toEqual({ kind: 'RESTART', reason: 'PROCESS_DEAD' });
  });

  it('restarts a process that is alive but no longer answering', () => {
    const verdict = evaluateHealth(healthy({ healthEndpointOk: false }), 0);
    expect(verdict).toEqual({ kind: 'RESTART', reason: 'ENDPOINT_UNREACHABLE' });
  });

  it('reports a dead process ahead of anything else that is also wrong', () => {
    // With no process there is nothing to ask about the database, and naming
    // the database would send the operator to the wrong machine.
    const verdict = evaluateHealth(
      healthy({ serverProcessAlive: false, databaseOk: false, uploadsWritable: false }),
      0,
    );
    expect(verdict).toEqual({ kind: 'RESTART', reason: 'PROCESS_DEAD' });
  });
});

/* ================================================================== */
/* The faults a restart cannot fix                                     */
/* ================================================================== */
describe('never restarting for something a restart cannot fix', () => {
  it('does not restart for a database that stopped answering', () => {
    // The server is serving; PostgreSQL is the thing that is down. Restarting
    // the server would produce a crash loop and fix nothing.
    const verdict = evaluateHealth(healthy({ databaseOk: false }), 0);
    expect(verdict).toEqual({ kind: 'DEGRADED', reasons: ['DATABASE_DOWN'] });
  });

  it('does not restart for an unwritable uploads directory', () => {
    const verdict = evaluateHealth(healthy({ uploadsWritable: false }), 0);
    expect(verdict).toEqual({ kind: 'DEGRADED', reasons: ['UPLOADS_NOT_WRITABLE'] });
  });

  it('does not restart for a disk that is nearly full', () => {
    const verdict = evaluateHealth(healthy({ freeDiskBytes: MIN_FREE_DISK_BYTES - 1 }), 0);
    expect(verdict).toEqual({ kind: 'DEGRADED', reasons: ['DISK_LOW'] });
  });

  it('reports every external fault at once rather than the first', () => {
    // They have different remedies and different people fix them.
    const verdict = evaluateHealth(
      healthy({ databaseOk: false, uploadsWritable: false, freeDiskBytes: 1024 }),
      0,
    );
    expect(verdict).toEqual({
      kind: 'DEGRADED',
      reasons: ['DATABASE_DOWN', 'UPLOADS_NOT_WRITABLE', 'DISK_LOW'],
    });
  });

  it('says nothing about a disk it could not measure', () => {
    // An unreadable figure is not a low figure. Guessing either way is worse
    // than staying quiet: one is a false alarm, the other is silence.
    expect(evaluateHealth(healthy({ freeDiskBytes: null }), 0)).toEqual({ kind: 'HEALTHY' });
  });

  it('treats exactly the threshold as enough room', () => {
    expect(evaluateHealth(healthy({ freeDiskBytes: MIN_FREE_DISK_BYTES }), 0)).toEqual({
      kind: 'HEALTHY',
    });
  });
});

/* ================================================================== */
/* The restart budget                                                  */
/* ================================================================== */
describe('the restart budget is spent, not renewed', () => {
  it('gives up after the allowed restarts', () => {
    const verdict = evaluateHealth(healthy({ serverProcessAlive: false }), MAX_RESTARTS);
    expect(verdict).toEqual({ kind: 'FATAL', reason: 'PROCESS_DEAD' });
  });

  it('gives up rather than restarting a second time, whatever the fault', () => {
    for (const sample of [
      healthy({ serverProcessAlive: false }),
      healthy({ healthEndpointOk: false }),
    ]) {
      expect(evaluateHealth(sample, MAX_RESTARTS).kind).toBe('FATAL');
    }
  });

  it('never restarts endlessly, at any count', () => {
    // The property, stated directly: past the budget there is no path back to
    // RESTART, however many samples arrive.
    for (const used of [MAX_RESTARTS, MAX_RESTARTS + 1, 50, 5000]) {
      expect(evaluateHealth(healthy({ serverProcessAlive: false }), used).kind).toBe('FATAL');
    }
  });

  it('still reports external faults after the budget is spent', () => {
    // Giving up on restarting is not giving up on reporting.
    const verdict = evaluateHealth(healthy({ databaseOk: false }), MAX_RESTARTS);
    expect(verdict.kind).toBe('DEGRADED');
  });
});

/* ================================================================== */
/* Diagnostics                                                         */
/* ================================================================== */
describe('what the operator is told', () => {
  const faults: HealthFault[] = [
    'PROCESS_DEAD',
    'ENDPOINT_UNREACHABLE',
    'DATABASE_DOWN',
    'UPLOADS_NOT_WRITABLE',
    'DISK_LOW',
  ];

  it('has a message for every fault', () => {
    for (const fault of faults) expect(healthFaultMessage(fault).length, fault).toBeGreaterThan(10);
  });

  it('says plainly that restarting will not fix a database outage', () => {
    // Otherwise the first thing anyone does is restart Kas, twice.
    const message = healthFaultMessage('DATABASE_DOWN');
    expect(message).toContain('KHÔNG khắc phục');
    expect(message).toContain('postgresql');
  });

  it('names what a full disk threatens before it happens', () => {
    expect(healthFaultMessage('DISK_LOW')).toContain('500 MB');
  });

  it('leaks no path, host or connection string in any fault message', () => {
    for (const fault of faults) {
      const message = healthFaultMessage(fault);
      expect(message, fault).not.toContain('postgresql://');
      expect(message, fault).not.toMatch(/[A-Z]:\\/);
    }
  });

  it('explains the giving-up decision and where to read about it', () => {
    const message = fatalMessage('ENDPOINT_UNREACHABLE');
    expect(message).toContain('vô hạn');
    expect(message).toContain('error.log');
  });
});

/* ================================================================== */
/* Log rotation                                                        */
/* ================================================================== */
describe('log rotation', () => {
  it('rotates at the cap, not before', () => {
    expect(shouldRotate(MAX_LOG_BYTES - 1)).toBe(false);
    expect(shouldRotate(MAX_LOG_BYTES)).toBe(true);
  });

  it('moves the highest generation first', () => {
    // Renaming server.log -> server.1.log first would destroy the previous
    // generation, which is usually where the first sign of the fault is.
    const plan = rotationPlan('server.log', 3);
    expect(plan).toEqual([
      { from: 'server.2.log', to: 'server.3.log' },
      { from: 'server.1.log', to: 'server.2.log' },
      { from: 'server.log', to: 'server.1.log' },
    ]);
  });

  it('never overwrites a generation that still needs moving', () => {
    // The ordering invariant, stated exactly: a rename may land on a file only
    // once that file has already been moved out of the way. If a destination
    // still appears as a SOURCE later in the plan, the plan destroys it.
    const plan = rotationPlan('service.log', MAX_LOG_GENERATIONS);
    plan.forEach(({ to }, index) => {
      const stillPending = plan.slice(index + 1).some((later) => later.from === to);
      expect(stillPending, `${to} is overwritten before it is moved`).toBe(false);
    });
  });

  it('names the generation that falls off the end', () => {
    expect(expiredGeneration('error.log', 5)).toBe('error.5.log');
  });

  it('keeps a bounded number of generations', () => {
    // "Rotate" without "discard" is a slower way of filling the disk.
    expect(MAX_LOG_GENERATIONS).toBeLessThanOrEqual(10);
    expect(rotationPlan('server.log')).toHaveLength(MAX_LOG_GENERATIONS);
  });

  it('separates the things an operator reads at different times', () => {
    expect(Object.values(LOG_FILES).sort()).toEqual([
      'backup.log',
      'error.log',
      'launcher.log',
      'restore.log',
      'server.log',
      'service.log',
      'startup.log',
      'verification.log',
    ]);
  });

  it('never mixes backup or restore into the server log', () => {
    // A restore is read weeks later by someone asking what it did to their
    // data; interleaved request logs make that unanswerable.
    expect(LOG_FILES.backup).not.toBe(LOG_FILES.server);
    expect(LOG_FILES.restore).not.toBe(LOG_FILES.server);
    expect(LOG_FILES.verification).not.toBe(LOG_FILES.backup);
  });
});

/* ================================================================== */
/* Production vs development                                           */
/* ================================================================== */
describe('production wording', () => {
  it('recognises production and nothing else', () => {
    expect(isProductionRuntime('production')).toBe(true);
    for (const value of ['development', 'test', '', undefined]) {
      expect(isProductionRuntime(value), String(value)).toBe(false);
    }
  });

  it('shows no developer warning in production', () => {
    // An operator reading "development mode" on the hotel's machine cannot act
    // on it and will reasonably conclude the install is broken.
    const banner = startupBanner('SERVICE', 'production').join('\n');
    expect(banner).not.toContain('CẢNH BÁO');
    expect(banner).not.toContain('development');
  });

  it('warns loudly when a non-production build is running the hotel', () => {
    expect(startupBanner('SERVICE', 'development').join('\n')).toContain('CẢNH BÁO');
    expect(startupBanner('SERVICE', undefined).join('\n')).toContain('chưa đặt');
  });

  it('says which way it was started', () => {
    expect(startupBanner('SERVICE', 'production').join('\n')).toContain('dịch vụ nền');
    expect(startupBanner('INTERACTIVE', 'production').join('\n')).toContain('thủ công');
  });
});

/* ================================================================== */
/* 6.4.2 — a service that would not serve the app                      */
/* ================================================================== */
describe('starting a runtime that cannot serve the client', () => {
  it('is FATAL in service mode', () => {
    // KasService.cmd is the production entry point. A production service that
    // answers /api and 404s index.html, the manifest and every asset is not a
    // degraded start — it is the exact failure that ran a hotel for a whole
    // deployment with nobody able to install the app.
    expect(clientServingFault('SERVICE', true, false)).toBe('FATAL');
  });

  it('is only a warning interactively', () => {
    // Kas.cmd is also how a developer runs a checkout, where NODE_ENV is
    // legitimately development. Refusing there would break a real workflow.
    expect(clientServingFault('INTERACTIVE', true, false)).toBe('WARNING');
  });

  it('says nothing when the client will be served', () => {
    for (const mode of ['SERVICE', 'INTERACTIVE'] as const) {
      expect(clientServingFault(mode, true, true), mode).toBeNull();
    }
  });

  it('stays silent when there is no build to serve', () => {
    // A missing build is a different fault with its own message; reporting
    // both would send the operator down two paths for one problem.
    expect(clientServingFault('SERVICE', false, false)).toBeNull();
  });

  it('names the symptom AND the two lines that fix it', () => {
    const message = clientServingMessage('FATAL');
    expect(message).toContain('404');
    expect(message).toContain('API vẫn chạy');
    expect(message).toContain('NODE_ENV=production');
    expect(message).toContain('SERVE_CLIENT=true');
  });

  it('refuses out loud in service mode, advises interactively', () => {
    expect(clientServingMessage('FATAL')).toContain('KHÔNG THỂ KHỞI ĐỘNG');
    expect(clientServingMessage('WARNING')).toContain('CẢNH BÁO');
  });
});
