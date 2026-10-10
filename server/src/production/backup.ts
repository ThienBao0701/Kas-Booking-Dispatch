/**
 * PostgreSQL production backup (Phase D.1 — replaces the SQLite pilot backup).
 *
 * The database is captured with `pg_dump --format=custom`, which is the format
 * PostgreSQL's own tooling is built around: it is compressed, it can be
 * restored selectively, `pg_restore --list` can inspect it without restoring,
 * and it is taken inside a single consistent snapshot transaction — so a
 * backup needs no downtime and cannot capture a half-written state, even while
 * eight branches are dispatching bookings.
 *
 * Uploads are copied afterwards, then a manifest with SHA-256 checksums, the
 * server version and the deployed commit is written LAST — so a backup
 * directory without a valid `manifest.json` is by construction incomplete, and
 * the restore tool rejects it.
 *
 * NOTHING HERE PRINTS A SECRET. The connection password is handed to pg_dump
 * through its environment (see pgTools), never through argv; the manifest
 * records the database NAME but never the URL; and every captured stderr is
 * scrubbed before it can reach a log or an Error.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { BACKUP_DIR, ISSUE_UPLOAD_DIR, PROOF_UPLOAD_DIR, env } from '../config/env';
import { describeDatabaseUrl } from '../config/databaseUrl';
import { connectionArgs, connectionFromUrl, pgToolVersion, runPgTool } from './pgTools';
import { containsLikelySecret, readConfigSnapshot } from './configSnapshot';
import { versionInfo } from './version';

export const BACKUP_MANIFEST_NAME = 'manifest.json';
export const BACKUP_CONFIG_NAME = 'config.json';

/** Repository root, from `server/src/production/` or `server/dist/production/`. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** The runtime log directory the 6.3a runner writes to. */
const DEFAULT_LOG_DIR = path.join(REPO_ROOT, 'logs');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.env');
/** Custom-format archive; `.dump` is the conventional extension. */
export const BACKUP_DB_NAME = 'database.dump';
/**
 * Format 2 = PostgreSQL custom-format dump. Format 1 was the SQLite pilot's
 * `VACUUM INTO` file; the restore tool refuses it explicitly rather than
 * failing obscurely, and points the operator at the D.0 rollback procedure.
 */
export const BACKUP_FORMAT_VERSION = 2;
export const LEGACY_SQLITE_FORMAT_VERSION = 1;

export interface BackupOptions {
  /** Root that holds one directory per backup. Defaults to BACKUP_DIR. */
  backupRoot?: string;
  /** Connection to dump. Defaults to the running process's DATABASE_URL. */
  databaseUrl?: string;
  /** Upload directories to include, in manifest order. */
  uploadDirs?: { name: string; dir: string }[];
  /** Keep at most this many backups (oldest deleted first). 0 = keep all. */
  retain?: number;
  now?: Date;
  client?: PrismaClient;
  /** Application release identifier (tag or commit) recorded in the manifest. */
  releaseRef?: string;
  /**
   * The runtime log directory to capture. Pass null to skip it.
   *
   * Logs are included because the question asked after a failure is almost
   * always "what was it doing at the time", and a backup taken at 22:00 is
   * frequently the only surviving copy of a log that has since rotated away.
   */
  logDir?: string | null;
  /**
   * The .env whose KEYS are recorded (never its secret values — see
   * configSnapshot). Pass null to skip.
   */
  envFile?: string | null;
}

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  appVersion: string;
  releaseRef: string | null;
  database: {
    file: string;
    sha256: string;
    bytes: number;
    engine: 'postgresql';
    /** Database NAME only — never the connection URL. */
    name: string;
    /**
     * The schema that was dumped. A custom-format archive names its objects
     * schema-qualified, so pg_restore can only put them back into a schema of
     * the same name — the restore tool checks this before it starts.
     */
    schema: string;
    serverVersion: string | null;
    dumpFormat: 'custom';
    pgDumpVersion: string | null;
  };
  uploads: { name: string; files: number; bytes: number; sha256: string }[];
  counts: Record<string, number>;
  /**
   * Everything below is OPTIONAL, and deliberately so: it was added in 6.3b and
   * a backup taken before that has none of it. Keeping the fields optional
   * rather than bumping the format version is what lets the restore tool still
   * accept every backup the hotel already holds — a format bump would have made
   * the existing backups unrestorable by the new tool, which is the opposite of
   * what a backup system is for.
   */
  logs?: { dir: string; files: number; bytes: number; sha256: string };
  /** Configuration KEYS with secret values withheld. Never a credential. */
  config?: { file: string; sha256: string; bytes: number; keys: number; redactedKeys: number };
  /** Total bytes of the whole backup directory, for capacity planning. */
  totalBytes?: number;
  /** The deployed commit, when the environment names one. */
  gitCommit?: string | null;
}

export interface BackupResult {
  backupDir: string;
  manifest: BackupManifest;
  prunedBackups: string[];
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '').replace('Z', '').slice(0, 15);
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

/**
 * A stable checksum for a whole directory: every file's relative path and
 * content, in sorted order. Two directories with identical contents hash the
 * same regardless of the order the filesystem happens to list them in.
 */
async function hashDirectory(dir: string): Promise<{ files: number; bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;

  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // a missing upload directory simply contributes nothing
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      const content = await fsp.readFile(full);
      hash.update(rel);
      hash.update(content);
      files += 1;
      bytes += content.byteLength;
    }
  };

  await walk(dir, '');
  return { files, bytes, sha256: hash.digest('hex') };
}

async function copyDirectory(from: string, to: string): Promise<void> {
  if (!fs.existsSync(from)) {
    await fsp.mkdir(to, { recursive: true });
    return;
  }
  await fsp.cp(from, to, { recursive: true });
}

/** Total bytes under a directory, following the tree. */
async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await fsp.stat(full)).size;
    }
  };
  await walk(dir);
  return total;
}

/** Row counts recorded for a quick "did the restore land?" comparison. */
async function counts(client: PrismaClient): Promise<Record<string, number>> {
  const [branches, aliases, users, bookings, proofs, issues, notifications, roomClasses, activeVersions, guests] =
    await Promise.all([
      client.branch.count(),
      client.branchSourceAlias.count(),
      client.user.count(),
      client.booking.count(),
      client.bookingCreationProof.count(),
      client.hotelIssue.count(),
      client.notification.count(),
      client.branchRoomClass.count(),
      client.branchRoomMappingVersion.count({ where: { status: 'ACTIVE' } }),
      client.bookingGuest.count(),
    ]);
  return {
    branches,
    aliases,
    users,
    bookings,
    proofs,
    issues,
    notifications,
    roomClasses,
    activeVersions,
    guests,
  };
}

export async function createBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const client = options.client ?? defaultPrisma;
  const now = options.now ?? new Date();
  const backupRoot = options.backupRoot ?? BACKUP_DIR;
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const uploadDirs = options.uploadDirs ?? [
    { name: 'booking-proofs', dir: PROOF_UPLOAD_DIR },
    { name: 'issue-photos', dir: ISSUE_UPLOAD_DIR },
  ];

  const target = describeDatabaseUrl(databaseUrl);
  if (target.kind !== 'postgresql') {
    throw new BackupError(
      'Chỉ hỗ trợ sao lưu PostgreSQL. DATABASE_URL không phải postgresql:// URL. ' +
        'Bản sao lưu SQLite của giai đoạn D.0 phải dùng công cụ của D.0.',
    );
  }

  // Destination validation: never write a backup into a path we cannot create
  // or that is not a directory (an operator pointing BACKUP_DIR at a file).
  await fsp.mkdir(backupRoot, { recursive: true });
  const rootStat = await fsp.stat(backupRoot);
  if (!rootStat.isDirectory()) {
    throw new BackupError(`Thư mục sao lưu không hợp lệ: ${backupRoot}`);
  }

  const backupDir = path.join(backupRoot, `backup-${stamp(now)}`);
  if (fs.existsSync(backupDir)) {
    throw new BackupError(`Thư mục sao lưu đã tồn tại: ${backupDir}`);
  }
  await fsp.mkdir(backupDir, { recursive: true });

  // --- Database: consistent custom-format dump of the live database --------
  const connection = connectionFromUrl(databaseUrl);
  const schema = target.schema ?? 'public';
  const dbTarget = path.join(backupDir, BACKUP_DB_NAME);
  const dump = await runPgTool(
    'pg_dump',
    [
      ...connectionArgs(connection),
      '--dbname', connection.database,
      '--format=custom',
      // Dump exactly the schema the application uses, not every schema that
      // happens to share the database. In production that is `public` and the
      // result is identical to a whole-database dump; it also means a backup
      // never sweeps up an unrelated schema's data.
      '--schema', schema,
      // Ownership and privileges belong to the target server, not the archive:
      // omitting them lets the same backup restore into a drill database owned
      // by a different role without a wall of permission errors.
      '--no-owner',
      '--no-privileges',
      '--file', dbTarget,
    ],
    connection,
  );

  if (!dump.ok) {
    // Remove the half-written directory so a failed backup can never be
    // mistaken for a usable one.
    await fsp.rm(backupDir, { recursive: true, force: true });
    throw new BackupError(`pg_dump thất bại (mã ${dump.exitCode}): ${dump.stderr.trim()}`);
  }

  const dbStat = await fsp.stat(dbTarget);
  const dbHash = await sha256OfFile(dbTarget);

  let serverVersion: string | null = null;
  try {
    const rows = await client.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`;
    serverVersion = rows[0]?.v ?? null;
  } catch {
    serverVersion = null;
  }

  // --- Uploads -------------------------------------------------------------
  const uploads: BackupManifest['uploads'] = [];
  for (const { name, dir } of uploadDirs) {
    const targetDir = path.join(backupDir, 'uploads', name);
    await copyDirectory(dir, targetDir);
    const digest = await hashDirectory(targetDir);
    uploads.push({ name, ...digest });
  }

  // --- Logs ----------------------------------------------------------------
  //
  // Copied, then hashed FROM THE COPY, so the checksum describes exactly what
  // the backup holds. Hashing the source instead would race the running server,
  // which appends to these files continuously, and produce a manifest that
  // disagrees with its own contents.
  let logs: BackupManifest['logs'];
  const logDir = options.logDir === undefined ? DEFAULT_LOG_DIR : options.logDir;
  if (logDir !== null) {
    const logTarget = path.join(backupDir, 'logs');
    await copyDirectory(logDir, logTarget);
    logs = { dir: 'logs', ...(await hashDirectory(logTarget)) };
  }

  // --- Configuration, without the credentials ------------------------------
  let config: BackupManifest['config'];
  const envFile = options.envFile === undefined ? DEFAULT_ENV_FILE : options.envFile;
  if (envFile !== null) {
    const snapshot = readConfigSnapshot(envFile, now);
    if (snapshot) {
      const serialised = `${JSON.stringify(snapshot, null, 2)}\n`;
      // The allow-list should already guarantee this. If it somehow did not,
      // failing the backup is far better than writing a password to a file that
      // is about to be copied onto a USB stick.
      if (containsLikelySecret(serialised)) {
        await fsp.rm(backupDir, { recursive: true, force: true });
        throw new BackupError(
          'Đã hủy sao lưu: ảnh chụp cấu hình có vẻ chứa giá trị bí mật. ' +
            'Không ghi bản sao lưu nào.',
        );
      }
      const configPath = path.join(backupDir, BACKUP_CONFIG_NAME);
      await fsp.writeFile(configPath, serialised, 'utf8');
      config = {
        file: BACKUP_CONFIG_NAME,
        sha256: await sha256OfFile(configPath),
        bytes: (await fsp.stat(configPath)).size,
        keys: snapshot.entries.length,
        redactedKeys: snapshot.entries.filter((e) => e.redacted).length,
      };
    }
  }

  // --- Manifest LAST: its presence is what makes a backup complete ---------
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    // Read from package.json on disk, never from npm_package_version: the
    // nightly task runs `node` directly, npm sets that variable and node does
    // not, and every scheduled backup was being stamped "0.0.0".
    appVersion: versionInfo().appVersion,
    releaseRef: options.releaseRef ?? process.env.APP_RELEASE_REF ?? null,
    database: {
      file: BACKUP_DB_NAME,
      sha256: dbHash,
      bytes: dbStat.size,
      engine: 'postgresql',
      name: target.database ?? '',
      schema,
      serverVersion,
      dumpFormat: 'custom',
      pgDumpVersion: await pgToolVersion('pg_dump'),
    },
    uploads,
    counts: await counts(client),
    ...(logs ? { logs } : {}),
    ...(config ? { config } : {}),
    gitCommit: options.releaseRef ?? versionInfo().gitCommit,
    // Measured after everything else is on disk, so it describes the real
    // directory rather than the sum of the parts we happened to track.
    totalBytes: await directoryBytes(backupDir),
  };
  await fsp.writeFile(
    path.join(backupDir, BACKUP_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return { backupDir, manifest, prunedBackups: await pruneBackups(backupRoot, options.retain ?? 0) };
}

/** Lists backup directories under a root, newest first. */
export async function listBackups(backupRoot: string = BACKUP_DIR): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** A backup directory is COMPLETE only if its manifest was written. */
export function isCompleteBackup(backupRoot: string, name: string): boolean {
  return fs.existsSync(path.join(backupRoot, name, BACKUP_MANIFEST_NAME));
}

/**
 * Retention: keeps the newest `retain` COMPLETE backups and removes older ones.
 *
 * Three rules, each protecting against a way this goes wrong:
 *
 *   A retain of 0 keeps everything. Deleting backups is never the default.
 *
 *   Only complete backups are counted and only complete backups are deleted. An
 *   in-progress backup has no manifest yet; counting it would let it push a
 *   good backup out of the window, and deleting it would destroy a backup that
 *   is being written at that moment. Incomplete directories are left for an
 *   operator to look at, because a manifest-less directory is evidence that a
 *   backup failed and that is worth noticing.
 *
 *   The newest complete backup is never deleted, whatever `retain` says. A
 *   retention policy that can empty the backup directory is a deletion policy.
 */
export async function pruneBackups(backupRoot: string, retain: number): Promise<string[]> {
  if (retain <= 0) return [];
  const complete = (await listBackups(backupRoot)).filter((name) =>
    isCompleteBackup(backupRoot, name),
  );
  // listBackups returns newest first, so slice(retain) is everything older than
  // the window. `Math.max(retain, 1)` is the floor that keeps the newest.
  const doomed = complete.slice(Math.max(retain, 1));
  for (const name of doomed) {
    await fsp.rm(path.join(backupRoot, name), { recursive: true, force: true });
  }
  return doomed;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  manifest: BackupManifest | null;
}

/**
 * Validates a backup directory without changing anything: the manifest must
 * parse, its format version must be understood, every checksum must match, and
 * the archive must be a readable custom-format dump (proved by asking
 * `pg_restore --list` to read its table of contents).
 *
 * The restore tool refuses to run unless this passes.
 */
export async function verifyBackup(backupDir: string): Promise<VerifyResult> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_NAME);

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, problems: ['Thiếu hoặc hỏng manifest.json.'], warnings, manifest: null };
  }

  if (manifest.formatVersion === LEGACY_SQLITE_FORMAT_VERSION) {
    return {
      ok: false,
      problems: [
        'Đây là bản sao lưu SQLite của giai đoạn D.0 (formatVersion 1). ' +
          'Công cụ PostgreSQL không khôi phục được; hãy dùng quy trình rollback D.0.',
      ],
      warnings,
      manifest,
    };
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    problems.push(`Định dạng bản sao lưu không được hỗ trợ: ${String(manifest.formatVersion)}.`);
  }

  const dbPath = path.join(backupDir, manifest.database?.file ?? BACKUP_DB_NAME);
  if (!fs.existsSync(dbPath)) {
    problems.push('Thiếu tệp cơ sở dữ liệu trong bản sao lưu.');
  } else if ((await sha256OfFile(dbPath)) !== manifest.database.sha256) {
    problems.push('Checksum cơ sở dữ liệu không khớp — bản sao lưu đã hỏng.');
  } else {
    // A matching checksum proves the bytes are intact; it does not prove they
    // are a readable archive. Ask pg_restore to parse the table of contents.
    const listed = await runPgTool('pg_restore', ['--list', dbPath], {
      host: '', port: 0, user: '', database: '', password: null,
    });
    if (!listed.ok) {
      problems.push('Tệp không phải archive custom-format hợp lệ (pg_restore --list thất bại).');
    }
  }

  for (const upload of manifest.uploads ?? []) {
    const dir = path.join(backupDir, 'uploads', upload.name);
    const digest = await hashDirectory(dir);
    if (digest.sha256 !== upload.sha256) {
      problems.push(`Checksum thư mục "${upload.name}" không khớp.`);
    }
  }

  // Logs and configuration are checked only when the manifest claims them. A
  // backup taken before 6.3b has neither, and must still verify — otherwise
  // this phase would have quietly invalidated every backup the hotel holds.
  if (manifest.logs) {
    const digest = await hashDirectory(path.join(backupDir, manifest.logs.dir));
    if (digest.sha256 !== manifest.logs.sha256) {
      problems.push('Checksum thư mục nhật ký không khớp.');
    }
  }

  if (manifest.config) {
    const configPath = path.join(backupDir, manifest.config.file);
    if (!fs.existsSync(configPath)) {
      problems.push('Thiếu tệp cấu hình được ghi trong manifest.');
    } else {
      if ((await sha256OfFile(configPath)) !== manifest.config.sha256) {
        problems.push('Checksum tệp cấu hình không khớp.');
      }
      // A backup that somehow acquired a credential must be reported as a
      // problem, not quietly restored onto a machine.
      if (containsLikelySecret(await fsp.readFile(configPath, 'utf8'))) {
        problems.push('Tệp cấu hình chứa giá trị trông giống bí mật — không dùng bản sao lưu này.');
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings, manifest };
}
