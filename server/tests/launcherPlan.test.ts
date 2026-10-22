/**
 * What the Windows launcher decides.
 *
 * THE RULE THIS FILE EXISTS TO PROTECT: the launcher opens `localhost`, never
 * the machine's LAN address. Chrome and Edge only permit installation on a
 * secure context, and `http://192.168.x.x:3001` is not one — an operator sent
 * there gets a working app with no install option and no service worker, which
 * is the entire problem Phase 6.2 removes. If a future change makes the
 * launcher prefer a "more useful" reachable address, this is what fails.
 *
 * The second property is that a second launch never starts a second server.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_NODE_MAJOR,
  appUrl,
  decideAction,
  describeEnvironment,
  problemMessage,
  type LauncherEnvironment,
} from '../src/launcher/plan';

/** A machine where everything is ready and Kas is not yet running. */
const ready = (over: Partial<LauncherEnvironment> = {}): LauncherEnvironment => ({
  nodeMajor: MIN_NODE_MAJOR,
  port: 3001,
  serverBuildPresent: true,
  clientBuildPresent: true,
  portInUse: false,
  portServesKas: false,
  databaseUrlConfigured: true,
  uploadDirWritable: true,
  logDirWritable: true,
  ...over,
});

/* ================================================================== */
/* The URL — the reason this phase exists                              */
/* ================================================================== */
describe('the address the launcher opens', () => {
  it('is always loopback', () => {
    expect(appUrl(3001)).toBe('http://localhost:3001');
  });

  it('honours a configured port', () => {
    expect(appUrl(8080)).toBe('http://localhost:8080');
  });

  it('never produces a LAN address', () => {
    // A LAN origin is not a secure context, so no service worker and no
    // install prompt — the exact failure this launcher exists to avoid.
    for (const port of [3001, 5173, 8080]) {
      const url = appUrl(port);
      expect(url.startsWith('http://localhost:')).toBe(true);
      expect(url).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    }
  });

  it('uses the same address whether starting or attaching', () => {
    const started = decideAction(ready());
    const attached = decideAction(ready({ portServesKas: true, portInUse: true }));
    expect(started.kind).toBe('START');
    expect(attached.kind).toBe('ATTACH');
    expect((started as { url: string }).url).toBe((attached as { url: string }).url);
  });
});

/* ================================================================== */
/* Duplicate prevention                                                */
/* ================================================================== */
describe('a second launch', () => {
  it('attaches to the running instance instead of starting another', () => {
    const action = decideAction(ready({ portServesKas: true, portInUse: true }));
    expect(action).toEqual({ kind: 'ATTACH', url: 'http://localhost:3001' });
  });

  it('attaches even when other checks would have failed', () => {
    // Kas is answering, so the build exists and the database is reachable by
    // definition. Reporting them as problems would be noise, and starting a
    // second process would just crash with EADDRINUSE.
    const action = decideAction(
      ready({
        portServesKas: true,
        portInUse: true,
        serverBuildPresent: false,
        clientBuildPresent: false,
        databaseUrlConfigured: false,
      }),
    );
    expect(action.kind).toBe('ATTACH');
  });

  it('does not attach to a foreign program on the port', () => {
    // Occupied, but it did not answer as Kas.
    const action = decideAction(ready({ portInUse: true, portServesKas: false }));
    expect(action).toEqual({ kind: 'ABORT', problem: 'PORT_TAKEN_BY_OTHER' });
  });
});

/* ================================================================== */
/* Diagnostics, in the order an operator can act on                    */
/* ================================================================== */
describe('startup diagnostics', () => {
  it('starts normally when every prerequisite is met', () => {
    expect(decideAction(ready())).toEqual({ kind: 'START', url: 'http://localhost:3001' });
  });

  it('refuses an unsupported Node before anything else', () => {
    // An old Node explains every later failure, so it is reported first.
    const action = decideAction(
      ready({ nodeMajor: MIN_NODE_MAJOR - 1, serverBuildPresent: false }),
    );
    expect(action).toEqual({ kind: 'ABORT', problem: 'NODE_TOO_OLD' });
  });

  it('reports a missing DATABASE_URL before a missing build', () => {
    // Without it the server starts and exits immediately; the build is a
    // downstream symptom of a machine that was never configured.
    const action = decideAction(ready({ databaseUrlConfigured: false, serverBuildPresent: false }));
    expect(action).toEqual({ kind: 'ABORT', problem: 'MISSING_DATABASE_URL' });
  });

  it('refuses when the server has not been built', () => {
    expect(decideAction(ready({ serverBuildPresent: false }))).toEqual({
      kind: 'ABORT',
      problem: 'MISSING_SERVER_BUILD',
    });
  });

  it('refuses when only the UI is missing', () => {
    // The API alone would start happily and serve nothing an operator can use.
    expect(decideAction(ready({ clientBuildPresent: false }))).toEqual({
      kind: 'ABORT',
      problem: 'MISSING_CLIENT_BUILD',
    });
  });

  it('accepts a Node newer than the minimum', () => {
    expect(decideAction(ready({ nodeMajor: MIN_NODE_MAJOR + 2 })).kind).toBe('START');
  });
});

/* ================================================================== */
/* What the operator is told                                           */
/* ================================================================== */
describe('the messages', () => {
  it('names the command that fixes a missing build', () => {
    expect(problemMessage('MISSING_SERVER_BUILD', ready())).toContain('npm run build');
    expect(problemMessage('MISSING_CLIENT_BUILD', ready())).toContain('npm run build');
  });

  it('names the required Node version and where to get it', () => {
    const message = problemMessage('NODE_TOO_OLD', ready({ nodeMajor: 18 }));
    expect(message).toContain('18');
    expect(message).toContain(String(MIN_NODE_MAJOR));
    expect(message).toContain('nodejs.org');
  });

  it('points at the configuration file rather than the secret', () => {
    const message = problemMessage('MISSING_DATABASE_URL', ready());
    expect(message).toContain('.env');
    expect(message).toContain('DATABASE_URL');
  });

  it('names the blocked port and both ways out', () => {
    const message = problemMessage('PORT_TAKEN_BY_OTHER', ready({ port: 3001 }));
    expect(message).toContain('3001');
    expect(message).toContain('PORT');
  });

  it('says what an unwritable uploads directory costs, not just that it is unwritable', () => {
    // "Permission denied on server/uploads" means nothing to a hotel manager.
    // "Reception will not be able to send proof images" is actionable.
    const message = problemMessage('UPLOAD_DIR_NOT_WRITABLE', ready());
    expect(message).toContain('ảnh');
    expect(message).toContain('server/uploads');
  });

  it('says an unwritable log directory costs diagnostics, not the app', () => {
    expect(problemMessage('LOG_DIR_NOT_WRITABLE', ready())).toContain('logs');
  });
});

/* ================================================================== */
/* Phase 6.3a — storage is validated before the port                   */
/* ================================================================== */
describe('writable storage', () => {
  it('refuses to start when proof images cannot be written', () => {
    // The failure would otherwise surface as a receptionist unable to upload
    // the only evidence that a reservation was created correctly.
    expect(decideAction(ready({ uploadDirWritable: false }))).toEqual({
      kind: 'ABORT',
      problem: 'UPLOAD_DIR_NOT_WRITABLE',
    });
  });

  it('refuses to start when nothing can be logged', () => {
    expect(decideAction(ready({ logDirWritable: false }))).toEqual({
      kind: 'ABORT',
      problem: 'LOG_DIR_NOT_WRITABLE',
    });
  });

  it('reports storage before a busy port', () => {
    // A port conflict is the visible symptom; unwritable storage is the fault
    // that survives fixing it.
    const action = decideAction(ready({ uploadDirWritable: false, portInUse: true }));
    expect(action).toEqual({ kind: 'ABORT', problem: 'UPLOAD_DIR_NOT_WRITABLE' });
  });

  it('still attaches to a running Kas rather than auditing storage', () => {
    // Kas is answering, so it plainly can write. Re-reporting would be noise.
    expect(decideAction(ready({ portServesKas: true, uploadDirWritable: false })).kind).toBe('ATTACH');
  });
});

/* ================================================================== */
/* Secrets                                                             */
/* ================================================================== */
describe('nothing secret is ever printed', () => {
  it('reports only whether DATABASE_URL is configured', () => {
    const lines = describeEnvironment(ready()).join('\n');
    expect(lines).toContain('DATABASE_URL');
    expect(lines).toContain('đã cấu hình');
    // The shape of a real connection string must never appear.
    expect(lines).not.toContain('postgresql://');
    expect(lines).not.toContain('@');
  });

  it('carries no connection string in any problem message', () => {
    const problems = [
      'NODE_TOO_OLD',
      'MISSING_DATABASE_URL',
      'MISSING_SERVER_BUILD',
      'MISSING_CLIENT_BUILD',
      'UPLOAD_DIR_NOT_WRITABLE',
      'LOG_DIR_NOT_WRITABLE',
      'PORT_TAKEN_BY_OTHER',
    ] as const;
    for (const problem of problems) {
      const message = problemMessage(problem, ready());
      expect(message, problem).not.toContain('postgresql://');
      expect(message, problem).not.toMatch(/:\/\/[^\s]*:[^\s]*@/);
    }
  });

  it('describes every check it made, so the log explains itself', () => {
    const lines = describeEnvironment(ready({ portServesKas: true }));
    expect(lines).toHaveLength(9);
    expect(lines.join('\n')).toContain('Kas đang chạy   : có');
  });
});
