/**
 * The supervised restore: stop, roll-back-point, restore, start, prove, undo.
 *
 * THE PROPERTY THIS FILE PROTECTS: a failed restore leaves the hotel where it
 * started. Restoring is the most dangerous thing this system does — it
 * overwrites live data, on the worst day someone has had — and the failure mode
 * that matters is not "the restore did not work", it is "the restore did not
 * work AND the previous data is gone".
 *
 * The second property is that nothing is stopped or overwritten until the
 * chosen backup has been verified. Taking the application down and THEN
 * discovering the archive is corrupt costs an outage to learn something that
 * was free to know.
 *
 * The application and the restore engine are both injected. A real pg_restore
 * here would test PostgreSQL, which `backupRestore.test.ts` already does
 * against a real database; what needs proving here is the ORDER of operations
 * and what happens when a step fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  looksLikeImage,
  safeRestore,
  validateRestoredSystem,
  type AppControl,
  type SafeRestoreOptions,
} from '../src/production/safeRestore';
import { BACKUP_MANIFEST_NAME, type BackupManifest } from '../src/production/backup';
import type { RestoreOptions, RestoreResult } from '../src/production/restore';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-restore-'));
  // A configured machine. The absent case is asserted explicitly further down;
  // here it must be present, or every run reports a configuration warning.
  fs.writeFileSync(path.join(root, '.env'), 'PORT=3001\n', 'utf8');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A manifest good enough for verifyBackup to accept the directory. */
function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: 2,
    createdAt: '2026-08-05T22:00:00.000Z',
    appVersion: '1.0.0',
    releaseRef: null,
    database: {
      file: 'database.dump',
      sha256: 'x',
      bytes: 1,
      engine: 'postgresql',
      name: 'kas_dev_cn1',
      schema: 'public',
      serverVersion: '17.0',
      dumpFormat: 'custom',
      pgDumpVersion: '17.0',
    },
    uploads: [],
    counts: { bookings: 3 },
    ...over,
  };
}

/** Writes a backup directory. `valid` controls whether verifyBackup accepts it. */
function makeBackupDir(name: string, valid = true): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (valid) {
    fs.writeFileSync(path.join(dir, BACKUP_MANIFEST_NAME), JSON.stringify(manifest()));
  }
  return dir;
}

/** Records the order of everything the orchestrator does. */
function makeApp(over: Partial<AppControl> = {}): { app: AppControl; calls: string[] } {
  const calls: string[] = [];
  const app: AppControl = {
    stop: async () => {
      calls.push('stop');
      return true;
    },
    start: async () => {
      calls.push('start');
    },
    waitHealthy: async () => {
      calls.push('waitHealthy');
      return true;
    },
    ...over,
  };
  return { app, calls };
}

const restoreResult = (verified = true): RestoreResult => ({
  targetDatabase: 'kas_dev_cn1',
  restoredUploads: [],
  manifest: manifest(),
  safetyCopyFile: null,
  verification: [],
  verified,
  warnings: [],
  checklist: [],
});

/**
 * Stands in for the real verifier.
 *
 * A directory verifies when it has a manifest. The REAL check also validates
 * checksums and asks `pg_restore --list` to read the archive — that needs a
 * genuine pg_dump archive and is covered against a real database in
 * `backupRestore.test.ts`. What this file proves is the ORDER of operations
 * around verification, which is a property of the orchestrator alone.
 */
const fakeVerify = async (dir: string) => {
  const manifestPath = path.join(dir, BACKUP_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: ['Thiếu hoặc hỏng manifest.json.'], warnings: [], manifest: null };
  }
  return {
    ok: true,
    problems: [],
    warnings: [],
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest,
  };
};

/** Options with every external effect stubbed out. */
function options(over: Partial<SafeRestoreOptions> = {}): SafeRestoreOptions {
  const { app } = makeApp();
  return {
    backupDir: makeBackupDir('backup-chosen'),
    targetUrl: 'postgresql://u:p@localhost:5432/kas_dev_cn1',
    confirmed: true,
    app,
    envFile: path.join(root, '.env'),
    uploadDirs: [],
    verify: fakeVerify,
    runRestore: async () => restoreResult(),
    makeRollbackPoint: async () => ({ backupDir: makeBackupDir('backup-rollback') }),
    ...over,
  };
}

/* ================================================================== */
/* Verify before anything is disturbed                                 */
/* ================================================================== */
describe('the backup is checked first', () => {
  it('never stops the application for an invalid backup', () => {
    // The whole reason verification comes first.
    return (async () => {
      const { app, calls } = makeApp();
      const result = await safeRestore(
        options({ app, backupDir: makeBackupDir('backup-broken', false) }),
      );
      expect(result.outcome).toBe('ABORTED');
      expect(calls).toEqual([]);
    })();
  });

  it('reports why it refused', async () => {
    const result = await safeRestore(options({ backupDir: makeBackupDir('backup-broken', false) }));
    expect(result.problems.join(' ')).toContain('manifest');
  });

  it('changes nothing when it aborts', async () => {
    const runRestore = vi.fn();
    await safeRestore(
      options({ backupDir: makeBackupDir('backup-broken', false), runRestore }),
    );
    expect(runRestore).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* The happy path, in order                                            */
/* ================================================================== */
describe('a successful restore', () => {
  it('stops, restores, starts and checks health — in that order', async () => {
    const { app, calls } = makeApp();
    const result = await safeRestore(options({ app }));

    expect(result.outcome).toBe('SUCCEEDED');
    // stop before restore; start before the health check.
    expect(calls[0]).toBe('stop');
    expect(calls).toContain('start');
    expect(calls.indexOf('start')).toBeLessThan(calls.lastIndexOf('waitHealthy'));
  });

  it('takes a rollback point before overwriting anything', async () => {
    const order: string[] = [];
    await safeRestore(
      options({
        makeRollbackPoint: async () => {
          order.push('rollbackPoint');
          return { backupDir: makeBackupDir('backup-rollback') };
        },
        runRestore: async () => {
          order.push('restore');
          return restoreResult();
        },
      }),
    );
    expect(order).toEqual(['rollbackPoint', 'restore']);
  });

  it('reports the rollback point so an operator can find it', async () => {
    const result = await safeRestore(options());
    expect(result.rollbackPoint).toContain('backup-rollback');
  });

  it('does not ask the restore engine for a second safety copy', async () => {
    // The rollback point IS the safety copy. Dumping the same database twice
    // buys nothing and doubles the time the application is down.
    // Typed so the recorded argument can be inspected: an untyped vi.fn infers
    // a zero-length parameter tuple and mock.calls[0][0] does not exist.
    const runRestore = vi.fn(async (_options: RestoreOptions) => restoreResult());
    await safeRestore(options({ runRestore }));
    expect(runRestore.mock.calls[0]![0]).toMatchObject({ safetyCopy: false });
  });
});

/* ================================================================== */
/* Rollback                                                            */
/* ================================================================== */
describe('when the restore fails', () => {
  it('puts the previous data back', async () => {
    const restores: string[] = [];
    const result = await safeRestore(
      options({
        runRestore: async (opts) => {
          restores.push(path.basename(opts.backupDir));
          if (restores.length === 1) throw new Error('pg_restore thất bại');
          return restoreResult();
        },
      }),
    );

    expect(result.outcome).toBe('FAILED_ROLLED_BACK');
    // Second call restored the rollback point, not the chosen backup.
    expect(restores).toEqual(['backup-chosen', 'backup-rollback']);
  });

  it('brings the application back up afterwards', async () => {
    // A rollback that leaves the hotel with no running application has
    // protected the data and lost the day.
    const { app, calls } = makeApp();
    await safeRestore(
      options({
        app,
        runRestore: async (opts) => {
          if (opts.backupDir.endsWith('backup-chosen')) throw new Error('nổ');
          return restoreResult();
        },
      }),
    );
    expect(calls.filter((c) => c === 'start').length).toBeGreaterThanOrEqual(1);
  });

  it('rolls back when the application does not come back healthy', async () => {
    // The restore "worked" but the result cannot serve. Same remedy.
    const restores: string[] = [];
    const result = await safeRestore(
      options({
        app: makeApp({ waitHealthy: async () => false }).app,
        runRestore: async (opts) => {
          restores.push(path.basename(opts.backupDir));
          return restoreResult();
        },
      }),
    );
    expect(result.outcome).toBe('FAILED_ROLLED_BACK');
    expect(restores).toEqual(['backup-chosen', 'backup-rollback']);
  });

  it('says so plainly when the rollback ALSO fails', async () => {
    // The worst case. It must be reported as itself, never as a plain failure,
    // and it must name where the surviving copy is.
    const result = await safeRestore(
      options({
        runRestore: async () => {
          throw new Error('mọi thứ đều hỏng');
        },
      }),
    );
    expect(result.outcome).toBe('FAILED_ROLLBACK_FAILED');
    expect(result.problems.join(' ')).toContain('HOÀN TÁC THẤT BẠI');
    expect(result.problems.join(' ')).toContain('backup-rollback');
  });
});

/* ================================================================== */
/* No way back means no restore                                        */
/* ================================================================== */
describe('when no rollback point can be made', () => {
  it('aborts rather than restoring without a way back', async () => {
    const runRestore = vi.fn(async () => restoreResult());
    const result = await safeRestore(
      options({
        runRestore,
        makeRollbackPoint: async () => {
          throw new Error('pg_dump thất bại');
        },
      }),
    );
    expect(result.outcome).toBe('ABORTED');
    expect(runRestore).not.toHaveBeenCalled();
  });

  it('restarts the application it stopped', async () => {
    const { app, calls } = makeApp();
    await safeRestore(
      options({
        app,
        makeRollbackPoint: async () => {
          throw new Error('pg_dump thất bại');
        },
      }),
    );
    expect(calls).toEqual(['stop', 'start']);
  });

  it('aborts when the rollback point itself does not verify', async () => {
    // An unverified rollback point is a rollback that fails when it is used.
    const runRestore = vi.fn(async () => restoreResult());
    const result = await safeRestore(
      options({ runRestore, makeRollbackPoint: async () => ({ backupDir: makeBackupDir('backup-bad', false) }) }),
    );
    expect(result.outcome).toBe('ABORTED');
    expect(runRestore).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* Post-restore validation                                             */
/* ================================================================== */
describe('proving the restore landed', () => {
  it('reports a count mismatch as a warning, not a success', async () => {
    const result = await safeRestore(options({ runRestore: async () => restoreResult(false) }));
    expect(result.outcome).toBe('RESTORED_WITH_WARNINGS');
    expect(result.problems.join(' ')).toContain('Số bản ghi');
  });

  it('checks that proof images can actually be opened', async () => {
    const uploads = path.join(root, 'proofs');
    fs.mkdirSync(uploads, { recursive: true });
    // A zero-length file passes every existence check and opens as nothing.
    fs.writeFileSync(path.join(uploads, 'proof-1.png'), '');

    const checks = await validateRestoredSystem({
      app: makeApp().app,
      uploadDirs: [{ name: 'booking-proofs', dir: uploads }],
      envFile: path.join(root, '.env'),
      manifest: manifest({ uploads: [{ name: 'booking-proofs', files: 1, bytes: 0, sha256: 'x' }] }),
      healthTimeoutMs: 10,
    });

    const images = checks.find((c) => c.name === 'images:booking-proofs');
    expect(images?.ok).toBe(false);
    expect(images?.detail).toContain('proof-1.png');
  });

  it('accepts a real PNG', async () => {
    const uploads = path.join(root, 'proofs');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(
      path.join(uploads, 'proof-1.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const checks = await validateRestoredSystem({
      app: makeApp().app,
      uploadDirs: [{ name: 'booking-proofs', dir: uploads }],
      envFile: path.join(root, '.env'),
      manifest: manifest({ uploads: [{ name: 'booking-proofs', files: 1, bytes: 8, sha256: 'x' }] }),
      healthTimeoutMs: 10,
    });
    expect(checks.find((c) => c.name === 'images:booking-proofs')?.ok).toBe(true);
  });

  it('notices when fewer files came back than the manifest recorded', async () => {
    const uploads = path.join(root, 'proofs');
    fs.mkdirSync(uploads, { recursive: true });

    const checks = await validateRestoredSystem({
      app: makeApp().app,
      uploadDirs: [{ name: 'booking-proofs', dir: uploads }],
      envFile: path.join(root, '.env'),
      manifest: manifest({ uploads: [{ name: 'booking-proofs', files: 12, bytes: 99, sha256: 'x' }] }),
      healthTimeoutMs: 10,
    });
    const uploadsCheck = checks.find((c) => c.name === 'uploads:booking-proofs');
    expect(uploadsCheck?.ok).toBe(false);
    expect(uploadsCheck?.detail).toContain('12');
  });

  it('does not call an empty upload set a fault when the backup held none', async () => {
    // A hotel that has never uploaded a proof restores an empty directory
    // correctly, and must not be told its restore failed.
    const uploads = path.join(root, 'proofs');
    fs.mkdirSync(uploads, { recursive: true });
    const checks = await validateRestoredSystem({
      app: makeApp().app,
      uploadDirs: [{ name: 'booking-proofs', dir: uploads }],
      envFile: path.join(root, '.env'),
      manifest: manifest({ uploads: [{ name: 'booking-proofs', files: 0, bytes: 0, sha256: 'x' }] }),
      healthTimeoutMs: 10,
    });
    expect(checks.find((c) => c.name === 'uploads:booking-proofs')?.ok).toBe(true);
  });

  it('reports a missing .env, which would stop the next start', async () => {
    const checks = await validateRestoredSystem({
      app: makeApp().app,
      uploadDirs: [],
      envFile: path.join(root, 'nope.env'),
      manifest: null,
      healthTimeoutMs: 10,
    });
    expect(checks.find((c) => c.name === 'configuration')?.ok).toBe(false);
  });

  it('reports an unhealthy application', async () => {
    const checks = await validateRestoredSystem({
      app: makeApp({ waitHealthy: async () => false }).app,
      uploadDirs: [],
      envFile: path.join(root, '.env'),
      manifest: null,
      healthTimeoutMs: 10,
    });
    expect(checks.find((c) => c.name === 'health')?.ok).toBe(false);
  });
});

/* ================================================================== */
/* Image signatures                                                    */
/* ================================================================== */
describe('recognising an image', () => {
  it('accepts PNG, JPEG and WebP', () => {
    expect(looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(looksLikeImage(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBe(true);
  });

  it('rejects an empty or truncated file', () => {
    expect(looksLikeImage(Buffer.alloc(0))).toBe(false);
    expect(looksLikeImage(Buffer.from([0x89, 0x50]))).toBe(false);
  });

  it('rejects text that happens to be sitting in the uploads directory', () => {
    expect(looksLikeImage(Buffer.from('not an image'))).toBe(false);
  });
});
