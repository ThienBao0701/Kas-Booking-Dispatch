/**
 * What the production runner decides, as pure data.
 *
 * The runner keeps Kas alive on a hotel PC with nobody watching it. Spawning
 * processes, probing sockets and renaming log files cannot be unit tested
 * without becoming a mock exercise that proves nothing; the DECISIONS can, and
 * they are the parts that would actually go wrong at 2am on a Sunday. So they
 * live here as functions over plain values, and `runner.ts` does nothing but
 * carry them out.
 *
 * THE RULE THAT MATTERS MOST: a restart is only ever attempted for a fault a
 * restart can fix, and only ONCE. Restarting because PostgreSQL is down, the
 * disk is full or the uploads directory is read-only fixes nothing and produces
 * a process that dies and respawns every few seconds — filling the disk it was
 * complaining about, and burying the one log line that said why. Those faults
 * are reported and left alone, loudly.
 *
 * Startup VALIDATION is not here: it already exists in `launcher/plan.ts`, is
 * already tested, and this phase extended it rather than growing a second
 * validator that could disagree with the first.
 */

/* ------------------------------------------------------------------ */
/* How the runner was started                                          */
/* ------------------------------------------------------------------ */

/**
 * INTERACTIVE — an operator double-clicked Kas.cmd. There is a desktop, so the
 * browser is opened and the console window is the stop control.
 *
 * SERVICE — Windows started Kas at boot from a scheduled task. There may be no
 * desktop session at all, and opening a browser into one either fails silently
 * or, worse, opens Kas on a machine nobody is sitting at.
 */
export type RunMode = 'INTERACTIVE' | 'SERVICE';

/** Reads the mode from argv. Anything unrecognised is an operator run. */
export function parseMode(argv: readonly string[]): RunMode {
  return argv.includes('--service') ? 'SERVICE' : 'INTERACTIVE';
}

/* ------------------------------------------------------------------ */
/* The command surface                                                 */
/* ------------------------------------------------------------------ */

/**
 * What the operator asked for.
 *
 * `START` is the default because that is what double-clicking Kas.cmd means. An
 * UNKNOWN verb is its own case rather than being folded into START: silently
 * starting the application because someone typed `--diagnoze` is how a support
 * call becomes "I ran the diagnostic and nothing happened".
 */
export type Command =
  | { kind: 'START'; mode: RunMode }
  | { kind: 'STOP' }
  | { kind: 'RESTART' }
  | { kind: 'DIAGNOSE' }
  | { kind: 'HEALTH' }
  | { kind: 'VERSION' }
  | { kind: 'LOGS' }
  | { kind: 'HELP' }
  | { kind: 'UNKNOWN'; argument: string };

/** Every verb, in the order help lists them. */
export const COMMANDS: { flag: string; summary: string }[] = [
  { flag: '(không có)', summary: 'Khởi động Kas và mở trình duyệt.' },
  { flag: '--service', summary: 'Khởi động nền, không mở trình duyệt (Windows dùng khi khởi động máy).' },
  { flag: '--stop', summary: 'Tắt an toàn bản đang chạy.' },
  { flag: '--restart', summary: 'Tắt an toàn rồi khởi động lại.' },
  { flag: '--diagnose', summary: 'Kiểm tra toàn bộ hệ thống. Không thay đổi dữ liệu.' },
  { flag: '--health', summary: 'Hỏi nhanh /api/health.' },
  { flag: '--version', summary: 'Phiên bản, commit và thời điểm build.' },
  { flag: '--logs', summary: 'Vị trí và kích thước các tệp nhật ký.' },
  { flag: '--help', summary: 'Danh sách đầy đủ các lệnh này.' },
];

/**
 * Reads one verb from argv.
 *
 * The FIRST recognised flag wins, and an unrecognised one is reported rather
 * than ignored. `--service` is checked last of the start-shaped flags so that
 * `--service --diagnose` diagnoses instead of starting a server, which is what
 * someone typing both plainly meant.
 */
export function parseCommand(argv: readonly string[]): Command {
  // `-h` is included deliberately: it is what people type, and a help request
  // that silently starts the application is the worst possible answer to it.
  const flags = argv.filter((a) => a.startsWith('--') || a === '-h');

  if (flags.includes('--help') || flags.includes('-h')) return { kind: 'HELP' };
  if (flags.includes('--diagnose')) return { kind: 'DIAGNOSE' };
  if (flags.includes('--health')) return { kind: 'HEALTH' };
  if (flags.includes('--version')) return { kind: 'VERSION' };
  if (flags.includes('--logs')) return { kind: 'LOGS' };
  if (flags.includes('--restart')) return { kind: 'RESTART' };
  if (flags.includes('--stop')) return { kind: 'STOP' };

  const known = new Set(COMMANDS.map((c) => c.flag));
  const unknown = flags.find((f) => !known.has(f) && f !== '--service');
  if (unknown) return { kind: 'UNKNOWN', argument: unknown };

  return { kind: 'START', mode: parseMode(argv) };
}

/** The help an operator sees, and what an invalid verb prints. */
export function helpText(): string[] {
  return [
    'Kas — trung tâm điều phối đặt phòng',
    '',
    'Cách dùng:  Kas.cmd [tuỳ chọn]',
    '',
    ...COMMANDS.map((c) => `  ${c.flag.padEnd(12)} ${c.summary}`),
    '',
    'Sao lưu:    KasBackup.cmd [số bản giữ lại]',
    'Chạy nền:   KasService.cmd  |  KasService.cmd stop',
  ];
}

/** What an unrecognised verb prints above the help. */
export function unknownCommandMessage(argument: string): string {
  return `Không nhận ra tuỳ chọn "${argument}".`;
}

/**
 * Whether to open a browser.
 *
 * Never in service mode. At boot the task runs before anyone logs in, so there
 * is no session to open a window in; and if there were, a browser appearing on
 * an unattended reception PC at 6am is not a feature.
 */
export function shouldOpenBrowser(mode: RunMode): boolean {
  return mode === 'INTERACTIVE';
}

/* ------------------------------------------------------------------ */
/* Single instance                                                     */
/* ------------------------------------------------------------------ */

/** What the runner writes into the lock file while it owns the port. */
export interface LockFile {
  pid: number;
  port: number;
  /** ISO timestamp. Only ever displayed, never compared for correctness. */
  startedAt: string;
  mode: RunMode;
}

/** Everything the lock decision depends on, gathered by the caller. */
export interface LockState {
  /** Parsed lock file, or null when absent or unreadable. */
  lock: LockFile | null;
  /** A process with that PID exists. NOT proof it is Kas. */
  lockPidAlive: boolean;
  /** The port answers the Kas health endpoint. */
  portServesKas: boolean;
}

export type LockDecision =
  /** Nothing else is running. Take the lock and start. */
  | { kind: 'PROCEED' }
  /** Kas is already serving. Open a browser at it; start nothing. */
  | { kind: 'ATTACH' }
  /** Another runner owns the lock and is still starting. Start nothing. */
  | { kind: 'ALREADY_STARTING' }
  /** A lock left behind by a crash. Delete it and start. */
  | { kind: 'CLEAR_STALE_LOCK' };

/**
 * Decides whether this process may start a server.
 *
 * THE PORT IS THE AUTHORITY, not the file. A lock file is a hint that can
 * outlive the process that wrote it — a power cut leaves one behind, and an
 * operator who then cannot start Kas at all has been locked out by a stale
 * hint. So a live health response means ATTACH regardless of what the file
 * says, and a lock whose PID no longer exists is deleted rather than obeyed.
 *
 * The remaining case is the narrow one: a lock, a live PID, and no health
 * response yet. That is another runner mid-startup — Prisma's first connection
 * takes a moment — and starting a second server would race it to the port and
 * lose with EADDRINUSE.
 */
export function decideLock(state: LockState): LockDecision {
  if (state.portServesKas) return { kind: 'ATTACH' };
  if (state.lock === null) return { kind: 'PROCEED' };
  if (!state.lockPidAlive) return { kind: 'CLEAR_STALE_LOCK' };
  return { kind: 'ALREADY_STARTING' };
}

/* ------------------------------------------------------------------ */
/* Will this runtime actually serve the app?                           */
/* ------------------------------------------------------------------ */

/**
 * The build is on disk, but will the process serve it?
 *
 * `serveClient` is `SERVE_CLIENT ?? isProduction`, so a machine whose .env says
 * `NODE_ENV=development` starts a server that mounts no static files at all:
 * index.html, manifest.webmanifest, sw.js and /assets/* every one a 404, while
 * /api answers perfectly. The application looks alive from every angle anyone
 * normally checks.
 *
 * That combination ran a hotel for an entire deployment. The build was present
 * the whole time — nothing ever asked Express to serve it.
 *
 * FATAL IN SERVICE MODE. KasService.cmd is the production entry point; a
 * production service that cannot serve the application is not a degraded
 * start, it is a failed one, and failing loudly at boot is far cheaper than
 * discovering it from a receptionist who cannot install the app.
 *
 * A WARNING interactively, because that is also how a developer runs a
 * checkout, and refusing there would break a legitimate way to work.
 */
export function clientServingFault(
  mode: RunMode,
  clientBuildPresent: boolean,
  serveClientEnabled: boolean,
): 'FATAL' | 'WARNING' | null {
  // Nothing to serve is a different problem, already reported by the build check.
  if (!clientBuildPresent || serveClientEnabled) return null;
  return mode === 'SERVICE' ? 'FATAL' : 'WARNING';
}

/** What to tell the operator, naming the two lines that fix it. */
export function clientServingMessage(fault: 'FATAL' | 'WARNING'): string {
  const cause =
    'Giao diện đã build nhưng tiến trình này KHÔNG phục vụ nó: ' +
    'manifest.webmanifest, sw.js và /assets đều sẽ trả 404 (API vẫn chạy bình thường). ' +
    'Nguyên nhân: .env đang đặt NODE_ENV=development và không đặt SERVE_CLIENT.';
  const remedy = 'Hãy thêm vào .env:  NODE_ENV=production  và  SERVE_CLIENT=true';
  return fault === 'FATAL'
    ? `KHÔNG THỂ KHỞI ĐỘNG DỊCH VỤ. ${cause} ${remedy}`
    : `CẢNH BÁO: ${cause} ${remedy}`;
}

/** What to tell the operator when a second copy was launched. */
export function lockMessage(decision: LockDecision): string {
  switch (decision.kind) {
    case 'ATTACH':
      return 'Kas đã chạy sẵn — mở trình duyệt tới bản đang chạy, không khởi động thêm.';
    case 'ALREADY_STARTING':
      return 'Một tiến trình Kas khác đang khởi động. Không khởi động thêm tiến trình nào.';
    case 'CLEAR_STALE_LOCK':
      return 'Tìm thấy khoá cũ từ lần chạy bị dừng đột ngột — đã xoá và tiếp tục khởi động.';
    case 'PROCEED':
      return 'Không có tiến trình Kas nào đang chạy.';
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/**
 * Below this the disk is reported as a fault.
 *
 * 500 MB. Proof images are a few hundred KB each and PostgreSQL needs room for
 * its WAL; a machine this close to full will fail a write soon, and the useful
 * moment to say so is before it does.
 */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;

/** One observation of the running system. Every field is measured, none derived. */
export interface HealthSample {
  /** The spawned server process still exists. */
  serverProcessAlive: boolean;
  /** GET /api/health answered 2xx. */
  healthEndpointOk: boolean;
  /** That response reported the database connected. */
  databaseOk: boolean;
  /** The proof-image directory still accepts a write. */
  uploadsWritable: boolean;
  /** Free bytes on the install volume, or null when it could not be read. */
  freeDiskBytes: number | null;
}

export type HealthVerdict =
  | { kind: 'HEALTHY' }
  /** Something is wrong that a restart cannot fix. Report; keep serving. */
  | { kind: 'DEGRADED'; reasons: HealthFault[] }
  /** The server is gone or wedged. Restart it — once. */
  | { kind: 'RESTART'; reason: HealthFault }
  /** Already restarted once and still failing. Stop trying. */
  | { kind: 'FATAL'; reason: HealthFault };

export type HealthFault =
  | 'PROCESS_DEAD'
  | 'ENDPOINT_UNREACHABLE'
  | 'DATABASE_DOWN'
  | 'UPLOADS_NOT_WRITABLE'
  | 'DISK_LOW';

/** How many times the runner will restart the server before giving up. */
export const MAX_RESTARTS = 1;

/**
 * Turns one observation into an action.
 *
 * ONLY TWO FAULTS JUSTIFY A RESTART, and both mean the same thing: the process
 * that should be serving is not serving. Everything else — a database that
 * stopped answering, a full disk, an uploads directory that lost its
 * permissions — is a fault OUTSIDE the process, and restarting the process
 * neither fixes it nor makes it more visible. It makes it less visible, by
 * replacing a stable machine reporting one clear fault with a crash loop.
 *
 * The restart budget is spent, not renewed. `restartsUsed` is never reset by a
 * later healthy sample: a server that needs restarting twice in one run is a
 * server with a fault nobody has diagnosed, and quietly papering over it is how
 * a hotel runs for a month on a process dying every ten minutes.
 */
export function evaluateHealth(sample: HealthSample, restartsUsed: number): HealthVerdict {
  const restartable: HealthFault | null = !sample.serverProcessAlive
    ? 'PROCESS_DEAD'
    : !sample.healthEndpointOk
      ? 'ENDPOINT_UNREACHABLE'
      : null;

  if (restartable !== null) {
    return restartsUsed >= MAX_RESTARTS
      ? { kind: 'FATAL', reason: restartable }
      : { kind: 'RESTART', reason: restartable };
  }

  // The process is serving. Now the things around it.
  const reasons: HealthFault[] = [];
  if (!sample.databaseOk) reasons.push('DATABASE_DOWN');
  if (!sample.uploadsWritable) reasons.push('UPLOADS_NOT_WRITABLE');
  if (sample.freeDiskBytes !== null && sample.freeDiskBytes < MIN_FREE_DISK_BYTES) {
    reasons.push('DISK_LOW');
  }

  return reasons.length === 0 ? { kind: 'HEALTHY' } : { kind: 'DEGRADED', reasons };
}

/**
 * What each fault means, and what to do about it.
 *
 * Every message names an action. A monitor that reports "database down" and
 * stops has moved the problem from the machine to the operator's inbox without
 * making it any easier to solve.
 */
export function healthFaultMessage(fault: HealthFault): string {
  switch (fault) {
    case 'PROCESS_DEAD':
      return 'Tiến trình máy chủ đã dừng.';
    case 'ENDPOINT_UNREACHABLE':
      return 'Máy chủ còn sống nhưng không trả lời /api/health.';
    case 'DATABASE_DOWN':
      return (
        'Không kết nối được PostgreSQL. Khởi động lại Kas KHÔNG khắc phục được việc này — ' +
        'hãy kiểm tra dịch vụ postgresql trong services.msc.'
      );
    case 'UPLOADS_NOT_WRITABLE':
      return (
        'Không ghi được vào thư mục ảnh xác nhận. Lễ tân sẽ không gửi được ảnh tạo đơn. ' +
        'Hãy kiểm tra quyền ghi của thư mục cài đặt.'
      );
    case 'DISK_LOW':
      return (
        `Dung lượng trống dưới ${Math.round(MIN_FREE_DISK_BYTES / 1024 / 1024)} MB. ` +
        'Hãy giải phóng ổ đĩa trước khi cơ sở dữ liệu hoặc ảnh xác nhận ghi lỗi.'
      );
  }
}

/** The one line written when the runner gives up. */
export function fatalMessage(fault: HealthFault): string {
  return (
    `Đã khởi động lại máy chủ ${MAX_RESTARTS} lần và vẫn lỗi: ${healthFaultMessage(fault)} ` +
    'Runner dừng theo dõi để tránh khởi động lại vô hạn. Xem logs/error.log.'
  );
}

/* ------------------------------------------------------------------ */
/* Log rotation                                                        */
/* ------------------------------------------------------------------ */

/** Rotate a log once it passes this size. 5 MB is a few weeks of a quiet hotel. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * How many rotated generations to keep.
 *
 * Bounded on purpose: "rotate" without "discard" is just a slower way of
 * filling the disk, and a full disk on the machine the hotel dispatches from is
 * a worse outcome than losing a fortnight of debug lines.
 */
export const MAX_LOG_GENERATIONS = 5;

export function shouldRotate(sizeBytes: number): boolean {
  return sizeBytes >= MAX_LOG_BYTES;
}

/** One rename the caller should perform, oldest first. */
export interface LogRename {
  from: string;
  to: string;
}

/**
 * The renames that rotate `name`, in the order they must happen.
 *
 * HIGHEST GENERATION FIRST. Renaming server.log → server.1.log before moving
 * server.1.log out of the way would destroy the previous generation, which is
 * usually the one holding the first sign of the fault being investigated.
 *
 * The oldest generation is not renamed anywhere: it is dropped, which is what
 * bounds the total. The caller deletes it.
 */
export function rotationPlan(name: string, generations = MAX_LOG_GENERATIONS): LogRename[] {
  const renames: LogRename[] = [];
  const base = name.replace(/\.log$/, '');
  for (let i = generations - 1; i >= 1; i -= 1) {
    renames.push({ from: `${base}.${i}.log`, to: `${base}.${i + 1}.log` });
  }
  renames.push({ from: name, to: `${base}.1.log` });
  return renames;
}

/** The generation that falls off the end and should be deleted first. */
export function expiredGeneration(name: string, generations = MAX_LOG_GENERATIONS): string {
  return `${name.replace(/\.log$/, '')}.${generations}.log`;
}

/* ------------------------------------------------------------------ */
/* Production vs development                                           */
/* ------------------------------------------------------------------ */

/**
 * The log files this phase writes, each answering a different question.
 *
 * Separated because they are read at different times by different people: an
 * operator ringing about a machine that will not start reads startup.log; a
 * developer diagnosing a fault reads error.log; server.log is the application's
 * own output, which is voluminous and would bury both.
 */
export const LOG_FILES = {
  /** The runner's own narrative: what it decided and why. */
  launcher: 'launcher.log',
  /** Everything the server process wrote to stdout and stderr. */
  server: 'server.log',
  /** Supervision: starts, restarts, health verdicts, shutdowns. */
  service: 'service.log',
  /** One block per startup attempt, with the validation results. */
  startup: 'startup.log',
  /** Faults only. Never noise — if this file has content, something is wrong. */
  error: 'error.log',
  /**
   * Backup and restore, kept apart from the application's own output on
   * purpose. A restore is read about weeks later by someone asking "what did
   * this actually do to my data", and interleaving it with request logs makes
   * that question much harder to answer. Verification is separate again
   * because it is the record consulted when a backup is DOUBTED, and it must
   * not be rotated away by ordinary backup chatter.
   */
  backup: 'backup.log',
  restore: 'restore.log',
  verification: 'verification.log',
} as const;

export type LogName = keyof typeof LOG_FILES;

export function isProductionRuntime(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production';
}

/**
 * The banner at the top of every startup block.
 *
 * In production it says nothing about builds, watch mode or developer tooling.
 * An operator reading "chế độ phát triển" on the hotel's machine cannot act on
 * it and will reasonably conclude the install is wrong.
 */
export function startupBanner(mode: RunMode, nodeEnv: string | undefined): string[] {
  const lines = [
    '===============================================',
    '  Kas — trung tâm điều phối đặt phòng',
    '===============================================',
    mode === 'SERVICE' ? 'Chế độ: dịch vụ nền (khởi động cùng Windows)' : 'Chế độ: khởi động thủ công',
  ];
  // Developer-only wording, and only when genuinely not in production.
  if (!isProductionRuntime(nodeEnv)) {
    lines.push(`CẢNH BÁO: NODE_ENV = ${nodeEnv ?? 'chưa đặt'} (không phải production).`);
  }
  return lines;
}
