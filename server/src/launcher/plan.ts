/**
 * What the Windows launcher should do, decided as pure data.
 *
 * WHY THIS IS SEPARATE FROM THE LAUNCHER ITSELF. Spawning processes, probing
 * ports and opening browsers cannot be unit tested without becoming a mock
 * exercise that proves nothing. The decisions can: which URL to open, whether a
 * second instance would be a duplicate, and which missing prerequisite to
 * report first. Those are the parts that would actually go wrong, so they live
 * here as functions over plain values, and the imperative shell in `cli.ts`
 * does nothing but carry them out.
 *
 * THE RULE THAT MATTERS MOST: the launcher always opens `localhost`, never the
 * machine's LAN address. Chrome and Edge only allow installation on a secure
 * context, and `http://192.168.x.x:3001` is not one — that is the entire reason
 * Phase 6.2 exists. `http://localhost:3001` is the documented exception, and it
 * reaches the same server, which already binds 0.0.0.0.
 */

/** Node versions the repository declares support for (`engines` in package.json). */
export const MIN_NODE_MAJOR = 22;

/** Everything the decision depends on, gathered by the caller. */
export interface LauncherEnvironment {
  /** Major version of the Node running the launcher. */
  nodeMajor: number;
  port: number;
  /** `server/dist/index.js` exists — the API has been built. */
  serverBuildPresent: boolean;
  /** `client/dist/index.html` exists — the SPA has been built. */
  clientBuildPresent: boolean;
  /** Something is listening on the port. */
  portInUse: boolean;
  /** That something answered the Kas health endpoint. */
  portServesKas: boolean;
  /** A database URL is configured. The VALUE is never read here. */
  databaseUrlConfigured: boolean;
  /**
   * The proof-image directory exists and accepts a write.
   *
   * Checked BEFORE starting rather than discovered when a receptionist uploads
   * the only evidence that a reservation was created correctly. A read-only or
   * missing uploads directory is a silent failure the rest of the way down.
   */
  uploadDirWritable: boolean;
  /**
   * The log directory accepts a write.
   *
   * A run whose logs cannot be written still works, but every diagnostic this
   * phase adds would be invisible — including the reason a later failure
   * happened. Reported as a problem so the operator fixes it now.
   */
  logDirWritable: boolean;
}

export type LauncherProblem =
  | 'NODE_TOO_OLD'
  | 'MISSING_DATABASE_URL'
  | 'MISSING_SERVER_BUILD'
  | 'MISSING_CLIENT_BUILD'
  | 'UPLOAD_DIR_NOT_WRITABLE'
  | 'LOG_DIR_NOT_WRITABLE'
  | 'PORT_TAKEN_BY_OTHER';

export type LauncherAction =
  /** Kas is already running: open the browser at it and start nothing. */
  | { kind: 'ATTACH'; url: string }
  /** Start the server, wait for health, then open the browser. */
  | { kind: 'START'; url: string }
  /** Cannot proceed; `problem` says which prerequisite is missing. */
  | { kind: 'ABORT'; problem: LauncherProblem };

/**
 * The address to open. Always loopback.
 *
 * Never the LAN IP, and never a hostname that resolves to one: an operator who
 * opens the LAN address gets a working app with no install option and no
 * service worker, which is the exact confusion this phase removes.
 */
export function appUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Decides what to do, in the order the operator can act on.
 *
 * A running instance wins over every other check. If Kas is already answering
 * on the port then the build obviously exists and the database is obviously
 * reachable — re-reporting those as problems would be noise, and starting a
 * second process would only produce an EADDRINUSE crash a moment later.
 *
 * After that the checks run cheapest-cause-first: an old Node explains every
 * later failure, a missing DATABASE_URL explains a server that starts and
 * immediately exits, and a missing build explains both.
 */
export function decideAction(env: LauncherEnvironment): LauncherAction {
  const url = appUrl(env.port);

  // Duplicate-instance prevention.
  if (env.portServesKas) return { kind: 'ATTACH', url };

  if (env.nodeMajor < MIN_NODE_MAJOR) return { kind: 'ABORT', problem: 'NODE_TOO_OLD' };
  if (!env.databaseUrlConfigured) return { kind: 'ABORT', problem: 'MISSING_DATABASE_URL' };
  if (!env.serverBuildPresent) return { kind: 'ABORT', problem: 'MISSING_SERVER_BUILD' };
  // Without the SPA the server serves the API alone: no app to open, and
  // nothing installable — which is the whole point of launching it this way.
  if (!env.clientBuildPresent) return { kind: 'ABORT', problem: 'MISSING_CLIENT_BUILD' };
  // Writable storage before the port: a server that starts and then cannot
  // store a proof image has failed in a way nobody notices until the evidence
  // is needed.
  if (!env.uploadDirWritable) return { kind: 'ABORT', problem: 'UPLOAD_DIR_NOT_WRITABLE' };
  if (!env.logDirWritable) return { kind: 'ABORT', problem: 'LOG_DIR_NOT_WRITABLE' };
  // Occupied, but not by Kas. Starting would fail with EADDRINUSE and the
  // operator would be left reading a stack trace.
  if (env.portInUse) return { kind: 'ABORT', problem: 'PORT_TAKEN_BY_OTHER' };

  return { kind: 'START', url };
}

/**
 * What to print when a prerequisite is missing.
 *
 * Every message names the command that fixes it. A diagnostic that only states
 * what is wrong leaves the operator to search the documentation; one that
 * states the remedy ends the incident.
 */
export function problemMessage(problem: LauncherProblem, env: LauncherEnvironment): string {
  switch (problem) {
    case 'NODE_TOO_OLD':
      return (
        `Node.js quá cũ: đang dùng phiên bản ${env.nodeMajor}, cần tối thiểu ${MIN_NODE_MAJOR}. ` +
        'Cài đặt Node.js LTS từ https://nodejs.org rồi chạy lại.'
      );
    case 'MISSING_DATABASE_URL':
      // The value is never read, printed or logged — only its presence.
      return (
        'Chưa cấu hình DATABASE_URL. Tạo tệp .env ở thư mục gốc của Kas ' +
        'theo hướng dẫn trong docs/deployment.md rồi chạy lại.'
      );
    case 'MISSING_SERVER_BUILD':
      return 'Chưa build máy chủ. Mở PowerShell tại thư mục Kas và chạy: npm run build';
    case 'MISSING_CLIENT_BUILD':
      return (
        'Chưa build giao diện — máy chủ sẽ chỉ phục vụ API và không mở được ứng dụng. ' +
        'Chạy: npm run build'
      );
    case 'UPLOAD_DIR_NOT_WRITABLE':
      return (
        'Không ghi được vào thư mục ảnh xác nhận (server/uploads). Kas vẫn chạy được ' +
        'nhưng lễ tân sẽ KHÔNG gửi được ảnh tạo đơn. Hãy kiểm tra quyền ghi của thư mục ' +
        'cài đặt rồi chạy lại.'
      );
    case 'LOG_DIR_NOT_WRITABLE':
      return (
        'Không ghi được vào thư mục nhật ký (logs). Ứng dụng sẽ chạy nhưng mọi chẩn đoán ' +
        'sẽ không được lưu lại. Hãy kiểm tra quyền ghi của thư mục cài đặt rồi chạy lại.'
      );
    case 'PORT_TAKEN_BY_OTHER':
      return (
        `Cổng ${env.port} đang bị một chương trình khác chiếm giữ (không phải Kas). ` +
        'Hãy đóng chương trình đó, hoặc đặt PORT khác trong .env, rồi chạy lại.'
      );
  }
}

/** One line per check, for the startup log and the console. */
export function describeEnvironment(env: LauncherEnvironment): string[] {
  return [
    `Node.js         : v${env.nodeMajor} (cần >= ${MIN_NODE_MAJOR})`,
    `Cổng            : ${env.port}`,
    `Build máy chủ   : ${env.serverBuildPresent ? 'có' : 'THIẾU'}`,
    `Build giao diện : ${env.clientBuildPresent ? 'có' : 'THIẾU'}`,
    // Presence only. The connection string is a secret and never appears here.
    `DATABASE_URL    : ${env.databaseUrlConfigured ? 'đã cấu hình' : 'CHƯA cấu hình'}`,
    `Thư mục ảnh     : ${env.uploadDirWritable ? 'ghi được' : 'KHÔNG ghi được'}`,
    `Thư mục nhật ký : ${env.logDirWritable ? 'ghi được' : 'KHÔNG ghi được'}`,
    `Cổng đang mở    : ${env.portInUse ? 'có' : 'không'}`,
    `Kas đang chạy   : ${env.portServesKas ? 'có' : 'không'}`,
  ];
}
