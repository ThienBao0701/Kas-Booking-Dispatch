import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { verifyPassword } from '../src/auth/password';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  TEMP_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let branchA: number;
let branchB: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();

  const b0 = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } });
  const b1 = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } });
  branchA = b0.id;
  branchB = b1.id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('POST /api/admin/users', () => {
  it('creates a receptionist with a forced password change', async () => {
    const res = await adminAgent
      .post('/api/admin/users')
      .send({ username: 'LeTanMoi', fullName: 'Lễ Tân Mới', temporaryPassword: TEMP_PASSWORD, branchId: branchA });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      username: 'letanmoi',
      role: 'RECEPTIONIST',
      mustChangePassword: true,
      active: true,
    });
    expect(res.body.user.branch.id).toBe(branchA);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const created = await testPrisma.user.findUniqueOrThrow({ where: { username: 'letanmoi' } });
    expect(created.role).toBe('RECEPTIONIST');
    expect(await verifyPassword(TEMP_PASSWORD, created.passwordHash)).toBe(true);
  });

  it('rejects a duplicate username', async () => {
    await createReceptionist(branchA, { username: 'dup' });
    const res = await adminAgent
      .post('/api/admin/users')
      .send({ username: 'dup', fullName: 'X', temporaryPassword: TEMP_PASSWORD, branchId: branchA });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a non-existent branch', async () => {
    const res = await adminAgent
      .post('/api/admin/users')
      .send({ username: 'x', fullName: 'X', temporaryPassword: TEMP_PASSWORD, branchId: 999999 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an inactive branch', async () => {
    await testPrisma.branch.update({ where: { id: branchB }, data: { active: false } });
    const res = await adminAgent
      .post('/api/admin/users')
      .send({ username: 'y', fullName: 'Y', temporaryPassword: TEMP_PASSWORD, branchId: branchB });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to create an ADMIN, rather than silently downgrading the request', async () => {
    // `role` is a real field since Bộ phận đặt phòng exists, so an ADMIN
    // request is now REJECTED instead of quietly producing a receptionist —
    // the caller learns their request was refused. Either way no admin is
    // ever minted here; an administrator is bootstrapped.
    const res = await adminAgent
      .post('/api/admin/users')
      .send({
        username: 'sneaky',
        fullName: 'Sneaky',
        temporaryPassword: TEMP_PASSWORD,
        branchId: branchA,
        role: 'ADMIN',
      });
    expect(res.status).toBe(422);
    expect(await testPrisma.user.count({ where: { username: 'sneaky' } })).toBe(0);
  });

  it('creates a BOOKING_DEPARTMENT account, which is global and has no branch', async () => {
    const res = await adminAgent.post('/api/admin/users').send({
      username: 'datphong',
      fullName: 'Bộ phận đặt phòng',
      temporaryPassword: TEMP_PASSWORD,
      role: 'BOOKING_DEPARTMENT',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('BOOKING_DEPARTMENT');
    expect(res.body.user.branch).toBeNull();
  });

  it('refuses a branch on a BOOKING_DEPARTMENT account', async () => {
    // A branch would imply a scope this role does not have.
    const res = await adminAgent.post('/api/admin/users').send({
      username: 'datphong2',
      fullName: 'Bộ phận đặt phòng',
      temporaryPassword: TEMP_PASSWORD,
      role: 'BOOKING_DEPARTMENT',
      branchId: branchA,
    });
    expect(res.status).toBe(422);
  });

  it('still requires a branch for a receptionist', async () => {
    const res = await adminAgent.post('/api/admin/users').send({
      username: 'nobranch',
      fullName: 'No Branch',
      temporaryPassword: TEMP_PASSWORD,
      role: 'RECEPTIONIST',
    });
    expect(res.status).toBe(422);
  });
});

describe('admin endpoint authorization', () => {
  it('forbids a receptionist from calling admin endpoints', async () => {
    await createReceptionist(branchA, { username: 'letan' });
    const { agent } = await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD);

    const list = await agent.get('/api/admin/users');
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const create = await agent
      .post('/api/admin/users')
      .send({ username: 'z', fullName: 'Z', temporaryPassword: TEMP_PASSWORD, branchId: branchA });
    expect(create.status).toBe(403);
  });
});

describe('PUT /api/admin/users/:id', () => {
  it('updates fullName and branch', async () => {
    const receptionist = await createReceptionist(branchA, { username: 'upd' });
    const res = await adminAgent
      .put(`/api/admin/users/${receptionist.id}`)
      .send({ fullName: 'Tên Mới', branchId: branchB });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Tên Mới');
    expect(res.body.user.branch.id).toBe(branchB);
  });

  it('refuses to modify an admin account', async () => {
    const admin = await testPrisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const res = await adminAgent.put(`/api/admin/users/${admin.id}`).send({ fullName: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/admin/users/:id/reset-password', () => {
  it('sets a new temporary password, forces a change, and never echoes it', async () => {
    const receptionist = await createReceptionist(branchA, {
      username: 'rst',
      mustChangePassword: false,
    });
    const res = await adminAgent
      .post(`/api/admin/users/${receptionist.id}/reset-password`)
      .send({ temporaryPassword: 'Reset123' });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Reset123');

    const updated = await testPrisma.user.findUniqueOrThrow({ where: { id: receptionist.id } });
    expect(updated.mustChangePassword).toBe(true);
    expect(await verifyPassword('Reset123', updated.passwordHash)).toBe(true);

    const login = await loginAgent(app, 'rst', 'Reset123');
    expect(login.res.status).toBe(200);
  });
});

describe('enable / disable', () => {
  it('disables and re-enables a receptionist', async () => {
    const receptionist = await createReceptionist(branchA, { username: 'toggle' });

    const disabled = await adminAgent.post(`/api/admin/users/${receptionist.id}/disable`);
    expect(disabled.status).toBe(200);
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: receptionist.id } })).active).toBe(false);

    const login = await loginAgent(app, 'toggle', RECEPTIONIST_PASSWORD);
    expect(login.res.status).toBe(403);
    expect(login.res.body.error.code).toBe('ACCOUNT_DISABLED');

    const enabled = await adminAgent.post(`/api/admin/users/${receptionist.id}/enable`);
    expect(enabled.status).toBe(200);
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: receptionist.id } })).active).toBe(true);
  });

  it('revokes a live session when the account is disabled (per-request re-read)', async () => {
    const receptionist = await createReceptionist(branchA, { username: 'live' });
    const { agent } = await loginAgent(app, 'live', RECEPTIONIST_PASSWORD);
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    // Disable directly in the DB (no session destruction) so the block is proven
    // to come from the per-request re-read, not just session invalidation.
    await testPrisma.user.update({ where: { id: receptionist.id }, data: { active: false } });

    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('drops the live session outright when disabled via the endpoint', async () => {
    const receptionist = await createReceptionist(branchA, { username: 'ep' });
    const { agent } = await loginAgent(app, 'ep', RECEPTIONIST_PASSWORD);
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    await adminAgent.post(`/api/admin/users/${receptionist.id}/disable`);

    const after = await agent.get('/api/auth/me');
    expect([401, 403]).toContain(after.status);
  });
});

describe('GET /api/admin/users', () => {
  it('lists only receptionists with safe fields and supports filters', async () => {
    await createReceptionist(branchA, { username: 'alpha', fullName: 'Alpha' });
    await createReceptionist(branchB, { username: 'beta', fullName: 'Beta' });

    const all = await adminAgent.get('/api/admin/users');
    expect(all.status).toBe(200);
    expect(all.body.users.every((u: { role: string }) => u.role === 'RECEPTIONIST')).toBe(true);
    expect(all.body.users.some((u: { username: string }) => u.username === 'admin')).toBe(false);
    expect(JSON.stringify(all.body)).not.toContain('passwordHash');
    expect(all.body.users[0]).toHaveProperty('createdAt');
    expect(all.body.users[0]).toHaveProperty('lastLoginAt');

    const byBranch = await adminAgent.get(`/api/admin/users?branchId=${branchA}`);
    expect(byBranch.body.users.every((u: { branch: { id: number } }) => u.branch.id === branchA)).toBe(true);

    const search = await adminAgent.get('/api/admin/users?search=alph');
    const usernames = search.body.users.map((u: { username: string }) => u.username);
    expect(usernames).toContain('alpha');
    expect(usernames).not.toContain('beta');
  });

  /*
    The account screen's "Admin / Quản trị" section. Opt-in, read-only: the
    default list is unchanged, and an admin listed here still cannot be locked.
  */
  it('lists admins too, only when asked, and still refuses to lock one', async () => {
    await createReceptionist(branchA, { username: 'alpha', fullName: 'Alpha' });

    const withAdmins = await adminAgent.get('/api/admin/users?includeAdmins=true');
    expect(withAdmins.status).toBe(200);
    const admin = withAdmins.body.users.find((u: { username: string }) => u.username === 'admin');
    expect(admin).toMatchObject({ role: 'ADMIN' });
    expect(withAdmins.body.users.some((u: { username: string }) => u.username === 'alpha')).toBe(true);
    expect(JSON.stringify(withAdmins.body)).not.toContain('passwordHash');

    // Without the flag, byte for byte the list it always was.
    const plain = await adminAgent.get('/api/admin/users');
    expect(plain.body.users.some((u: { role: string }) => u.role === 'ADMIN')).toBe(false);

    // Listing grants nothing.
    const lock = await adminAgent.post(`/api/admin/users/${admin.id}/disable`);
    expect(lock.status).toBe(403);
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } })).active).toBe(true);
  });

  it('rejects any other value for includeAdmins', async () => {
    const res = await adminAgent.get('/api/admin/users?includeAdmins=yes');
    expect(res.status).toBe(422);
  });

  it('is refused to a receptionist, flag or not', async () => {
    await createReceptionist(branchA, { username: 'nosy' });
    const { agent } = await loginAgent(app, 'nosy', RECEPTIONIST_PASSWORD);
    expect((await agent.get('/api/admin/users?includeAdmins=true')).status).toBe(403);
  });
});
