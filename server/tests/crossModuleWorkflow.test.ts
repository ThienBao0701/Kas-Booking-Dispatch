/**
 * CROSS-MODULE WORKFLOW — the claims this file exists to prove.
 *
 *   A. "Xóa" a journal record: Admin / Quản lý lễ tân / Tổng quản lý lễ tân,
 *      within their branch scope, as an audited void (actor + role + reason); a
 *      deleted payment leaves the drawer's totals; "Lịch sử xóa" shows it to the
 *      people who may see that branch, and to nobody else.
 *   B. A correction a reception manager makes for a receptionist requires a
 *      reason; the record keeps its creator.
 *   C. "Nhập bù": a manager records what the receptionist missed, on the
 *      ORIGINAL shift — it counts on that business date, not today — for the
 *      receptionist who worked it, with the manager and the reason on file.
 *   D. Tổng quản lý kỹ thuật → Quản lý kỹ thuật → kĩ thuật khách sạn / bên ngoài:
 *      branch scope, ownership, contractor validation and privacy, and the
 *      required repair cost at completion.
 *   E. The new role is created with its branches, like a Quản lý kỹ thuật.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { userIdOf } from './helpers/issues';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

// Two apps: the login limiter allows ten sign-ins per app, and this file signs in eleven accounts.
const apps = [createApp(), createApp()];
let logins = 0;
const signIn = async (username: string, password: string) => {
  const res = await loginAgent(apps[Math.floor(logins++ / 8)]!, username, password);
  expect(res.res.status).toBe(200);
  return res.agent;
};
type Agent = Awaited<ReturnType<typeof signIn>>;

const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let rm1: Agent;
let rgm: Agent;
let tgm: Agent;
let qlkt1: Agent;
let qlkt2: Agent;
let tech: Agent;
const ids: Record<string, number> = {};

async function staff(username: string, fullName: string, role: string, branchIds?: number[]) {
  if (branchIds) {
    const res = await admin.post('/api/admin/users').send({ username, fullName, temporaryPassword: PASSWORD, role, branchIds });
    expect(res.status).toBe(201);
    ids[username] = res.body.user.id;
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  } else {
    ids[username] = (await createUser({ username, password: PASSWORD, fullName, role: role as never, branchId: null, mustChangePassword: false })).id;
  }
  return signIn(username, PASSWORD);
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  ids.admin = (await createAdmin({ mustChangePassword: false })).id;
  admin = await signIn('admin', ADMIN_PASSWORD);
  ids.letan1 = (await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false })).id;
  letan1 = await signIn('letan1', RECEPTIONIST_PASSWORD);
  ids.letan2 = (await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false })).id;
  letan2 = await signIn('letan2', RECEPTIONIST_PASSWORD);
  rm1 = await staff('quanly1', 'Quản lý CN1', 'RECEPTION_MANAGER', [cn1]);
  rgm = await staff('tongql', 'Tổng quản lý lễ tân', 'RECEPTION_GENERAL_MANAGER');
  tgm = await staff('tongkt', 'Tổng quản lý kỹ thuật', 'TECHNICAL_GENERAL_MANAGER', [cn1]);
  qlkt1 = await staff('qlkt1', 'QLKT Một', 'TECHNICAL_MANAGER', [cn1]);
  qlkt2 = await staff('qlkt2', 'QLKT Hai', 'TECHNICAL_MANAGER', [cn1]);
  // A manager of the OTHER branch only — never a valid target for a CN1 incident.
  await staff('qlkt3', 'QLKT Ba', 'TECHNICAL_MANAGER', [cn2]);
  tech = await staff('kythuat', 'Kỹ thuật Một', 'TECHNICAL');
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-10-08', '08:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function checkIn(agent: Agent, shiftType = 'A', name = 'Người trực') {
  const res = await agent.post('/api/reception/shifts/check-in').send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}

async function payment(agent: Agent, amount = 500000) {
  const res = await agent.post('/api/reception/reports').send({ category: 'PAYMENT', payment: { source: 'Walking', method: 'CASH', amount } });
  expect(res.status).toBe(201);
  return res.body.report.id as string;
}

async function complaint(agent: Agent) {
  const res = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Khách A', description: 'Máy lạnh ồn' },
  });
  expect(res.status).toBe(201);
  return res.body.report.id as string;
}

async function incident(agent: Agent, room = '301') {
  const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: room, category: 'DOOR', description: `Phòng ${room}` });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

/* ================================================================== */
describe('A. deleting a journal record', () => {
  it('lets a reception manager delete within its scope — audited with its role — and nobody outside it', async () => {
    await checkIn(letan1, 'A', 'Lan');
    await checkIn(letan2, 'A', 'Hoa');
    const own = await complaint(letan1);
    const other = await complaint(letan2);

    // Outside the scope, another branch's desk, and a department with no journal: refused.
    expect((await rm1.post(`/api/reception/reports/${other}/void`).send({ reason: 'Nhầm' })).status).toBe(403);
    expect((await letan2.post(`/api/reception/reports/${own}/void`).send({ reason: 'Nhầm' })).status).toBe(403);
    expect((await tech.post(`/api/reception/reports/${own}/void`).send({ reason: 'Nhầm' })).status).toBe(403);
    expect((await qlkt1.post(`/api/reception/reports/${own}/void`).send({ reason: 'Nhầm' })).status).toBe(403);
    // A reason is required.
    expect((await rm1.post(`/api/reception/reports/${own}/void`).send({ reason: '   ' })).status).toBe(422);

    setClock({ now: () => hcm('2026-10-08', '09:15') });
    const res = await rm1.post(`/api/reception/reports/${own}/void`).send({ reason: 'Ghi trùng' });
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({
      voided: true,
      voidReason: 'Ghi trùng',
      voidedByName: 'Quản lý CN1',
      voidedByRole: 'RECEPTION_MANAGER',
      voidedByRoleLabel: 'Quản lý lễ tân',
      // The original reporter, shift and business date stay.
      createdByName: 'Lan',
      createdByRole: 'RECEPTIONIST',
      shiftType: 'A',
      shiftDate: '2026-10-08',
    });
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { reportId: own, action: 'VOID' } });
    expect(audit).toMatchObject({ actorUserId: ids.quanly1, actorRole: 'RECEPTION_MANAGER', reason: 'Ghi trùng' });
    expect(audit.createdAt.toISOString()).toBe(hcm('2026-10-08', '09:15').toISOString());
    // Once only: a second "Xóa" is a conflict, not a second audit row.
    expect((await rgm.post(`/api/reception/reports/${own}/void`).send({ reason: 'Lần hai' })).status).toBe(409);
    expect(await testPrisma.receptionReportAudit.count({ where: { reportId: own, action: 'VOID' } })).toBe(1);
    // The row is still there.
    expect(await testPrisma.receptionOperationalReport.count({ where: { id: own } })).toBe(1);
  });

  it('takes a deleted payment out of the shift drawer, keeping the row', async () => {
    await checkIn(letan1, 'A', 'Lan');
    const kept = await payment(letan1, 300000);
    const gone = await payment(letan1, 500000);
    expect((await letan1.get('/api/reception/shifts/cash')).body.cash.cashCollected).toBe(800000);
    expect((await rgm.post(`/api/reception/reports/${gone}/void`).send({ reason: 'Thu nhầm' })).status).toBe(200);
    const cash = (await letan1.get('/api/reception/shifts/cash')).body.cash;
    expect(cash.cashCollected).toBe(300000);
    expect(cash.voidedCount).toBe(1);
    const stored = await testPrisma.receptionPayment.findUniqueOrThrow({ where: { reportId: gone } });
    expect(stored.amount).toBe(500000);
    expect(kept).not.toBe(gone);
  });

  it('shows "Lịch sử xóa" to the desk of that branch and the supervisors of it — and to nobody else', async () => {
    await checkIn(letan1, 'A', 'Lan');
    const id = await complaint(letan1);
    expect((await admin.post(`/api/reception/reports/${id}/void`).send({ reason: 'Sai khách' })).status).toBe(200);

    const desk = await letan1.get('/api/reception/reports/deleted');
    expect(desk.status).toBe(200);
    expect(desk.body.reports.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(desk.body.reports[0]).toMatchObject({ voidedByRole: 'ADMIN', createdByName: 'Lan' });
    expect((await rm1.get('/api/reception/reports/deleted')).body.reports).toHaveLength(1);
    // Another branch's desk sees nothing of it; a manager may not ask for a branch outside its scope.
    expect((await letan2.get('/api/reception/reports/deleted')).body.reports).toHaveLength(0);
    expect((await rm1.get(`/api/reception/reports/deleted?branchId=${cn2}`)).status).toBe(403);
    expect((await tech.get('/api/reception/reports/deleted')).status).toBe(403);
    // By business date: the 8th has it, the 7th does not.
    expect((await admin.get('/api/reception/reports/deleted?from=2026-10-08&to=2026-10-08')).body.reports).toHaveLength(1);
    expect((await admin.get('/api/reception/reports/deleted?from=2026-10-07&to=2026-10-07')).body.reports).toHaveLength(0);
  });
});

/* ================================================================== */
describe('B. a manager correcting a receptionist’s record', () => {
  it('requires the reason, records it with the manager, and keeps the creator', async () => {
    await checkIn(letan1, 'A', 'Lan');
    const id = await complaint(letan1);
    const edit = (agent: Agent, body: Record<string, unknown>) => agent.patch(`/api/reception/reports/${id}`).send(body);

    expect((await edit(rm1, { complaint: { description: 'Máy lạnh kêu to' } })).status).toBe(422);
    expect((await edit(rm1, { complaint: { description: 'Máy lạnh kêu to' }, reason: '   ' })).status).toBe(422);
    expect((await edit(rgm, { complaint: { description: 'Máy lạnh kêu to' } })).status).toBe(422);

    const saved = await edit(rm1, { complaint: { description: 'Máy lạnh kêu to' }, reason: 'Lễ tân ghi thiếu' });
    expect(saved.status).toBe(200);
    expect(saved.body.report).toMatchObject({ createdByName: 'Lan', createdByRole: 'RECEPTIONIST' });
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { reportId: id, action: 'EDIT' } });
    expect(audit).toMatchObject({
      field: 'description',
      oldValue: 'Máy lạnh ồn',
      newValue: 'Máy lạnh kêu to',
      reason: 'Lễ tân ghi thiếu',
      actorUserId: ids.quanly1,
      actorRole: 'RECEPTION_MANAGER',
    });
    // The rule is the managers'; the Admin's own edits keep their optional reason.
    expect((await edit(admin, { complaint: { description: 'Máy lạnh rất ồn' } })).status).toBe(200);
  });

  it('leaves a manager’s correction of its OWN record optional', async () => {
    await checkIn(letan1, 'A', 'Lan');
    const created = await rm1.post('/api/reception/reports').send({
      branchId: cn1,
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Khách B', description: 'Ồn' },
    });
    expect(created.status).toBe(201);
    const res = await rm1.patch(`/api/reception/reports/${created.body.report.id}`).send({ complaint: { description: 'Rất ồn' } });
    expect(res.status).toBe(200);
  });
});

/* ================================================================== */
describe('C. "Nhập bù" — a missed record on its original shift', () => {
  async function yesterdaysShift() {
    setClock({ now: () => hcm('2026-10-07', '06:05') });
    const sessionId = await checkIn(letan1, 'A', 'Lan');
    setClock({ now: () => hcm('2026-10-07', '14:02') });
    expect((await letan1.post('/api/reception/shifts/close').send({})).status).toBe(200);
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    return sessionId;
  }

  it('lists the finished shifts of a date, then records on the original shift for the receptionist who worked it', async () => {
    const sessionId = await yesterdaysShift();
    const sessions = await rm1.get(`/api/reception/reports/late-entry/sessions?branchId=${cn1}&date=2026-10-07`);
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toEqual([
      expect.objectContaining({ id: sessionId, shiftType: 'A', businessDate: '2026-10-07', receptionist: { id: ids.letan1, name: 'Lan' } }),
    ]);

    const res = await rm1.post('/api/reception/reports/late-entry').send({
      shiftSessionId: sessionId,
      reason: 'Lễ tân quên ghi khoản thu',
      category: 'PAYMENT',
      payment: { source: 'Walking', method: 'CASH', amount: 700000 },
    });
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({
      shiftSessionId: sessionId,
      shiftType: 'A',
      shiftDate: '2026-10-07',
      createdBy: { id: ids.letan1 },
      createdByName: 'Lan',
      createdByRole: 'RECEPTIONIST',
      createdAt: hcm('2026-10-08', '10:30').toISOString(),
      lateEntry: {
        enteredBy: { id: ids.quanly1, name: 'Quản lý CN1' },
        enteredByRole: 'RECEPTION_MANAGER',
        reason: 'Lễ tân quên ghi khoản thu',
      },
    });
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { reportId: res.body.report.id } });
    expect(audit).toMatchObject({ action: 'LATE_ENTRY', actorUserId: ids.quanly1, actorRole: 'RECEPTION_MANAGER', reason: 'Lễ tân quên ghi khoản thu' });

    // It counts on the 7th, shift A — and not on the 8th, the day it was typed.
    const seventh = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-10-07&to=2026-10-07&category=PAYMENT`);
    expect(seventh.body.reports.map((r: { id: string }) => r.id)).toEqual([res.body.report.id]);
    expect(seventh.body.cash.cashCollected).toBe(700000);
    const shiftA = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-10-07&to=2026-10-07&shiftType=A&category=PAYMENT`);
    expect(shiftA.body.reports).toHaveLength(1);
    const eighth = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-10-08&to=2026-10-08&category=PAYMENT`);
    expect(eighth.body.reports).toHaveLength(0);
  });

  it('requires the reason and a finished shift of its own scope, and is the managers’ only', async () => {
    const sessionId = await yesterdaysShift();
    const body = { shiftSessionId: sessionId, category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'K', description: 'D' } };
    expect((await rm1.post('/api/reception/reports/late-entry').send({ ...body, reason: '  ' })).status).toBe(422);
    expect((await rm1.post('/api/reception/reports/late-entry').send(body)).status).toBe(422);
    // The receptionist itself, and a department with no journal, cannot.
    expect((await letan1.post('/api/reception/reports/late-entry').send({ ...body, reason: 'x' })).status).toBe(403);
    expect((await tech.post('/api/reception/reports/late-entry').send({ ...body, reason: 'x' })).status).toBe(403);
    // An incident is reported now, not back-filled.
    expect(
      (await rm1.post('/api/reception/reports/late-entry').send({ shiftSessionId: sessionId, reason: 'x', category: 'FACILITY_ISSUE', facility: { issueId: 'nope' } })).status,
    ).toBe(422);

    // Another branch's shift is outside the Quản lý lễ tân's scope — by id or by list.
    setClock({ now: () => hcm('2026-10-07', '06:05') });
    const otherSession = await checkIn(letan2, 'A', 'Hoa');
    setClock({ now: () => hcm('2026-10-07', '14:02') });
    await letan2.post('/api/reception/shifts/close').send({});
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    expect((await rm1.post('/api/reception/reports/late-entry').send({ ...body, shiftSessionId: otherSession, reason: 'x' })).status).toBe(403);
    expect((await rm1.get(`/api/reception/reports/late-entry/sessions?branchId=${cn2}&date=2026-10-07`)).status).toBe(403);

    // A shift still open is the desk's own to write on.
    const open = await checkIn(letan1, 'A', 'Lan');
    expect((await rm1.post('/api/reception/reports/late-entry').send({ ...body, shiftSessionId: open, reason: 'x' })).status).toBe(409);

    // The Tổng quản lý lễ tân reaches every branch.
    expect((await rgm.post('/api/reception/reports/late-entry').send({ ...body, shiftSessionId: otherSession, reason: 'Bổ sung' })).status).toBe(201);
  });
});

/* ================================================================== */
describe('D. the technical dispatch chain', () => {
  it('scopes the Tổng quản lý kỹ thuật to the branches ticked on it', async () => {
    const own = await incident(letan1);
    const other = await incident(letan2);
    const list = await tgm.get('/api/issues');
    expect(list.status).toBe(200);
    expect(list.body.issues.map((i: { id: string }) => i.id)).toEqual([own]);
    expect((await tgm.get(`/api/issues/${other}`)).status).toBe(403);
    expect((await tgm.get(`/api/issues?branchId=${cn2}`)).status).toBe(403);
    expect((await tgm.get(`/api/issues/managers?branchId=${cn2}`)).status).toBe(403);
    // The Quản lý kỹ thuật of the branch only, by name.
    const managers = await tgm.get(`/api/issues/managers?branchId=${cn1}`);
    expect(managers.body.managers.map((m: { fullName: string }) => m.fullName)).toEqual(['QLKT Hai', 'QLKT Một']);
    // Its own reception journal is none of its business.
    expect((await tgm.get('/api/reception/reports/deleted')).status).toBe(403);
  });

  it('Tổng quản lý kỹ thuật → Quản lý kỹ thuật: instructions required, the branch’s managers only, the holder owns the next step', async () => {
    const id = await incident(letan1);
    const give = (managerUserId: number, note?: string) => tgm.post(`/api/issues/${id}/dispatch-manager`).send({ managerUserId, note });
    expect((await give(ids.qlkt1!)).status).toBe(422);
    expect((await give(ids.qlkt3!, 'Kiểm tra cửa')).status).toBe(422);
    expect((await qlkt1.post(`/api/issues/${id}/dispatch-manager`).send({ managerUserId: ids.qlkt2, note: 'x' })).status).toBe(403);

    setClock({ now: () => hcm('2026-10-08', '09:00') });
    const res = await give(ids.qlkt1!, 'Kiểm tra bản lề cửa phòng 301');
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'NEW',
      assignmentState: 'MANAGER_ASSIGNED',
      assignedManager: { id: ids.qlkt1, name: 'QLKT Một', assignedByName: 'Tổng quản lý kỹ thuật', note: 'Kiểm tra bản lề cửa phòng 301' },
    });

    // The receiving manager sees who gave it, when, and the instructions.
    const seen = (await qlkt1.get(`/api/issues/${id}`)).body.issue;
    expect(seen.dispatches).toEqual([
      expect.objectContaining({
        kind: 'TO_MANAGER',
        assignedByName: 'Tổng quản lý kỹ thuật',
        assignedByRole: 'TECHNICAL_GENERAL_MANAGER',
        note: 'Kiểm tra bản lề cửa phòng 301',
        manager: { id: ids.qlkt1, name: 'QLKT Một' },
        createdAt: hcm('2026-10-08', '09:00').toISOString(),
      }),
    ]);
    // Another Quản lý kỹ thuật of the branch cannot take the next step.
    expect((await qlkt2.post(`/api/issues/${id}/assign`).send({ technicianUserId: ids.kythuat })).status).toBe(403);
    expect(
      (await qlkt2.post(`/api/issues/${id}/dispatch-external`).send({ name: 'A', phone: '0901234567', specialty: 'Cửa', type: 'INDIVIDUAL', note: 'x' })).status,
    ).toBe(403);
    // The holder hands it to an in-house technician, with instructions kept on the assignment.
    const assigned = await qlkt1.post(`/api/issues/${id}/assign`).send({ technicianUserId: ids.kythuat, note: 'Thay bản lề' });
    expect(assigned.status).toBe(200);
    expect(assigned.body.issue.assignments.at(-1)).toMatchObject({ technicianName: 'Kỹ thuật Một', assignedByName: 'QLKT Một', note: 'Thay bản lề' });
    // One incident throughout — never a copy.
    expect(await testPrisma.hotelIssue.count()).toBe(1);
  });

  it('lets the Tổng quản lý kỹ thuật give a job straight to an in-house technician, inside its branches only', async () => {
    const own = await incident(letan1);
    const other = await incident(letan2);
    const res = await tgm.post(`/api/issues/${own}/assign`).send({ technicianUserId: ids.kythuat, note: 'Ưu tiên sáng nay' });
    expect(res.status).toBe(200);
    expect(res.body.issue.assignments[0]).toMatchObject({ assignedByRole: 'TECHNICAL_GENERAL_MANAGER', note: 'Ưu tiên sáng nay' });
    expect((await tgm.post(`/api/issues/${other}/assign`).send({ technicianUserId: ids.kythuat })).status).toBe(403);
  });

  it('Quản lý kỹ thuật → kĩ thuật bên ngoài: validated contact, no account, kept private, the cost required to complete', async () => {
    const id = await incident(letan1);
    const hire = (body: Record<string, unknown>, agent: Agent = qlkt1) => agent.post(`/api/issues/${id}/dispatch-external`).send(body);
    const valid = { name: 'Nguyễn Thợ', phone: '0901 234 567', specialty: 'Điện lạnh', type: 'COMPANY', company: 'Công ty Lạnh Việt', note: 'Thay block máy lạnh' };
    expect((await hire({ ...valid, company: '' })).status).toBe(422);
    expect((await hire({ ...valid, phone: '12ab' })).status).toBe(422);
    expect((await hire({ ...valid, phone: '0901' })).status).toBe(422);
    expect((await hire({ ...valid, name: ' ' })).status).toBe(422);
    expect((await hire({ ...valid, type: 'TEAM' })).status).toBe(422);
    expect((await hire({ ...valid, note: '' })).status).toBe(422);
    // The Tổng quản lý kỹ thuật and Reception do not hire outside contractors.
    expect((await hire(valid, tgm)).status).toBe(403);
    expect((await hire(valid, letan1)).status).toBe(403);
    const accounts = await testPrisma.user.count();

    setClock({ now: () => hcm('2026-10-08', '10:00') });
    const res = await hire(valid);
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'IN_PROGRESS', assignmentState: 'EXTERNAL_IN_PROGRESS' });
    expect(res.body.issue.externalWork.contractor).toMatchObject({
      name: 'Nguyễn Thợ',
      type: 'COMPANY',
      phone: '0901 234 567',
      specialty: 'Điện lạnh',
      company: 'Công ty Lạnh Việt',
    });
    expect(await testPrisma.user.count()).toBe(accounts);
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id, technicianUserId: null, outcomeAt: null } })).toBe(1);

    // Reception sees that it went outside and to whom — never how to reach them.
    const desk = (await letan1.get(`/api/issues/${id}`)).body.issue;
    expect(desk.externalWork.contractor).toMatchObject({ name: 'Nguyễn Thợ', phone: null, specialty: null, company: null });
    expect(desk.technicianPhone).toBeNull();
    expect(desk.attempts.every((a: { technicianPhone: string | null }) => a.technicianPhone === null)).toBe(true);
    expect(JSON.stringify(desk)).not.toContain('0901 234 567');
    // The Admin reads it in full.
    expect((await admin.get(`/api/issues/${id}`)).body.issue.externalWork.contractor.phone).toBe('0901 234 567');

    // Completion: only the manager who hired it, and only with a valid cost.
    const complete = (body: Record<string, unknown>, agent: Agent = qlkt1) => agent.post(`/api/issues/${id}/complete-external`).send(body);
    expect((await complete({ repairCost: 1000000, verdict: 'CORRECT' }, qlkt2)).status).toBe(403);
    expect((await complete({ verdict: 'CORRECT' })).status).toBe(422);
    expect((await complete({ repairCost: -1, verdict: 'CORRECT' })).status).toBe(422);
    expect((await complete({ repairCost: 1.5, verdict: 'CORRECT' })).status).toBe(422);
    // A formatted string is refused, never coerced into a number.
    expect((await complete({ repairCost: '1000000', verdict: 'CORRECT' })).status).toBe(422);
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');

    setClock({ now: () => hcm('2026-10-08', '15:00') });
    const done = await complete({ repairCost: 0, verdict: 'CORRECT', resolution: 'Bảo hành, không tính phí' });
    expect(done.status).toBe(200);
    expect(done.body.issue).toMatchObject({ status: 'COMPLETED', completedByName: 'QLKT Một' });
    expect(done.body.issue.dispatches.at(-1)).toMatchObject({
      repairCost: 0,
      completedByName: 'QLKT Một',
      completedAt: hcm('2026-10-08', '15:00').toISOString(),
      completionNote: 'Bảo hành, không tính phí',
    });
    const stored = await testPrisma.hotelIssueDispatch.findFirstOrThrow({ where: { issueId: id, kind: 'TO_EXTERNAL' } });
    expect(stored).toMatchObject({ repairCost: 0, completedByUserId: ids.qlkt1, contractorType: 'COMPANY' });
    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt).toMatchObject({ outcome: 'COMPLETED', technicianNameSnapshot: 'Nguyễn Thợ (Công ty Lạnh Việt)' });
    // Once only.
    expect((await complete({ repairCost: 5, verdict: 'CORRECT' })).status).toBe(409);
  });

  it('keeps the cost rules in the database too', async () => {
    const id = await incident(letan1);
    await expect(
      testPrisma.hotelIssueDispatch.create({
        data: {
          issueId: id,
          branchId: cn1,
          kind: 'TO_EXTERNAL',
          assignedByUserId: ids.qlkt1!,
          assignedByNameSnapshot: 'x',
          assignedByRole: 'TECHNICAL_MANAGER',
          note: 'x',
          createdAt: new Date(),
          contractorName: 'A',
          contractorPhone: '0901234567',
          contractorType: 'INDIVIDUAL',
          repairCost: -5,
        },
      }),
    ).rejects.toThrow();
    await expect(
      testPrisma.hotelIssueDispatch.create({
        data: {
          issueId: id,
          branchId: cn1,
          kind: 'TO_EXTERNAL',
          assignedByUserId: ids.qlkt1!,
          assignedByNameSnapshot: 'x',
          assignedByRole: 'TECHNICAL_MANAGER',
          note: 'x',
          createdAt: new Date(),
          contractorName: 'A',
          contractorPhone: '0901234567',
          contractorType: 'COMPANY',
        },
      }),
    ).rejects.toThrow();
  });
});

/* ================================================================== */
describe('E. the Tổng quản lý kỹ thuật account', () => {
  it('is created by the Admin with at least one ticked branch, like a Quản lý kỹ thuật', async () => {
    const base = { username: 'tongkt2', fullName: 'Tổng KT Hai', temporaryPassword: PASSWORD, role: 'TECHNICAL_GENERAL_MANAGER' };
    expect((await admin.post('/api/admin/users').send(base)).status).toBe(422);
    expect((await admin.post('/api/admin/users').send({ ...base, branchId: cn1 })).status).toBe(422);
    const created = await admin.post('/api/admin/users').send({ ...base, branchIds: [cn1, cn2] });
    expect(created.status).toBe(201);
    expect(created.body.user.managedBranches.map((b: { id: number }) => b.id).sort()).toEqual([cn1, cn2].sort());
    expect(await userIdOf(tgm)).toBe(ids.tongkt);
  });
});
