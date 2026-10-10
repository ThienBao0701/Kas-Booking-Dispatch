/**
 * THIS BATCH'S RULES, each pinned:
 *   1. "Hoàn thành" needs "Đúng" or "Sai" — one rule for incidents and the
 *      journal; "Sai" needs its reason; the archive splits by it.
 *   2. "Giao kỹ thuật" for a room's chosen subset: exactly those, together.
 *   3. "Chuyển về chờ giao kỹ thuật": history kept, given again later.
 *   4. "Xóa": a void — gone from every list, the journal entry with it; only
 *      the incident's own branch and the supervisors in scope may do it.
 *   5. The shared report period: business dates and the shifts that ran.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetReportData, resetShiftData, testPrisma } from './helpers/db';
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
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let tech: Agent;
let techId = 0;

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
  await createUser({ username: 'kythuat1', password: PASSWORD, fullName: 'Nguyễn Văn A', role: 'TECHNICAL', branchId: null, mustChangePassword: false });
  tech = (await loginAgent(app, 'kythuat1', PASSWORD)).agent;
  techId = await userIdOf(tech);
});

beforeEach(async () => {
  await resetReportData();
  await resetIssueData();
  await resetShiftData();
  await testPrisma.notification.deleteMany({});
  setClock({ now: () => hcm('2026-10-01', '09:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function report(agent: Agent, body: Record<string, unknown> = {}): Promise<string> {
  const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'Sự cố', ...body });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

async function acceptedBy(agent: Agent, id: string): Promise<void> {
  await assignTo(admin, id, agent);
  expect((await agent.post(`/api/issues/${id}/accept`).send({ technicianName: 'Nguyễn Văn A', technicianPhone: '0901234567' })).status).toBe(200);
}

/* 1 --------------------------------------------------------------- verdict */

describe('"Hoàn thành" — Đúng / Sai, one rule', () => {
  it('refuses a completion without a verdict, and "Sai" without its reason', async () => {
    const id = await report(letan1);
    await acceptedBy(tech, id);
    expect((await tech.post(`/api/issues/${id}/complete`).send({})).status).toBe(422);
    expect((await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'INCORRECT', incorrectReason: '  ' })).status).toBe(422);
    const res = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'INCORRECT', incorrectReason: 'Máy lạnh vẫn chạy bình thường' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'COMPLETED', reportVerdict: 'INCORRECT', incorrectReason: 'Máy lạnh vẫn chạy bình thường' });
  });

  it('keeps "Cách xử lý" optional on "Đúng"', async () => {
    const id = await report(letan1);
    await acceptedBy(tech, id);
    const res = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });
    expect(res.body.issue).toMatchObject({ status: 'COMPLETED', reportVerdict: 'CORRECT', incorrectReason: null });
  });

  it('applies the same rule to a guest request, and the archive splits by it', async () => {
    await letan1.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn A' });
    const make = async (note: string) =>
      (await letan1.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'Khách', note } })).body.report.id as string;
    const right = await make('Gửi balo');
    const wrong = await make('Báo nhầm phòng');
    expect((await letan1.post(`/api/reception/reports/${wrong}/complete`).send({})).status).toBe(422);
    expect((await letan1.post(`/api/reception/reports/${wrong}/complete`).send({ verdict: 'INCORRECT' })).status).toBe(422);
    expect((await letan1.post(`/api/reception/reports/${wrong}/complete`).send({ verdict: 'INCORRECT', incorrectReason: 'Khách đã nhận đồ' })).status).toBe(200);
    expect((await letan1.post(`/api/reception/reports/${right}/complete`).send({ verdict: 'CORRECT' })).status).toBe(200);

    // 12 hours later both are in "Hoàn thành vấn đề" — each under its own view.
    setClock({ now: () => hcm('2026-10-01', '23:00') });
    const ids = async (verdict: string) =>
      ((await admin.get(`/api/reception/reports/archive?from=2026-10-01&to=2026-10-01&verdict=${verdict}`)).body.reports as { id: string }[]).map((r) => r.id);
    expect(await ids('CORRECT')).toEqual([right]);
    expect(await ids('INCORRECT')).toEqual([wrong]);
  });
});

/* 2 ---------------------------------------------------- a room's subset */

describe('"Giao kỹ thuật" for a room — exactly the chosen incidents', () => {
  it('assigns 3 of a room’s 4 incidents together; the fourth keeps waiting', async () => {
    const ids: string[] = [];
    for (const category of ['AIR_CONDITIONER', 'TV', 'WATER', 'OTHER']) {
      ids.push(await report(letan1, { roomNumber: '202', category, description: `Phòng 202 — ${category}` }));
    }
    const res = await admin.post('/api/issues/assign').send({ issueIds: ids.slice(0, 3), technicianUserId: techId });
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(3);

    const mine = (await tech.get('/api/issues?stage=WAITING')).body.issues as { id: string }[];
    expect(mine.map((i) => i.id).sort()).toEqual(ids.slice(0, 3).sort());
    const fourth = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: ids[3]! } });
    expect(fourth.assignedTechnicianUserId).toBeNull();
    // One notification names the batch.
    expect(await testPrisma.notification.count({ where: { userId: techId } })).toBe(1);
  });

  it('is all-or-nothing, and refused outside the assigner’s role', async () => {
    const open = await report(letan1, { roomNumber: '202' });
    const working = await report(letan1, { roomNumber: '202', category: 'TV' });
    await acceptedBy(tech, working);
    expect((await admin.post('/api/issues/assign').send({ issueIds: [open, working], technicianUserId: techId })).status).toBe(409);
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: open } })).assignedTechnicianUserId).toBeNull();
    expect((await letan1.post('/api/issues/assign').send({ issueIds: [open], technicianUserId: techId })).status).toBe(403);
  });
});

/* 3 ------------------------------------------------------------- unassign */

describe('"Chuyển về chờ giao kỹ thuật"', () => {
  it('returns an assigned incident to the queue, keeps the history, and can be given again', async () => {
    const id = await report(letan1);
    await assignTo(admin, id, tech);
    expect((await letan2.post(`/api/issues/${id}/unassign`)).status).toBe(403);
    expect((await tech.post(`/api/issues/${id}/unassign`)).status).toBe(403);
    const res = await letan1.post(`/api/issues/${id}/unassign`);
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ assignedTechnician: null, assignmentState: 'UNASSIGNED' });
    expect(res.body.issue.assignments).toHaveLength(1);
    expect(res.body.issue.assignments[0]).toMatchObject({ technicianName: 'Nguyễn Văn A', returnedByName: 'Lễ tân CN1' });
    expect((await tech.get('/api/issues?stage=WAITING')).body.issues).toHaveLength(0);
    // Not assigned any more: nothing to take back; and it can be given again.
    expect((await letan1.post(`/api/issues/${id}/unassign`)).status).toBe(409);
    await assignTo(admin, id, tech);
  });

  it('leaves an accepted repair with the technician', async () => {
    const id = await report(letan1);
    await acceptedBy(tech, id);
    expect((await admin.post(`/api/issues/${id}/unassign`)).status).toBe(409);
  });
});

/* 4 ----------------------------------------------------------------- void */

describe('"Xóa" — a void, scoped like the incident', () => {
  it('removes the incident from every list and count, and voids its journal entry', async () => {
    await letan1.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn A' });
    const id = await report(letan1);
    const journal = await letan1.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: id } });
    expect(journal.status).toBe(201);
    await assignTo(admin, id, tech);

    expect((await letan2.post(`/api/issues/${id}/void`).send({})).status).toBe(403);
    expect((await tech.post(`/api/issues/${id}/void`).send({})).status).toBe(403);
    expect((await letan1.post(`/api/issues/${id}/void`).send({ reason: 'Báo trùng' })).status).toBe(200);

    expect((await admin.get('/api/issues')).body.issues).toHaveLength(0);
    expect((await tech.get('/api/issues?stage=WAITING')).body.issues).toHaveLength(0);
    expect((await admin.get('/api/issues/summary')).body.summary.totalUnresolved).toBe(0);
    expect((await letan1.get('/api/issues/similar?areaCategory=ROOM&roomNumber=301&category=AIR_CONDITIONER')).body.open).toHaveLength(0);
    expect((await admin.get(`/api/issues/${id}`)).status).toBe(404);
    // Kept, not removed — with who, when and why.
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ voidedByNameSnapshot: 'Lễ tân CN1', voidReason: 'Báo trùng' });
    const entry = await testPrisma.receptionOperationalReport.findUniqueOrThrow({ where: { id: journal.body.report.id } });
    expect(entry.voidedAt).not.toBeNull();
    // The technician holding it is told.
    expect(await testPrisma.notification.count({ where: { userId: techId, title: 'Sự cố đã bị xóa' } })).toBe(1);
  });

  it('keeps a finished incident', async () => {
    const id = await report(letan1);
    await acceptedBy(tech, id);
    await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });
    expect((await admin.post(`/api/issues/${id}/void`).send({})).status).toBe(409);
  });
});

/* 5 --------------------------------------------------- the report period */

describe('the shared report period — business dates and the shifts that ran', () => {
  it('puts a Ca C incident at 01:30 on the 2nd on the 1st, and offers only the shifts that ran', async () => {
    setClock({ now: () => hcm('2026-10-01', '22:05') });
    expect((await letan1.post('/api/reception/shifts/check-in').send({ shiftType: 'C', receptionistName: 'Nguyễn C' })).status).toBe(201);
    setClock({ now: () => hcm('2026-10-02', '01:30') });
    const id = await report(letan1);

    const shifts = await admin.get('/api/reception/shifts/available?from=2026-10-01&to=2026-10-01');
    expect(shifts.status).toBe(200);
    expect(shifts.body.shifts.map((s: { code: string }) => s.code)).toEqual(['C']);
    expect((await admin.get('/api/reception/shifts/available?from=2026-10-02&to=2026-10-02')).body.shifts).toEqual([]);

    const list = async (q: string) => ((await admin.get(`/api/issues?${q}`)).body.issues as { id: string }[]).map((i) => i.id);
    expect(await list('from=2026-10-01&to=2026-10-01')).toEqual([id]);
    expect(await list('from=2026-10-01&to=2026-10-01&shiftType=C')).toEqual([id]);
    expect(await list('from=2026-10-01&to=2026-10-01&shiftType=A')).toEqual([]);
    expect(await list('from=2026-10-02&to=2026-10-02')).toEqual([]);
    // A branch outside the reader's scope is refused.
    expect((await letan1.get(`/api/reception/shifts/available?from=2026-10-01&to=2026-10-01&branchId=${cn2}`)).status).toBe(403);
  });
});
