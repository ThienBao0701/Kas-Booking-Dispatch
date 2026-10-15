import fs from 'node:fs';
import { Router } from 'express';
import { checkDatabase, checkMigrationsApplied } from '../db/prisma';
import {
  BACKUP_DIR,
  ISSUE_UPLOAD_DIR,
  PROOF_UPLOAD_DIR,
  devToolsEnabled,
  env,
  isProduction,
} from '../config/env';

export const healthRouter: Router = Router();

/**
 * GET /api/health — liveness, plus the one dependency the process cannot serve
 * a single request without.
 *
 * The PAYLOAD distinguishes the two things an operator needs to tell apart
 * (D.1 §17): `process` is always reported as alive — if the process were not
 * alive this endpoint would not answer at all, which is the other case — while
 * `database` reports PostgreSQL connectivity separately. So "connection
 * refused" means the process is down, and "503 with process.alive = true"
 * means the process is up but PostgreSQL is not answering.
 *
 * The STATUS CODE keeps its established contract: 503 when the database is
 * unreachable. The container HEALTHCHECK, the Caddy upstream probe and
 * scripts/production/health-check.sh all key off that, and an app that cannot
 * reach its database genuinely must not receive traffic.
 */
healthRouter.get('/health', async (_req, res, next) => {
  try {
    const startedAt = Date.now();
    const databaseOk = await checkDatabase();
    const databaseLatencyMs = Date.now() - startedAt;

    const body = {
      status: databaseOk ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      // Liveness: reaching this line at all proves the process is serving.
      process: { alive: true, pid: process.pid },
      database: {
        connected: databaseOk,
        engine: 'postgresql',
        latencyMs: databaseLatencyMs,
      },
    };

    if (!databaseOk) {
      // A structured 503 rather than a bare error envelope: the operator needs
      // to see WHICH half is broken. No connection string, no driver message.
      res.status(503).json(body);
      return;
    }

    res.json(body);
  } catch (error) {
    next(error);
  }
});

/** One dependency the process needs before it can serve real traffic. */
interface ReadinessCheck {
  name: string;
  ok: boolean;
  /** A short, operator-facing reason. Never a path, credential or stack trace. */
  detail?: string;
}

/** A directory must exist AND be writable — a read-only volume fails uploads. */
function checkWritableDir(name: string, dir: string): ReadinessCheck {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { name, ok: true };
  } catch {
    // Deliberately no path in the message: readiness is often public-ish.
    return { name, ok: false, detail: 'không ghi được' };
  }
}

/**
 * GET /api/ready — readiness.
 *
 * Verifies the dependencies the app needs to actually do its job: the database
 * answers, the persistent upload/backup directories exist and are writable, and
 * the production configuration is coherent. Returns 503 with a per-check list
 * when anything fails.
 *
 * The payload deliberately contains NO secrets, NO filesystem paths and NO
 * database credentials — only check names and a short reason.
 */
healthRouter.get('/ready', async (_req, res) => {
  const checks: ReadinessCheck[] = [];

  const startedAt = Date.now();
  const databaseOk = await checkDatabase();
  checks.push({
    name: 'database',
    ok: databaseOk,
    ...(databaseOk ? {} : { detail: 'không phản hồi' }),
  });

  // A reachable PostgreSQL is not the same as a MIGRATED one. After the D.1
  // cutover it is entirely possible to point the app at a database that exists
  // but has never had `prisma migrate deploy` run against it; every request
  // would then fail at its first query. Readiness catches that here instead.
  // The detail never names a migration — readiness is often reachable.
  if (databaseOk) {
    const migrationsOk = await checkMigrationsApplied();
    checks.push({
      name: 'migrations',
      ok: migrationsOk === true,
      ...(migrationsOk === true ? {} : { detail: 'schema chưa được triển khai đầy đủ' }),
    });
  } else {
    checks.push({ name: 'migrations', ok: false, detail: 'không kiểm tra được' });
  }

  checks.push(checkWritableDir('proofUploads', PROOF_UPLOAD_DIR));
  checks.push(checkWritableDir('issueUploads', ISSUE_UPLOAD_DIR));
  checks.push(checkWritableDir('backups', BACKUP_DIR));

  // Configuration coherence. `env` already refused to load if a required value
  // was missing, so this is the last line of defence against a deployment that
  // somehow reached production with the developer tools armed.
  const configOk = !isProduction || (!devToolsEnabled && env.SESSION_COOKIE_SECURE && Boolean(env.APP_ORIGIN));
  checks.push({
    name: 'configuration',
    ok: configOk,
    ...(configOk ? {} : { detail: 'cấu hình production không hợp lệ' }),
  });

  const ready = checks.every((c) => c.ok);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    timestamp: new Date().toISOString(),
    databaseLatencyMs: Date.now() - startedAt,
    checks,
  });
});
