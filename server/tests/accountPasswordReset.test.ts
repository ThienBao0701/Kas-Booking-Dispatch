/**
 * "ĐẶT LẠI MẬT KHẨU" — the Admin sets a new temporary password; nobody can read
 * an existing one.
 *
 *   19  no endpoint returns a password or its hash — not the list, not one
 *       account, not the reset itself
 *   20  the Admin (and only the Admin) can reset; the new password works and
 *       must be changed at first login
 *   21  the new password exists only where the Admin typed it: the server keeps
 *       a hash and never sends it back, so the screen can show it once
 *   22  every reset is audited: who, when, which account — never the value
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const NEW_TEMP = 'Tam7mPq2026';

let admin: Agent;
let adminId = 0;
let letanId = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  letanId = (await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false })).id;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

const leaksSecret = (body: unknown, ...secrets: string[]) => {
  const text = JSON.stringify(body);
  return /password(?!Changed)|passwordHash|\$2[aby]\$/i.test(text.replace(/mustChangePassword/g, '')) || secrets.some((s) => text.includes(s));
};

describe('passwords are never readable', () => {
  it('19. neither the list, one account, the session nor the reset answer carries a password or hash', async () => {
    const list = await admin.get('/api/admin/users').query({ includeAdmins: 'true' });
    expect(list.status).toBe(200);
    expect(leaksSecret(list.body, RECEPTIONIST_PASSWORD, ADMIN_PASSWORD)).toBe(false);
    expect(list.body.users[0]).toHaveProperty('mustChangePassword');
    const me = await admin.get('/api/auth/me');
    expect(leaksSecret(me.body, ADMIN_PASSWORD)).toBe(false);
    const reset = await admin.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: NEW_TEMP });
    expect(reset.status).toBe(200);
    // 21. Only "done": the value lives in the Admin's browser, nowhere else.
    expect(reset.body).toEqual({ success: true });
    expect(leaksSecret((await admin.get('/api/admin/users')).body, NEW_TEMP)).toBe(false);
  });
});

describe('resetting', () => {
  it('20. the Admin resets; the new temporary password works and must be changed', async () => {
    expect((await admin.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: NEW_TEMP })).status).toBe(200);
    const stored = await testPrisma.user.findUniqueOrThrow({ where: { id: letanId } });
    expect(stored.passwordHash).not.toContain(NEW_TEMP);
    expect(stored.mustChangePassword).toBe(true);
    const login = await loginAgent(app, 'letan1', NEW_TEMP);
    expect(login.res.status).toBe(200);
    expect(login.res.body.user.mustChangePassword).toBe(true);
    // A weak one is refused by the same rule as account creation.
    expect((await admin.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: 'abc' })).status).toBe(422);
    // Nobody else may reset: not a manager, not the account itself.
    await createUser({ username: 'tongql', password: 'Matkhau123', fullName: 'Tổng QL', role: 'RECEPTION_GENERAL_MANAGER', branchId: null, mustChangePassword: false });
    const general = (await loginAgent(app, 'tongql', 'Matkhau123')).agent;
    expect((await general.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: NEW_TEMP })).status).toBe(403);
  });

  it('22. every reset is audited — who, when, which account; never the password', async () => {
    await testPrisma.accountAudit.deleteMany();
    expect((await admin.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: NEW_TEMP })).status).toBe(200);
    const audits = await testPrisma.accountAudit.findMany();
    expect(audits).toEqual([
      expect.objectContaining({ userId: letanId, action: 'PASSWORD_RESET', actorUserId: adminId, actorNameSnapshot: 'Quản trị viên', createdAt: expect.any(Date) }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(NEW_TEMP);
    // A refused reset writes nothing.
    await admin.post(`/api/admin/users/${letanId}/reset-password`).send({ temporaryPassword: 'abc' });
    expect(await testPrisma.accountAudit.count()).toBe(1);
  });
});
