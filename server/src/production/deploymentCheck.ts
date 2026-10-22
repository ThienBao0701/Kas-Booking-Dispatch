/**
 * Is this machine actually able to run Kas, and is it doing so?
 *
 * Two audiences, one set of facts. Before an install, an operator wants to know
 * what will stop them. After an install, when a branch reports that "Kas isn't
 * working", somebody needs a single command that says which of a dozen things
 * is wrong. Both are the same question asked at different times, so they are
 * the same code — `gatherFacts` measures, and `evaluateDeployment` judges.
 *
 * THE SPLIT IS THE POINT. Measuring touches the filesystem, the network, the
 * database and Windows itself; none of that can be unit tested without becoming
 * a mock exercise. The JUDGEMENT — which failures are fatal, which are merely
 * worth knowing, and in which order to report them — is where this would
 * actually go wrong, and it is a pure function over plain values.
 *
 * NOTHING HERE MODIFIES ANYTHING. Diagnostics that repair things are how an
 * operator loses the evidence of what was broken.
 */
import type { VersionInfo } from './version';

export type Severity = 'PASS' | 'WARNING' | 'FAIL';

export interface CheckResult {
  name: string;
  severity: Severity;
  /** One line an operator can act on. Never a stack trace, never a secret. */
  detail: string;
}

/** Everything the judgement depends on, measured by the caller. */
export interface DeploymentFacts {
  nodeMajor: number;
  /** Windows release, e.g. "10.0.19045". Null when it could not be read. */
  windowsRelease: string | null;
  /** Whether this process is elevated. */
  administrator: boolean;
  databaseConnected: boolean;
  /** Whether migrations are fully applied. Null when it could not be asked. */
  migrationsApplied: boolean | null;
  serverBuildPresent: boolean;
  clientBuildPresent: boolean;
  uploadDirWritable: boolean;
  backupDirWritable: boolean;
  logDirWritable: boolean;
  /** The two Windows tasks 6.3a and 6.3b register. */
  startupTaskRegistered: boolean;
  backupTaskRegistered: boolean;
  freeDiskBytes: number | null;
  /** Something is listening on the configured port. */
  portInUse: boolean;
  /** /api/health answered 200 with the database connected. */
  healthOk: boolean;
  /** The app answered at all, even a 503. */
  healthAnswered: boolean;
  /**
   * Whether the origin is serving the BUILT client rather than a dev server.
   *
   * Null when it could not be asked (nothing is running). This exists because
   * an entire deployment once ran on the Vite dev server: everything worked,
   * because Vite proxies /api to the real backend, but the built manifest and
   * service worker were never served and the app was permanently
   * uninstallable. Health was 200 throughout. Nothing else here would have
   * caught it.
   */
  servedClientIsBuild: boolean | null;
  /** NODE_ENV as the running process sees it. */
  environment: string;
  /** Newest complete backup, ISO. Null when none exists. */
  lastBackupAt: string | null;
  /** Last line recorded in verification.log, if any. */
  lastVerification: string | null;
  port: number;
}

/** The lowest supported Node, matching `engines` in package.json. */
export const MIN_NODE_MAJOR = 22;
/** Windows 10 and Server 2016 both report major 10. */
export const MIN_WINDOWS_MAJOR = 10;
/** Below this, report the disk. Same threshold the runner's monitor uses. */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
/** A backup older than this is stale for a system backing up nightly. */
export const BACKUP_STALE_HOURS = 48;

export interface DeploymentReport {
  overall: Severity;
  checks: CheckResult[];
  /** PASS/WARNING/FAIL counts, for a one-line summary. */
  summary: { pass: number; warning: number; fail: number };
}

const pass = (name: string, detail: string): CheckResult => ({ name, severity: 'PASS', detail });
const warn = (name: string, detail: string): CheckResult => ({ name, severity: 'WARNING', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, severity: 'FAIL', detail });

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Turns measurements into a verdict.
 *
 * WHAT COUNTS AS FAIL is the whole design decision here. A FAIL means Kas
 * cannot serve a booking; a WARNING means it can, but something an operator
 * should know about is true. Administrator rights are the clearest example:
 * Kas installs and runs perfectly well without them — only the boot task needs
 * elevation — so reporting "not Administrator" as a failure would send someone
 * chasing a permission problem on a working system.
 */
export function evaluateDeployment(facts: DeploymentFacts, now: Date = new Date()): DeploymentReport {
  const checks: CheckResult[] = [];

  // --- The platform -------------------------------------------------------
  checks.push(
    facts.nodeMajor >= MIN_NODE_MAJOR
      ? pass('node', `Node.js v${facts.nodeMajor}.`)
      : fail('node', `Node.js v${facts.nodeMajor} quá cũ — cần tối thiểu v${MIN_NODE_MAJOR}.`),
  );

  const windowsMajor = Number.parseInt((facts.windowsRelease ?? '').split('.')[0] ?? '0', 10);
  checks.push(
    facts.windowsRelease === null
      ? warn('windows', 'Không đọc được phiên bản Windows.')
      : windowsMajor >= MIN_WINDOWS_MAJOR
        ? pass('windows', `Windows ${facts.windowsRelease}.`)
        : fail('windows', `Windows ${facts.windowsRelease} chưa được hỗ trợ (cần Windows 10 trở lên).`),
  );

  // Never a FAIL. Kas is a per-user install and runs without elevation; only
  // registering the boot task needs it.
  checks.push(
    facts.administrator
      ? pass('administrator', 'Đang chạy với quyền Administrator.')
      : warn(
          'administrator',
          'Không có quyền Administrator. Kas vẫn chạy bình thường; chỉ việc đăng ký ' +
            'khởi động cùng Windows là cần quyền này.',
        ),
  );

  // --- The build ----------------------------------------------------------
  checks.push(
    facts.serverBuildPresent
      ? pass('serverBuild', 'Đã build máy chủ.')
      : fail('serverBuild', 'Chưa build máy chủ. Chạy: npm run build'),
  );
  checks.push(
    facts.clientBuildPresent
      ? pass('clientBuild', 'Đã build giao diện.')
      : fail('clientBuild', 'Chưa build giao diện — sẽ không mở được ứng dụng. Chạy: npm run build'),
  );

  // --- Data ---------------------------------------------------------------
  checks.push(
    facts.databaseConnected
      ? pass('database', 'Kết nối được PostgreSQL.')
      : fail('database', 'Không kết nối được PostgreSQL. Kiểm tra dịch vụ postgresql trong services.msc.'),
  );
  checks.push(
    facts.migrationsApplied === null
      ? warn('migrations', 'Không kiểm tra được migration (cơ sở dữ liệu không phản hồi).')
      : facts.migrationsApplied
        ? pass('migrations', 'Schema đã được triển khai đầy đủ.')
        : fail('migrations', 'Schema chưa đầy đủ. Chạy: npm run db:migrate'),
  );

  // --- Storage ------------------------------------------------------------
  checks.push(
    facts.uploadDirWritable
      ? pass('uploads', 'Ghi được thư mục ảnh xác nhận.')
      : fail('uploads', 'Không ghi được thư mục ảnh xác nhận — lễ tân sẽ không gửi được ảnh tạo đơn.'),
  );
  checks.push(
    facts.logDirWritable
      ? pass('logs', 'Ghi được thư mục nhật ký.')
      : fail('logs', 'Không ghi được thư mục nhật ký — mọi chẩn đoán sẽ mất.'),
  );
  // The backup root is also where a restore writes its rollback point, so an
  // unwritable one means a restore has no way back.
  checks.push(
    facts.backupDirWritable
      ? pass('backups', 'Ghi được thư mục sao lưu (cũng là nơi lưu điểm hoàn tác khi khôi phục).')
      : fail('backups', 'Không ghi được thư mục sao lưu — không sao lưu được và khôi phục sẽ không có đường lùi.'),
  );

  checks.push(
    facts.freeDiskBytes === null
      ? warn('disk', 'Không đọc được dung lượng trống.')
      : facts.freeDiskBytes < MIN_FREE_DISK_BYTES
        ? fail('disk', `Chỉ còn ${megabytes(facts.freeDiskBytes)} MB trống (tối thiểu ${megabytes(MIN_FREE_DISK_BYTES)} MB).`)
        : pass('disk', `Còn ${megabytes(facts.freeDiskBytes)} MB trống.`),
  );

  // --- Running state ------------------------------------------------------
  //
  // Not running is a WARNING, not a failure: `--diagnose` is run precisely when
  // Kas is down, and reporting that as FAIL would bury the reason underneath it.
  checks.push(
    facts.healthOk
      ? pass('health', `Ứng dụng phản hồi tại cổng ${facts.port} và cơ sở dữ liệu hoạt động.`)
      : facts.healthAnswered
        ? fail('health', 'Ứng dụng đang chạy nhưng cơ sở dữ liệu không phản hồi (/api/health trả 503).')
        : facts.portInUse
          ? fail('health', `Cổng ${facts.port} đang bị chiếm nhưng không phải Kas.`)
          : warn('health', 'Kas hiện không chạy.'),
  );

  // --- The setting the whole deployment hangs on ---------------------------
  //
  // A FAIL, and it names the file and the line. `serveClient` is
  // `SERVE_CLIENT ?? isProduction`, so a machine running as development never
  // mounts express.static and answers every non-API request with a 404 — while
  // the API keeps working perfectly. That combination cost a whole deployment,
  // and the header of this report showed "Môi trường: development" the entire
  // time without anything treating it as a fault.
  checks.push(
    facts.environment === 'production'
      ? pass('environment', 'NODE_ENV = production.')
      : fail(
          'environment',
          `NODE_ENV = ${facts.environment || '(chưa đặt)'}, không phải production. ` +
            'Máy chủ sẽ KHÔNG phục vụ giao diện (manifest, sw.js, /assets đều trả 404) ' +
            'dù API vẫn chạy. Hãy thêm NODE_ENV=production và SERVE_CLIENT=true vào .env ' +
            'rồi khởi động lại bằng KasService.cmd.',
        ),
  );

  // --- Is the thing on the port the PRODUCTION build? ----------------------
  //
  // A FAIL, not a warning. The application is fully usable in this state —
  // which is exactly what makes it dangerous: it looks correct from every
  // other angle, and the only symptom is that nobody can install the app.
  checks.push(
    facts.servedClientIsBuild === null
      ? warn('servedClient', 'Không kiểm tra được bản giao diện đang phục vụ (Kas chưa chạy).')
      : facts.servedClientIsBuild
        ? pass('servedClient', 'Đang phục vụ bản build production (có manifest.webmanifest).')
        : fail(
            'servedClient',
            'Địa chỉ này đang phục vụ MÁY CHỦ DEV, không phải bản build. ' +
              'Ứng dụng vẫn chạy nhưng KHÔNG cài được (không có manifest/service worker). ' +
              'Hãy dừng `npm run dev`, trỏ tunnel/proxy vào cổng 3001 và khởi động bằng KasService.cmd.',
          ),
  );

  // --- Windows integration ------------------------------------------------
  checks.push(
    facts.startupTaskRegistered
      ? pass('startupTask', 'Đã đăng ký khởi động cùng Windows (Scheduled Task "Kas").')
      : warn('startupTask', 'Chưa đăng ký khởi động cùng Windows — sau khi khởi động lại máy phải mở Kas thủ công.'),
  );
  checks.push(
    facts.backupTaskRegistered
      ? pass('backupTask', 'Đã đăng ký sao lưu hàng ngày (Scheduled Task "Kas Backup").')
      : warn('backupTask', 'Chưa đăng ký sao lưu tự động — sẽ không có bản sao lưu nào nếu không chạy tay.'),
  );

  // --- Recovery readiness --------------------------------------------------
  if (facts.lastBackupAt === null) {
    checks.push(warn('lastBackup', 'Chưa có bản sao lưu nào. Chạy: KasBackup.cmd'));
  } else {
    const ageHours = (now.getTime() - new Date(facts.lastBackupAt).getTime()) / 3_600_000;
    checks.push(
      ageHours > BACKUP_STALE_HOURS
        ? warn(
            'lastBackup',
            `Bản sao lưu gần nhất đã ${Math.round(ageHours)} giờ trước — lịch sao lưu có thể không chạy.`,
          )
        : pass('lastBackup', `Bản sao lưu gần nhất: ${facts.lastBackupAt}.`),
    );
  }

  const fails = checks.filter((c) => c.severity === 'FAIL').length;
  const warnings = checks.filter((c) => c.severity === 'WARNING').length;

  return {
    overall: fails > 0 ? 'FAIL' : warnings > 0 ? 'WARNING' : 'PASS',
    checks,
    summary: { pass: checks.length - fails - warnings, warning: warnings, fail: fails },
  };
}

/** The one-line verdict, with the count that makes it actionable. */
export function verdictLine(report: DeploymentReport): string {
  const { pass: ok, warning, fail: bad } = report.summary;
  switch (report.overall) {
    case 'PASS':
      return `PASS — ${ok}/${report.checks.length} kiểm tra đạt. Hệ thống sẵn sàng.`;
    case 'WARNING':
      return `WARNING — ${ok} đạt, ${warning} cảnh báo. Kas chạy được nhưng có việc cần xem.`;
    case 'FAIL':
      return `FAIL — ${bad} lỗi nghiêm trọng, ${warning} cảnh báo. Kas KHÔNG hoạt động đúng.`;
  }
}

/**
 * The report as an operator reads it: failures first.
 *
 * A diagnostic that prints twelve PASS lines and hides the one FAIL in the
 * middle has technically reported the fault and practically buried it.
 */
export function formatReport(report: DeploymentReport, version: VersionInfo): string[] {
  const order: Severity[] = ['FAIL', 'WARNING', 'PASS'];
  const mark: Record<Severity, string> = { PASS: '[ OK ]', WARNING: '[WARN]', FAIL: '[FAIL]' };

  const lines = [
    '===============================================',
    '  Kas — chẩn đoán hệ thống',
    '===============================================',
    `Phiên bản : ${version.appVersion} (${version.gitCommit?.slice(0, 8) ?? 'không rõ commit'})`,
    `Môi trường: ${version.environment}`,
    '',
  ];
  for (const severity of order) {
    for (const check of report.checks.filter((c) => c.severity === severity)) {
      lines.push(`${mark[check.severity]} ${check.name.padEnd(14)} ${check.detail}`);
    }
  }
  lines.push('', verdictLine(report));
  return lines;
}

/**
 * The report for the one case where nothing can be measured at all.
 *
 * Every probe in diagnose.ts needs the configuration — upload paths, backup
 * path, the database URL — so when `.env` has not been filled in, the module
 * cannot even load and there are no facts to judge. That is exactly the state a
 * machine is in one second after a fresh install, which is precisely when an
 * operator runs the diagnostic, and until this existed they got an unhandled
 * "Lỗi không mong đợi" and no idea which line of .env was wrong.
 *
 * `detail` is the loader's own message, which already names every failing
 * variable. It is reproduced verbatim rather than summarised: the loader knows
 * what it rejected and a second wording of it would eventually disagree.
 */
export function unconfiguredReport(detail: string): string[] {
  return [
    '===============================================',
    '  Kas — chẩn đoán hệ thống',
    '===============================================',
    '',
    '[FAIL] cấu hình      Chưa cấu hình xong .env — không thể kiểm tra phần còn lại.',
    '',
    ...detail.split('\n'),
    '',
    'KẾT LUẬN: LỖI NGHIÊM TRỌNG. Sửa .env rồi chạy lại:  Kas.cmd --diagnose',
  ];
}
