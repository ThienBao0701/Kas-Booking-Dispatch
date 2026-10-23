/**
 * THE WORKFLOW UPGRADE — departments, routing, responsibility and shifts.
 *
 *   A  the name on an open shift: its own person corrects it, nothing else changes
 *   B  "Bộ phận nhận việc": routing by who is on shift — and saying so when nobody is
 *   C  "Người xử lý": only the current assignee completes; the completing department kept apart
 *   D  the 12 hours run from the completion; the menu counts open records only
 *   E  "Bộ phận": the filter by the department a request is with
 *   F  Bell: its own work, nothing of the desk's
 *   H  a housekeeper's shift ends by itself — out of work, or at 20:00 — finishing nothing
 *   I  inventory items: "Sửa" and "Xóa", by who manages them, history untouched
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { startShiftAt } from './helpers/workplace';
import { endShiftsAtCutoff, lastShiftCutoff } from '../src/housekeeping/shiftAutoEnd';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-07';
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const at = (day: string, hhmm: string) => setClock({ now: () => hcm(day, hhmm) });

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let qlbp1: Agent;
let qlbp2: Agent;
let lan: Agent;
let hoa: Agent;
let bell1: Agent;
let bell2: Agent;
let letan1Id = 0;
let lanId = 0;
let hoaId = 0;
let bell1Id = 0;
let bell2Id = 0;
let qlbp1Id = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  letan1Id = (await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false })).id;
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân Hai', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  qlbp1Id = (await createUser({ username: 'qlbp1', password: PASSWORD, fullName: 'QL Buồng 1', role: 'HOUSEKEEPING_MANAGER', branchId: cn1 })).id;
  await createUser({ username: 'qlbp2', password: PASSWORD, fullName: 'QL Buồng 2', role: 'HOUSEKEEPING_MANAGER', branchId: cn2 });
  qlbp1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  qlbp2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  lanId = (await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING' })).id;
  hoaId = (await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING' })).id;
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
  bell1Id = (await createUser({ username: 'bell1', password: PASSWORD, fullName: 'Bell Một', role: 'BELL', branchId: cn1 })).id;
  bell2Id = (await createUser({ username: 'bell2', password: PASSWORD, fullName: 'Bell Hai', role: 'BELL', branchId: cn1 })).id;
  bell1 = (await loginAgent(app, 'bell1', PASSWORD)).agent;
  bell2 = (await loginAgent(app, 'bell2', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  await resetHousekeepingData();
  await testPrisma.housekeepingWorkGroup.deleteMany();
  await testPrisma.notification.deleteMany();
  at(DAY, '09:00');
});

afterAll(async () => {
  resetClock();
  await testPrisma.housekeepingWorkGroup.deleteMany();
  await resetAll();
});

const checkIn = async (agent: Agent, name = 'Người trực') =>
  expect((await agent.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: name })).status).toBe(201);
const newRequest = (agent: Agent, receivingDepartment: string | undefined, extra: Record<string, unknown> = {}, note = 'Khách cần thêm gối') =>
  agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'Khách A', note, ...(receivingDepartment ? { receivingDepartment } : {}) }, ...extra });
const complete = (agent: Agent, id: string) => agent.post(`/api/reception/reports/${id}/complete`).send({ verdict: 'CORRECT', resolution: 'Đã làm' });
const stored = (reportId: string) => testPrisma.guestRequestReport.findUniqueOrThrow({ where: { reportId } });

describe('A. the name on an open shift', () => {
  it('is corrected by its own person — the shift, its times, the account and the branch stay — and the change is kept', async () => {
    await checkIn(letan1, 'Lễ tân Sáng');
    const before = await testPrisma.receptionShiftSession.findFirstOrThrow({ where: { userId: letan1Id, closedAt: null } });
    const res = await letan1.patch('/api/reception/shifts/current/name').send({ receptionistName: '  Nguyễn Văn Nam  ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.session).toMatchObject({ receptionistName: 'Nguyễn Văn Nam', shiftType: 'A', branchId: cn1 });
    const after = await testPrisma.receptionShiftSession.findUniqueOrThrow({ where: { id: before.id } });
    expect({ ...after, receptionistName: before.receptionistName, updatedAt: before.updatedAt }).toEqual(before);
    // It persists: the next read (a refresh, a new login) says the new name.
    expect((await letan1.get('/api/reception/shifts/current')).body.session.receptionistName).toBe('Nguyễn Văn Nam');
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { action: 'SHIFT_NAME' } });
    expect(audit).toMatchObject({ shiftSessionId: before.id, oldValue: 'Lễ tân Sáng', newValue: 'Nguyễn Văn Nam', actorUserId: letan1Id });
  });

  it('refuses an empty name, a person with no open shift, and roles that work no desk shift', async () => {
    const offShift = await letan1.patch('/api/reception/shifts/current/name').send({ receptionistName: 'X' });
    expect(offShift.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
    await checkIn(letan1);
    expect((await letan1.patch('/api/reception/shifts/current/name').send({ receptionistName: '   ' })).status).toBe(422);
    for (const agent of [admin, lan, qlbp1]) expect((await agent.patch('/api/reception/shifts/current/name').send({ receptionistName: 'X' })).status).toBe(403);
  });
});

describe('B. "Bộ phận nhận việc" — routed by who is on shift', () => {
  it('is required on a live request', async () => {
    await checkIn(letan1);
    const res = await newRequest(letan1, undefined);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('bộ phận nhận việc');
  });

  it('Lễ tân: the receptionist who took it, on shift here', async () => {
    await checkIn(letan1);
    const res = await newRequest(letan1, 'RECEPTION');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report.guestRequest).toMatchObject({
      receivingDepartment: 'RECEPTION',
      assignee: { id: letan1Id, department: 'RECEPTION' },
    });
  });

  it('Bell: a Bell on shift at the branch — never one off shift — and the work is shared out, least loaded first', async () => {
    await checkIn(letan1);
    await checkIn(bell1, 'Bell Một');
    await checkIn(bell2, 'Bell Hai');
    const first = (await newRequest(letan1, 'BELL', {}, 'Xách hành lý phòng 301')).body.report;
    const second = (await newRequest(letan1, 'BELL', {}, 'Gọi taxi cho phòng 205')).body.report;
    const holders = [first.guestRequest.assignee.id, second.guestRequest.assignee.id].sort();
    expect(holders).toEqual([bell1Id, bell2Id].sort());
    // Each is told once.
    expect(await testPrisma.notification.count({ where: { kind: 'REQUEST_ASSIGNED' } })).toBe(2);
    expect(await testPrisma.notification.findFirstOrThrow({ where: { userId: first.guestRequest.assignee.id } })).toMatchObject({ link: '/app/bell' });
  });

  it('Bell with nobody on shift: refused, saying so — and saved unassigned only when the desk chooses to', async () => {
    await checkIn(letan1);
    const refused = await newRequest(letan1, 'BELL');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ message: expect.stringContaining('không có nhân viên Bell'), details: { reason: 'NO_STAFF_ON_SHIFT', department: 'BELL' } });
    expect(await testPrisma.guestRequestReport.count()).toBe(0);
    const waiting = await newRequest(letan1, 'BELL', { allowUnassigned: true });
    expect(waiting.status).toBe(201);
    expect(waiting.body.report.guestRequest).toMatchObject({ receivingDepartment: 'BELL', assignee: null });
    // A Bell of ANOTHER branch on shift there changes nothing here.
    await checkIn(letan2);
    expect((await newRequest(letan2, 'BELL')).status).toBe(409);
  });

  it('Buồng phòng: waits in the department’s pool — nobody holds it, everyone of it on shift at the branch is told', async () => {
    await checkIn(letan1);
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    await startShiftAt(qlbp1, cn1);
    const a = (await newRequest(letan1, 'HOUSEKEEPING', {}, 'Thay khăn phòng 101')).body.report;
    expect(a.guestRequest.assignee).toBeNull();
    expect(await stored(a.id)).toMatchObject({ receivingDepartment: 'HOUSEKEEPING', assigneeUserId: null });
    const told = await testPrisma.notification.findMany({ where: { dedupeKey: { startsWith: `request-pool:${a.id}:` } } });
    expect(told.map((n) => n.userId).sort()).toEqual([lanId, hoaId, qlbp1Id].sort());
    // Nobody of Buồng phòng on shift at this branch: refused, as for any department.
    await testPrisma.housekeepingWorkSegment.updateMany({ data: { branchId: cn2 }, where: { session: { userId: { in: [lanId, hoaId] } } } });
    await testPrisma.housekeepingWorkSession.updateMany({ where: { userId: qlbp1Id }, data: { endedAt: new Date() } });
    await testPrisma.housekeepingWorkSegment.updateMany({ where: { session: { userId: qlbp1Id } }, data: { endedAt: new Date() } });
    expect((await newRequest(letan1, 'HOUSEKEEPING', {}, 'Mang thêm gối phòng 104')).status).toBe(409);
  });

  it('a housekeeper routed a desk request reads it — and nothing else of the desk', async () => {
    await checkIn(letan1);
    await startShiftAt(lan, cn1);
    const desk = (await newRequest(letan1, 'HOUSEKEEPING')).body.report.id as string;
    const other = (await newRequest(letan1, 'RECEPTION', {}, 'Đổi phòng cho khách')).body.report.id as string;
    const seen = ((await lan.get('/api/reception/reports/housekeeping')).body.reports as { id: string }[]).map((r) => r.id);
    expect(seen).toContain(desk);
    expect(seen).not.toContain(other);
  });
});

describe('C. "Người xử lý" — only the current assignee completes', () => {
  it('refuses everyone else — the Admin who gave it out included — and records who, which department and when', async () => {
    await checkIn(letan1);
    await checkIn(bell1, 'Bell Một');
    await checkIn(bell2, 'Bell Hai');
    const id = (await newRequest(letan1, 'BELL')).body.report.id as string;
    const holder = (await stored(id)).assigneeUserId!;
    const [holderAgent, otherAgent] = holder === bell1Id ? [bell1, bell2] : [bell2, bell1];
    expect((await complete(letan1, id)).status).toBe(403);
    expect((await complete(otherAgent, id)).status).toBe(403);
    expect((await complete(admin, id)).status).toBe(403);
    // "Nhận việc" — the holder's, once.
    expect((await otherAgent.post(`/api/reception/reports/${id}/acknowledge`)).status).toBe(403);
    const ack = await holderAgent.post(`/api/reception/reports/${id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body.report.guestRequest.acknowledgedAt).not.toBeNull();
    at(DAY, '09:40');
    const done = await complete(holderAgent, id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const row = await stored(id);
    expect(row).toMatchObject({ receivingDepartment: 'BELL', assigneeUserId: holder, completedByUserId: holder, completedDepartment: 'BELL', completedAt: hcm(DAY, '09:40') });
  });

  it('moves "Hoàn thành" with a reassignment at once — and keeps the receiving department and both people apart', async () => {
    await checkIn(letan1);
    await checkIn(bell1, 'Bell Một');
    const id = (await newRequest(letan1, 'BELL')).body.report.id as string;
    expect((await stored(id)).assigneeUserId).toBe(bell1Id);
    // Only those who give work out may; the person must be on shift at the branch.
    expect((await letan1.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: letan1Id })).status).toBe(403);
    expect((await admin.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: lanId })).status).toBe(422);
    const moved = await admin.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: letan1Id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await complete(bell1, id)).status).toBe(403);
    expect((await complete(letan1, id)).status).toBe(200);
    expect(await stored(id)).toMatchObject({ receivingDepartment: 'BELL', assigneeUserId: letan1Id, assigneeDepartment: 'RECEPTION', completedByUserId: letan1Id, completedDepartment: 'RECEPTION' });
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { reportId: id, action: 'ASSIGN' } });
    expect(audit).toMatchObject({ oldValue: 'Bell Một', newValue: expect.any(String), field: 'assignee' });
    // Completed: no more giving out.
    expect((await admin.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: null })).status).toBe(409);
  });

  it('a Quản lý buồng phòng gives its branch’s requests to its own housekeepers only, never another branch’s', async () => {
    await checkIn(letan1);
    await startShiftAt(qlbp1, cn1);
    await startShiftAt(lan, cn1);
    await checkIn(bell1, 'Bell Một');
    const id = (await newRequest(letan1, 'HOUSEKEEPING')).body.report.id as string;
    expect((await stored(id)).assigneeUserId).toBeNull();
    expect((await qlbp1.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: bell1Id })).status).toBe(422);
    expect((await qlbp2.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: lanId })).status).toBe(403);
    expect((await qlbp1.post(`/api/reception/reports/${id}/assignee`).send({ assigneeUserId: lanId })).status).toBe(200);
    expect((await complete(qlbp1, id)).status).toBe(403);
    expect((await complete(lan, id)).status).toBe(200);
    expect((await stored(id)).completedDepartment).toBe('HOUSEKEEPING');
  });

  it('keeps the old rule for a request given to nobody — the desk completes it', async () => {
    await checkIn(letan1);
    const id = (await newRequest(letan1, 'BELL', { allowUnassigned: true })).body.report.id as string;
    expect((await complete(letan1, id)).status).toBe(200);
    expect(await stored(id)).toMatchObject({ assigneeUserId: null, completedByUserId: letan1Id, completedDepartment: 'RECEPTION' });
  });
});

describe('D. twelve hours from the completion — and the menu counts open records only', () => {
  it('keeps a request completed late in the active list for 12 hours from its completion, then in "Hoàn thành vấn đề"', async () => {
    await checkIn(letan1);
    at(DAY, '07:00');
    const id = (await newRequest(letan1, 'RECEPTION')).body.report.id as string;
    const counts = async () => (await letan1.get('/api/reception/reports/open-counts')).body.counts.guestRequest.reception as number;
    expect(await counts()).toBe(1);
    // Completed 20 hours after it was received.
    at('2026-10-08', '03:00');
    expect((await complete(letan1, id)).status).toBe(200);
    // Out of the count at once…
    expect(await counts()).toBe(0);
    const activeIds = async () => ((await letan1.get('/api/reception/reports/active')).body.reports as { id: string }[]).map((r) => r.id);
    const archivedIds = async () => ((await letan1.get('/api/reception/reports/archive')).body.reports as { id: string }[]).map((r) => r.id);
    // …but still listed, completed, for the next shift to see.
    expect(await activeIds()).toContain(id);
    expect(await archivedIds()).not.toContain(id);
    at('2026-10-08', '14:59');
    expect(await activeIds()).toContain(id);
    at('2026-10-08', '15:00');
    expect(await activeIds()).not.toContain(id);
    expect(await archivedIds()).toContain(id);
    // Nothing was moved or rewritten to get there.
    expect((await stored(id)).completedAt).toEqual(hcm('2026-10-08', '03:00'));
  });

  it('counts Bell’s own open requests for its menu, and not the desk’s', async () => {
    await checkIn(letan1);
    await checkIn(bell1, 'Bell Một');
    const id = (await newRequest(letan1, 'BELL')).body.report.id as string;
    const mine = async () => (await bell1.get('/api/reception/reports/open-counts')).body.counts.guestRequest.mine as number;
    expect(await mine()).toBe(1);
    expect((await complete(bell1, id)).status).toBe(200);
    expect(await mine()).toBe(0);
  });
});

describe('E. "Bộ phận" — the department a request is with', () => {
  it('filters an open request by its current holder’s department, a completed one by the completing department', async () => {
    await checkIn(letan1);
    await checkIn(bell1, 'Bell Một');
    const toBell = (await newRequest(letan1, 'BELL', {}, 'Xách hành lý')).body.report.id as string;
    const toDesk = (await newRequest(letan1, 'RECEPTION', {}, 'In hóa đơn')).body.report.id as string;
    const ids = async (dept: string) => ((await letan1.get(`/api/reception/reports/active?workDepartment=${dept}`)).body.reports as { id: string; category: string }[]).filter((r) => r.category === 'GUEST_REQUEST').map((r) => r.id);
    expect(await ids('BELL')).toEqual([toBell]);
    expect(await ids('RECEPTION')).toEqual([toDesk]);
    // Given to the desk and completed there: now "Lễ tân" — its receiving department untouched.
    expect((await admin.post(`/api/reception/reports/${toBell}/assignee`).send({ assigneeUserId: letan1Id })).status).toBe(200);
    expect((await complete(letan1, toBell)).status).toBe(200);
    expect(await ids('BELL')).toEqual([]);
    expect((await ids('RECEPTION')).sort()).toEqual([toBell, toDesk].sort());
    expect((await stored(toBell)).receivingDepartment).toBe('BELL');
    // The Admin's report filters the same way.
    const adminRows = (await admin.get('/api/admin/reports/operational').query({ branchId: cn1, category: 'GUEST_REQUEST', from: DAY, to: DAY, workDepartment: 'RECEPTION' })).body.reports as { id: string }[];
    expect(adminRows.map((r) => r.id).sort()).toEqual([toBell, toDesk].sort());
  });
});

describe('F. Bell', () => {
  it('opens its shift at the shift gate, reads the requests given to it — and nothing of the desk or the bookings', async () => {
    await checkIn(bell1, 'Bell Một');
    await checkIn(letan1);
    const id = (await newRequest(letan1, 'BELL')).body.report.id as string;
    const mine = await bell1.get('/api/reception/reports/assigned');
    expect(mine.status).toBe(200);
    expect((mine.body.reports as { id: string }[]).map((r) => r.id)).toEqual([id]);
    for (const path of ['/api/bookings/new', '/api/reception/reports', '/api/reception/reports/active', '/api/issues', '/api/reception/shifts/cash', '/api/chat/channels']) {
      expect((await bell1.get(path)).status, path).toBe(403);
    }
    expect((await bell1.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'K', note: 'x', receivingDepartment: 'BELL' } })).status).toBe(403);
    // Bell's shift is not a desk shift: the desk's shift reports leave it out.
    const sessions = await admin.get('/api/reception/shifts/available').query({ from: DAY, to: DAY, branchId: cn1 });
    expect(JSON.stringify(sessions.body)).not.toContain('Bell Một');
    // And it ends its shift like the desk.
    expect((await bell1.post('/api/reception/shifts/close').send({})).status).toBe(200);
  });

  it('is created with exactly one branch', async () => {
    const without = await admin.post('/api/admin/users').send({ username: 'bell9', fullName: 'Bell Chín', temporaryPassword: PASSWORD, role: 'BELL' });
    expect(without.status).toBe(422);
    const ok = await admin.post('/api/admin/users').send({ username: 'bell9', fullName: 'Bell Chín', temporaryPassword: PASSWORD, role: 'BELL', branchId: cn1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await testPrisma.user.delete({ where: { id: ok.body.user.id } });
  });
});

/* ---------------------------- work groups ---------------------------- */

const room = (roomNumber: string) => ({ areaKind: 'ROOM', roomNumber, taskCodes: ['OUT'] });
const createGroup = (agent: Agent, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  agent.post('/api/housekeeping/manager/work-groups').send({ workDate: DAY, items, ...extra });
const accept = (agent: Agent, id: string) => agent.post(`/api/housekeeping/work/groups/${id}/accept`).send({});
const url = (id: string) => `/api/housekeeping/work/tasks/${id}`;
const openSession = (userId: number) => testPrisma.housekeepingWorkSession.findFirst({ where: { userId, endedAt: null } });

describe('G. daily room work takes no assignee at creation', () => {
  it('ignores an assignee sent with a new work group — it waits in the pool, nobody is told', async () => {
    await startShiftAt(lan, cn1);
    const res = await createGroup(qlbp1, [room('101')], { requestId: 'req-noassign-01', assigneeUserId: lanId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.group).toMatchObject({ assignee: null, acceptedAt: null });
    expect(res.body.group).not.toHaveProperty('origin');
    expect(res.body.group.items[0].assignee).toBeNull();
    expect(await testPrisma.notification.count()).toBe(0);
  });
});

describe('H. a housekeeper’s shift ends by itself at 20:00', () => {
  it('at 20:00 — every housekeeper’s open workday, once, at 20:00 — leaving unfinished work exactly as it was', async () => {
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    await startShiftAt(qlbp1, cn1);
    const g = (await createGroup(qlbp1, [room('101'), room('102')], { requestId: 'req-cut-00001' })).body.group;
    expect((await accept(lan, g.id)).status).toBe(200);
    expect((await lan.post(`${url(g.items[0].id)}/begin-inspection`)).status).toBe(200);
    const before = await testPrisma.housekeepingRoomTask.findMany({ where: { workGroupId: g.id }, orderBy: { roomNumber: 'asc' } });
    // Before 20:00 nothing ends.
    at(DAY, '19:59');
    expect(await endShiftsAtCutoff()).toBe(0);
    at(DAY, '20:01');
    expect(lastShiftCutoff(hcm(DAY, '20:01'))).toEqual(hcm(DAY, '20:00'));
    expect(await endShiftsAtCutoff()).toBe(2);
    // Idempotent: a second sweep (another tick, a restart) ends nothing more.
    expect(await endShiftsAtCutoff()).toBe(0);
    for (const userId of [lanId, hoaId]) {
      const s = await testPrisma.housekeepingWorkSession.findFirstOrThrow({ where: { userId } });
      expect(s).toMatchObject({ endedAt: hcm(DAY, '20:00'), endReason: 'CUTOFF_20H' });
    }
    // The Quản lý buồng phòng's own workday is its own to end.
    expect(await openSession(qlbp1Id)).not.toBeNull();
    // Unfinished work is untouched: same state, same holder, nothing completed.
    const after = await testPrisma.housekeepingRoomTask.findMany({ where: { workGroupId: g.id }, orderBy: { roomNumber: 'asc' } });
    expect(after.map((t) => [t.state, t.assigneeUserId, t.completedAt, t.inspectionStartedAt])).toEqual(before.map((t) => [t.state, t.assigneeUserId, t.completedAt, t.inspectionStartedAt]));
    expect(await testPrisma.notification.count({ where: { dedupeKey: { startsWith: 'hk-shift-ended:' } } })).toBe(2);
    // A shift begun after 20:00 runs to the next 20:00.
    at(DAY, '21:00');
    await startShiftAt(lan, cn1);
    expect(await endShiftsAtCutoff()).toBe(0);
    at('2026-10-08', '20:00');
    expect(await endShiftsAtCutoff()).toBe(1);
  });

  it('never before 20:00 — an empty list at 15:00, every room done at 17:00, work not yet taken at 19:00 — and new work still arrives', async () => {
    at(DAY, '08:00');
    await startShiftAt(lan, cn1);
    await startShiftAt(qlbp1, cn1);
    // 15:00: nothing given out at all.
    at(DAY, '15:00');
    expect(await endShiftsAtCutoff()).toBe(0);
    expect(await openSession(lanId)).not.toBeNull();
    // 17:00: its only room completed — through the API, where the old "no work left" end ran.
    at(DAY, '16:00');
    const g = (await createGroup(qlbp1, [room('101')], { requestId: 'req-keep-0001' })).body.group;
    expect((await accept(lan, g.id)).status).toBe(200);
    expect((await lan.post(`${url(g.items[0].id)}/inspect`).send({ issues: [] })).status).toBe(201);
    expect((await lan.post(`${url(g.items[0].id)}/start`)).status).toBe(200);
    at(DAY, '17:00');
    const done = await lan.post(`${url(g.items[0].id)}/complete`).send({});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await endShiftsAtCutoff()).toBe(0);
    expect(await openSession(lanId)).not.toBeNull();
    // 19:00: new work arrives and nobody has taken it — still on shift, and it can take it.
    at(DAY, '19:00');
    const g2 = (await createGroup(qlbp1, [room('102')], { requestId: 'req-keep-0002' })).body.group;
    expect(await endShiftsAtCutoff()).toBe(0);
    expect(await openSession(lanId)).not.toBeNull();
    expect((await accept(lan, g2.id)).status).toBe(200);
    const before = await testPrisma.housekeepingRoomTask.findMany({ orderBy: { roomNumber: 'asc' } });
    // 20:00 exactly: ended once; the rooms are as they were.
    at(DAY, '20:00');
    expect(await endShiftsAtCutoff()).toBe(1);
    expect(await endShiftsAtCutoff()).toBe(0);
    expect(await testPrisma.housekeepingWorkSession.findFirstOrThrow({ where: { userId: lanId } })).toMatchObject({ endedAt: hcm(DAY, '20:00'), endReason: 'CUTOFF_20H' });
    const after = await testPrisma.housekeepingRoomTask.findMany({ orderBy: { roomNumber: 'asc' } });
    expect(after.map((t) => [t.id, t.state, t.assigneeUserId, t.completedAt])).toEqual(before.map((t) => [t.id, t.state, t.assigneeUserId, t.completedAt]));
  });
});

/* ---------------------- the Buồng phòng request pool ---------------------- */

const sees = async (agent: Agent, id: string) => ((await agent.get('/api/reception/reports/housekeeping')).body.reports as { id: string }[] | undefined)?.some((r) => r.id === id) ?? false;

describe('J. the Buồng phòng pool — "Nhận việc", "Tự nhận việc" and "Bộ phận nhận việc" in "Sửa"', () => {
  it('every housekeeper on shift at the branch sees it, another branch never; two take it at once — exactly one holds it', async () => {
    await checkIn(letan1);
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    const id = (await newRequest(letan1, 'HOUSEKEEPING')).body.report.id as string;
    expect(await sees(lan, id)).toBe(true);
    expect(await sees(hoa, id)).toBe(true);
    expect(await sees(qlbp2, id)).toBe(false);
    // Another department does not take Buồng phòng's work.
    await checkIn(bell1, 'Bell Một');
    expect((await bell1.post(`/api/reception/reports/${id}/claim`)).status).toBe(403);
    const [x, y] = await Promise.all([lan.post(`/api/reception/reports/${id}/claim`), hoa.post(`/api/reception/reports/${id}/claim`)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const winner = x.status === 200 ? lanId : hoaId;
    expect(await stored(id)).toMatchObject({ assigneeUserId: winner, assigneeDepartment: 'HOUSEKEEPING', acknowledgedAt: expect.any(Date) });
    expect(await testPrisma.receptionReportAudit.count({ where: { reportId: id, action: 'ASSIGN', reason: 'Tự nhận' } })).toBe(1);
    // Held: nobody takes it again.
    expect((await (winner === lanId ? hoa : lan).post(`/api/reception/reports/${id}/claim`)).status).toBe(409);
  });

  it('"Tự nhận việc": the writer holds it at once — its own department’s, marked as such', async () => {
    await startShiftAt(lan, cn1);
    const res = await newRequest(lan, 'SELF');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report.guestRequest.selfClaimed).toBe(true);
    expect(await stored(res.body.report.id)).toMatchObject({ receivingDepartment: 'HOUSEKEEPING', assigneeUserId: lanId, assigneeDepartment: 'HOUSEKEEPING', acknowledgedAt: expect.any(Date) });
  });

  it('"Sửa" sends an older request with no department to one — only by who may, and never away from its holder', async () => {
    await checkIn(letan1);
    const id = (await newRequest(letan1, 'RECEPTION')).body.report.id as string;
    // As a request recorded before "Bộ phận nhận việc" existed: no department, nobody holds it.
    await testPrisma.guestRequestReport.update({ where: { reportId: id }, data: { receivingDepartment: null, assigneeUserId: null, assigneeNameSnapshot: null, assigneeDepartment: null, assignedAt: null } });
    const move = (agent: Agent, receivingDepartment: string) => agent.post(`/api/reception/reports/${id}/department`).send({ receivingDepartment });
    expect([403, 404]).toContain((await move(letan2, 'HOUSEKEEPING')).status);
    expect((await move(bell1, 'HOUSEKEEPING')).status).toBe(403);
    await startShiftAt(lan, cn1);
    const res = await move(letan1, 'HOUSEKEEPING');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stored(id)).toMatchObject({ receivingDepartment: 'HOUSEKEEPING', assigneeUserId: null });
    expect(await testPrisma.notification.count({ where: { userId: lanId, dedupeKey: `request-pool:${id}:${lanId}` } })).toBe(1);
    expect(await testPrisma.receptionReportAudit.count({ where: { reportId: id, action: 'EDIT', field: 'receivingDepartment' } })).toBe(1);
    // Taken: the desk no longer moves it — a manager may.
    expect((await lan.post(`/api/reception/reports/${id}/claim`)).status).toBe(200);
    expect((await move(letan1, 'RECEPTION')).status).toBe(403);
    expect((await stored(id)).assigneeUserId).toBe(lanId);
  });

  it('lists Housekeeping’s own unresolved incidents in its journal', async () => {
    await startShiftAt(lan, cn1);
    const issue = (await lan.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'WATER', description: 'Vòi sen rò nước' })).body.issue as { id: string };
    const logged = (await lan.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } })).body.report.id as string;
    expect(await sees(qlbp1, logged)).toBe(true);
    expect(await sees(qlbp2, logged)).toBe(false);
  });
});

/* ------------------------ "trạng thái tốt" ------------------------ */

describe('K. a room inspected in good condition', () => {
  it('is saved with the inspection — no finding, no incident, no notice — and never together with an issue', async () => {
    await startShiftAt(lan, cn1);
    await startShiftAt(qlbp1, cn1);
    const g = (await createGroup(qlbp1, [room('101'), room('102')], { requestId: 'req-good-0001' })).body.group;
    expect((await accept(lan, g.id)).status).toBe(200);
    const task = (n: string) => (g.items as { id: string; roomNumber: string }[]).find((i) => i.roomNumber === n)!.id;
    const notices = await testPrisma.notification.count();
    // Both at once: refused, the room untouched.
    expect((await lan.post(`${url(task('102'))}/inspect`).send({ issues: [{ type: 'ODOR' }], goodCondition: true })).status).toBe(422);
    expect(await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task('102') } })).toMatchObject({ state: 'NOT_STARTED', inspectionId: null });
    const ok = await lan.post(`${url(task('101'))}/inspect`).send({ issues: [], goodCondition: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.task.inspection).toMatchObject({ goodCondition: true, findings: [] });
    expect(await testPrisma.roomInspection.findFirstOrThrow({ where: { roomNumber: '101' }, include: { issues: true } })).toMatchObject({ goodCondition: true, issues: [] });
    expect(await testPrisma.hotelIssue.count()).toBe(0);
    expect(await testPrisma.notification.count()).toBe(notices);
    // Read back as saved; an inspection that says nothing of it stays false.
    expect((await lan.get(url(task('101')))).body.task.inspection.goodCondition).toBe(true);
    expect((await lan.post(`${url(task('102'))}/inspect`).send({ issues: [] })).body.task.inspection.goodCondition).toBe(false);
  });
});

/* ------------------- the desk's "Buồng phòng" count ------------------- */

describe('L. the desk’s "Buồng phòng" count — what Housekeeping reported and is still open', () => {
  it('its branch’s open Housekeeping requests and unresolved Housekeeping incidents, each once — no completed one, no other branch’s, not the desk’s own', async () => {
    await checkIn(letan1);
    await startShiftAt(lan, cn1);
    const count = async (agent: Agent) =>
      ((await agent.get('/api/reception/reports/open-counts')).body.counts.guestRequest.housekeeping as number) +
      ((await agent.get('/api/issues/summary')).body.summary.byDepartment.housekeeping as number);
    expect(await count(letan1)).toBe(0);
    const a = (await newRequest(lan, 'SELF')).body.report.id as string;
    await newRequest(lan, 'HOUSEKEEPING', {}, 'Thêm nước phòng 102');
    await newRequest(letan1, 'RECEPTION', {}, 'Đổi phòng cho khách');
    // An incident logged in the journal too: still one record.
    const issue = (await lan.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'WATER', description: 'Vòi sen rò nước' })).body.issue as { id: string };
    expect((await lan.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } })).status).toBe(201);
    expect(await count(letan1)).toBe(3);
    expect(await count(letan2)).toBe(0);
    // Completed: out of the count at once, though still listed for 12 hours.
    expect((await complete(lan, a)).status).toBe(200);
    expect(((await letan1.get('/api/reception/reports/active')).body.reports as { id: string }[]).map((r) => r.id)).toContain(a);
    expect(await count(letan1)).toBe(2);
  });
});

/* ---------------------------- inventory ---------------------------- */

const INV = '/api/housekeeping/inventory';
const createItems = (agent: Agent, names: string[], warehouse = 'CHEMICAL_TOOLS') => agent.post(`${INV}/items/batch`).send({ warehouse, items: names.map((name) => ({ name })) });

describe('I. inventory items — "Sửa" and "Xóa"', () => {
  it('the manager renames its own item and changes its unit — the code, stock and history stay — never to a name in use', async () => {
    const [mop, broom] = (await createItems(qlbp1, ['Cây lau sàn', 'Chổi'])).body.items as { id: string; code: string }[];
    expect((await qlbp1.post(`${INV}/receipts`).send({ warehouse: 'CHEMICAL_TOOLS', requestId: 'inv-rcpt-0001', lines: [{ itemId: mop!.id, quantity: 7 }] })).status).toBe(201);
    const movementsBefore = await testPrisma.inventoryMovement.findMany({ where: { itemId: mop!.id } });
    const res = await qlbp1.patch(`${INV}/items/${mop!.id}`).send({ name: 'Cây lau sàn lớn', unit: 'cây' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item).toMatchObject({ code: mop!.code, label: 'Cây lau sàn lớn', unit: 'cây', balances: { AVAILABLE: 7 } });
    expect(await testPrisma.inventoryMovement.findMany({ where: { itemId: mop!.id } })).toEqual(movementsBefore);
    // A name already used in the warehouse: refused, naming it.
    const taken = await qlbp1.patch(`${INV}/items/${mop!.id}`).send({ name: 'chổi' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toContain('Chổi');
    expect((await qlbp1.patch(`${INV}/items/${mop!.id}`).send({ name: '  ' })).status).toBe(422);
    // A code is never edited.
    await qlbp1.patch(`${INV}/items/${broom!.id}`).send({ code: '9.999', name: 'Chổi quét' });
    expect((await testPrisma.inventoryItem.findUniqueOrThrow({ where: { id: broom!.id } })).code).toBe(broom!.code);
  });

  it('keeps every other role, and another branch, out — by the API, not only the screen', async () => {
    const [mop] = (await createItems(qlbp1, ['Cây lau sàn'])).body.items as { id: string }[];
    await startShiftAt(lan, cn1);
    for (const agent of [lan, letan1, bell1]) {
      expect((await agent.patch(`${INV}/items/${mop!.id}`).send({ name: 'X' })).status).toBe(403);
      expect((await agent.delete(`${INV}/items/${mop!.id}`)).status).toBe(403);
    }
    expect((await qlbp2.patch(`${INV}/items/${mop!.id}`).send({ name: 'X' })).status).toBe(404);
    expect((await qlbp2.delete(`${INV}/items/${mop!.id}`)).status).toBe(404);
    // The Admin manages the shared catalog, not a branch's own item.
    expect((await admin.patch(`${INV}/items/${mop!.id}`).send({ name: 'X' })).status).toBe(403);
    expect((await testPrisma.inventoryItem.findUniqueOrThrow({ where: { id: mop!.id } })).name).toBe('Cây lau sàn');
  });

  it('a shared item: the Admin renames it in every branch at once; a manager only sets its own threshold and note', async () => {
    const created = await createItems(admin, ['Bao tay']);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const code = created.body.items[0].code as string;
    const rows = await testPrisma.inventoryItem.findMany({ where: { code, scope: 'SYSTEM' } });
    expect(rows.length).toBeGreaterThan(1);
    const mine = rows.find((r) => r.branchId === cn1)!;
    expect((await qlbp1.patch(`${INV}/items/${mine.id}`).send({ name: 'Găng tay' })).status).toBe(403);
    expect((await qlbp1.delete(`${INV}/items/${mine.id}`)).status).toBe(403);
    expect((await qlbp1.patch(`${INV}/items/${mine.id}`).send({ lowStockThreshold: 3, note: 'Tầng 2' })).status).toBe(200);
    const renamed = await admin.patch(`${INV}/items/${mine.id}`).send({ name: 'Găng tay', unit: 'đôi' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const after = await testPrisma.inventoryItem.findMany({ where: { code, scope: 'SYSTEM' } });
    expect(after.every((r) => r.name === 'Găng tay' && r.unit === 'đôi' && r.code === code)).toBe(true);
    // The branch's own threshold and note were not the Admin's to change.
    expect(after.find((r) => r.id === mine.id)).toMatchObject({ lowStockThreshold: 3, note: 'Tầng 2' });
    expect((await admin.patch(`${INV}/items/${mine.id}`).send({ note: 'x' })).status).toBe(422);
  });

  it('removes an item never used; archives one with history — kept whole, out of every new document', async () => {
    const [unused, used] = (await createItems(qlbp1, ['Bàn chải', 'Nước lau kính'])).body.items as { id: string }[];
    expect((await qlbp1.post(`${INV}/receipts`).send({ warehouse: 'CHEMICAL_TOOLS', requestId: 'inv-rcpt-0002', lines: [{ itemId: used!.id, quantity: 4 }] })).status).toBe(201);
    expect((await qlbp1.delete(`${INV}/items/${unused!.id}`)).body).toEqual({ removed: true, archived: false });
    expect(await testPrisma.inventoryItem.findUnique({ where: { id: unused!.id } })).toBeNull();
    const receiptLines = await testPrisma.inventoryReceiptLine.count({ where: { itemId: used!.id } });
    const movements = await testPrisma.inventoryMovement.count({ where: { itemId: used!.id } });
    expect((await qlbp1.delete(`${INV}/items/${used!.id}`)).body).toEqual({ removed: false, archived: true });
    // Again: still archived, nothing else happens.
    expect((await qlbp1.delete(`${INV}/items/${used!.id}`)).body).toEqual({ removed: false, archived: true });
    const kept = await testPrisma.inventoryItem.findUniqueOrThrow({ where: { id: used!.id } });
    expect(kept.archivedAt).not.toBeNull();
    expect(await testPrisma.inventoryReceiptLine.count({ where: { itemId: used!.id } })).toBe(receiptLines);
    expect(await testPrisma.inventoryMovement.count({ where: { itemId: used!.id } })).toBe(movements);
    // Off the active list; listed with the archived ones; never in a new document; not editable.
    const active = (await qlbp1.get(`${INV}/items?warehouse=CHEMICAL_TOOLS`)).body.items as { id: string }[];
    expect(active.map((i) => i.id)).not.toContain(used!.id);
    const all = (await qlbp1.get(`${INV}/items?warehouse=CHEMICAL_TOOLS&includeArchived=true`)).body.items as { id: string; archived: boolean }[];
    expect(all.find((i) => i.id === used!.id)).toMatchObject({ archived: true });
    expect((await qlbp1.post(`${INV}/receipts`).send({ warehouse: 'CHEMICAL_TOOLS', requestId: 'inv-rcpt-0003', lines: [{ itemId: used!.id, quantity: 1 }] })).status).not.toBe(201);
    expect((await qlbp1.patch(`${INV}/items/${used!.id}`).send({ name: 'X' })).status).toBe(409);
  });
});
