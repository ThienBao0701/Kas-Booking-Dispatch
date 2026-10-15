/**
 * What the Windows installer should do, decided as pure data.
 *
 * Same split as the launcher: the decisions live here as functions over plain
 * values, and the PowerShell in scripts/production/windows carries them out.
 * Copying files and writing registry keys cannot be unit tested without
 * becoming a mock exercise — but "is this an upgrade or a fresh install",
 * "which files must survive it", and "what may an uninstall delete" are exactly
 * the questions that destroy someone's data when answered wrongly.
 *
 * THE RULE THIS MODULE ENFORCES: an upgrade never touches operator data.
 * Configuration, uploaded proof images and issue photos belong to the hotel,
 * not to the release. The database is never touched at all — it lives in
 * PostgreSQL, outside the install directory, and nothing here can reach it.
 */

/** Node versions the repository declares support for. */
export const MIN_NODE_MAJOR = 22;

/** Paths, relative to the install root, that belong to the OPERATOR. */
export const OPERATOR_DATA: readonly string[] = [
  // Configuration, including the database URL. Replacing it on upgrade would
  // point a working install at nothing.
  '.env',
  // Guest documents. These are evidence of what a branch actually did.
  'server/uploads',
  // Launcher and installer history.
  'logs',
];

/**
 * The backups, held apart from every other kind of data.
 *
 * `BACKUP_DIR` defaults to `backups` INSIDE the install directory, and until
 * now that path appeared in neither list — it survived an upgrade by accident
 * rather than by decision, and `-PurgeData`, documented as full removal,
 * silently left it behind.
 *
 * It is separate from OPERATOR_DATA because it answers a different question.
 * Uploads and configuration can be recreated by a hotel that still has its
 * database; the backups are what remain when nothing else does. So they are
 * preserved unconditionally on upgrade, and removing them takes its own
 * explicit flag rather than riding along with `-PurgeData`.
 */
export const BACKUP_DATA: readonly string[] = ['backups'];

/**
 * Everything an upgrade must leave alone.
 *
 * Declared, rather than achieved by omission: a path that survives because
 * nobody listed it is one refactor away from not surviving.
 */
export const PRESERVED_ON_UPGRADE: readonly string[] = [...OPERATOR_DATA, ...BACKUP_DATA];

/** Paths the installer OWNS and replaces wholesale on every upgrade. */
export const RELEASE_PAYLOAD: readonly string[] = [
  'server/dist',
  'client/dist',
  'prisma',
  'node_modules',
  'package.json',
  'Kas.cmd',
  // The background entry point Windows runs at boot. Part of the payload, not
  // operator data: it is replaced wholesale on every upgrade like the rest of
  // the application.
  'KasService.cmd',
  // The nightly backup entry point. Application code, same reasoning.
  'KasBackup.cmd',
  // The recovery path for an install made without Administrator, where task
  // registration was skipped. It must live in the INSTALL directory, not only
  // in the release folder — the release folder gets deleted, and then the one
  // script that fixes "Kas does not come back after a reboot" is gone with it.
  'Enable-KasAutostart.cmd',
  'Enable-KasAutostart.ps1',
];

/* ------------------------------------------------------------------ */
/* Recognising an existing Kas install                                 */
/* ------------------------------------------------------------------ */

/** The `name` field the repository's root package.json carries. */
export const KAS_PACKAGE_NAME = 'hotel-booking-dispatch';

/**
 * What the installer found in the target directory.
 *
 * Gathered by the PowerShell script; judged here so the rule is tested and
 * cannot drift between the two.
 */
export interface InstallMarkers {
  /** `kas-release.json` — written by installs from Phase 6.3 onward. */
  releaseMetadata: boolean;
  /** The `name` in the target's root package.json, when it has one. */
  packageName: string | null;
  /** `server/dist/index.js` */
  serverBuild: boolean;
  /** `client/dist/index.html` */
  clientBuild: boolean;
  /** `prisma/schema.prisma` */
  prismaSchema: boolean;
  /** `Kas.cmd` */
  launcher: boolean;
  /** `.env` or `server/uploads` — the hotel's own data. */
  operatorData: boolean;
}

/**
 * Is this directory an existing Kas installation?
 *
 * WHY THIS IS NOT JUST "kas-release.json EXISTS". That file only appeared in
 * Phase 6.3. An installation predating it is still unmistakably Kas — it has
 * the built server, the built client, the Prisma schema and the hotel's own
 * uploads — but the old check called it a foreign folder and refused to
 * upgrade, which is precisely backwards: the one directory that must never be
 * treated as a stranger is the one holding the hotel's data.
 *
 * THE RULE IS DELIBERATELY CONSERVATIVE, because the check it relaxes exists
 * to stop an install into Documents or C:\ from later being uninstalled and
 * taking the contents with it. Recognition needs either
 *
 *   - the release metadata, or
 *   - a package.json that names this application, or
 *   - TWO independent structural markers
 *
 * Two is the threshold because any single one can occur innocently: a stray
 * `prisma/` folder, an unrelated `client/dist`. Two together, in one
 * directory, do not.
 */
export function isKasInstallation(markers: InstallMarkers): boolean {
  if (markers.releaseMetadata) return true;
  if (markers.packageName === KAS_PACKAGE_NAME) return true;

  const structural = [
    markers.serverBuild,
    markers.clientBuild,
    markers.prismaSchema,
    markers.launcher,
    markers.operatorData,
  ].filter(Boolean).length;

  return structural >= 2;
}

export type InstallKind =
  /** Nothing installed at the target yet. */
  | 'FRESH'
  /** A different version is present; replace the payload, keep the data. */
  | 'UPGRADE'
  /** The same version is present; replace the payload to fix damage. */
  | 'REPAIR';

export type InstallProblem =
  | 'NODE_MISSING'
  | 'NODE_TOO_OLD'
  | 'WINDOWS_TOO_OLD'
  | 'NOT_ENOUGH_DISK'
  | 'TARGET_NOT_WRITABLE'
  | 'PAYLOAD_INCOMPLETE'
  | 'TARGET_OCCUPIED_BY_OTHER';

/** Windows 10 and Server 2016 both report major version 10. */
export const MIN_WINDOWS_MAJOR = 10;

/**
 * Free space required to install.
 *
 * The payload is around 310 MB and an upgrade briefly holds the old and new
 * copies at once. 1 GB leaves room for that plus the database growth and the
 * proof images that follow, and refusing here is far kinder than running out
 * halfway through replacing node_modules.
 */
export const MIN_INSTALL_DISK_BYTES = 1024 * 1024 * 1024;

/** Everything the decision depends on, gathered by the installer script. */
export interface InstallEnvironment {
  /** Major version of the Node found on PATH, or null when there is none. */
  nodeMajor: number | null;
  /** The chosen install directory. */
  targetDir: string;
  /** The directory exists and can be written to. */
  targetWritable: boolean;
  /** A Kas install is already present at the target. */
  existingInstall: boolean;
  /** Version recorded by a previous install, when there is one. */
  existingVersion: string | null;
  /** Version being installed. */
  incomingVersion: string;
  /** The staged release contains every file in RELEASE_PAYLOAD. */
  payloadComplete: boolean;
  /**
   * The target directory has files in it but no Kas install — someone chose a
   * folder that already belongs to something else.
   */
  targetOccupiedByOther: boolean;
  /** Major Windows version, or null when it could not be read. */
  windowsMajor?: number | null;
  /** Free bytes on the target volume, or null when it could not be read. */
  freeDiskBytes?: number | null;
  /**
   * Something already holds the port Kas will use.
   *
   * A WARNING, never a refusal: nothing is being started yet, the operator may
   * be about to stop whatever holds it, and blocking an install over a running
   * program would be an odd thing for an installer to do. It is reported so the
   * first failed start is not a surprise.
   */
  portInUse?: boolean;
  /** The port that would be used. Only for the message. */
  port?: number;
}

export type InstallAction =
  | { kind: InstallKind; preserve: readonly string[] }
  | { kind: 'ABORT'; problem: InstallProblem };

/**
 * Decides what kind of install this is, and what must survive it.
 *
 * Prerequisites are checked before anything is classified: an installer that
 * decides "this is an upgrade" and only then discovers Node is missing has
 * already told the operator something it cannot deliver.
 */
export function decideInstall(env: InstallEnvironment): InstallAction {
  if (env.nodeMajor === null) return { kind: 'ABORT', problem: 'NODE_MISSING' };
  if (env.nodeMajor < MIN_NODE_MAJOR) return { kind: 'ABORT', problem: 'NODE_TOO_OLD' };
  // An unreadable Windows version is NOT a refusal: the check exists to stop an
  // install onto Windows 7, not to stop one on a machine whose version string
  // could not be parsed. Guessing "too old" there would block a working PC.
  if (env.windowsMajor != null && env.windowsMajor < MIN_WINDOWS_MAJOR) {
    return { kind: 'ABORT', problem: 'WINDOWS_TOO_OLD' };
  }
  // Same reasoning: refuse a disk that is measurably too small, never one that
  // could not be measured.
  if (env.freeDiskBytes != null && env.freeDiskBytes < MIN_INSTALL_DISK_BYTES) {
    return { kind: 'ABORT', problem: 'NOT_ENOUGH_DISK' };
  }
  if (!env.payloadComplete) return { kind: 'ABORT', problem: 'PAYLOAD_INCOMPLETE' };
  if (!env.targetWritable) return { kind: 'ABORT', problem: 'TARGET_NOT_WRITABLE' };
  // Refusing here is what stops an install into "C:\" or a documents folder
  // from later being uninstalled and taking the contents with it.
  if (env.targetOccupiedByOther) return { kind: 'ABORT', problem: 'TARGET_OCCUPIED_BY_OTHER' };

  if (!env.existingInstall) return { kind: 'FRESH', preserve: [] };

  // Same version present means the operator is fixing a broken install rather
  // than moving to a new one. Both replace the payload; the distinction is
  // reported so the log says what actually happened.
  const kind: InstallKind = env.existingVersion === env.incomingVersion ? 'REPAIR' : 'UPGRADE';
  return { kind, preserve: PRESERVED_ON_UPGRADE };
}

/**
 * Whether a path may be removed while replacing the payload.
 *
 * Everything under an operator-data path is protected, not just the exact
 * path — `server/uploads/booking-proofs/x.png` is as untouchable as
 * `server/uploads` itself.
 */
export function isProtectedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return PRESERVED_ON_UPGRADE.some(
    (protectedPath) => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`),
  );
}

/**
 * What an uninstall removes.
 *
 * TWO SEPARATE CONSENTS, because the two kinds of loss are not comparable.
 * `purgeData` removes the configuration and the proof images — recoverable
 * from a backup. `purgeBackups` removes the backups themselves, which is the
 * one action in this system with no way back, and it is not something anyone
 * should be able to do by passing a flag that sounded like it meant something
 * milder.
 */
export function uninstallTargets(purgeData: boolean, purgeBackups = false): readonly string[] {
  // Default keeps everything the hotel produced. An uninstall that silently
  // deleted proof images would destroy the only record that a branch created a
  // reservation correctly.
  return [
    ...RELEASE_PAYLOAD,
    ...(purgeData ? OPERATOR_DATA : []),
    ...(purgeBackups ? BACKUP_DATA : []),
  ];
}

/* ------------------------------------------------------------------ */
/* Folders the installer creates                                       */
/* ------------------------------------------------------------------ */

/**
 * Directories created at install time rather than left to appear on demand.
 *
 * The application creates each of these when it first needs one, so this is
 * not about correctness — it is about the operator being able to SEE where
 * their proof images and backups will live before anything has happened, and
 * about `--diagnose` reporting a real permission problem on the day of the
 * install instead of on the day of the first upload.
 */
export const CREATED_DIRECTORIES: readonly string[] = [
  'logs',
  'backups',
  'server/uploads/booking-proofs',
  'server/uploads/issue-photos',
];

/* ------------------------------------------------------------------ */
/* Starting with Windows                                               */
/* ------------------------------------------------------------------ */

/**
 * The scheduled task that starts Kas at boot.
 *
 * WHY A TASK AND NOT A SERVICE. A Windows service must speak the Service
 * Control Protocol — connect to the SCM and report status within about thirty
 * seconds. Node has no binding for it, so `sc create` registers a service that
 * then fails to start with error 1053. A real service needs a third-party
 * wrapper binary shipped unsigned to the hotel; an at-startup scheduled task
 * needs nothing that is not already in Windows, and does the same job: starts
 * at boot, with no console, no PowerShell and nobody logged in.
 *
 * What it does NOT give us is `services.msc` and the SCM's own restart policy —
 * which is why the runner monitors its own health and why stopping is
 * `KasService.cmd stop` rather than `sc stop`.
 */
export const SCHEDULED_TASK_NAME = 'Kas';

export interface ScheduledTaskSpec {
  name: string;
  /** Relative to the install root. */
  target: string;
  /** When Windows runs it. */
  trigger: 'AtStartup';
  /**
   * Run even when no user is logged in — the point of the whole exercise. A
   * task limited to an interactive session would not start until a receptionist
   * signed in, which is exactly the wait this removes.
   */
  runWhetherLoggedOnOrNot: true;
  /**
   * SYSTEM: the account that exists before anyone logs in and does not lose its
   * session at logoff. It also means no operator password is stored anywhere,
   * which a per-user task would require.
   */
  runAsAccount: 'SYSTEM';
  /**
   * No time limit. The default 72-hour cap would stop a perfectly healthy
   * server every three days, at whatever hour it happened to start.
   */
  executionTimeLimit: 'PT0S';
}

export function scheduledTaskSpec(): ScheduledTaskSpec {
  return {
    name: SCHEDULED_TASK_NAME,
    target: 'KasService.cmd',
    trigger: 'AtStartup',
    runWhetherLoggedOnOrNot: true,
    runAsAccount: 'SYSTEM',
    executionTimeLimit: 'PT0S',
  };
}

/* ------------------------------------------------------------------ */
/* The nightly backup                                                  */
/* ------------------------------------------------------------------ */

export const BACKUP_TASK_NAME = 'Kas Backup';

/**
 * 22:00, daily.
 *
 * Late enough that the day's reservations are all in, early enough that someone
 * is usually still awake to notice a failure. It does NOT stop the application:
 * pg_dump takes a consistent snapshot of a live database, so a backup at 22:00
 * is invisible to a receptionist checking a guest in at 22:00.
 */
export const BACKUP_TASK_TIME = '22:00';

/**
 * How many backups the nightly task keeps.
 *
 * A month of daily history, bounded on purpose: an unbounded backup directory
 * on the machine that also runs PostgreSQL ends as a full disk, and a full disk
 * takes the hotel down — a more likely disaster than the one being insured
 * against.
 */
export const BACKUP_TASK_RETAIN = 30;

export interface BackupTaskSpec {
  name: string;
  target: string;
  trigger: 'Daily';
  time: string;
  retain: number;
  runAsAccount: 'SYSTEM';
  /**
   * A backup that overruns is stopped rather than left to overlap the next
   * night's run: two pg_dumps writing at once is how a backup directory ends up
   * with two half-written archives and no manifest.
   */
  executionTimeLimit: 'PT2H';
}

export function backupTaskSpec(): BackupTaskSpec {
  return {
    name: BACKUP_TASK_NAME,
    target: 'KasBackup.cmd',
    trigger: 'Daily',
    time: BACKUP_TASK_TIME,
    retain: BACKUP_TASK_RETAIN,
    runAsAccount: 'SYSTEM',
    executionTimeLimit: 'PT2H',
  };
}

/** One shortcut the installer creates. */
export interface ShortcutSpec {
  /** File name without the .lnk extension. */
  name: string;
  /** Where it goes. */
  location: 'Desktop' | 'StartMenu';
  /** Relative to the install root. */
  target: string;
  iconRelativePath: string;
}

/**
 * The shortcuts to create.
 *
 * Both point at Kas.cmd — the production runner — rather than at node or a URL.
 * A URL shortcut would open a browser at a server that is not running; the
 * runner starts it first if needed, attaches to it if it is already running as
 * a background service, and opens localhost so the app stays installable.
 */
export function shortcutSpecs(): ShortcutSpec[] {
  const shared = {
    target: 'Kas.cmd',
    iconRelativePath: 'client/dist/favicon.ico',
  };
  return [
    { name: 'Kas', location: 'Desktop', ...shared },
    { name: 'Kas', location: 'StartMenu', ...shared },
  ];
}

/** What to print when a prerequisite fails. Every message names the remedy. */
export function installProblemMessage(problem: InstallProblem, env: InstallEnvironment): string {
  switch (problem) {
    case 'NODE_MISSING':
      return (
        'Không tìm thấy Node.js. Kas cần Node.js để chạy. ' +
        'Hãy cài bản LTS tại https://nodejs.org rồi chạy lại trình cài đặt.'
      );
    case 'NODE_TOO_OLD':
      return (
        `Node.js quá cũ: phiên bản ${env.nodeMajor}, cần tối thiểu ${MIN_NODE_MAJOR}. ` +
        'Hãy cập nhật Node.js tại https://nodejs.org rồi chạy lại.'
      );
    case 'PAYLOAD_INCOMPLETE':
      return (
        'Gói cài đặt thiếu tệp. Hãy tải lại bản phát hành đầy đủ ' +
        '(giải nén toàn bộ thư mục trước khi chạy trình cài đặt).'
      );
    case 'TARGET_NOT_WRITABLE':
      return (
        `Không ghi được vào "${env.targetDir}". ` +
        'Hãy chọn thư mục khác, hoặc chạy trình cài đặt với quyền Administrator.'
      );
    case 'TARGET_OCCUPIED_BY_OTHER':
      return (
        `Thư mục "${env.targetDir}" đã có dữ liệu không phải của Kas. ` +
        'Hãy chọn một thư mục trống hoặc thư mục Kas đã cài trước đó.'
      );
    case 'WINDOWS_TOO_OLD':
      return (
        `Phiên bản Windows quá cũ (${String(env.windowsMajor)}). Kas cần Windows 10 trở lên ` +
        '(hoặc Windows Server 2016 trở lên).'
      );
    case 'NOT_ENOUGH_DISK':
      return (
        `Không đủ dung lượng trống: còn ${Math.round((env.freeDiskBytes ?? 0) / 1024 / 1024)} MB, ` +
        `cần tối thiểu ${Math.round(MIN_INSTALL_DISK_BYTES / 1024 / 1024)} MB. ` +
        'Hãy giải phóng ổ đĩa rồi chạy lại.'
      );
  }
}

/** A human summary of what is about to happen, for the log and the console. */
export function describeInstall(action: InstallAction, env: InstallEnvironment): string[] {
  if (action.kind === 'ABORT') return [`KHÔNG THỂ CÀI ĐẶT: ${installProblemMessage(action.problem, env)}`];

  const lines = [`Thư mục cài đặt : ${env.targetDir}`, `Phiên bản       : ${env.incomingVersion}`];

  if (action.kind === 'FRESH') {
    lines.push('Kiểu cài đặt    : cài mới');
  } else {
    lines.push(
      `Kiểu cài đặt    : ${action.kind === 'UPGRADE' ? 'nâng cấp' : 'sửa chữa'}` +
        (env.existingVersion ? ` (từ ${env.existingVersion})` : ''),
    );
    lines.push(`Giữ nguyên      : ${action.preserve.join(', ')}`);
  }
  // Stated every time, because it is the assurance an operator most needs.
  lines.push('Cơ sở dữ liệu   : không bị thay đổi (PostgreSQL nằm ngoài thư mục cài đặt)');

  // A warning, not a refusal — but said BEFORE the install rather than left to
  // surface as a failed first start.
  if (env.portInUse) {
    lines.push(
      `CẢNH BÁO        : cổng ${env.port ?? 3001} đang bị chiếm. Kas sẽ không khởi động được ` +
        'cho tới khi chương trình đó dừng, hoặc bạn đổi PORT trong .env.',
    );
  }
  return lines;
}
