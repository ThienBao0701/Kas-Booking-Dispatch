/**
 * THIS BATCH'S RULES, each pinned:
 *   1. Floors come from the branch's floor catalog (Chi nhánh 4: two buildings).
 *   2. "Có thể bị trùng": one structured key — branch, area, room/floor/fixture,
 *      fault type — finds the same problem in every area; it warns, never blocks.
 *   3. Quản lý kỹ thuật: its ticked branches only — incidents, assignment, export.
 *   4. A repair in stages: numbered in order, the incident stays "Đang sửa" until
 *      "Đã xử lý xong"; a repeat shows what was done last time.
 *   5. Accounts: edited in place; deleted permanently, history kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { assignTo, userIdOf } from './helpers/issues';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { DELETED_ACCOUNT_NAME, DELETED_ACCOUNT_USERNAME } from '../src/auth/deleteAccount';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';

let cn1 = 0;
let cn4 = 0;
let admin: Agent;
let letan1: Agent;
let letan4: Agent;
let tech: Agent;
let tech2: Agent;
let techManager: Agent;
let managerId = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn4 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'NGUYEN_THAI_BINH_170' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn4, { username: 'letan4', fullName: 'Lễ tân CN4', mustChangePassword: false });
  letan4 = (await loginAgent(app, 'letan4', RECEPTIONIST_PASSWORD)).agent;
  for (const [username, fullName] of [
    ['kythuat1', 'Nguyễn Văn A'],
    ['kythuat2', 'Nguyễn Văn B'],
  ] as const) {
    await createUser({ username, password: PASSWORD, fullName, role: 'TECHNICAL', branchId: null, mustChangePassword: false });
  }
  tech = (await loginAgent(app, 'kythuat1', PASSWORD)).agent;
  tech2 = (await loginAgent(app, 'kythuat2', PASSWORD)).agent;

  // The Quản lý kỹ thuật is created the way the Admin creates it: with ticked branches.
  const created = await admin.post('/api/admin/users').send({
    username: 'qlkt1',
    fullName: 'Quản lý kỹ thuật',
    temporaryPassword: PASSWORD,
    role: 'TECHNICAL_MANAGER',
    branchIds: [cn1],
  });
  expect(created.status).toBe(201);
  managerId = created.body.user.id as number;
  await testPrisma.user.update({ where: { id: managerId }, data: { mustChangePassword: false } });
  techManager = (await loginAgent(app, 'qlkt1', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-10-01', '09:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function report(agent: Agent, body: Record<string, unknown>): Promise<string> {
  const res = await agent.post('/api/issues').send({ description: 'Sự cố', ...body });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

/* 1 ---------------------------------------------------------------- floors */

describe('the floor catalog', () => {
  it('is served with the rooms, and keeps Chi nhánh 4’s two buildings apart', async () => {
    const one = await letan1.get(`/api/branches/${cn1}/rooms`);
    expect(one.body.floors).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const four = await letan4.get(`/api/branches/${cn4}/rooms`);
    expect(four.body.floors).toContain('2 (Khu Suite)');
    expect(four.body.floors).toContain('2 (Tòa bên cạnh)');
    expect(four.body.floors).not.toContain('1 (Tòa bên cạnh)');
  });

  it('refuses a floor the branch does not have', async () => {
    expect((await letan1.post('/api/issues').send({ areaCategory: 'HALLWAY', floorNumber: '8', description: 'x' })).status).toBe(422);
    const ok = await letan1.post('/api/issues').send({ areaCategory: 'HALLWAY', floorNumber: '7', description: 'Đèn hỏng' });
    expect(ok.status).toBe(201);
    expect(ok.body.issue.locationLabel).toContain('Tầng 7');
    expect((await letan4.post('/api/issues').send({ areaCategory: 'STAIRCASE', floorNumber: '9', description: 'x' })).status).toBe(422);
    const suite = await letan4.post('/api/issues').send({ areaCategory: 'STAIRCASE', floorNumber: '2 (Tòa bên cạnh)', description: 'x' });
    expect(suite.status).toBe(201);
    expect(suite.body.issue.locationLabel).toContain('Tầng 2 (Tòa bên cạnh)');
  });
});

/* 2 ------------------------------------------------------------ duplicates */

describe('"Vấn đề này có thể bị trùng" — the structured key, in every area', () => {
  it('finds the same room and fault, not another fault or room', async () => {
    const id = await report(letan1, { areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER' });
    const same = await letan1.get('/api/issues/similar?areaCategory=ROOM&roomNumber=301&category=AIR_CONDITIONER');
    expect(same.body.open.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(same.body.open[0]).toMatchObject({ description: 'Sự cố', reporterName: 'Lễ tân CN1' });
    expect((await letan1.get('/api/issues/similar?areaCategory=ROOM&roomNumber=301&category=TV')).body.open).toHaveLength(0);
    expect((await letan1.get('/api/issues/similar?areaCategory=ROOM&roomNumber=302&category=AIR_CONDITIONER')).body.open).toHaveLength(0);
    // A warning, never a block: the second report still goes in.
    await report(letan1, { areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'Ca B báo lại' });
  });

  it('finds a hallway by its floor, and a lobby by its fixture', async () => {
    const hall = await report(letan1, { areaCategory: 'HALLWAY', floorNumber: '3' });
    const lobby = await report(letan1, { areaCategory: 'LOBBY', areaSubtype: 'SOFA' });
    const byFloor = await letan1.get('/api/issues/similar?areaCategory=HALLWAY&floorNumber=3');
    expect(byFloor.body.open.map((i: { id: string }) => i.id)).toEqual([hall]);
    expect((await letan1.get('/api/issues/similar?areaCategory=HALLWAY&floorNumber=4')).body.open).toHaveLength(0);
    expect((await letan1.get('/api/issues/similar?areaCategory=STAIRCASE&floorNumber=3')).body.open).toHaveLength(0);
    const byFixture = await letan1.get('/api/issues/similar?areaCategory=LOBBY&areaSubtype=SOFA');
    expect(byFixture.body.open.map((i: { id: string }) => i.id)).toEqual([lobby]);
    // A branch's key never reaches another branch.
    expect((await letan4.get('/api/issues/similar?areaCategory=HALLWAY&floorNumber=3')).body.open).toHaveLength(0);
  });
});

/* 3 ------------------------------------------------------- technical manager */

describe('a Quản lý kỹ thuật works its ticked branches only', () => {
  it('sees, assigns and exports in scope — and nothing else', async () => {
    const mine = await report(letan1, { areaCategory: 'ROOM', roomNumber: '301', category: 'TV' });
    const other = await report(letan4, { areaCategory: 'ROOM', roomNumber: '201', category: 'TV' });

    const list = await techManager.get('/api/issues?pageSize=500');
    expect(list.body.issues.map((i: { id: string }) => i.id)).toEqual([mine]);
    expect((await techManager.get(`/api/issues/${other}`)).status).toBe(403);

    // It picks a technician by full name, and gives the job — in scope only.
    const technicians = await techManager.get('/api/issues/technicians');
    expect(technicians.body.technicians.map((t: { fullName: string }) => t.fullName)).toEqual(['Nguyễn Văn A', 'Nguyễn Văn B']);
    const techId = await userIdOf(tech);
    expect((await techManager.post(`/api/issues/${mine}/assign`).send({ technicianUserId: techId })).status).toBe(200);
    expect((await techManager.post(`/api/issues/${other}/assign`).send({ technicianUserId: techId })).status).toBe(403);
    const told = await testPrisma.notification.count({ where: { userId: techId, title: 'Bạn được giao xử lý sự cố' } });
    expect(told).toBe(1);

    // The technical report of its branches; nothing of Reception's.
    const day = 'from=2026-10-01&to=2026-10-01';
    const pdf = await techManager.get(`/api/admin/reports/operational.pdf?${day}&section=TECHNICAL&branchIds=${cn1}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toContain('_Ky thuat.pdf');
    expect((await techManager.get(`/api/admin/reports/operational.pdf?${day}&section=TECHNICAL&branchIds=${cn4}`)).status).toBe(403);
    expect((await techManager.get(`/api/admin/reports/operational.pdf?${day}`)).status).toBe(403);
    expect((await techManager.get(`/api/admin/reports/operational.xlsx?${day}&section=HOUSEKEEPING`)).status).toBe(403);
    expect((await techManager.get('/api/reception/reports/active')).status).toBe(403);
    expect((await techManager.get('/api/bookings/new')).status).toBe(403);
  });
});

/* 4 ----------------------------------------------------------- staged repair */

describe('a repair in stages', () => {
  async function working(): Promise<string> {
    const id = await report(letan1, { areaCategory: 'ROOM', roomNumber: '302', category: 'WATER', description: 'Tường phòng bị ẩm nước' });
    await assignTo(admin, id, tech);
    setClock({ now: () => hcm('2026-10-01', '09:30') });
    expect((await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Nguyễn Văn A', technicianPhone: '0900' })).status).toBe(200);
    return id;
  }

  it('records each stage in order, keeps "Đang sửa", and closes on "Đã xử lý xong"', async () => {
    const id = await working();
    setClock({ now: () => hcm('2026-10-01', '11:00') });
    const one = await tech.post(`/api/issues/${id}/stage`).send({ workDone: 'Xác định vị trí thấm nước', nextWork: 'Theo dõi nguồn nước' });
    expect(one.status).toBe(200);
    expect(one.body.issue).toMatchObject({ status: 'IN_PROGRESS', currentStageNumber: 2 });
    expect(one.body.issue.stages[0]).toMatchObject({
      stageNumber: 1,
      workDone: 'Xác định vị trí thấm nước',
      nextWork: 'Theo dõi nguồn nước',
      final: false,
      technicianName: 'Nguyễn Văn A',
      startedAt: hcm('2026-10-01', '09:30').toISOString(),
      completedAt: hcm('2026-10-01', '11:00').toISOString(),
    });

    // Validation, and only the technician holding the job.
    expect((await tech.post(`/api/issues/${id}/stage`).send({ workDone: 'x', nextWork: '  ' })).status).toBe(422);
    expect((await tech2.post(`/api/issues/${id}/stage`).send({ workDone: 'x', nextWork: 'y' })).status).toBe(403);

    setClock({ now: () => hcm('2026-10-02', '10:00') });
    const two = await tech.post(`/api/issues/${id}/stage`).send({ workDone: 'Chống thấm tường', nextWork: 'Sơn lại' });
    expect(two.body.issue.stages[1]).toMatchObject({
      stageNumber: 2,
      startedAt: hcm('2026-10-01', '11:00').toISOString(),
    });

    setClock({ now: () => hcm('2026-10-03', '10:00') });
    const done = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', result: 'Đã sơn lại, tường khô' });
    expect(done.status).toBe(200);
    expect(done.body.issue.status).toBe('COMPLETED');
    expect(done.body.issue.currentStageNumber).toBeNull();
    expect(done.body.issue.stages.map((s: { stageNumber: number; final: boolean }) => [s.stageNumber, s.final])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect((await tech.post(`/api/issues/${id}/stage`).send({ workDone: 'x', nextWork: 'y' })).status).toBe(409);

    // The fault comes back: the new report shows what was done last time.
    const again = await report(letan1, { areaCategory: 'ROOM', roomNumber: '302', category: 'WATER', description: 'Lại ẩm' });
    const seen = await admin.get(`/api/issues/${again}`);
    expect(seen.body.issue.repeatOf.id).toBe(id);
    expect(seen.body.issue.repeatOf.stages.map((s: { workDone: string }) => s.workDone)).toEqual([
      'Xác định vị trí thấm nước',
      'Chống thấm tường',
      'Đã sơn lại, tường khô',
    ]);
  });
});

/* 5 ----------------------------------------------------------------- accounts */

describe('account management', () => {
  it('edits in place: a manager’s branches, a name; never a branch on a housekeeping account', async () => {
    const moved = await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn1, cn4], fullName: 'Quản lý kỹ thuật A' });
    expect(moved.status).toBe(200);
    expect(moved.body.user.fullName).toBe('Quản lý kỹ thuật A');
    expect(moved.body.user.managedBranches.map((b: { id: number }) => b.id).sort()).toEqual([cn1, cn4].sort());
    const hk = await createUser({ username: 'buong_sua', password: PASSWORD, fullName: 'Buồng', role: 'HOUSEKEEPING', branchId: null });
    expect((await admin.put(`/api/admin/users/${hk.id}`).send({ branchId: cn1 })).status).toBe(422);
    await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn1], fullName: 'Quản lý kỹ thuật' });
  });

  it('deletes permanently — refusing live work, keeping every record readable', async () => {
    const gone = await createUser({ username: 'kythuat_xoa', password: PASSWORD, fullName: 'Kỹ thuật Xóa', role: 'TECHNICAL', branchId: null, mustChangePassword: false });
    const goneAgent = (await loginAgent(app, 'kythuat_xoa', PASSWORD)).agent;
    const id = await report(letan1, { areaCategory: 'ROOM', roomNumber: '401', category: 'DOOR' });
    await assignTo(admin, id, goneAgent);

    // Holding a job: refused, with the reason.
    const blocked = await admin.delete(`/api/admin/users/${gone.id}`);
    expect(blocked.status).toBe(409);

    await goneAgent.post(`/api/issues/${id}/accept`).send({ technicianName: 'Kỹ thuật Xóa', technicianPhone: '0900' });
    await goneAgent.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', result: 'Đã thay bản lề' });

    // Not by a manager, not the Admin itself.
    expect((await techManager.delete(`/api/admin/users/${gone.id}`)).status).toBe(403);
    const adminId = await userIdOf(admin);
    expect((await admin.delete(`/api/admin/users/${adminId}`)).status).toBe(403);

    const res = await admin.delete(`/api/admin/users/${gone.id}`);
    expect(res.body).toEqual({ deleted: true, id: gone.id });
    expect(await testPrisma.user.findUnique({ where: { id: gone.id } })).toBeNull();
    // The work is still on file, under the name it was done in.
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id }, include: { stages: true, attempts: true } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.completedByNameSnapshot).toBe('Kỹ thuật Xóa');
    expect(stored.stages[0]!.technicianNameSnapshot).toBe('Kỹ thuật Xóa');
    expect(stored.attempts[0]!.technicianNameSnapshot).toBe('Kỹ thuật Xóa');
    const placeholder = await testPrisma.user.findUniqueOrThrow({ where: { username: DELETED_ACCOUNT_USERNAME } });
    expect(placeholder).toMatchObject({ active: false, fullName: DELETED_ACCOUNT_NAME });
    expect(stored.completedByUserId).toBe(placeholder.id);
    // The placeholder is never listed, and the username is free again.
    const listed = await admin.get('/api/admin/users?includeAdmins=true');
    expect(listed.body.users.map((u: { username: string }) => u.username)).not.toContain(DELETED_ACCOUNT_USERNAME);
    expect((await loginAgent(app, 'kythuat_xoa', PASSWORD)).res.status).not.toBe(200);
  });
});
