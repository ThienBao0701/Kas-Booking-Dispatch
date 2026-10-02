/**
 * What the Windows installer decides.
 *
 * THE PROPERTY THIS FILE PROTECTS: an upgrade never destroys operator data.
 * Configuration holds the database password, and server/uploads holds the proof
 * images that are the only evidence a branch created a reservation correctly.
 * An installer that replaced either would be discovered days later, by which
 * time the originals are gone.
 *
 * The second property is that an uninstall keeps that data unless the operator
 * explicitly asks otherwise, and that the database is never in scope at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KAS_PACKAGE_NAME,
  MIN_NODE_MAJOR,
  isKasInstallation,
  BACKUP_DATA,
  CREATED_DIRECTORIES,
  MIN_INSTALL_DISK_BYTES,
  MIN_WINDOWS_MAJOR,
  OPERATOR_DATA,
  PRESERVED_ON_UPGRADE,
  RELEASE_PAYLOAD,
  SCHEDULED_TASK_NAME,
  decideInstall,
  describeInstall,
  installProblemMessage,
  isProtectedPath,
  scheduledTaskSpec,
  shortcutSpecs,
  uninstallTargets,
  type InstallEnvironment,
  type InstallMarkers,
} from '../src/installer/plan';

/** A machine where everything is ready and nothing is installed yet. */
/** Narrows away ABORT so 'preserve' can be read without an unchecked cast. */
function proceeding(action: ReturnType<typeof decideInstall>) {
  if (action.kind === 'ABORT') throw new Error('mong doi cai dat tiep tuc, nhung bi ABORT');
  return action;
}

const ready = (over: Partial<InstallEnvironment> = {}): InstallEnvironment => ({
  nodeMajor: MIN_NODE_MAJOR,
  targetDir: 'C:\\Users\\op\\AppData\\Local\\Kas',
  targetWritable: true,
  existingInstall: false,
  existingVersion: null,
  incomingVersion: '1.2.0',
  payloadComplete: true,
  targetOccupiedByOther: false,
  ...over,
});

/* ================================================================== */
/* Install kind                                                        */
/* ================================================================== */
describe('classifying the install', () => {
  it('is a fresh install when nothing is there', () => {
    expect(decideInstall(ready())).toEqual({ kind: 'FRESH', preserve: [] });
  });

  it('is an upgrade when a different version is present', () => {
    const action = decideInstall(ready({ existingInstall: true, existingVersion: '1.1.0' }));
    expect(action.kind).toBe('UPGRADE');
  });

  it('is a repair when the same version is present', () => {
    // The operator is fixing damage, not moving forward. Both replace the
    // payload; naming it correctly is what makes the log honest.
    const action = decideInstall(ready({ existingInstall: true, existingVersion: '1.2.0' }));
    expect(action.kind).toBe('REPAIR');
  });

  it('preserves nothing on a fresh install, because there is nothing to keep', () => {
    expect(proceeding(decideInstall(ready())).preserve).toEqual([]);
  });
});

/* ================================================================== */
/* The data that must survive                                          */
/* ================================================================== */
describe('operator data', () => {
  it('is preserved by an upgrade', () => {
    const action = proceeding(decideInstall(ready({ existingInstall: true, existingVersion: '1.1.0' })));
    expect(action.preserve).toEqual(PRESERVED_ON_UPGRADE);
  });

  it('is preserved by a repair too', () => {
    const action = proceeding(decideInstall(ready({ existingInstall: true, existingVersion: '1.2.0' })));
    expect(action.preserve).toEqual(PRESERVED_ON_UPGRADE);
  });

  it('covers configuration, uploads and logs', () => {
    expect(OPERATOR_DATA).toContain('.env');
    expect(OPERATOR_DATA).toContain('server/uploads');
    expect(OPERATOR_DATA).toContain('logs');
  });

  it('never overlaps with the files the installer replaces', () => {
    // An item in both lists would be preserved and overwritten at once, and
    // which happened would depend on ordering.
    for (const item of RELEASE_PAYLOAD) {
      expect(OPERATOR_DATA, item).not.toContain(item);
    }
  });

  it('protects everything beneath an operator path, not just the path itself', () => {
    expect(isProtectedPath('server/uploads')).toBe(true);
    expect(isProtectedPath('server/uploads/booking-proofs/proof-1.png')).toBe(true);
    expect(isProtectedPath('server/uploads/issue-photos/x.jpg')).toBe(true);
    expect(isProtectedPath('.env')).toBe(true);
  });

  it('tolerates Windows separators and leading ./', () => {
    expect(isProtectedPath('server\\uploads\\booking-proofs\\a.png')).toBe(true);
    expect(isProtectedPath('./.env')).toBe(true);
  });

  it('does not protect the application files', () => {
    expect(isProtectedPath('server/dist/index.js')).toBe(false);
    expect(isProtectedPath('node_modules/express/index.js')).toBe(false);
    expect(isProtectedPath('client/dist/index.html')).toBe(false);
  });

  it('does not protect a path that merely starts with the same letters', () => {
    // "server/uploads-old" is not inside "server/uploads".
    expect(isProtectedPath('server/uploads-old/x.png')).toBe(false);
    expect(isProtectedPath('.environment')).toBe(false);
  });
});

/* ================================================================== */
/* Uninstall                                                           */
/* ================================================================== */
describe('uninstall', () => {
  it('keeps operator data by default', () => {
    const targets = uninstallTargets(false);
    for (const kept of OPERATOR_DATA) expect(targets).not.toContain(kept);
    expect(targets).toEqual(RELEASE_PAYLOAD);
  });

  it('removes operator data only when explicitly asked', () => {
    const targets = uninstallTargets(true);
    for (const item of [...RELEASE_PAYLOAD, ...OPERATOR_DATA]) expect(targets).toContain(item);
  });

  it('never lists the database, a dump, or the backup directory', () => {
    // The database lives in PostgreSQL, outside the install directory, and the
    // backups are the last line of defence. Neither may be reachable from an
    // uninstall under any flag.
    //
    // Checked per-target rather than against the joined string: `KasBackup.cmd`
    // is APPLICATION code whose name contains the word "backup", and an
    // uninstall removing it is correct. What must never appear is a path that
    // IS backup data — the directory itself, or a dump file.
    for (const purge of [false, true]) {
      for (const target of uninstallTargets(purge)) {
        const lower = target.toLowerCase();
        expect(lower, target).not.toContain('postgres');
        expect(lower.endsWith('.sql') || lower.endsWith('.dump'), target).toBe(false);
        // The backup ROOT, with or without a trailing separator — but not a
        // file that merely mentions it.
        expect(/^backups?([\\/]|$)/.test(lower), target).toBe(false);
      }
    }
  });
});

/* ================================================================== */
/* Prerequisites, checked before anything is classified                */
/* ================================================================== */
describe('prerequisites', () => {
  it('refuses when Node is absent', () => {
    expect(decideInstall(ready({ nodeMajor: null }))).toEqual({
      kind: 'ABORT',
      problem: 'NODE_MISSING',
    });
  });

  it('refuses an unsupported Node', () => {
    expect(decideInstall(ready({ nodeMajor: MIN_NODE_MAJOR - 1 }))).toEqual({
      kind: 'ABORT',
      problem: 'NODE_TOO_OLD',
    });
  });

  it('refuses an incomplete download', () => {
    expect(decideInstall(ready({ payloadComplete: false })).kind).toBe('ABORT');
  });

  it('refuses a directory it cannot write to', () => {
    expect(decideInstall(ready({ targetWritable: false }))).toEqual({
      kind: 'ABORT',
      problem: 'TARGET_NOT_WRITABLE',
    });
  });

  it('refuses a folder that belongs to something else', () => {
    // This is what stops an install into Documents from later being
    // uninstalled and taking the contents with it.
    expect(decideInstall(ready({ targetOccupiedByOther: true }))).toEqual({
      kind: 'ABORT',
      problem: 'TARGET_OCCUPIED_BY_OTHER',
    });
  });

  it('checks prerequisites before classifying an upgrade', () => {
    // Telling the operator "upgrading from 1.1.0" and only then discovering
    // Node is missing promises something the installer cannot deliver.
    const action = decideInstall(
      ready({ nodeMajor: null, existingInstall: true, existingVersion: '1.1.0' }),
    );
    expect(action).toEqual({ kind: 'ABORT', problem: 'NODE_MISSING' });
  });

  it('allows an existing Kas folder — that is an upgrade, not an obstruction', () => {
    const action = decideInstall(
      ready({ existingInstall: true, existingVersion: '1.1.0', targetOccupiedByOther: false }),
    );
    expect(action.kind).toBe('UPGRADE');
  });
});

/* ================================================================== */
/* Shortcuts                                                           */
/* ================================================================== */
describe('shortcuts', () => {
  it('creates one on the Desktop and one in the Start Menu', () => {
    const specs = shortcutSpecs();
    expect(specs.map((s) => s.location).sort()).toEqual(['Desktop', 'StartMenu']);
  });

  it('points at the launcher, never at node or a URL', () => {
    // A URL shortcut would open a browser at a server that is not running;
    // the launcher starts it first and opens localhost, which is what keeps
    // the app installable as a PWA.
    for (const spec of shortcutSpecs()) {
      expect(spec.target).toBe('Kas.cmd');
      expect(spec.target).not.toContain('http');
      expect(spec.target).not.toContain('node');
    }
  });

  it('uses the application icon that ships with the client build', () => {
    for (const spec of shortcutSpecs()) {
      expect(spec.iconRelativePath).toBe('client/dist/favicon.ico');
    }
  });
});

/* ================================================================== */
/* What the operator is told                                           */
/* ================================================================== */
describe('the messages', () => {
  it('names where to get Node when it is missing', () => {
    expect(installProblemMessage('NODE_MISSING', ready({ nodeMajor: null }))).toContain('nodejs.org');
  });

  it('names the directory it could not write to', () => {
    const env = ready({ targetWritable: false });
    const message = installProblemMessage('TARGET_NOT_WRITABLE', env);
    expect(message).toContain(env.targetDir);
    expect(message).toContain('Administrator');
  });

  it('states that the database is untouched, every time', () => {
    // The assurance an operator most needs before running an upgrade.
    for (const existing of [null, '1.1.0']) {
      const env = ready({ existingInstall: existing !== null, existingVersion: existing });
      const lines = describeInstall(decideInstall(env), env).join('\n');
      expect(lines).toContain('Cơ sở dữ liệu');
      expect(lines).toContain('không bị thay đổi');
    }
  });

  it('says what will be preserved on an upgrade', () => {
    const env = ready({ existingInstall: true, existingVersion: '1.1.0' });
    const lines = describeInstall(decideInstall(env), env).join('\n');
    expect(lines).toContain('nâng cấp');
    expect(lines).toContain('1.1.0');
    expect(lines).toContain('.env');
  });

  it('reports only the failure when it cannot proceed', () => {
    const env = ready({ nodeMajor: null });
    const lines = describeInstall(decideInstall(env), env);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('KHÔNG THỂ CÀI ĐẶT');
  });

  it('never prints anything resembling a connection string', () => {
    const problems = [
      'NODE_MISSING',
      'NODE_TOO_OLD',
      'TARGET_NOT_WRITABLE',
      'PAYLOAD_INCOMPLETE',
      'TARGET_OCCUPIED_BY_OTHER',
    ] as const;
    for (const problem of problems) {
      const message = installProblemMessage(problem, ready());
      expect(message, problem).not.toContain('postgresql://');
      expect(message, problem).not.toMatch(/:\/\/[^\s]*:[^\s]*@/);
    }
  });
});

/* ================================================================== */
/* Phase 6.3a — starting with Windows                                  */
/* ================================================================== */
describe('the boot task', () => {
  it('runs the background entry point, not the interactive one', () => {
    // Kas.cmd opens a browser and holds a console window. Running THAT at boot
    // would put a browser on an unattended machine and leave a console open.
    expect(scheduledTaskSpec().target).toBe('KasService.cmd');
  });

  it('starts at boot rather than at logon', () => {
    // A logon trigger would leave the hotel waiting for someone to sign in
    // before any branch could receive a dispatch.
    expect(scheduledTaskSpec().trigger).toBe('AtStartup');
    expect(scheduledTaskSpec().runWhetherLoggedOnOrNot).toBe(true);
  });

  it('runs as SYSTEM, so no operator password is stored anywhere', () => {
    expect(scheduledTaskSpec().runAsAccount).toBe('SYSTEM');
  });

  it('has no execution time limit', () => {
    // The Windows default of 72 hours would stop a healthy server every three
    // days, at whatever hour it happened to have started.
    expect(scheduledTaskSpec().executionTimeLimit).toBe('PT0S');
  });

  it('ships the file the task points at', () => {
    // A task registered against a file the installer never copies is a boot
    // failure that only appears after the next restart.
    expect(RELEASE_PAYLOAD).toContain(scheduledTaskSpec().target);
  });

  it('keeps the background entry point out of operator data', () => {
    // It is application code: an upgrade must replace it.
    expect(OPERATOR_DATA).not.toContain('KasService.cmd');
  });

  it('removes it on uninstall along with the rest of the payload', () => {
    expect(uninstallTargets(false)).toContain('KasService.cmd');
  });

  it('names the task the same way everywhere', () => {
    expect(scheduledTaskSpec().name).toBe(SCHEDULED_TASK_NAME);
  });
});

/* ================================================================== */
/* The packager and the plan must not drift                            */
/* ================================================================== */
describe('the release packager ships what the plan declares', () => {
  const packager = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'scripts', 'production', 'windows', 'Package-Kas.ps1'),
    'utf8',
  );

  it.each([...RELEASE_PAYLOAD])('copies %s into the release', (item) => {
    // THE BUG THIS CATCHES, found by installing into a throwaway directory and
    // listing what arrived: KasService.cmd and KasBackup.cmd were absent from
    // the packager while the installer already registered Scheduled Tasks
    // pointing at them. On an elevated install both tasks would have referenced
    // files that were never copied — no boot start, no nightly backup, and no
    // error until the machine was next restarted.
    //
    // The PowerShell script writes Windows separators; the plan uses forward
    // slashes. Compare on a normalised form so the two can be kept in step.
    // node_modules is the one item the packager PRODUCES rather than copies:
    // it runs `npm ci --omit=dev` in the staging directory, so the release gets
    // production dependencies instead of whatever the developer had installed.
    if (item === 'node_modules') {
      expect(packager).toContain('--omit=dev');
      return;
    }

    const windowsPath = item.split('/').join('\\');
    expect(
      packager.includes(`'${windowsPath}'`) || packager.includes(`'${item}'`),
      `${item} is in RELEASE_PAYLOAD but Package-Kas.ps1 never copies it`,
    ).toBe(true);
  });
});

/* ================================================================== */
/* Phase 6.4 — the backups, held apart from everything else            */
/* ================================================================== */
describe('backups', () => {
  it('are preserved by an upgrade, by declaration rather than by omission', () => {
    // Until 6.4 the backup directory appeared in neither list. It survived an
    // upgrade because nothing happened to mention it — which is one refactor
    // away from not surviving.
    const action = proceeding(decideInstall(ready({ existingInstall: true, existingVersion: '1.1.0' })));
    expect(action.preserve).toContain('backups');
  });

  it('are protected from the payload replacement', () => {
    expect(isProtectedPath('backups')).toBe(true);
    expect(isProtectedPath('backups/backup-20260805T2200/database.dump')).toBe(true);
    expect(isProtectedPath(['backups', 'backup-20260805T2200', 'manifest.json'].join('\\'))).toBe(true);
  });

  it('survive an uninstall that purges operator data', () => {
    // THE PROPERTY. -PurgeData removes configuration and proof images, both of
    // which a backup can restore. The backups are what remain when nothing
    // else does, so a flag about "data" must not take them.
    expect(uninstallTargets(true)).not.toContain('backups');
  });

  it('are removed only by their own explicit flag', () => {
    expect(uninstallTargets(false, true)).toContain('backups');
    expect(uninstallTargets(false, false)).not.toContain('backups');
  });

  it('can be removed together with everything else when both are asked for', () => {
    const targets = uninstallTargets(true, true);
    for (const item of [...RELEASE_PAYLOAD, ...OPERATOR_DATA, ...BACKUP_DATA]) {
      expect(targets, item).toContain(item);
    }
  });

  it('are never in the payload the installer replaces', () => {
    for (const item of BACKUP_DATA) expect(RELEASE_PAYLOAD, item).not.toContain(item);
  });
});

/* ================================================================== */
/* Phase 6.4 — folders the installer creates                           */
/* ================================================================== */
describe('created folders', () => {
  it('covers logs, backups and both upload directories', () => {
    expect(CREATED_DIRECTORIES).toContain('logs');
    expect(CREATED_DIRECTORIES).toContain('backups');
    expect(CREATED_DIRECTORIES).toContain('server/uploads/booking-proofs');
    expect(CREATED_DIRECTORIES).toContain('server/uploads/issue-photos');
  });

  it('creates only paths that are protected from an upgrade', () => {
    // A directory the installer creates and then replaces on the next upgrade
    // would silently discard whatever the hotel had put in it.
    for (const dir of CREATED_DIRECTORIES) {
      expect(isProtectedPath(dir), dir).toBe(true);
    }
  });
});

/* ================================================================== */
/* Phase 6.4 — machine prerequisites                                   */
/* ================================================================== */
describe('machine prerequisites', () => {
  it('refuses Windows older than 10', () => {
    expect(decideInstall(ready({ windowsMajor: 6 }))).toEqual({
      kind: 'ABORT',
      problem: 'WINDOWS_TOO_OLD',
    });
  });

  it('accepts Windows 10 and later', () => {
    for (const major of [MIN_WINDOWS_MAJOR, 11]) {
      expect(decideInstall(ready({ windowsMajor: major })).kind, String(major)).not.toBe('ABORT');
    }
  });

  it('refuses a disk that cannot hold the install', () => {
    expect(decideInstall(ready({ freeDiskBytes: MIN_INSTALL_DISK_BYTES - 1 }))).toEqual({
      kind: 'ABORT',
      problem: 'NOT_ENOUGH_DISK',
    });
  });

  it('accepts exactly the required amount', () => {
    expect(decideInstall(ready({ freeDiskBytes: MIN_INSTALL_DISK_BYTES })).kind).not.toBe('ABORT');
  });

  it('never refuses because a measurement could not be taken', () => {
    // An unreadable version or free-space figure is not a bad one. Refusing
    // there would block an install on a working machine.
    expect(decideInstall(ready({ windowsMajor: null, freeDiskBytes: null })).kind).toBe('FRESH');
  });

  it('checks the platform before the payload', () => {
    // Telling someone their download is incomplete, when the real problem is
    // that Kas will not run on their Windows at all, sends them to re-download
    // 300 MB for nothing.
    const action = decideInstall(ready({ windowsMajor: 6, payloadComplete: false }));
    expect(action).toMatchObject({ problem: 'WINDOWS_TOO_OLD' });
  });

  it('names the remedy for each new refusal', () => {
    expect(installProblemMessage('WINDOWS_TOO_OLD', ready({ windowsMajor: 6 }))).toContain('Windows 10');
    const disk = installProblemMessage('NOT_ENOUGH_DISK', ready({ freeDiskBytes: 1024 }));
    expect(disk).toContain('giải phóng');
    expect(disk).toContain('1024');
  });
});

/* ================================================================== */
/* Phase 6.4 — a busy port warns, never blocks                         */
/* ================================================================== */
describe('the port', () => {
  it('does not stop an install', () => {
    // Nothing is being started yet, and the operator may be about to stop
    // whatever holds it. An installer that refused over a running program
    // would be an odd thing.
    expect(decideInstall(ready({ portInUse: true })).kind).toBe('FRESH');
  });

  it('is reported before the install rather than at the first failed start', () => {
    const env = ready({ portInUse: true, port: 3001 });
    const lines = describeInstall(decideInstall(env), env).join('\n');
    expect(lines).toContain('CẢNH BÁO');
    expect(lines).toContain('3001');
    expect(lines).toContain('PORT');
  });

  it('says nothing when the port is free', () => {
    const env = ready();
    expect(describeInstall(decideInstall(env), env).join('\n')).not.toContain('CẢNH BÁO');
  });
});

/* ================================================================== */
/* Recognising an install that predates kas-release.json               */
/* ================================================================== */
describe('recognising an existing Kas installation', () => {
  const none: InstallMarkers = {
    releaseMetadata: false,
    packageName: null,
    serverBuild: false,
    clientBuild: false,
    prismaSchema: false,
    launcher: false,
    operatorData: false,
  };

  it('recognises a modern install by its release metadata', () => {
    expect(isKasInstallation({ ...none, releaseMetadata: true })).toBe(true);
  });

  it('recognises a LEGACY install with no release metadata', () => {
    // THE BUG THIS FIXES. kas-release.json only appeared in Phase 6.3, so the
    // hotel's own installation was classified as a foreign folder and refused
    // — the one directory that must never be treated as a stranger.
    const legacy: InstallMarkers = {
      ...none,
      packageName: KAS_PACKAGE_NAME,
      serverBuild: true,
      clientBuild: true,
      prismaSchema: true,
      operatorData: true,
    };
    expect(isKasInstallation(legacy)).toBe(true);
  });

  it('recognises it by package name alone', () => {
    expect(isKasInstallation({ ...none, packageName: KAS_PACKAGE_NAME })).toBe(true);
  });

  it('recognises it by two structural markers alone', () => {
    // A stripped install whose package.json was replaced or removed.
    expect(isKasInstallation({ ...none, serverBuild: true, prismaSchema: true })).toBe(true);
    expect(isKasInstallation({ ...none, clientBuild: true, operatorData: true })).toBe(true);
  });

  it('still refuses a folder holding somebody else’s work', () => {
    // The check being relaxed exists to stop an install into Documents from
    // later being uninstalled and taking the contents with it.
    expect(isKasInstallation({ ...none, packageName: 'some-other-app' })).toBe(false);
    expect(isKasInstallation(none)).toBe(false);
  });

  it('needs TWO structural markers, never one', () => {
    // Any single one can occur innocently — a stray prisma folder, an
    // unrelated client/dist. Two together in one directory do not.
    for (const single of ['serverBuild', 'clientBuild', 'prismaSchema', 'launcher', 'operatorData'] as const) {
      expect(isKasInstallation({ ...none, [single]: true }), single).toBe(false);
    }
  });

  it('is not fooled by a Node project that merely has a package.json', () => {
    expect(isKasInstallation({ ...none, packageName: 'express-demo' })).toBe(false);
  });

  it('classifies a recognised legacy install as an UPGRADE, preserving data', () => {
    // No recorded version, so it cannot be a REPAIR — and every operator path
    // is preserved, which is the whole point of getting this classification
    // right rather than aborting.
    const action = proceeding(
      decideInstall(ready({ existingInstall: true, existingVersion: null, incomingVersion: '0.1.0' })),
    );
    expect(action.kind).toBe('UPGRADE');
    expect(action.preserve).toEqual(PRESERVED_ON_UPGRADE);
    expect(action.preserve).toContain('.env');
    expect(action.preserve).toContain('server/uploads');
    expect(action.preserve).toContain('backups');
  });
});

/* ================================================================== */
/* The release ships the autostart helper                              */
/* ================================================================== */
describe('the packager ships what a deployment needs', () => {
  const packager = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'scripts', 'production', 'windows', 'Package-Kas.ps1'),
    'utf8',
  );

  it('includes the autostart script an operator runs after a non-elevated install', () => {
    // The installer skips task registration without Administrator, so this is
    // the recovery path. A release without it leaves the operator with a
    // machine that never starts Kas after a reboot and nothing to run.
    expect(packager).toContain('Enable-KasAutostart.ps1');
    expect(packager).toContain('Enable-KasAutostart.cmd');
  });

  it('puts the .cmd at the top of the release, not in a subfolder', () => {
    // Something you have to go looking for in a subfolder is something that
    // does not get run.
    expect(packager).toMatch(/Enable-KasAutostart\.cmd'\)\s*\(Join-Path \$stage/);
  });

  it('is reachable through one documented npm command', () => {
    const scripts = (
      JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
      ) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.release).toContain('Package-Kas.ps1');
  });
});

/* ================================================================== */
/* Scheduled task registration                                         */
/* ================================================================== */
describe('the autostart tasks are registered with a command that Windows accepts', () => {
  const windows = (name: string): string =>
    fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'scripts', 'production', 'windows', name),
      'utf8',
    );

  /** Comments explain the bug by quoting it; only real statements are pinned. */
  const statements = (text: string): string =>
    text
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

  const autostart = windows('Enable-KasAutostart.ps1');
  const installer = windows('Install-Kas.ps1');

  it('never calls schtasks /Change /ET, which registration died on', () => {
    // `/ET` is the TRIGGER'S END BOUNDARY, not the execution time limit it was
    // reached for. `schtasks /Change /TN 'Kas Backup' /ET 02:00` asked for a
    // trigger starting at 22:00 and expiring at 02:00 the same day, and Windows
    // answered:
    //
    //   ERROR: The task XML contains a value which is incorrectly formatted or
    //   out of range.
    //   (11,42):EndBoundary:2026-08-06T02:00:00
    //
    // Reproduced on a live machine. The registration failed and the backup task
    // was never created.
    for (const script of [statements(autostart), statements(installer)]) {
      expect(script).not.toMatch(/schtasks[^\n]*\/ET\b/);
    }
  });

  it('sets the execution limit where it can actually be named', () => {
    // ExecutionTimeLimit cannot be set from the schtasks command line under any
    // spelling — which is why the wrong knob got turned. PT0S is "no limit",
    // and without it the default PT72H stops a healthy server every three days.
    expect(autostart).toContain('Register-ScheduledTask');
    expect(autostart).toContain('-ExecutionTimeLimit');
    expect(autostart).toMatch(/TimeSpan\]::Zero/);
  });

  it('runs both tasks as SYSTEM, so they start before anyone logs in', () => {
    expect(autostart).toMatch(/-UserId 'SYSTEM'/);
    expect(autostart).toContain('-LogonType ServiceAccount');
  });

  it('registers from ONE place — the installer delegates instead of copying', () => {
    // The bug existed twice because the registration was written twice. The
    // installer must call the script, not restate it.
    expect(installer).toContain('Enable-KasAutostart.ps1');
    expect(statements(installer)).not.toMatch(/schtasks[^\n]*\/Create/);
  });

  it('reads the tasks back from Windows instead of trusting the call', () => {
    // The old code checked only the /Create exit code and printed [OK] over a
    // /Change that Windows had just rejected.
    expect(autostart).toContain('Get-ScheduledTask');
  });
});
