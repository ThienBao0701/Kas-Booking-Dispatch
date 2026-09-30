/**
 * THE RECEPTION SUPERVISORS AND THE TECHNICIAN ASSIGNMENT MODEL.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A Quản lý lễ tân is scoped, on the server, to the branches ticked on its
 *      account — reports, records, incidents, chat — and the Admin moves that
 *      scope on the SAME account. A Tổng quản lý lễ tân reads all eight.
 *   2. A supervisor writes a record for ONE named branch of its scope, marked
 *      with who entered it; a record entered while no shift is open still
 *      reaches the period report.
 *   3. "Chi tiền" is a pure cash payout: no amount collected, cash only.
 *   4. A technician works only what was assigned to them; every assignment and
 *      reassignment is kept; "Không sửa được" hands the job back for
 *      reassignment without losing any of it.
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

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

const MANAGER_PASSWORD = 'Quanly123';
const TECH_PASSWORD = 'Technical1';

let cn1 = 0;
let cn2 = 0;
let cn3 = 0;
let admin: Agent;
let letan1: Agent;
let letan3: Agent;
let manager: Agent;
let managerId = 0;
let general: Agent;
let tech: Agent;
let tech2: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const byCode = async (code: string) => (await testPrisma.branch.findUniqueOrThrow({ where: { code } })).id;
  cn1 = await byCode('TRUONG_DINH_05');
  cn2 = await byCode('LY_TU_TRONG_260');
  cn3 = await byCode('NGUYEN_TRAI_47A');

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn3, { username: 'letan3', fullName: 'Lễ tân CN3', mustChangePassword: false });
  letan3 = (await loginAgent(app, 'letan3', RECEPTIONIST_PASSWORD)).agent;

  // The Quản lý lễ tân is created the way the Admin creates it: with ticked branches.
  const created = await admin.post('/api/admin/users').send({
    username: 'quanly1',
    fullName: 'Quản lý Một',
    temporaryPassword: MANAGER_PASSWORD,
    role: 'RECEPTION_MANAGER',
    branchIds: [cn1, cn2],
  });
  expect(created.status).toBe(201);
  managerId = created.body.user.id as number;
  await testPrisma.user.update({ where: { id: managerId }, data: { mustChangePassword: false } });
  manager = (await loginAgent(app, 'quanly1', MANAGER_PASSWORD)).agent;

  await createUser({
    username: 'tongquanly',
    password: MANAGER_PASSWORD,
    fullName: 'Tổng quản lý',
    role: 'RECEPTION_GENERAL_MANAGER',
    branchId: null,
    mustChangePassword: false,
  });
  general = (await loginAgent(app, 'tongquanly', MANAGER_PASSWORD)).agent;

  for (const [username, fullName] of [
    ['kythuat1', 'Kỹ thuật Một'],
    ['kythuat2', 'Kỹ thuật Hai'],
  ] as const) {
    await createUser({ username, password: TECH_PASSWORD, fullName, role: 'TECHNICAL', branchId: null, mustChangePassword: false });
  }
  tech = (await loginAgent(app, 'kythuat1', TECH_PASSWORD)).agent;
  tech2 = (await loginAgent(app, 'kythuat2', TECH_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  setClock({ now: () => hcm('2026-09-19', '08:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function checkIn(agent: Agent, name: string) {
  const res = await agent.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: name });
  expect(res.status).toBe(201);
}

async function incident(agent: Agent, room: string, category = 'DOOR'): Promise<string> {
  const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: room, category, description: `Phòng ${room}` });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

/* ================================================================== */
/* 1. Scope                                                            */
/* ================================================================== */

describe('a Quản lý lễ tân is its ticked branches, on the server', () => {
  it('lists only its branches, and reaches none of the Admin-only routes', async () => {
    const branches = await manager.get('/api/branches');
    expect(branches.status).toBe(200);
    expect(branches.body.branches.map((b: { id: number }) => b.id).sort()).toEqual([cn1, cn2].sort());
    expect((await manager.get('/api/admin/users')).status).toBe(403);
    expect((await manager.get('/api/admin/bookings/1')).status).toBe(403);
    expect((await manager.get('/api/admin/reports/incidents?from=2026-09-01&to=2026-09-30')).status).toBe(403);
  });

  it('reads its branches’ records and incidents, and refuses another branch', async () => {
    await checkIn(letan1, 'Nguyễn A');
    await checkIn(letan3, 'Trần C');
    await letan1.post('/api/reception/reports').send({ category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'A', description: 'CN1' } });
    await letan3.post('/api/reception/reports').send({ category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'C', description: 'CN3' } });
    const own = await incident(letan1, '301');
    const other = await incident(letan3, '301');

    const period = 'from=2026-09-19&to=2026-09-19';
    const all = await manager.get(`/api/admin/reports/operational?${period}`);
    expect(all.status).toBe(200);
    expect(all.body.reports.map((r: { branchId: number }) => r.branchId)).toEqual([cn1]);
    const theirs = await manager.get(`/api/admin/reports/operational?${period}&branchId=${cn3}`);
    expect(theirs.status === 403 || theirs.body.reports.length === 0).toBe(true);

    const issues = await manager.get('/api/issues');
    expect(issues.body.issues.map((i: { id: string }) => i.id)).toEqual([own]);
    expect((await manager.get(`/api/issues/${other}`)).status).toBe(403);
    // It assigns in its own branches only.
    const techId = await userIdOf(tech);
    expect((await manager.post(`/api/issues/${own}/assign`).send({ technicianUserId: techId })).status).toBe(200);
    expect((await manager.post(`/api/issues/${other}/assign`).send({ technicianUserId: techId })).status).toBe(403);
  });

  it('sees the chat channels of its branches only', async () => {
    const res = await manager.get('/api/chat/channels');
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: { branchId: number }) => c.branchId).sort()).toEqual([cn1, cn2].sort());
  });

  it('follows the Admin’s change of branches on the same account, from the next request', async () => {
    const moved = await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn3] });
    expect(moved.status).toBe(200);
    try {
      const branches = await manager.get('/api/branches');
      expect(branches.body.branches.map((b: { id: number }) => b.id)).toEqual([cn3]);
      // The account is the same one: no new login, no new user.
      expect(await testPrisma.user.count({ where: { username: 'quanly1' } })).toBe(1);
    } finally {
      await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn1, cn2] });
    }
  });

  it('cannot be left with no branch', async () => {
    expect((await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [] })).status).toBe(422);
  });

  it('a Tổng quản lý lễ tân reads all eight', async () => {
    const branches = await general.get('/api/branches');
    expect(branches.body.branches).toHaveLength(8);
  });
});

/* ================================================================== */
/* 2. Supervisor writes, and the report                                */
/* ================================================================== */

describe('a supervisor writes for one named branch', () => {
  const complaint = (branchId?: number) => ({
    ...(branchId ? { branchId } : {}),
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Khách', description: 'Ghi nhận của quản lý' },
  });

  it('refuses no branch and a branch outside the scope; marks the record with its source', async () => {
    expect((await manager.post('/api/reception/reports').send(complaint())).status).toBe(422);
    expect((await manager.post('/api/reception/reports').send(complaint(cn3))).status).toBe(403);

    const res = await manager.post('/api/reception/reports').send(complaint(cn2));
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({ branchId: cn2, sourceLabel: 'Quản lý lễ tân tạo' });
    const stored = await testPrisma.receptionOperationalReport.findUniqueOrThrow({ where: { id: res.body.report.id } });
    expect(stored.createdByRole).toBe('RECEPTION_MANAGER');
    expect(stored.createdByUserId).toBe(managerId);
  });

  it('reaches the period report and its export even with no shift open', async () => {
    const res = await general.post('/api/reception/reports').send(complaint(cn3));
    expect(res.status).toBe(201);
    expect(res.body.report.sourceLabel).toBe('Tổng quản lý lễ tân tạo');
    const stored = await testPrisma.receptionOperationalReport.findUniqueOrThrow({ where: { id: res.body.report.id } });
    expect(stored.shiftSessionId).toBeNull();

    const period = 'from=2026-09-19&to=2026-09-19';
    const screen = await admin.get(`/api/admin/reports/operational?${period}&branchId=${cn3}`);
    expect(screen.body.reports.map((r: { id: string }) => r.id)).toContain(res.body.report.id);
    // Several branches in one export ("1 + 3"), by the Tổng quản lý.
    const pdf = await general.get(`/api/admin/reports/operational.pdf?${period}&branchIds=${cn1},${cn3}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xlsx = await general.get(`/api/admin/reports/operational.xlsx?${period}&shiftType=A`);
    expect(xlsx.status).toBe(200);
  });
});

/* ================================================================== */
/* 3. "Chi tiền"                                                       */
/* ================================================================== */

describe('"Chi tiền" is a pure cash payout', () => {
  const pay = (payment: Record<string, unknown>) =>
    letan1.post('/api/reception/reports').send({ category: 'PAYMENT', payment: { source: 'Chi tiền', ...payment } });

  it('needs its amount, and never carries an amount collected', async () => {
    await checkIn(letan1, 'Nguyễn A');
    expect((await pay({ method: 'CASH', amount: 0, expense: 0 })).status).toBe(422);
    expect((await pay({ method: 'CASH', amount: 100_000, expense: 50_000 })).status).toBe(422);

    const ok = await pay({ method: 'TRANSFER', amount: 0, expense: 250_000 });
    expect(ok.status).toBe(201);
    expect(ok.body.report.payment).toMatchObject({ source: 'Chi tiền', method: 'CASH', amount: 0, expense: 250_000 });
  });

  it('cannot be corrected into a mixed row', async () => {
    await checkIn(letan1, 'Nguyễn A');
    const created = await pay({ method: 'CASH', amount: 0, expense: 250_000 });
    const res = await letan1.patch(`/api/reception/reports/${created.body.report.id}`).send({ payment: { amount: 300_000 } });
    expect(res.status).toBe(422);
  });
});

/* ================================================================== */
/* 4. Assignment                                                       */
/* ================================================================== */

describe('a technician works only what was assigned to them', () => {
  it('sees nothing unassigned, and cannot take it', async () => {
    const id = await incident(letan1, '301');
    expect((await tech.get('/api/issues')).body.issues).toHaveLength(0);
    expect((await tech.get(`/api/issues/${id}`)).status).toBe(403);
    expect((await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'A', technicianPhone: '1' })).status).toBe(403);
    // Neither a receptionist nor a technician assigns.
    const techId = await userIdOf(tech);
    expect((await letan1.post(`/api/issues/${id}/assign`).send({ technicianUserId: techId })).status).toBe(403);
    expect((await tech.post(`/api/issues/${id}/assign`).send({ technicianUserId: techId })).status).toBe(403);
    // Only an active technician can be given a job.
    expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: managerId })).status).toBe(422);
  });

  it('keeps every assignment, reassignment and "Không sửa được", and notifies each technician', async () => {
    const id = await incident(letan1, '301');
    await assignTo(admin, id, tech);
    expect((await tech.get('/api/issues?stage=WAITING')).body.issues).toHaveLength(1);

    // Moved before it was taken: the first technician no longer holds it.
    setClock({ now: () => hcm('2026-09-19', '08:10') });
    await assignTo(manager, id, tech2);
    expect((await tech.get('/api/issues?stage=WAITING')).body.issues).toHaveLength(0);
    expect((await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'A', technicianPhone: '1' })).status).toBe(403);

    // The second takes it, cannot repair it, and hands it back for reassignment.
    const accepted = await tech2.post(`/api/issues/${id}/accept`).send({ technicianName: 'Kỹ thuật Hai', technicianPhone: '0900' });
    expect(accepted.status).toBe(200);
    // Taken jobs are not reassigned underneath the technician.
    expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: await userIdOf(tech) })).status).toBe(409);
    const failed = await tech2.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });
    expect(failed.status).toBe(200);
    expect(failed.body.issue).toMatchObject({ status: 'NEW', assignedTechnician: null, assignmentState: 'AWAITING_REASSIGNMENT' });

    // Back to the first technician, with the whole history in view.
    setClock({ now: () => hcm('2026-09-19', '09:00') });
    await assignTo(admin, id, tech);
    const detail = await admin.get(`/api/issues/${id}`);
    const history = detail.body.issue.assignments as { technicianName: string; reassigned: boolean; assignedByName: string }[];
    expect(history.map((a) => [a.technicianName, a.reassigned])).toEqual([
      ['Kỹ thuật Một', false],
      ['Kỹ thuật Hai', true],
      ['Kỹ thuật Một', false],
    ]);
    expect(history[1]!.assignedByName).toBe('Quản lý Một');
    expect(detail.body.issue.attempts).toHaveLength(1);
    expect(await testPrisma.hotelIssueAssignment.count({ where: { issueId: id } })).toBe(3);

    // Each technician was told when the job became theirs.
    const t1 = await testPrisma.notification.count({ where: { userId: await userIdOf(tech), title: 'Bạn được giao xử lý sự cố' } });
    const t2 = await testPrisma.notification.count({ where: { userId: await userIdOf(tech2), title: 'Bạn được giao xử lý sự cố' } });
    expect([t1, t2]).toEqual([2, 1]);

    // The second technician keeps it in their own history ("Lịch sử").
    expect((await tech2.get('/api/issues')).body.issues.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it('flags a repeat of a finished repair — a warning, never a block', async () => {
    const first = await incident(letan1, '302', 'AIR_CONDITIONER');
    await assignTo(admin, first, tech);
    await tech.post(`/api/issues/${first}/accept`).send({ technicianName: 'A', technicianPhone: '1' });
    await tech.post(`/api/issues/${first}/complete`).send({});

    const similar = await letan1.get(`/api/issues/similar?roomNumber=302&category=AIR_CONDITIONER`);
    expect(similar.status).toBe(200);
    expect(similar.body.recent.map((i: { id: string }) => i.id)).toEqual([first]);

    const again = await incident(letan1, '302', 'AIR_CONDITIONER');
    const res = await admin.get(`/api/issues/${again}`);
    expect(res.body.issue.repeatOf).toMatchObject({ id: first, technicianName: 'A' });
    // Another room, or another fault, is not a repeat.
    const otherRoom = await incident(letan1, '301', 'AIR_CONDITIONER');
    expect((await admin.get(`/api/issues/${otherRoom}`)).body.issue.repeatOf).toBeNull();
  });
});
