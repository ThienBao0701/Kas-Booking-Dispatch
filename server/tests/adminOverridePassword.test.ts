/**
 * "MẬT KHẨU GHI ĐÈ ADMIN" — one Admin-set password that signs in AS a non-Admin
 * account, through the ordinary login.
 *
 *   1  only an Admin reads, sets or turns it off; nobody ever reads it back
 *   2  it is stored as a bcrypt hash — the plaintext is nowhere in the database
 *   3  the account's own password still signs in, unchanged
 *   4  username + override → signed in AS that account, marked and audited
 *   5  after sign-in the session is the account's: no Admin power, no password change
 *   6  a wrong password, an unknown user, or no override set: one generic answer
 *   7  never an Admin account; a disabled account stays disabled
 *   8  changing or turning it off ends the sessions it opened
 *   9  a database without the override migration (the reported "Đã xảy ra lỗi
 *      hệ thống." on "Lưu") answers with what to do; once migrated, "Lưu"
 *      persists the hash and a change replaces it
 */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';

// A fresh app per test, so each test has its own login rate-limit counter.
let app = createApp();
const login = (username: string, password: string) => loginAgent(app, username, password);

const OVERRIDE = 'Ghide2026x';
let cn1 = 0;
let cn2 = 0;
const ids: Record<string, number> = {};

async function adminAgent() {
  return (await login('admin', ADMIN_PASSWORD)).agent;
}

async function setOverride(password = OVERRIDE) {
  const res = await (await adminAgent()).put('/api/admin/override-password').send({ password, confirmPassword: password });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  ids.admin = (await createAdmin({ mustChangePassword: false })).id;
  ids.letan = (await createReceptionist(cn1, { username: 'letan', fullName: 'Lễ tân CN1', mustChangePassword: false })).id;
  ids.letan2 = (await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false })).id;
});

beforeEach(async () => {
  app = createApp();
  await testPrisma.adminOverrideCredential.deleteMany();
  await testPrisma.accountAudit.deleteMany();
  await testPrisma.session.deleteMany();
  await testPrisma.user.updateMany({ where: { id: ids.letan }, data: { active: true } });
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('managing the override password', () => {
  it('1. only an Admin reads, sets or turns it off — and nobody reads the password back', async () => {
    const receptionist = (await login('letan', RECEPTIONIST_PASSWORD)).agent;
    expect((await receptionist.get('/api/admin/override-password')).status).toBe(403);
    expect((await receptionist.put('/api/admin/override-password').send({ password: OVERRIDE, confirmPassword: OVERRIDE })).status).toBe(403);
    expect((await receptionist.delete('/api/admin/override-password')).status).toBe(403);
    expect((await request(app).get('/api/admin/override-password')).status).toBe(401);
    expect(await testPrisma.adminOverrideCredential.count()).toBe(0);

    const admin = await adminAgent();
    expect((await admin.get('/api/admin/override-password')).body).toEqual({ configured: false, updatedAt: null, setByName: null });
    // The account password rule, typed twice.
    expect((await admin.put('/api/admin/override-password').send({ password: 'ngan1', confirmPassword: 'ngan1' })).status).toBe(422);
    expect((await admin.put('/api/admin/override-password').send({ password: OVERRIDE, confirmPassword: 'Khac2026x' })).status).toBe(422);
    expect(await testPrisma.adminOverrideCredential.count()).toBe(0);

    const set = await admin.put('/api/admin/override-password').send({ password: OVERRIDE, confirmPassword: OVERRIDE });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ configured: true, setByName: expect.any(String) });
    expect(Object.keys(set.body).sort()).toEqual(['configured', 'setByName', 'updatedAt']);
    const status = await admin.get('/api/admin/override-password');
    expect(JSON.stringify(status.body)).not.toContain(OVERRIDE);
    expect(JSON.stringify(status.body)).not.toContain('$2');

    const cleared = await admin.delete('/api/admin/override-password');
    expect(cleared.body).toEqual({ configured: false, updatedAt: null, setByName: null });
    expect(
      (await testPrisma.accountAudit.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => [a.action, a.userId, a.actorUserId]),
    ).toEqual([
      ['ADMIN_OVERRIDE_SET', ids.admin, ids.admin],
      ['ADMIN_OVERRIDE_CLEARED', ids.admin, ids.admin],
    ]);
  });

  it('2. only a bcrypt hash is stored — the plaintext is in no credential, audit or session row', async () => {
    await setOverride();
    const row = await testPrisma.adminOverrideCredential.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.passwordHash).not.toBe(OVERRIDE);
    expect(row.passwordHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(OVERRIDE, row.passwordHash)).toBe(true);

    await login('letan', OVERRIDE);
    const everything = JSON.stringify([
      await testPrisma.adminOverrideCredential.findMany(),
      await testPrisma.accountAudit.findMany(),
      await testPrisma.session.findMany(),
      await testPrisma.user.findMany({ select: { passwordHash: true } }),
    ]);
    expect(everything).not.toContain(OVERRIDE);
  });
});

describe('signing in', () => {
  it('3. the account’s own password still signs in, as before — with or without an override set', async () => {
    await setOverride();
    const { agent, res } = await login('letan', RECEPTIONIST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: ids.letan, role: 'RECEPTIONIST' });
    expect((await agent.get('/api/auth/me')).body.user.id).toBe(ids.letan);
    const sessions = await testPrisma.session.findMany({ where: { userId: ids.letan } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.data).not.toContain('adminOverride');
    expect(await testPrisma.accountAudit.count({ where: { action: 'ADMIN_OVERRIDE_LOGIN' } })).toBe(0);
  });

  it('4. username + override signs in AS that account — marked, audited, its password untouched', async () => {
    await setOverride();
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: ids.letan } });

    const { agent, res } = await login('letan', OVERRIDE);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: ids.letan, username: 'letan', role: 'RECEPTIONIST' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect((await agent.get('/api/auth/me')).body.user).toMatchObject({ id: ids.letan, branch: { id: cn1 } });

    const session = await testPrisma.session.findFirstOrThrow({ where: { userId: ids.letan } });
    expect(JSON.parse(session.data)).toMatchObject({ userId: ids.letan, adminOverride: true });
    const audit = await testPrisma.accountAudit.findMany({ where: { action: 'ADMIN_OVERRIDE_LOGIN' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: ids.letan, actorUserId: ids.admin });

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: ids.letan } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.lastLoginAt?.getTime() ?? null).toBe(before.lastLoginAt?.getTime() ?? null);
    // Its own password still works afterwards.
    expect((await login('letan', RECEPTIONIST_PASSWORD)).res.status).toBe(200);
  });

  it('5. after an override sign-in the session is the account’s — no Admin power, its own branch only', async () => {
    await setOverride();
    const { agent } = await login('letan', OVERRIDE);
    expect((await agent.get('/api/admin/users')).status).toBe(403);
    expect((await agent.get('/api/admin/override-password')).status).toBe(403);
    expect((await agent.get('/api/confidential-reports')).status).toBe(403);
    // The override is not the account's current password: it cannot change it.
    const change = await agent.post('/api/auth/change-password').send({ currentPassword: OVERRIDE, newPassword: 'Moi2026abc' });
    expect(change.status).toBe(401);
  });

  it('6. a wrong password, an unknown user, or no override set: the same generic refusal, nothing audited', async () => {
    const refusal = async (username: string, password: string) => {
      const { res } = await login(username, password);
      expect(res.status).toBe(401);
      return res.body.error.code as string;
    };
    // No override set: the override value is just a wrong password.
    expect(await refusal('letan', OVERRIDE)).toBe('INVALID_CREDENTIALS');
    await setOverride();
    expect(await refusal('letan', 'Sai2026abc')).toBe('INVALID_CREDENTIALS');
    expect(await refusal('khongton', OVERRIDE)).toBe('INVALID_CREDENTIALS');
    expect(await testPrisma.accountAudit.count({ where: { action: 'ADMIN_OVERRIDE_LOGIN' } })).toBe(0);
    expect(await testPrisma.session.count()).toBe(1); // the Admin's, from setOverride
  });

  it('7. never an Admin account; a disabled account stays disabled', async () => {
    await setOverride();
    const admin = await login('admin', OVERRIDE);
    expect(admin.res.status).toBe(401);
    expect(admin.res.body.error.code).toBe('INVALID_CREDENTIALS');

    await testPrisma.user.update({ where: { id: ids.letan }, data: { active: false } });
    const disabled = await login('letan', OVERRIDE);
    expect(disabled.res.status).not.toBe(200);
    expect(disabled.res.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(await testPrisma.accountAudit.count({ where: { action: 'ADMIN_OVERRIDE_LOGIN' } })).toBe(0);
  });

  it('8. changing or turning it off ends the sessions it opened — and only those', async () => {
    await setOverride();
    const viaOverride = (await login('letan', OVERRIDE)).agent;
    const ordinary = (await login('letan2', RECEPTIONIST_PASSWORD)).agent;

    await setOverride('Moi2026ghide');
    expect((await viaOverride.get('/api/auth/me')).status).toBe(401);
    expect((await ordinary.get('/api/auth/me')).status).toBe(200);
    expect((await login('letan', OVERRIDE)).res.status).toBe(401);
    const again = (await login('letan', 'Moi2026ghide')).agent;
    expect((await again.get('/api/auth/me')).status).toBe(200);

    expect((await (await adminAgent()).delete('/api/admin/override-password')).status).toBe(200);
    expect((await again.get('/api/auth/me')).status).toBe(401);
    expect((await login('letan', 'Moi2026ghide')).res.status).toBe(401);
    expect((await ordinary.get('/api/auth/me')).status).toBe(200);
  });
});

describe('a database the override migration has not reached', () => {
  it('9. "Lưu" fails with what to do, not an anonymous error — and once migrated it persists and updates', async () => {
    const admin = await adminAgent();
    const save = (password: string) =>
      admin.put('/api/admin/override-password').send({ password, confirmPassword: password });

    // The reported failure: the code is newer than the database — the table is
    // not there. Every call answered 500 "Đã xảy ra lỗi hệ thống.".
    await testPrisma.$executeRawUnsafe('ALTER TABLE "AdminOverrideCredential" RENAME TO "AdminOverrideCredential_missing"');
    try {
      for (const res of [await admin.get('/api/admin/override-password'), await save(OVERRIDE)]) {
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(res.body.error.message).toContain('npm run db:migrate');
      }
    } finally {
      await testPrisma.$executeRawUnsafe('ALTER TABLE "AdminOverrideCredential_missing" RENAME TO "AdminOverrideCredential"');
    }
    expect(await testPrisma.accountAudit.count()).toBe(0);

    // Migrated: "Lưu" persists only the hash, audited.
    const first = await save(OVERRIDE);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ configured: true });
    const stored = await testPrisma.adminOverrideCredential.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored).toMatchObject({ setByUserId: ids.admin });
    expect(await bcrypt.compare(OVERRIDE, stored.passwordHash)).toBe(true);

    // Changing it replaces the one row.
    expect((await save('Moi2026ghide')).status).toBe(200);
    const rows = await testPrisma.adminOverrideCredential.findMany();
    expect(rows).toHaveLength(1);
    expect(await bcrypt.compare('Moi2026ghide', rows[0]!.passwordHash)).toBe(true);
    expect(await bcrypt.compare(OVERRIDE, rows[0]!.passwordHash)).toBe(false);
    expect((await testPrisma.accountAudit.findMany()).map((a) => [a.action, a.userId])).toEqual([
      ['ADMIN_OVERRIDE_SET', ids.admin],
      ['ADMIN_OVERRIDE_SET', ids.admin],
    ]);
    expect(JSON.stringify(await testPrisma.adminOverrideCredential.findMany())).not.toContain('Moi2026ghide');
  });
});
