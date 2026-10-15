/**
 * A restore that can be undone.
 *
 * `restoreBackup` knows how to put data back. What it deliberately never did
 * was touch the running application — it printed a checklist and left the
 * operator to stop Kas, restore, start Kas and check health by hand, in the
 * right order, at the worst possible moment. This orchestrates that sequence,
 * and adds the part a human cannot reliably do under pressure: putting it all
 * back when the restore fails halfway.
 *
 * ── THE ORDER IS THE DESIGN ───────────────────────────────────────────────
 *
 *   1. Verify the chosen backup FIRST, while Kas is still serving guests. A
 *      corrupt archive discovered after the application is down has cost the
 *      hotel an outage to learn something that was knowable for free.
 *   2. Stop Kas. Gracefully, over the control pipe, so in-flight requests
 *      finish — a restore that begins by cutting a write in half is a restore
 *      that starts by creating the damage it exists to repair.
 *   3. Take a ROLLBACK POINT: a complete, verified backup of the current state.
 *      Not a loose dump — a real backup, verified with the same tool, because
 *      an unverified rollback point is a rollback that fails when used.
 *   4. Restore. If anything throws, roll back to step 3 and restart.
 *   5. Start Kas and wait for it to be genuinely healthy — process up AND
 *      database reachable. An app that starts but cannot read its data has not
 *      been restored, it has been broken quietly.
 *   6. Validate what was restored, then report.
 *
 * ── WHAT THIS WILL NOT DO ─────────────────────────────────────────────────
 * The database guard is untouched. `kas_production` and `kas_d1_test` remain
 * refused, whatever is passed here, so this is exercised against the disposable
 * database and a real production restore stays a deliberate manual act. That
 * was the decision for this phase and it is enforced one layer down, in
 * `restoreBackup`, not by anything here.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBackup, verifyBackup, type BackupManifest, type VerifyResult } from './backup';
import { restoreBackup, type RestoreOptions, type RestoreResult } from './restore';

/** How the application is stopped, started and checked. Injectable for tests. */
export interface AppControl {
  /** Returns true when a running instance acknowledged the stop. */
  stop(): Promise<boolean>;
  start(): Promise<void>;
  /** Resolves true once the app is serving AND its database answers. */
  waitHealthy(timeoutMs: number): Promise<boolean>;
}

export type SafeRestoreOutcome =
  /** Restored, application healthy, validations passed. */
  | 'SUCCEEDED'
  /** Restored, application healthy, but a validation failed. Data is the new data. */
  | 'RESTORED_WITH_WARNINGS'
  /** The restore failed and the previous state was put back. */
  | 'FAILED_ROLLED_BACK'
  /** The restore failed AND the rollback failed. The worst case, reported as such. */
  | 'FAILED_ROLLBACK_FAILED'
  /** Nothing was touched — the backup did not verify, or no rollback point could be made. */
  | 'ABORTED';

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SafeRestoreResult {
  outcome: SafeRestoreOutcome;
  /** The verified backup of the state that existed before this ran. */
  rollbackPoint: string | null;
  manifest: BackupManifest | null;
  restore: RestoreResult | null;
  validations: ValidationCheck[];
  /** Ordered narrative, written to restore.log by the caller. */
  steps: string[];
  problems: string[];
}

export interface SafeRestoreOptions {
  backupDir: string;
  targetUrl: string;
  confirmed: boolean;
  app: AppControl;
  /** Where the rollback point is written. Defaults beside the chosen backup. */
  backupRoot?: string;
  resetSchema?: boolean;
  allowedDatabases?: readonly string[];
  healthTimeoutMs?: number;
  /** Directories checked for readable proof images afterwards. */
  uploadDirs?: { name: string; dir: string }[];
  envFile?: string;
  now?: Date;
  /**
   * Seams for tests. Default to the real implementations.
   *
   * `verify` is injectable for the same reason as the other two: proving that
   * a corrupt archive is REJECTED needs a real pg_dump archive to corrupt,
   * which `backupRestore.test.ts` already does against a real database. What
   * needs proving here is the ORDER — that verification happens before the
   * application is stopped — and that is a property of this file.
   */
  runRestore?: (options: RestoreOptions) => Promise<RestoreResult>;
  makeRollbackPoint?: (backupRoot: string) => Promise<{ backupDir: string }>;
  verify?: (backupDir: string) => Promise<VerifyResult>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;

/** The first bytes of the image formats a proof can be. */
const IMAGE_SIGNATURES: { name: string; bytes: number[] }[] = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * Is this file a readable image?
 *
 * Read, not stat. A restore that produced zero-byte files, or copied the
 * directory entries without the contents, passes every existence check ever
 * written and fails the only thing a receptionist needs: opening the picture
 * that proves a reservation was created.
 */
export function looksLikeImage(head: Buffer): boolean {
  return IMAGE_SIGNATURES.some(({ bytes }) =>
    bytes.every((byte, index) => head[index] === byte),
  );
}

/** Walks a directory, returning up to `limit` file paths. */
async function sampleFiles(dir: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    if (found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(dir);
  return found;
}

/**
 * Feature H: what must be true after a restore, checked rather than assumed.
 *
 * Exported because it is worth running on its own — after a manual restore, or
 * simply to ask whether the current machine is intact.
 */
export async function validateRestoredSystem(options: {
  app: AppControl;
  uploadDirs: { name: string; dir: string }[];
  envFile: string;
  manifest: BackupManifest | null;
  healthTimeoutMs: number;
}): Promise<ValidationCheck[]> {
  const checks: ValidationCheck[] = [];

  const healthy = await options.app.waitHealthy(options.healthTimeoutMs);
  checks.push({
    name: 'health',
    ok: healthy,
    detail: healthy
      ? '/api/health trả 200 và cơ sở dữ liệu phản hồi.'
      : 'Ứng dụng không đạt trạng thái khoẻ mạnh trong thời gian chờ.',
  });

  for (const upload of options.uploadDirs) {
    const expected = options.manifest?.uploads.find((u) => u.name === upload.name)?.files ?? null;
    const files = await sampleFiles(upload.dir, 10_000);
    // An empty upload set is only a fault when the backup HELD files. A hotel
    // that has never uploaded a proof restores an empty directory correctly.
    const ok = expected === null || files.length >= expected;
    checks.push({
      name: `uploads:${upload.name}`,
      ok,
      detail: ok
        ? `${files.length} tệp có mặt.`
        : `Chỉ thấy ${files.length} tệp, manifest ghi ${String(expected)}.`,
    });

    const sample = files.slice(0, 5);
    if (sample.length > 0) {
      const unreadable: string[] = [];
      for (const file of sample) {
        try {
          const handle = await fsp.open(file, 'r');
          const buffer = Buffer.alloc(8);
          await handle.read(buffer, 0, 8, 0);
          await handle.close();
          if (!looksLikeImage(buffer)) unreadable.push(path.basename(file));
        } catch {
          unreadable.push(path.basename(file));
        }
      }
      checks.push({
        name: `images:${upload.name}`,
        ok: unreadable.length === 0,
        detail:
          unreadable.length === 0
            ? `Đã mở và kiểm tra ${sample.length} ảnh mẫu.`
            : `Không đọc được: ${unreadable.join(', ')}.`,
      });
    }
  }

  const configPresent = fs.existsSync(options.envFile);
  checks.push({
    name: 'configuration',
    ok: configPresent,
    detail: configPresent
      ? 'Tệp .env có mặt (khôi phục không ghi đè cấu hình).'
      : 'Không tìm thấy .env — ứng dụng sẽ không khởi động được.',
  });

  return checks;
}

export async function safeRestore(options: SafeRestoreOptions): Promise<SafeRestoreResult> {
  const steps: string[] = [];
  const problems: string[] = [];
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const backupRoot = options.backupRoot ?? path.dirname(options.backupDir);
  const runRestore = options.runRestore ?? restoreBackup;
  const verify = options.verify ?? verifyBackup;
  const makeRollbackPoint =
    options.makeRollbackPoint ?? ((root: string) => createBackup({ backupRoot: root }));
  const envFile = options.envFile ?? path.resolve(__dirname, '..', '..', '..', '.env');
  const uploadDirs = options.uploadDirs ?? [];

  const fail = (outcome: SafeRestoreOutcome, rollbackPoint: string | null): SafeRestoreResult => ({
    outcome,
    rollbackPoint,
    manifest: null,
    restore: null,
    validations: [],
    steps,
    problems,
  });

  // --- 1. Verify BEFORE the application is disturbed -----------------------
  steps.push('Kiểm tra bản sao lưu được chọn.');
  const verification = await verify(options.backupDir);
  if (!verification.ok || !verification.manifest) {
    problems.push(...verification.problems);
    steps.push('Bản sao lưu không hợp lệ — KHÔNG dừng ứng dụng, không thay đổi gì.');
    return fail('ABORTED', null);
  }
  const manifest = verification.manifest;

  // --- 2. Stop the application ---------------------------------------------
  steps.push('Dừng Kas (tắt an toàn, các yêu cầu đang xử lý được hoàn tất).');
  await options.app.stop();

  // --- 3. A verified way back ----------------------------------------------
  steps.push('Tạo điểm khôi phục từ trạng thái hiện tại.');
  let rollbackPoint: string;
  try {
    rollbackPoint = (await makeRollbackPoint(backupRoot)).backupDir;
  } catch (error) {
    problems.push(`Không tạo được điểm khôi phục: ${(error as Error).message}`);
    steps.push('Không có đường lùi — hủy bỏ và khởi động lại Kas với dữ liệu cũ.');
    await options.app.start();
    return fail('ABORTED', null);
  }

  const rollbackUsable = await verify(rollbackPoint);
  if (!rollbackUsable.ok) {
    problems.push('Điểm khôi phục vừa tạo không kiểm tra được — hủy bỏ.');
    problems.push(...rollbackUsable.problems);
    await options.app.start();
    return fail('ABORTED', rollbackPoint);
  }
  steps.push(`Điểm khôi phục đã kiểm tra: ${rollbackPoint}`);

  /** Puts the previous state back and brings the app up. */
  const rollBack = async (): Promise<SafeRestoreOutcome> => {
    steps.push('Đang hoàn tác về điểm khôi phục.');
    try {
      await runRestore({
        backupDir: rollbackPoint,
        targetUrl: options.targetUrl,
        confirmed: true,
        safetyCopy: false,
        // The rollback replaces exactly what the failed restore touched.
        resetSchema: options.resetSchema ?? false,
        ...(options.allowedDatabases ? { allowedDatabases: options.allowedDatabases } : {}),
      });
      steps.push('Đã hoàn tác. Dữ liệu trở lại trạng thái trước khi khôi phục.');
      await options.app.start();
      return 'FAILED_ROLLED_BACK';
    } catch (error) {
      problems.push(`HOÀN TÁC THẤT BẠI: ${(error as Error).message}`);
      problems.push(`Điểm khôi phục vẫn còn tại: ${rollbackPoint}`);
      await options.app.start();
      return 'FAILED_ROLLBACK_FAILED';
    }
  };

  // --- 4. Restore -----------------------------------------------------------
  steps.push('Khôi phục cơ sở dữ liệu và tệp tải lên.');
  let restore: RestoreResult;
  try {
    restore = await runRestore({
      backupDir: options.backupDir,
      targetUrl: options.targetUrl,
      confirmed: options.confirmed,
      // The rollback point above IS the safety copy; taking a second one inside
      // the restore would dump the same database twice for no extra safety.
      safetyCopy: false,
      resetSchema: options.resetSchema ?? false,
      ...(options.allowedDatabases ? { allowedDatabases: options.allowedDatabases } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    problems.push(`Khôi phục thất bại: ${(error as Error).message}`);
    const outcome = await rollBack();
    return { ...fail(outcome, rollbackPoint), manifest };
  }

  // --- 5. Bring it back up --------------------------------------------------
  steps.push('Khởi động Kas.');
  await options.app.start();

  const healthy = await options.app.waitHealthy(healthTimeoutMs);
  if (!healthy) {
    problems.push('Kas không đạt trạng thái khoẻ mạnh sau khi khôi phục.');
    const outcome = await rollBack();
    return { ...fail(outcome, rollbackPoint), manifest, restore };
  }

  // --- 6. Prove it -----------------------------------------------------------
  steps.push('Kiểm tra sau khôi phục.');
  const validations = await validateRestoredSystem({
    app: options.app,
    uploadDirs,
    envFile,
    manifest,
    healthTimeoutMs,
  });

  // The data-level verification restoreBackup already performed counts too: a
  // row-count mismatch means the restore did not land what the manifest said.
  const dataOk = restore.verified;
  if (!dataOk) {
    problems.push('Số bản ghi sau khôi phục không khớp manifest.');
  }
  for (const check of validations) if (!check.ok) problems.push(check.detail);

  return {
    outcome: dataOk && validations.every((c) => c.ok) ? 'SUCCEEDED' : 'RESTORED_WITH_WARNINGS',
    rollbackPoint,
    manifest,
    restore,
    validations,
    steps,
    problems,
  };
}
