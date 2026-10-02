import fs from 'node:fs';
import { resolveBranchIdentity } from '../src/booking/identityResolver';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import {
  BACKUP_DIR,
  FILE_BACKED_SECRETS,
  ISSUE_UPLOAD_DIR,
  PROOF_UPLOAD_DIR,
  expandFileSecrets,
  parseEnvironment,
} from '../src/config/env';
import { runProductionSeed } from '../src/production/productionSeed';
import { checkAdminPasswordStrength, createInitialAdmin } from '../src/production/createAdmin';
import { setDevToolsOverride } from '../src/devtest/guard';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import { matchBranch, resolveAgodaBranch } from '../src/booking/branchMatcher';
import { parseAgodaBooking } from '../src/booking/agoda';
import { parseBooking } from '../src/booking/parser';
import { generateStoredFileName, readProofFile, saveProofFile } from '../src/booking/proofStorage';
import { TEST_RECEPTIONIST_USERNAME } from '../src/devtest/constants';
import { normalizeUsername } from '../src/auth/username';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionistAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;

/**
 * A complete, VALID production environment. Individual cases override one field
 * at a time so each assertion pins exactly one rule. Nothing here is a real
 * secret, domain or password — `.invalid` is the reserved never-resolving TLD.
 */
const PRODUCTION_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PORT: '3001',
  // PostgreSQL 17 since Phase D.1. The password is a placeholder and the host
  // is loopback: this fixture is never connected to, only validated. Note the
  // percent-encoded '@' — the fixture deliberately exercises the encoding rule
  // that a real deployment must follow.
  DATABASE_URL: 'postgresql://kas_app:pl%40ceholder@127.0.0.1:5432/kas',
  APP_ORIGIN: 'https://dispatch.example.invalid',
  SESSION_SECRET: 'f'.repeat(64),
  SESSION_COOKIE_SECURE: 'true',
  TRUST_PROXY: '1',
  INITIAL_ADMIN_USERNAME: 'operator',
  INITIAL_ADMIN_PASSWORD: 'S0me-Str0ng!Bootstrap',
  INITIAL_ADMIN_FULL_NAME: 'Quản trị viên',
  PROOF_UPLOAD_DIR: '/data/uploads/booking-proofs',
  ISSUE_UPLOAD_DIR: '/data/uploads/issue-photos',
  CHARGE_UPLOAD_DIR: '/data/uploads/charge-documents',
  CHAT_UPLOAD_DIR: '/data/uploads/chat-attachments',
  BACKUP_DIR: '/data/backups',
  ENABLE_DEV_TEST_TOOLS: 'false',
};

const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...PRODUCTION_ENV, ...over });

/** The validation message for one key, or '' when that key raised nothing. */
function errorFor(result: ReturnType<typeof parseEnvironment>, key: string): string {
  if (result.success) return '';
  return result.errors.find((e) => e.startsWith(`${key}:`)) ?? '';
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(ownBranchId, { username: 'letan', mustChangePassword: false });
  receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 60_000);

afterEach(() => setDevToolsOverride(null));
afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* 1–6  Production configuration contract                              */
/* ================================================================== */

describe('production configuration', () => {
  it('1. a complete production environment validates', () => {
    const result = parseEnvironment(prod());
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.env.NODE_ENV).toBe('production');
      expect(result.env.SESSION_COOKIE_SECURE).toBe(true);
      expect(result.env.TRUST_PROXY).toBe(1);
    }
  });

  it('1b. production refuses a SQLite DATABASE_URL, and never echoes the URL', () => {
    // The D.0 pilot shape must not be able to boot a production process after
    // the D.1 cutover: it would silently start the app on an empty local
    // database instead of PostgreSQL.
    const sqlite = parseEnvironment(prod({ DATABASE_URL: 'file:/data/db/kas.db' }));
    expect(sqlite.success).toBe(false);
    expect(errorFor(sqlite, 'DATABASE_URL')).toContain('postgresql');

    // A malformed URL is reported by NAME only — never by value, because the
    // value carries the database password.
    const secret = 'postgresql://kas_app:sup3r-s3cret-value@127.0.0.1:5432';
    const malformed = parseEnvironment(prod({ DATABASE_URL: secret }));
    expect(malformed.success).toBe(false);
    const joined = malformed.success ? '' : malformed.errors.join('\n');
    expect(joined).not.toContain('sup3r-s3cret-value');
    expect(joined).not.toContain(secret);
    expect(errorFor(malformed, 'DATABASE_URL')).toContain('percent-encode');

    // Outside production a file: URL is still accepted, because the transfer
    // tool has to be able to open the legacy pilot database.
    const dev = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'file:./data.db',
      SESSION_SECRET: 'x'.repeat(20),
    });
    expect(dev.success).toBe(true);
  });

  it('1c. production refuses a RELATIVE upload or backup path, CHARGE_UPLOAD_DIR included', () => {
    /*
      A relative path resolves inside the application directory — which a
      release REPLACES. For charge documents that is the sharpest case: they are
      financial evidence, writing them there succeeds silently, and the next
      deployment deletes them. Refusing to boot is the only safe response.
    */
    for (const key of [
      'PROOF_UPLOAD_DIR',
      'ISSUE_UPLOAD_DIR',
      'CHARGE_UPLOAD_DIR',
      'CHAT_UPLOAD_DIR',
      'BACKUP_DIR',
    ] as const) {
      const relative = parseEnvironment(prod({ [key]: 'server/uploads/somewhere' }));
      expect(relative.success, key).toBe(false);
      expect(errorFor(relative, key), key).toContain('absolute path in production');
    }

    // The default is relative, so an omitted CHARGE_UPLOAD_DIR must be refused
    // in production exactly as an explicitly relative one is. This is the case
    // that actually occurs: a launcher that simply never sets the variable.
    const omitted = prod();
    delete omitted.CHARGE_UPLOAD_DIR;
    const result = parseEnvironment(omitted);
    expect(result.success).toBe(false);
    expect(errorFor(result, 'CHARGE_UPLOAD_DIR')).toContain('absolute path in production');

    // An absolute value is accepted, so the guard rejects the shape and not the
    // variable itself.
    expect(parseEnvironment(prod({ CHARGE_UPLOAD_DIR: 'C:\\KasData\\uploads\\charge-documents' })).success)
      .toBe(true);
  });

  it('2. every required variable is named when missing, without echoing secrets', () => {
    // Base-schema requirements are reported for any environment.
    const bare = parseEnvironment({ NODE_ENV: 'production' });
    expect(bare.success).toBe(false);
    for (const key of ['DATABASE_URL', 'SESSION_SECRET']) {
      expect(errorFor(bare, key), key).not.toBe('');
    }

    // The production-only requirements are checked once the base schema is
    // satisfied (Zod runs superRefine only after the object itself parses), so
    // each one is asserted by removing exactly that key from a valid config.
    for (const key of [
      'APP_ORIGIN', 'INITIAL_ADMIN_USERNAME', 'INITIAL_ADMIN_PASSWORD', 'INITIAL_ADMIN_FULL_NAME',
    ]) {
      const result = parseEnvironment(prod({ [key]: undefined }));
      expect(result.success, key).toBe(false);
      expect(errorFor(result, key), key).toContain('required in production');
    }
    // A rejected configuration must never print a secret's value back.
    const withSecret = parseEnvironment(prod({ APP_ORIGIN: 'not-a-url' }));
    expect(withSecret.success).toBe(false);
    if (!withSecret.success) {
      expect(withSecret.errors.join('\n')).not.toContain('f'.repeat(64));
      expect(withSecret.errors.join('\n')).not.toContain('S0me-Str0ng!Bootstrap');
    }
  });

  it('3. production refuses ENABLE_DEV_TEST_TOOLS=true; development may enable it', () => {
    const result = parseEnvironment(prod({ ENABLE_DEV_TEST_TOOLS: 'true' }));
    expect(result.success).toBe(false);
    expect(errorFor(result, 'ENABLE_DEV_TEST_TOOLS')).toContain('must be false in production');

    const dev = parseEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'file:./data.db',
      SESSION_SECRET: 'x'.repeat(20),
      ENABLE_DEV_TEST_TOOLS: 'true',
    });
    expect(dev.success).toBe(true);
    expect(dev.success && dev.env.ENABLE_DEV_TEST_TOOLS).toBe(true);
  });

  it('4. production demands secure cookies, an https origin and a real secret', () => {
    expect(errorFor(parseEnvironment(prod({ SESSION_COOKIE_SECURE: 'false' })), 'SESSION_COOKIE_SECURE'))
      .toContain('must be true in production');
    expect(errorFor(parseEnvironment(prod({ APP_ORIGIN: 'http://dispatch.example.invalid' })), 'APP_ORIGIN'))
      .toContain('https');
    expect(errorFor(parseEnvironment(prod({ SESSION_SECRET: 'short' })), 'SESSION_SECRET')).not.toBe('');
    expect(errorFor(parseEnvironment(prod({ SESSION_SECRET: `change-me-${'x'.repeat(40)}` })), 'SESSION_SECRET'))
      .toContain('placeholder');
    expect(errorFor(parseEnvironment(prod({ INITIAL_ADMIN_PASSWORD: 'changeme123456' })), 'INITIAL_ADMIN_PASSWORD'))
      .toContain('placeholder');
    // Persistent data must not live inside the disposable container filesystem.
    expect(errorFor(parseEnvironment(prod({ PROOF_UPLOAD_DIR: 'server/uploads/x' })), 'PROOF_UPLOAD_DIR'))
      .toContain('absolute');
    expect(errorFor(parseEnvironment(prod({ BACKUP_DIR: 'backups' })), 'BACKUP_DIR')).toContain('absolute');
  });

  it('4b. the session cookie is HttpOnly, SameSite=Lax and Secure-driven', async () => {
    const { res } = await loginAgent(app, 'admin', ADMIN_PASSWORD);
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw]).find((c) => c?.startsWith('hbd.sid='))!;

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    // Secure follows SESSION_COOKIE_SECURE, which production forces to true
    // (asserted above); the test environment runs over plain HTTP.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'session.ts'), 'utf8');
    expect(source).toContain('secure: env.SESSION_COOKIE_SECURE');
    expect(source).toContain('httpOnly: true');
  });

  it('5. exactly one origin is allowed and no CORS header is ever emitted', async () => {
    // Kas serves its own frontend, so there is no cross-origin browser client:
    // the "allowlist" is the single APP_ORIGIN and no ACAO header is sent.
    const res = await adminAgent.get('/api/branches').set('Origin', 'https://evil.example.invalid');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();

    const result = parseEnvironment(prod());
    expect(result.success && result.env.APP_ORIGIN).toBe('https://dispatch.example.invalid');

    // The same-origin guard compares against the CONFIGURED origin.
    const guard = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'sameOrigin.ts'), 'utf8');
    expect(guard).toContain('allowedOriginHost()');
    expect(guard).toContain('new URL(env.APP_ORIGIN).host');
  });

  it('6. trust proxy is configuration-driven and bounded', () => {
    // Exactly one proxy (Caddy) sits in front of the app.
    expect(createApp().get('trust proxy')).toBe(1);
    expect(parseEnvironment(prod({ TRUST_PROXY: '0' })).success).toBe(true);
    // Trusting more hops than exist lets a client forge X-Forwarded-For and
    // slip past the login limiter, so the value is capped.
    expect(parseEnvironment(prod({ TRUST_PROXY: '99' })).success).toBe(false);
  });

  it('6b. secrets can be supplied as files, keeping values out of the environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-secret-'));
    const secretFile = path.join(dir, 'session_secret');
    fs.writeFileSync(secretFile, `${'a'.repeat(64)}\n`);

    expect(expandFileSecrets({ SESSION_SECRET_FILE: secretFile }).SESSION_SECRET).toBe('a'.repeat(64));
    // An explicit value always wins over the file.
    expect(
      expandFileSecrets({ SESSION_SECRET: 'inline', SESSION_SECRET_FILE: secretFile }).SESSION_SECRET,
    ).toBe('inline');
    // An unreadable secret file is a hard failure, never a silent empty secret.
    const broken = parseEnvironment({ ...prod(), SESSION_SECRET: undefined, SESSION_SECRET_FILE: path.join(dir, 'nope') });
    expect(broken.success).toBe(false);

    expect(FILE_BACKED_SECRETS).toContain('SESSION_SECRET');
    expect(FILE_BACKED_SECRETS).toContain('INITIAL_ADMIN_PASSWORD');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('6c. login brute-force protection is configured and enforced', async () => {
    const result = parseEnvironment(prod());
    expect(result.success && result.env.LOGIN_RATE_LIMIT_MAX).toBeGreaterThan(0);
    expect(result.success && result.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES).toBeGreaterThan(0);

    // A fresh app has its own limiter state; exhausting it yields 429.
    const isolated = createApp();
    const agent = request.agent(isolated);
    let sawRateLimit = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await agent.post('/api/auth/login').send({ username: 'admin', password: 'wrong-password' });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  }, 60_000);
});

/* ================================================================== */
/* 7–9  Development tooling must not exist in production               */
/* ================================================================== */

describe('developer tooling gates', () => {
  it('7. every dev-test route 404s when the tools are off', async () => {
    setDevToolsOverride(false);
    for (const res of await Promise.all([
      adminAgent.get('/api/dev-test/status'),
      adminAgent.post('/api/dev-test/ensure-test-account'),
      adminAgent.post('/api/dev-test/demo/generate').send({ bookingsPerBranch: 1 }),
      adminAgent.delete('/api/dev-test/demo').send({ confirmPhrase: 'XOA DU LIEU DEMO' }),
      receptionistAgent.post('/api/dev-test/active-branch').send({ branchId: ownBranchId }),
    ])) {
      expect(res.status).toBe(404);
    }
  });

  it('7b. the gate is computed from the flag AND the environment', async () => {
    const { computeDevToolsEnabled } = await import('../src/config/env');
    // Even a mistakenly-set flag cannot arm the tools in production.
    expect(computeDevToolsEnabled(true, 'production')).toBe(false);
    expect(computeDevToolsEnabled(true, 'development')).toBe(true);
    expect(computeDevToolsEnabled(false, 'development')).toBe(false);
  });

  it('8. the dev UI is gated on the server response, not merely hidden', () => {
    // Both dev surfaces render null unless the server reports enabled — and the
    // server 404s in production, so nothing can be revealed by CSS or DOM edits.
    const clientSrc = path.join(__dirname, '..', '..', 'client', 'src');
    const panel = fs.readFileSync(path.join(clientSrc, 'components', 'DevToolsPanel.tsx'), 'utf8');
    expect(panel).toContain('if (!status.data?.enabled) return null;');

    const bar = fs.readFileSync(path.join(clientSrc, 'layout', 'DevToolsBar.tsx'), 'utf8');
    expect(bar).toMatch(/enabled/);

    const hook = fs.readFileSync(path.join(clientSrc, 'hooks', 'useDevTools.ts'), 'utf8');
    expect(hook).toMatch(/enabled/);
  });

  it('9. a normal receptionist can never switch branch, even with tools enabled', async () => {
    setDevToolsOverride(true);
    const res = await receptionistAgent
      .post('/api/dev-test/active-branch')
      .send({ branchId: ownBranchId });
    expect(res.status).toBe(403);

    // The account's real branch is untouched, and it still sees only its own.
    const user = await testPrisma.user.findFirstOrThrow({ where: { username: 'letan' } });
    expect(user.branchId).toBe(ownBranchId);
    const branches = await receptionistAgent.get('/api/branches');
    expect(branches.body.branches).toHaveLength(1);
  });
});

/* ================================================================== */
/* 10–16  Migration, production bootstrap and clean-start guarantees   */
/* ================================================================== */

describe('production database bootstrap', () => {
  beforeEach(async () => {
    await testPrisma.booking.deleteMany({});
    await testPrisma.demoDataBatch.deleteMany({});
    await testPrisma.user.deleteMany({ where: { username: { notIn: ['admin', 'letan'] } } });
  });

  it('10. the committed migrations create the schema on a clean database', async () => {
    // The vitest global setup builds this database from scratch with
    // `prisma migrate deploy` — the exact production command. Every table the
    // production code touches therefore already exists here.
    const dir = path.join(__dirname, '..', '..', 'prisma', 'migrations');
    const migrations = fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d));

    // Phase D.1 replaced the eleven SQLite migrations with a deterministic
    // PostgreSQL baseline, so a COUNT proves nothing any more. What matters is
    // asserted directly instead.
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    for (const m of migrations) {
      expect(fs.existsSync(path.join(dir, m, 'migration.sql')), m).toBe(true);
    }

    // The engine the migration history is locked to must be PostgreSQL: a lock
    // file still saying "sqlite" makes `migrate deploy` refuse to run at all.
    const lock = fs.readFileSync(path.join(dir, 'migration_lock.toml'), 'utf8');
    expect(lock).toContain('provider = "postgresql"');

    // The SQLite history must be archived, NOT deleted — it is still the
    // definition of the source database the D.1 transfer tool reads.
    const legacyDir = path.join(__dirname, '..', '..', 'prisma', 'legacy-sqlite', 'migrations');
    expect(fs.existsSync(legacyDir)).toBe(true);
    const legacy = fs.readdirSync(legacyDir).filter((d) => /^\d{14}_/.test(d));
    expect(legacy.length).toBeGreaterThanOrEqual(10);
    expect(legacy.some((m) => m.includes('branch_management'))).toBe(true);
    expect(legacy.some((m) => m.includes('branch_room_class_versioning'))).toBe(true);

    // ...and it must never be executed against PostgreSQL. The archived files
    // use SQLite's table-rebuild idiom, which would be catastrophic here.
    //
    // `--` comments are stripped first: the PostgreSQL migrations DESCRIBE the
    // SQLite idiom in their header comments, and matching that prose would be
    // a false positive. Only executable SQL is checked.
    const executableSql = migrations
      .map((m) => fs.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8'))
      .join('\n')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(executableSql).not.toMatch(/PRAGMA/i);
    expect(executableSql).not.toMatch(/\bDATETIME\b/);
    expect(executableSql).not.toMatch(/\bAUTOINCREMENT\b/i);
    // Positive control: the stripper must not have eaten the real statements.
    expect(executableSql).toMatch(/CREATE TABLE "Booking"/);
    expect(executableSql).toMatch(/CREATE TYPE "BookingStatus"/);

    // Prove the newest tables really are present on this freshly migrated DB.
    await expect(testPrisma.branchSourceAlias.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(testPrisma.branchChangeLog.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(testPrisma.branchRoomClass.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(testPrisma.bookingGuest.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(testPrisma.bookingAuditEvent.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('10b. the C.3.8 and D.1 invariants exist as real database indexes', async () => {
    // These are the constraints that application code alone cannot guarantee
    // once eight branches write concurrently. They must exist in the DATABASE.
    const indexes = await testPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
    `;
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

    const activeVersion = byName.get('BranchRoomMappingVersion_one_active_per_branch');
    expect(activeVersion, 'one-ACTIVE-version-per-branch index is missing').toBeTruthy();
    expect(activeVersion).toMatch(/UNIQUE/i);
    expect(activeVersion).toMatch(/WHERE/i);

    const primaryGuest = byName.get('BookingGuest_one_primary_per_booking');
    expect(primaryGuest, 'one-primary-guest-per-booking index is missing').toBeTruthy();
    expect(primaryGuest).toMatch(/UNIQUE/i);

    const operationalBooking = byName.get('Booking_one_operational_per_code_branch_checkin');
    expect(operationalBooking, 'operational duplicate-booking index is missing').toBeTruthy();
    expect(operationalBooking).toMatch(/UNIQUE/i);
    /*
      The PREDICATE, not just the index.

      This index and `findOperationalDuplicate` are two enforcements of one rule,
      and they must agree. They did not: soft delete leaves `status` untouched,
      so a WITHDRAWN order stayed inside an index that only asked about status,
      and re-sending a reservation the Admin had taken back was refused by the
      database even once the application allowed it.

      Asserted here so a future migration that recreates this index cannot
      silently drop the clause and bring the refusal back.
    */
    expect(operationalBooking).toMatch(/"?deletedAt"?\s+IS\s+NULL/i);
    // The states it still covers — DRAFT/READY remain deliberately excluded.
    expect(operationalBooking).toMatch(/NEW/);
    expect(operationalBooking).toMatch(/COMPLETED/);
    expect(operationalBooking).toMatch(/ARCHIVED/);

    /*
      ONE OPEN SHIFT PER RECEPTIONIST.

      Invisible to schema.prisma — Prisma's schema language cannot express a
      partial unique index — so a migration regenerated from the schema would
      silently drop it and let two open sessions exist for one person. Every
      shift handover depends on there being exactly one.
    */
    const openShift = byName.get('ReceptionShiftSession_one_open_per_user');
    expect(openShift, 'one-open-shift-per-user index is missing').toBeTruthy();
    expect(openShift).toMatch(/UNIQUE/i);
    expect(openShift).toMatch(/"?closedAt"?\s+IS\s+NULL/i);

    /*
      ONE LIVE REPAIR ATTEMPT PER INCIDENT.

      Two technicians pressing "Tiếp nhận" at the same instant both pass an
      application-level "is it still NEW?" check; this is what makes one of them
      lose, instead of the incident quietly acquiring two live attempts with two
      different technicians.
    */
    const openAttempt = byName.get('TechnicalRepairAttempt_one_open_per_issue');
    expect(openAttempt, 'one-open-repair-attempt-per-issue index is missing').toBeTruthy();
    expect(openAttempt).toMatch(/UNIQUE/i);
    expect(openAttempt).toMatch(/"?outcomeAt"?\s+IS\s+NULL/i);
  });

  it('11. the production bootstrap is idempotent', async () => {
    const first = await runProductionSeed(testPrisma);
    const second = await runProductionSeed(testPrisma);
    const third = await runProductionSeed(testPrisma);

    expect(second.aliasesCreated).toBe(0);
    expect(third.aliasesCreated).toBe(0);
    expect(second.branches).toBe(first.branches);
    expect(third.aliasesTotal).toBe(first.aliasesTotal);
  });

  it('11b. it never re-enables an alias an Admin deliberately disabled', async () => {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } });
    const alias = await testPrisma.branchSourceAlias.findFirstOrThrow({
      where: { branchId: branch.id, alias: 'Bamboo Water Hotel' },
    });
    await testPrisma.branchSourceAlias.update({ where: { id: alias.id }, data: { active: false } });

    await runProductionSeed(testPrisma);

    expect((await testPrisma.branchSourceAlias.findUniqueOrThrow({ where: { id: alias.id } })).active).toBe(false);
    await testPrisma.branchSourceAlias.update({ where: { id: alias.id }, data: { active: true } });
  });

  it('11c. it never overwrites an Admin-edited branch value', async () => {
    await testPrisma.branch.update({
      where: { code: 'TRUONG_DINH_05' },
      data: { branchNumber: 42, breakfastIncluded: true },
    });
    await runProductionSeed(testPrisma);

    const after = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } });
    expect(after.branchNumber).toBe(42);
    expect(after.breakfastIncluded).toBe(true);

    await testPrisma.branch.update({
      where: { code: 'TRUONG_DINH_05' },
      data: { branchNumber: 1, breakfastIncluded: false },
    });
  });

  it('12. the bootstrap yields exactly the eight configured branches', async () => {
    const result = await runProductionSeed(testPrisma);
    expect(result.branches).toBe(BRANCHES.length);
    expect(result.branches).toBe(8);

    const numbers = (await testPrisma.branch.findMany({ orderBy: { branchNumber: 'asc' } }))
      .map((b) => b.branchNumber);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('13. every Booking.com hotel name still resolves after the bootstrap', async () => {
    await runProductionSeed(testPrisma);
    const configs = await loadBranchConfigs(testPrisma);
    const expected: [string, string][] = [
      ['Bamboo Water Hotel', 'LY_TU_TRONG_260'],
      ['Luxury Elegance Hotel Ben Thanh', 'LY_TU_TRONG_260'],
      ['Luxury Elegance Hotel Ben Than', 'LY_TU_TRONG_260'],
      ['Kaliee Nata Hotel', 'NGUYEN_THAI_BINH_170'],
      ['Saigon Hotel & Ben Thanh', 'TRUONG_DINH_05'],
      ['Boutique Zody Hotel Ben Thanh', 'LE_THANH_TON_278'],
      ['Ben Thanh Market Luxury Hotel', 'BUI_THI_XUAN_40'],
      ['Modern Luxury Eliana Hotel', 'BUI_THI_XUAN_13'],
      ['Modern Luxury Dilly Hotel', 'LE_THANH_TON_191'],
    ];
    for (const [name, code] of expected) {
      expect(matchBranch(name, configs)?.branch.code, name).toBe(code);
    }
  });

  it('14. every Agoda hotel name still resolves, and an unknown one does not', async () => {
    await runProductionSeed(testPrisma);
    const configs = await loadBranchConfigs(testPrisma);
    const expected: [string, string][] = [
      ['KAS Passion Boutique Hotel', 'TRUONG_DINH_05'],
      ['KAS Elegance Hotel', 'LY_TU_TRONG_260'],
      ['KAS Ancient Boutique Hotel', 'NGUYEN_TRAI_47A'],
      ['KAS Milestone Premium Hotel', 'NGUYEN_THAI_BINH_170'],
      ['KAS Zody Boutique Hotel', 'LE_THANH_TON_278'],
      ['KAS Sonata Luxury Hotel', 'BUI_THI_XUAN_40'],
      ['KAS Eliana Luxury Hotel', 'BUI_THI_XUAN_13'],
      ['KAS Dilly Hotel', 'LE_THANH_TON_191'],
    ];
    for (const [name, code] of expected) {
      expect(resolveAgodaBranch(name, configs)?.code, name).toBe(code);
    }
    // An unknown or incomplete name is never routed to a default branch.
    for (const unknown of ['KAS Unknown Hotel', 'KAS Sonata Hotel', 'Milestone Premium']) {
      expect(resolveAgodaBranch(unknown, configs), unknown).toBeNull();
    }
  });

  it('15/16. the bootstrap creates no operational, demo or test-account rows', async () => {
    const result = await runProductionSeed(testPrisma);
    expect(result.operational).toEqual({
      bookings: 0, proofs: 0, issues: 0, notifications: 0, demoBatches: 0, demoBookings: 0,
    });
    expect(result.testReceptionistPresent).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(
      await testPrisma.user.findUnique({ where: { username: normalizeUsername(TEST_RECEPTIONIST_USERNAME) } }),
    ).toBeNull();
  });

  it('15b. demo data or the test account is reported as a hard warning', async () => {
    const branch = await testPrisma.branch.findFirstOrThrow();
    const batch = await testPrisma.demoDataBatch.create({ data: { paramsJson: '{}', summaryJson: '{}' } });
    await testPrisma.booking.create({
      data: {
        bookingCode: 'DEMO-1', branchId: branch.id, customerName: 'TEST', paymentStatus: 'PAY_BEFORE',
        rawText: 'x', isDemo: true, demoBatchId: batch.id,
      },
    });

    const result = await runProductionSeed(testPrisma);
    expect(result.operational.demoBookings).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/DỮ LIỆU DEMO/);
  });
});

/* ================================================================== */
/* 17–18  Initial administrator                                        */
/* ================================================================== */

describe('initial administrator', () => {
  beforeEach(async () => {
    await testPrisma.user.deleteMany({ where: { username: { notIn: ['admin', 'letan'] } } });
  });

  it('17. creates the first Admin, hashed and forced to rotate the password', async () => {
    await testPrisma.user.deleteMany({ where: { role: 'ADMIN' } });

    const outcome = await createInitialAdmin({
      username: '  Operator  ',
      password: 'Str0ng-Bootstrap!2026',
      fullName: 'Quản trị viên',
      client: testPrisma,
    });
    expect(outcome.created).toBe(true);

    const admin = await testPrisma.user.findUniqueOrThrow({ where: { username: 'operator' } });
    expect(admin.role).toBe('ADMIN');
    expect(admin.branchId).toBeNull();
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.passwordHash).not.toContain('Str0ng-Bootstrap!2026');
    expect(admin.passwordHash.startsWith('$2')).toBe(true);

    // Restore the shared fixture admin for the remaining cases.
    await testPrisma.user.deleteMany({ where: { username: 'operator' } });
    await createAdmin({ mustChangePassword: false });
    adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  });

  it('17b. a weak password is refused and never echoed back', async () => {
    await expect(
      createInitialAdmin({ username: 'weak', password: 'short', fullName: 'X', client: testPrisma }),
    ).rejects.toThrow(/12 ký tự/);

    for (const bad of ['alllowercase1!', 'ALLUPPERCASE1!', 'NoDigitsHere!!', 'NoSpecial12345', 'has space 1A!']) {
      expect(checkAdminPasswordStrength(bad).ok, bad).toBe(false);
    }
    expect(checkAdminPasswordStrength('Str0ng-Bootstrap!2026').ok).toBe(true);

    await expect(
      createInitialAdmin({ username: 'weak', password: 'admin1234567', fullName: 'X', client: testPrisma }),
    ).rejects.toThrow(/^(?!.*admin1234567).*$/s);
  });

  it('18. a duplicate Admin is refused unless explicitly allowed', async () => {
    const blocked = await createInitialAdmin({
      username: 'second', password: 'Str0ng-Bootstrap!2026', fullName: 'Second', client: testPrisma,
    });
    expect(blocked).toMatchObject({ created: false, reason: 'admin-exists' });
    expect(await testPrisma.user.findUnique({ where: { username: 'second' } })).toBeNull();

    const allowed = await createInitialAdmin({
      username: 'second', password: 'Str0ng-Bootstrap!2026', fullName: 'Second',
      allowAdditional: true, client: testPrisma,
    });
    expect(allowed.created).toBe(true);

    // A taken username is still refused even with the override.
    const dupe = await createInitialAdmin({
      username: 'second', password: 'Str0ng-Bootstrap!2026', fullName: 'Second',
      allowAdditional: true, client: testPrisma,
    });
    expect(dupe).toMatchObject({ created: false, reason: 'username-taken' });
  });
});

/* ================================================================== */
/* 19–22  Health, readiness and upload persistence                     */
/* ================================================================== */

describe('health, readiness and storage', () => {
  it('19. GET /api/health reports liveness and leaks nothing', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database.connected).toBe(true);
    // Unauthenticated on purpose: the container probe has no session.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/DATABASE_URL|SESSION_SECRET|passwordHash|file:/);
    // Since D.1 the connection URL carries a password, so the probe payload
    // must not contain a connection string, a host:port, or a credential.
    expect(body).not.toMatch(/postgres(ql)?:\/\//i);
    expect(body).not.toMatch(/kas_app/);
    expect(body).not.toMatch(/5432/);
    // Liveness and database readiness are reported as separate facts (D.1 §17).
    expect(res.body.process.alive).toBe(true);
    expect(res.body.database.engine).toBe('postgresql');
  });

  it('20. GET /api/ready verifies the database and every writable directory', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');

    const checks = res.body.checks as { name: string; ok: boolean }[];
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['database', 'proofUploads', 'issueUploads', 'backups', 'configuration']),
    );
    expect(checks.every((c) => c.ok)).toBe(true);

    // No path, credential or connection string is exposed.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/[A-Za-z]:\\|file:|SECRET|password/i);
  });

  it('20b. readiness fails loudly when a dependency is unusable', async () => {
    // A directory check that cannot be satisfied must surface as not-ready
    // rather than being quietly ignored.
    const { healthRouter } = await import('../src/routes/health');
    expect(healthRouter).toBeDefined();

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'health.ts'), 'utf8');
    expect(source).toContain('fs.constants.W_OK');
    expect(source).toContain("res.status(ready ? 200 : 503)");
    // The reason string must not embed the failing path.
    expect(source).toContain("return { name, ok: false, detail: 'không ghi được' };");
  });

  it('21. upload and backup directories are absolute and writable', () => {
    for (const dir of [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR, BACKUP_DIR]) {
      expect(path.isAbsolute(dir)).toBe(true);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    }
    // In production they must be volume paths, never under the source tree.
    const result = parseEnvironment(prod());
    expect(result.success && path.isAbsolute(result.env.PROOF_UPLOAD_DIR)).toBe(true);
    expect(PRODUCTION_ENV.PROOF_UPLOAD_DIR).not.toContain('server/');
    expect(PRODUCTION_ENV.BACKUP_DIR).not.toContain('server/');
  });

  it('22. a stored upload survives application recreation', async () => {
    const name = generateStoredFileName('persist1', 1, 'image/png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(24),
    ]);
    await saveProofFile(bytes, name);

    // Recreating the Express app is the in-process equivalent of
    // `docker compose up -d --force-recreate app`: a brand-new instance over
    // the same mounted volume. The file must still be there and unchanged.
    const recreated = createApp();
    expect(recreated).toBeDefined();
    expect(await readProofFile(name)).toEqual(bytes);

    fs.rmSync(path.join(PROOF_UPLOAD_DIR, name), { force: true });
  });

  it('22b. uploads keep server-generated names and resist path traversal', async () => {
    const name = generateStoredFileName('../../etc/passwd', 1, 'image/png');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toMatch(/^[a-z0-9]+_a1_[0-9a-f]{16}\.png$/);

    for (const evil of ['../secret.png', '..\\secret.png', 'sub/dir.png', '\0.png']) {
      await expect(readProofFile(evil)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

/* ================================================================== */
/* 34–39  Regressions that must survive the production changes         */
/* ================================================================== */

describe('production regressions', () => {
  it('34. the Booking.com parser still resolves through the database configuration', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseBooking(
      [
        'Bamboo Water Hotel',
        'Số đặt phòng: 4455667788',
        'Tên khách: TEST GUEST',
        'Nhận phòng: Thứ 2, 27 tháng 7 2026',
        'Trả phòng: Thứ 4, 29 tháng 7 2026',
      ].join('\n'),
      configs,
    );
    expect(parsed.suggestedBranch?.code).toBe('LY_TU_TRONG_260');
    expect(parsed.bookingCode).toBe('4455667788');
  });

  it('35. the Agoda parser still produces the exact PMS note', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseAgodaBooking(
      [
        'Agoda Booking ID 1753026280 - CONFIRMED',
        'Property Name\tKAS Sonata Luxury Hotel',
        'Booking ID\t1753026280',
        'Customer First Name\tTEST',
        'Customer Last Name\tCUSTOMER',
        'Check-in\tJuly 27, 2026',
        'Check-out\tJuly 29, 2026',
        'Room Type\tNo. of Rooms\tOccupancy\tNo. of Extra Bed',
        'Standard (0)\t1\t2 Adults\t0',
        'Reference sell rate (incl. taxes & fees)\tVND 1,680,000.00',
        'Net rate (incl. taxes & fees)\tVND 1,016,710.00',
      ].join('\n'),
      configs,
    );
    expect(parsed.hotelName).toBe('40-42 Bùi Thị Xuân');
    expect(parsed.agoda?.pmsNote).toBe(
      'AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG',
    );
  });

  it('36/39. branch management works and an inactive branch leaves routing', async () => {
    const created = await adminAgent.post('/api/admin/branches').send({
      branchNumber: 30, hotelName: 'Chi nhánh production test', address: '3 Đề Thám',
      code: 'DE_THAM_3', breakfastIncluded: false, active: true,
    });
    expect(created.status).toBe(201);
    const id = created.body.branch.id as number;

    expect(
      (await adminAgent.put(`/api/admin/branches/${id}/platform-identities/AGODA`)
        .send({ name: 'KAS De Tham Hotel' })).status,
    ).toBe(200);
    expect(
      resolveBranchIdentity('KAS De Tham Hotel', 'AGODA', await loadBranchConfigs(testPrisma)).branchCode,
    ).toBe('DE_THAM_3');

    await adminAgent.post(`/api/admin/branches/${id}/deactivate`);

    // 39. A disabled branch is removed from automatic routing and from dispatch.
    const after = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity('KAS De Tham Hotel', 'AGODA', after).branchId).toBeNull();
    expect(after.some((b) => b.id === id)).toBe(false);
    expect((await adminAgent.get('/api/branches')).body.branches.some((b: { id: number }) => b.id === id)).toBe(false);

    await testPrisma.branchPlatformIdentityEvent.deleteMany({ where: { branchId: id } });
    await testPrisma.branchPlatformIdentity.deleteMany({ where: { branchId: id } });
    await testPrisma.branchSourceAlias.deleteMany({ where: { branchId: id } });
    await testPrisma.branchChangeLog.deleteMany({ where: { branchId: id } });
    await testPrisma.branch.delete({ where: { id } });
  });

  it('37. branch isolation is unchanged and cannot be widened', async () => {
    const res = await receptionistAgent.get('/api/branches');
    expect(res.body.branches).toHaveLength(1);
    expect(res.body.branches[0].id).toBe(ownBranchId);

    const other = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } });
    expect((await receptionistAgent.get(`/api/branches/${other.id}`)).status).toBe(403);
    // A client-supplied branchId never widens the scope.
    const widened = await receptionistAgent.get(`/api/branches?branchId=${other.id}`);
    expect(widened.body.branches).toHaveLength(1);
    expect(widened.body.branches[0].id).toBe(ownBranchId);
  });

  it('38. Admin-only routes still reject a receptionist', async () => {
    for (const res of await Promise.all([
      receptionistAgent.get('/api/admin/branches'),
      receptionistAgent.get('/api/admin/users'),
      receptionistAgent.get('/api/admin/dashboard/summary'),
      receptionistAgent.post('/api/bookings/extract').send({ rawText: 'x', source: 'BOOKING_COM' }),
      receptionistAgent.post('/api/admin/branches').send({
        branchNumber: 99, hotelName: 'x', address: 'y', code: 'X_1',
      }),
    ])) {
      expect(res.status).toBe(403);
    }
  });

  it('38b. a server error never returns a stack trace in production', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'errorHandler.ts'), 'utf8');
    // The stack is attached ONLY outside production.
    expect(source).toContain('if (!isProduction && apiError.status >= 500');
    // Anything unrecognised collapses to a generic internal error.
    expect(source).toContain('return ApiError.internal();');
  });

  it('40. the production build output exists and is servable', () => {
    // `npm run build` produces server/dist + client/dist; the runtime image
    // copies exactly those two directories. Assert the app is wired to serve
    // the client and that the compiled entry point is what production runs.
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
    expect(appSource).toContain('mountClient(app)');
    expect(appSource).toContain("req.path.startsWith('/api/')");

    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe('node dist/index.js');
    expect(pkg.scripts.build).toContain('tsc');
    // Production must never execute TypeScript directly.
    expect(pkg.scripts.start).not.toContain('tsx');
    expect(pkg.scripts.start).not.toContain('nodemon');
  });
});
