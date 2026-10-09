/**
 * "GIAO KỸ THUẬT" ONLY TO THE TECHNICIANS OF THE INCIDENT'S BRANCH.
 *
 *   1. The Admin ticks a Kỹ thuật viên's branches (UserBranchAssignment), on
 *      creation and later — one or several, never "all" by default.
 *   2. The picker with a branch lists only that branch's technicians, and only
 *      for a branch the reader may see.
 *   3. The server refuses a technician outside the incident's branch, whatever
 *      id the request carries — single and bulk alike, nothing written.
 *   4. An existing technician without branches keeps its account and the job it
 *      already holds; it simply cannot be given new work until the Admin ticks
 *      its branches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, testPrisma } from './helpers/db';
import { serveBranches } from './helpers/issues';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';

const app = createApp();
const app2 = createApp();
const PASSWORD = 'Matkhau123';
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let qlkt1: Agent;
let legacy: Agent;
const ids: Record<string, number> = {};

async function technician(username: string, fullName: string) {
  ids[username] = (await createUser({ username, password: PASSWORD, fullName, role: 'TECHNICAL', branchId: null, mustChangePassword: false })).id;
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

  const created = await admin
    .post('/api/admin/users')
    .send({ username: 'qlkt1', fullName: 'QLKT CN1', temporaryPassword: PASSWORD, role: 'TECHNICAL_MANAGER', branchIds: [cn1] });
  expect(created.status).toBe(201);
  await testPrisma.user.update({ where: { id: created.body.user.id }, data: { mustChangePassword: false } });
  qlkt1 = (await loginAgent(app, 'qlkt1', PASSWORD)).agent;

  await technician('kt_cn1', 'Kỹ thuật CN1');
  await technician('kt_cn2', 'Kỹ thuật CN2');
  await technician('kt_both', 'Kỹ thuật Hai chi nhánh');
  await technician('kt_legacy', 'Kỹ thuật Cũ');
  await serveBranches(ids.kt_cn1!, [cn1]);
  await serveBranches(ids.kt_cn2!, [cn2]);
  await serveBranches(ids.kt_both!, [cn1, cn2]);
  legacy = (await loginAgent(app2, 'kt_legacy', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function incident(agent: Agent, room = '301') {
  const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: room, category: 'DOOR', description: `Phòng ${room}` });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

const names = (res: { body: { technicians: { fullName: string }[] } }) => res.body.technicians.map((t) => t.fullName);

describe('the Admin assigns a technician’s branches', () => {
  it('creates a technician with its branches and replaces them later; a manager-only rule is not imposed', async () => {
    const created = await admin
      .post('/api/admin/users')
      .send({ username: 'kt_new', fullName: 'Kỹ thuật Mới', temporaryPassword: PASSWORD, role: 'TECHNICAL', branchIds: [cn2] });
    expect(created.status).toBe(201);
    expect(created.body.user.managedBranches.map((b: { id: number }) => b.id)).toEqual([cn2]);
    // Still a global department: never one `branchId`.
    expect(created.body.user.branch).toBeNull();

    const moved = await admin.put(`/api/admin/users/${created.body.user.id}`).send({ branchIds: [cn1, cn2] });
    expect(moved.status).toBe(200);
    expect(moved.body.user.managedBranches.map((b: { id: number }) => b.id).sort()).toEqual([cn1, cn2].sort());
    expect((await admin.put(`/api/admin/users/${created.body.user.id}`).send({ branchId: cn1 })).status).toBe(422);

    // An inactive or unknown branch is refused.
    expect((await admin.put(`/api/admin/users/${created.body.user.id}`).send({ branchIds: [999999] })).status).toBe(422);
    await testPrisma.user.delete({ where: { id: created.body.user.id } });
  });

  it('keeps refusing a branch set on roles that have none', async () => {
    const res = await admin
      .post('/api/admin/users')
      .send({ username: 'dp_x', fullName: 'Đặt phòng', temporaryPassword: PASSWORD, role: 'BOOKING_DEPARTMENT', branchIds: [cn1] });
    expect(res.status).toBe(422);
  });
});

describe('the "Giao kỹ thuật" picker', () => {
  it('lists only the technicians of the branch, multi-branch ones in each', async () => {
    expect(names(await admin.get(`/api/issues/technicians?branchId=${cn1}`))).toEqual(['Kỹ thuật CN1', 'Kỹ thuật Hai chi nhánh']);
    expect(names(await admin.get(`/api/issues/technicians?branchId=${cn2}`))).toEqual(['Kỹ thuật CN2', 'Kỹ thuật Hai chi nhánh']);
    // Without a branch: every active technician — the history filters, unchanged.
    expect(names(await admin.get('/api/issues/technicians'))).toEqual([
      'Kỹ thuật CN1',
      'Kỹ thuật CN2',
      'Kỹ thuật Cũ',
      'Kỹ thuật Hai chi nhánh',
    ]);
  });

  it('refuses a branch outside the reader’s scope', async () => {
    expect((await qlkt1.get(`/api/issues/technicians?branchId=${cn1}`)).status).toBe(200);
    expect((await qlkt1.get(`/api/issues/technicians?branchId=${cn2}`)).status).toBe(403);
    expect((await letan1.get(`/api/issues/technicians?branchId=${cn1}`)).status).toBe(403);
  });
});

describe('the server enforces the branch on every assignment', () => {
  it('assigns a technician of the incident’s branch', async () => {
    const id = await incident(letan1);
    const res = await qlkt1.post(`/api/issues/${id}/assign`).send({ technicianUserId: ids.kt_cn1 });
    expect(res.status).toBe(200);
    expect(res.body.issue.assignedTechnician).toMatchObject({ id: ids.kt_cn1 });
    const both = await incident(letan2, '302');
    expect((await admin.post(`/api/issues/${both}/assign`).send({ technicianUserId: ids.kt_both })).status).toBe(200);
  });

  it('refuses a technician of another branch, even by a hand-typed id — nothing is written', async () => {
    const id = await incident(letan1);
    const res = await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: ids.kt_cn2 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Kỹ thuật viên này chưa được phân công cho chi nhánh của sự cố.');
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(issue.assignedTechnicianUserId).toBeNull();
    expect(await testPrisma.hotelIssueAssignment.count()).toBe(0);
  });

  it('refuses a bulk assignment when any incident is outside the technician’s branches — the batch lands whole or not at all', async () => {
    const a = await incident(letan1, '301');
    const b = await incident(letan2, '302');
    const res = await admin.post('/api/issues/assign').send({ issueIds: [a, b], technicianUserId: ids.kt_cn1 });
    expect(res.status).toBe(422);
    expect(await testPrisma.hotelIssueAssignment.count()).toBe(0);
    expect(await testPrisma.hotelIssue.count({ where: { assignedTechnicianUserId: { not: null } } })).toBe(0);
  });
});

describe('an existing technician without branches', () => {
  it('keeps its account and the job it already holds, but cannot be given new work', async () => {
    // A job given before branches existed — the row, as it stands in the database.
    const held = await incident(letan1, '401');
    await testPrisma.hotelIssue.update({
      where: { id: held },
      data: { assignedTechnicianUserId: ids.kt_legacy, assignedTechnicianNameSnapshot: 'Kỹ thuật Cũ', assignedAt: new Date() },
    });
    expect((await legacy.get('/api/auth/me')).status).toBe(200);
    const accepted = await legacy.post(`/api/issues/${held}/accept`).send({ technicianName: 'Kỹ thuật Cũ', technicianPhone: '0901234567' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.issue.status).toBe('IN_PROGRESS');

    // New work: not listed for any branch, and refused by the server.
    expect(names(await admin.get(`/api/issues/technicians?branchId=${cn1}`))).not.toContain('Kỹ thuật Cũ');
    const fresh = await incident(letan1, '402');
    expect((await admin.post(`/api/issues/${fresh}/assign`).send({ technicianUserId: ids.kt_legacy })).status).toBe(422);

    // Once the Admin ticks its branch, it can be given work there — and only there.
    expect((await admin.put(`/api/admin/users/${ids.kt_legacy}`).send({ branchIds: [cn1] })).status).toBe(200);
    expect((await admin.post(`/api/issues/${fresh}/assign`).send({ technicianUserId: ids.kt_legacy })).status).toBe(200);
    const elsewhere = await incident(letan2, '403');
    expect((await admin.post(`/api/issues/${elsewhere}/assign`).send({ technicianUserId: ids.kt_legacy })).status).toBe(422);
    await testPrisma.userBranchAssignment.deleteMany({ where: { userId: ids.kt_legacy } });
  });
});
