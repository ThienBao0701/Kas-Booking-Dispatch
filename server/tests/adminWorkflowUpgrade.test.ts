/**
 * THE ADMIN WORKFLOW UPGRADE — three server-side rules this file pins:
 *
 *   1. "XÁC NHẬN HOÀN THÀNH". A technician's "Hoàn thành" moves an incident to
 *      AWAITING_INSPECTION ("Đã hoàn thành chờ quản lý xác nhận"), never to
 *      COMPLETED. Any ONE of Admin, Tổng quản lý / Quản lý lễ tân, Quản lý /
 *      Tổng quản lý kỹ thuật confirms it, within its branches; nobody else, and
 *      never the person who completed it. A second confirmation is a 409. The
 *      confirmer, role and time are stamped on the incident, the status change
 *      is a HotelIssueEdit row, and only then is it on the completed list.
 *   2. "LỊCH SỬ CHỈNH SỬA". Every audited correction, field by field, scoped by
 *      branch, narrowed by category — and never a deletion.
 *   3. "THÊM CA". A shift the receptionist never checked in to is added CLOSED
 *      at its nominal window, once, for an active receptionist of the branch,
 *      by a reception supervisor — with no report, payment or open shift as a
 *      side effect — and the normal "Nhập bù" then files on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetReportData, resetShiftData, testPrisma } from './helpers/db';
import { serveBranches } from './helpers/issues';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

// The login limiter allows ten sign-ins per app; this file signs in more.
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
let qlkt3: Agent;
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
  // A manager of the OTHER branch only.
  qlkt3 = await staff('qlkt3', 'QLKT Ba', 'TECHNICAL_MANAGER', [cn2]);
  tech = await staff('kythuat', 'Kỹ thuật Một', 'TECHNICAL');
  await serveBranches(ids.kythuat!, [cn1]);
});

beforeEach(async () => {
  await resetIssueData();
  await resetReportData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-10-08', '08:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* 1. Xác nhận hoàn thành                                              */
/* ================================================================== */

/** Reported by the CN1 desk, assigned to and accepted by the technician. */
async function inProgress(): Promise<string> {
  const reported = await admin.post('/api/issues').send({
    branchId: cn1,
    areaCategory: 'ROOM',
    roomNumber: '301',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không lạnh',
  });
  expect(reported.status).toBe(201);
  const id = reported.body.issue.id as string;
  expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: ids.kythuat })).status).toBe(200);
  const accepted = await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0369852177' });
  expect(accepted.status).toBe(200);
  return id;
}

/** ...and finished by the technician: "Đã hoàn thành chờ quản lý xác nhận". */
async function awaiting(body: Record<string, unknown> = { verdict: 'CORRECT', result: 'Đã nạp gas' }): Promise<string> {
  const id = await inProgress();
  const done = await tech.post(`/api/issues/${id}/complete`).send(body);
  expect(done.status).toBe(200);
  return id;
}

const listIds = async (agent: Agent, query: string) => {
  const res = await agent.get(`/api/issues?${query}&pageSize=100`);
  expect(res.status).toBe(200);
  return (res.body.issues as { id: string }[]).map((i) => i.id);
};

describe('a technician’s "Hoàn thành" waits for a manager', () => {
  it('moves the incident to AWAITING_INSPECTION — not completed, on the pending queue, still outstanding', async () => {
    const id = await awaiting();
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('AWAITING_INSPECTION');
    expect(stored.completedByUserId).toBe(ids.kythuat);
    expect(stored.completionConfirmedAt).toBeNull();

    const detail = (await admin.get(`/api/issues/${id}`)).body.issue;
    expect(detail).toMatchObject({
      status: 'AWAITING_INSPECTION',
      stage: 'AWAITING_INSPECTION',
      stageLabel: 'Chờ quản lý xác nhận',
      assignmentStateLabel: 'Đã hoàn thành — chờ quản lý xác nhận',
      completionConfirmation: null,
    });
    expect(await listIds(admin, `branchId=${cn1}&stage=AWAITING_INSPECTION`)).toEqual([id]);
    expect(await listIds(admin, `branchId=${cn1}&stage=COMPLETED`)).toEqual([]);
    expect(await listIds(admin, `branchId=${cn1}&outstanding=true`)).toContain(id);
  });

  it('a "Sai" verdict waits for the confirmation too — no technician closes an incident alone', async () => {
    const id = await awaiting({ verdict: 'INCORRECT', incorrectReason: 'Máy vẫn chạy bình thường' });
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } })).status).toBe('AWAITING_INSPECTION');
  });
});

describe('who may confirm', () => {
  it.each([
    ['Admin', () => admin, 'ADMIN'],
    ['Tổng quản lý lễ tân', () => rgm, 'RECEPTION_GENERAL_MANAGER'],
    ['Quản lý lễ tân (CN1)', () => rm1, 'RECEPTION_MANAGER'],
    ['Quản lý kỹ thuật (CN1)', () => qlkt1, 'TECHNICAL_MANAGER'],
    ['Tổng quản lý kỹ thuật (CN1)', () => tgm, 'TECHNICAL_GENERAL_MANAGER'],
  ] as const)('%s confirms: COMPLETED, stamped, audited, and on the completed list', async (_name, agentOf, role) => {
    const id = await awaiting();
    setClock({ now: () => hcm('2026-10-08', '09:15') });
    const res = await agentOf().post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'COMPLETED',
      stage: 'COMPLETED',
      inspectionState: 'PASSED',
      completionConfirmation: { role, confirmedAt: hcm('2026-10-08', '09:15').toISOString() },
    });

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: 'COMPLETED', completionConfirmedByRole: role });
    expect(stored.completionConfirmedByUserId).not.toBeNull();
    // Before → after, in the incident's own audit trail.
    const edits = await testPrisma.hotelIssueEdit.findMany({ where: { issueId: id, field: 'status' } });
    expect(edits).toEqual([
      expect.objectContaining({ oldValue: 'AWAITING_INSPECTION', newValue: 'COMPLETED', actorUserId: stored.completionConfirmedByUserId }),
    ]);
    // The attempt it judged carries the verdict.
    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt.inspectionResult).toBe('PASSED');

    expect(await listIds(admin, `branchId=${cn1}&stage=COMPLETED`)).toEqual([id]);
    expect(await listIds(admin, `branchId=${cn1}&stage=AWAITING_INSPECTION`)).toEqual([]);
    expect(await listIds(admin, `branchId=${cn1}&outstanding=true`)).not.toContain(id);
  });

  it('refuses the technician, the receptionist and a manager of another branch — and nothing changes', async () => {
    const id = await awaiting();
    expect((await tech.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(403);
    expect((await letan1.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(403);
    expect((await qlkt3.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(403);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('AWAITING_INSPECTION');
    expect(stored.completionConfirmedAt).toBeNull();
    expect(await testPrisma.hotelIssueEdit.count({ where: { issueId: id } })).toBe(0);
  });

  it('a second confirmation is a 409 and writes nothing twice; concurrent ones produce exactly one', async () => {
    const id = await awaiting();
    const [a, b] = await Promise.all([
      admin.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' }),
      qlkt1.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await rgm.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(409);
    expect(await testPrisma.hotelIssueEdit.count({ where: { issueId: id, field: 'status' } })).toBe(1);
  });

  it('cannot confirm work that is not finished', async () => {
    const id = await inProgress();
    expect((await admin.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(409);
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');
  });

  it('nobody confirms their own completion — the manager who closed outside work is already its confirmer', async () => {
    const id = await awaiting();
    // Pretend the Quản lý kỹ thuật had pressed "Hoàn thành" itself.
    await testPrisma.hotelIssue.update({ where: { id }, data: { completedByUserId: ids.qlkt1 } });
    expect((await qlkt1.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(403);
    expect((await tgm.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' })).status).toBe(200);
  });
});

describe('sending a repair back ("Không đạt")', () => {
  it('needs a reason, then returns it to the queue as rework, audited — reopen still works', async () => {
    const id = await awaiting();
    expect((await rm1.post(`/api/issues/${id}/inspect`).send({ result: 'FAILED' })).status).toBe(422);
    const res = await rm1.post(`/api/issues/${id}/inspect`).send({ result: 'FAILED', note: 'Vẫn chưa lạnh' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'NEW', stage: 'REWORK', completionConfirmation: null });
    const edit = await testPrisma.hotelIssueEdit.findFirstOrThrow({ where: { issueId: id, field: 'status' } });
    expect(edit).toMatchObject({ oldValue: 'AWAITING_INSPECTION', newValue: 'NEW', actorUserId: ids.quanly1 });
    // The assignment is kept on a fail; the next "Tiếp nhận" opens a second attempt.
    expect(res.body.issue.assignedTechnician?.id).toBe(ids.kythuat);
    expect((await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0369852177' })).status).toBe(200);
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(2);
  });
});

/* ================================================================== */
/* 2. Lịch sử chỉnh sửa                                                */
/* ================================================================== */

async function checkIn(agent: Agent, shiftType = 'A', name = 'Người trực') {
  const res = await agent.post('/api/reception/shifts/check-in').send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}

async function complaint(agent: Agent) {
  const res = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Khách A', description: 'Máy lạnh ồn' },
  });
  expect(res.status).toBe(201);
  return res.body.report.id as string;
}

describe('"Lịch sử chỉnh sửa"', () => {
  it('lists each corrected field, old → new, with the record, who, the role and the reason — and never a deletion', async () => {
    setClock({ now: () => hcm('2026-10-08', '07:00') });
    await checkIn(letan1, 'A', 'Lan');
    const edited = await complaint(letan1);
    const deleted = await complaint(letan1);
    setClock({ now: () => hcm('2026-10-08', '09:00') });
    const patch = await rm1
      .patch(`/api/reception/reports/${edited}`)
      .send({ complaint: { guestName: 'Khách B', description: 'Máy lạnh rất ồn' }, reason: 'Ghi sai tên khách' });
    expect(patch.status).toBe(200);
    expect((await rm1.post(`/api/reception/reports/${deleted}/void`).send({ reason: 'Nhập trùng' })).status).toBe(200);

    const res = await rm1.get(`/api/reception/reports/edits?branchId=${cn1}&from=2026-10-08&to=2026-10-08`);
    expect(res.status).toBe(200);
    const edits = res.body.edits as { field: string; oldValue: string; newValue: string; report: { id: string } }[];
    expect(edits.every((e) => e.report.id === edited)).toBe(true);
    expect(edits.map((e) => [e.field, e.oldValue, e.newValue]).sort()).toEqual([
      ['description', 'Máy lạnh ồn', 'Máy lạnh rất ồn'],
      ['guestName', 'Khách A', 'Khách B'],
    ]);
    expect(res.body.edits[0]).toMatchObject({
      action: 'EDIT',
      reason: 'Ghi sai tên khách',
      actor: { id: ids.quanly1, name: 'Quản lý CN1' },
      actorRoleLabel: 'Quản lý lễ tân',
      createdAt: hcm('2026-10-08', '09:00').toISOString(),
      report: { id: edited, category: 'CUSTOMER_COMPLAINT', createdByName: 'Lan', shiftDate: '2026-10-08', voided: false },
    });

    // The deletion is in "Lịch sử xóa" — and only there.
    const removed = await rm1.get(`/api/reception/reports/deleted?branchId=${cn1}`);
    expect((removed.body.reports as { id: string }[]).map((r) => r.id)).toEqual([deleted]);
  });

  it('narrows by category and keeps every reader to its own branches', async () => {
    setClock({ now: () => hcm('2026-10-08', '07:00') });
    await checkIn(letan1, 'A', 'Lan');
    const id = await complaint(letan1);
    expect((await admin.patch(`/api/reception/reports/${id}`).send({ complaint: { guestName: 'Khách C' } })).status).toBe(200);

    expect((await admin.get(`/api/reception/reports/edits?category=CUSTOMER_COMPLAINT`)).body.edits).toHaveLength(1);
    expect((await admin.get(`/api/reception/reports/edits?category=PAYMENT`)).body.edits).toHaveLength(0);
    // The CN1 desk sees its own branch's corrections; CN2's desk does not.
    expect((await letan1.get('/api/reception/reports/edits')).body.edits).toHaveLength(1);
    expect((await letan2.get('/api/reception/reports/edits')).body.edits).toHaveLength(0);
    // A CN1 manager asking for CN2 is refused, and a technician has no journal.
    expect((await rm1.get(`/api/reception/reports/edits?branchId=${cn2}`)).status).toBe(403);
    expect((await tech.get('/api/reception/reports/edits')).status).toBe(403);
  });
});

/* ================================================================== */
/* 3. Thêm ca                                                          */
/* ================================================================== */

const addShift = (agent: Agent, body: Record<string, unknown>) =>
  agent.post('/api/reception/reports/late-entry/sessions').send({
    branchId: cn1,
    date: '2026-10-07',
    shiftType: 'A',
    receptionistUserId: ids.letan1,
    reason: 'Lễ tân quên vào ca A',
    ...body,
  });

describe('"Thêm ca"', () => {
  it('adds the missing shift closed at its nominal window, audited, with nothing else created', async () => {
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    const res = await addShift(rm1, {});
    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      branchId: cn1,
      businessDate: '2026-10-07',
      shiftType: 'A',
      shiftName: 'Ca A',
      receptionist: { id: ids.letan1, name: 'Lễ tân CN1' },
      startedAt: hcm('2026-10-07', '06:00').toISOString(),
      closedAt: hcm('2026-10-07', '14:00').toISOString(),
      backfill: { backfilledByName: 'Quản lý CN1', backfilledByRole: 'RECEPTION_MANAGER', reason: 'Lễ tân quên vào ca A' },
    });
    const stored = await testPrisma.receptionShiftSession.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect(stored).toMatchObject({ userId: ids.letan1, backfilledByUserId: ids.quanly1, openingCash: null });
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { shiftSessionId: stored.id } });
    expect(audit).toMatchObject({ action: 'SHIFT_BACKFILL', reportId: null, actorUserId: ids.quanly1, reason: 'Lễ tân quên vào ca A' });
    // No report, no payment, and the receptionist is not "on shift".
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
    expect((await letan1.get('/api/reception/shifts/current')).body.session ?? null).toBeNull();

    // It is offered with the day's other shifts, marked, and "Nhập bù" files on it.
    const list = await rm1.get(`/api/reception/reports/late-entry/sessions?branchId=${cn1}&date=2026-10-07`);
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([stored.id]);
    const late = await rm1.post('/api/reception/reports/late-entry').send({
      shiftSessionId: stored.id,
      reason: 'Lễ tân quên ghi khoản thu',
      category: 'PAYMENT',
      payment: { source: 'Walking', method: 'CASH', amount: 700000 },
    });
    expect(late.status).toBe(201);
    expect(late.body.report).toMatchObject({
      shiftDate: '2026-10-07',
      createdBy: { id: ids.letan1 },
      lateEntry: { enteredBy: { id: ids.quanly1 } },
      // The record says its shift was added afterwards, and by whom.
      shiftBackfill: { backfilledByName: 'Quản lý CN1', reason: 'Lễ tân quên vào ca A' },
    });

    // Several services of one guest in one "Nhập bù": each its own entry, each audited.
    const services = await rm1.post('/api/reception/reports/late-entry').send({
      shiftSessionId: stored.id,
      reason: 'Lễ tân quên ghi dịch vụ',
      category: 'ROOM_SERVICE',
      roomServices: [
        { serviceType: 'SMOKING', guestName: 'Khách Hút', price: 500000 },
        { serviceType: 'LAUNDRY', guestName: 'Khách Hút', price: 60000 },
      ],
    });
    expect(services.status).toBe(201);
    expect(services.body.reports).toHaveLength(2);
    for (const r of services.body.reports) {
      expect(r).toMatchObject({ shiftDate: '2026-10-07', createdBy: { id: ids.letan1 }, lateEntry: { enteredBy: { id: ids.quanly1 } } });
    }
    const ids2 = services.body.reports.map((r: { id: string }) => r.id);
    expect(await testPrisma.receptionReportAudit.count({ where: { reportId: { in: ids2 }, action: 'LATE_ENTRY' } })).toBe(2);
  });

  it('places an overnight Ca C on its own business date', async () => {
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    const res = await addShift(rgm, { shiftType: 'C' });
    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      businessDate: '2026-10-07',
      startedAt: hcm('2026-10-07', '22:00').toISOString(),
      closedAt: hcm('2026-10-08', '06:00').toISOString(),
    });
  });

  it('refuses a shift that already exists — and returns it, so it is used instead', async () => {
    setClock({ now: () => hcm('2026-10-07', '06:05') });
    const existing = await checkIn(letan1, 'A', 'Lan');
    setClock({ now: () => hcm('2026-10-07', '14:02') });
    expect((await letan1.post('/api/reception/shifts/close').send({})).status).toBe(200);
    setClock({ now: () => hcm('2026-10-08', '10:30') });

    const res = await addShift(rm1, {});
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ shiftSessionId: existing });
    // An overlapping shift of the same receptionist is refused as well.
    expect((await addShift(rm1, { shiftType: 'A4' })).status).toBe(409);
    // Ca B of the same day is genuinely missing, and may be added.
    expect((await addShift(rm1, { shiftType: 'B' })).status).toBe(201);
    expect(await testPrisma.receptionShiftSession.count()).toBe(2);
  });

  it('two managers adding the same shift at once produce one shift and one 409', async () => {
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    const [a, b] = await Promise.all([addShift(rm1, {}), addShift(rgm, {})]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await testPrisma.receptionShiftSession.count()).toBe(1);
    expect(await testPrisma.receptionReportAudit.count({ where: { action: 'SHIFT_BACKFILL' } })).toBe(1);
  });

  it('validates the receptionist, the date, the reason and that the shift is over', async () => {
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    // Another branch's receptionist, a technician, nobody.
    expect((await addShift(rm1, { receptionistUserId: ids.letan2 })).status).toBe(422);
    expect((await addShift(rm1, { receptionistUserId: ids.kythuat })).status).toBe(422);
    expect((await addShift(rm1, { receptionistUserId: 999999 })).status).toBe(422);
    expect((await addShift(rm1, { reason: '   ' })).status).toBe(422);
    expect((await addShift(rm1, { date: '2026-10-09' })).status).toBe(422);
    // Today's Ca B has not ended yet: it is the desk's own to check in to.
    expect((await addShift(rm1, { date: '2026-10-08', shiftType: 'B' })).status).toBe(409);
    expect(await testPrisma.receptionShiftSession.count()).toBe(0);
  });

  it('is the reception supervisors’ only, within their branches', async () => {
    setClock({ now: () => hcm('2026-10-08', '10:30') });
    expect((await addShift(letan1, {})).status).toBe(403);
    expect((await addShift(tech, {})).status).toBe(403);
    expect((await addShift(qlkt1, {})).status).toBe(403);
    expect((await addShift(rm1, { branchId: cn2, receptionistUserId: ids.letan2 })).status).toBe(403);
    expect((await rm1.get(`/api/reception/reports/late-entry/receptionists?branchId=${cn2}`)).status).toBe(403);
    const names = await rm1.get(`/api/reception/reports/late-entry/receptionists?branchId=${cn1}`);
    expect(names.body.receptionists).toEqual([{ id: ids.letan1, fullName: 'Lễ tân CN1' }]);
    expect(await testPrisma.receptionShiftSession.count()).toBe(0);
  });
});
