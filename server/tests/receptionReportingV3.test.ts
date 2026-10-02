/**
 * Reception reporting v3 — the 12-hour completion archive, the "Review" room
 * service, and correcting a service-quality report.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. II, III and IV follow ONE rule by the SERVER clock, measured from the
 *      ORIGINAL receipt: unfinished → active however old; completed and received
 *      under 12 hours ago → active; completed and received 12 hours ago or more →
 *      "Hoàn thành vấn đề". I and V are never part of it.
 *   2. The active set is the BRANCH's across shifts — the next shift sees what
 *      the last one left — and never another branch's.
 *   3. Crossing the line moves nothing: no row is copied, deleted or rewritten.
 *   4. "Review" is a count, not a sale: two whole-number counts, price 0, never
 *      revenue, correctable only in its own fields.
 *   5. A service-quality correction touches Tên khách, Mã EZ and Mô tả only,
 *      and never a report or completion time; completion needs no handling text
 *      and is stamped by the server.
 *   6. "Hoàn thành vấn đề" can be narrowed to the days records were RECEIVED on
 *      — inclusive Vietnamese calendar days, never the completion day — and a
 *      date only narrows the archive: it never admits a record the 12-hour
 *      rule keeps active.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { assignTo } from './helpers/issues';
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

const TECHNICAL_PASSWORD = 'Technical1';

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const at = (day: string, hhmm: string) => setClock({ now: () => hcm(day, hhmm) });

let cn1 = 0;
let cn2 = 0;
let letanA: Agent;
let letanB: Agent;
let letanCn2: Agent;
let tech: Agent;
let admin: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createReceptionist(cn1, { username: 'letana', fullName: 'Lễ tân A', mustChangePassword: false });
  letanA = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letanb', fullName: 'Lễ tân B', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false });
  letanCn2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  // The Admin gives each job to the technician before it can be taken.
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  resetClock();
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function checkIn(agent: Agent, shiftType: string, name: string) {
  const res = await agent.post('/api/reception/shifts/check-in').send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session as { id: string };
}

async function closeShift(agent: Agent) {
  expect((await agent.post('/api/reception/shifts/close').send({})).status).toBe(200);
}

async function request(agent: Agent, guestName = 'Khách A') {
  const res = await agent.post('/api/reception/reports').send({
    category: 'GUEST_REQUEST',
    guestRequest: { guestName, ezCode: 'EZ1', note: 'Gửi balo' },
  });
  expect(res.status).toBe(201);
  return res.body.report.id as string;
}

async function complaint(agent: Agent, guestName = 'Khách B') {
  const res = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName, ezCode: 'EZ2', description: 'Phòng ồn' },
  });
  expect(res.status).toBe(201);
  return res.body.report.id as string;
}

async function complete(agent: Agent, id: string, body: Record<string, unknown> = {}) {
  const res = await agent.post(`/api/reception/reports/${id}/complete`).send(body);
  expect(res.status).toBe(200);
  return res.body.report;
}

async function activeIds(agent: Agent): Promise<string[]> {
  const res = await agent.get('/api/reception/reports/active');
  expect(res.status).toBe(200);
  return (res.body.reports as { id: string }[]).map((r) => r.id);
}

async function archiveIds(agent: Agent): Promise<string[]> {
  const res = await agent.get('/api/reception/reports/archive');
  expect(res.status).toBe(200);
  return (res.body.reports as { id: string }[]).map((r) => r.id);
}

/** An incident reported at an exact HCM instant (its createdAt is a DB default). */
async function incidentAt(agent: Agent, day: string, hhmm: string): Promise<string> {
  const res = await agent
    .post('/api/issues')
    .send({ areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'Máy lạnh' });
  expect(res.status).toBe(201);
  await testPrisma.hotelIssue.update({ where: { id: res.body.issue.id }, data: { createdAt: hcm(day, hhmm) } });
  return res.body.issue.id as string;
}

async function issueIds(agent: Agent, scope: 'active' | 'archive'): Promise<string[]> {
  const res = await agent.get(`/api/issues?scope=${scope}&pageSize=100`);
  expect(res.status).toBe(200);
  return (res.body.issues as { id: string }[]).map((i) => i.id);
}

/* ================================================================== */
/* The 12-hour rule                                                    */
/* ================================================================== */

describe('the 12-hour completion archive (II and IV)', () => {
  it('keeps a completed record active until 12 hours after it was RECEIVED, then archives it', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '10:00');
    const req = await request(letanA);
    const cq = await complaint(letanA);
    at('2026-09-25', '11:00');
    await complete(letanA, req, { resolution: 'Đã trả balo' });
    await complete(letanA, cq);

    // 11:59 — completed, but received under 12 hours ago: still active.
    at('2026-09-25', '11:59');
    expect(await activeIds(letanA)).toEqual(expect.arrayContaining([req, cq]));
    expect(await archiveIds(letanA)).toEqual([]);

    // 21:59 — still under 12 hours after RECEIPT (the completion time is irrelevant).
    at('2026-09-25', '21:59');
    expect(await activeIds(letanA)).toEqual(expect.arrayContaining([req, cq]));

    // 22:00 — exactly 12 hours after 10:00: archived, and no longer active.
    at('2026-09-25', '22:00');
    expect(await activeIds(letanA)).not.toContain(req);
    expect(await activeIds(letanA)).not.toContain(cq);
    const archive = await letanA.get('/api/reception/reports/archive');
    expect(archive.body.reports.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([req, cq]));
    expect(archive.body.totals).toEqual({ GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 1 });
    expect(archive.body.archiveAfterHours).toBe(12);
  });

  it('never archives an unfinished record, however old', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '10:00');
    const req = await request(letanA);
    const cq = await complaint(letanA);

    at('2026-09-26', '12:00'); // 26 hours later, still "Đã tiếp nhận"
    expect(await activeIds(letanA)).toEqual(expect.arrayContaining([req, cq]));
    expect(await archiveIds(letanA)).toEqual([]);
  });

  it('shows the next shift what the last one left — unfinished and recently completed', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '09:00');
    const open = await request(letanA, 'Còn mở');
    const done = await complaint(letanA, 'Đã xong');
    await complete(letanA, done);
    at('2026-09-25', '14:00');
    await closeShift(letanA);

    // Another receptionist, another shift, the same branch.
    at('2026-09-25', '14:05');
    await checkIn(letanB, 'B', 'Lan');
    expect(await activeIds(letanB)).toEqual(expect.arrayContaining([open, done]));
  });

  it('keeps branch isolation: another branch sees none of it, active or archived', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '08:30');
    const req = await request(letanA);
    await complete(letanA, req);
    at('2026-09-25', '09:00');
    await checkIn(letanCn2, 'A', 'Nam');
    expect(await activeIds(letanCn2)).not.toContain(req);
    at('2026-09-25', '21:00');
    expect(await archiveIds(letanCn2)).not.toContain(req);
    expect(await archiveIds(letanA)).toContain(req);
  });

  it('leaves payments and room services out of both lists', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    const pay = await letanA.post('/api/reception/reports').send({
      category: 'PAYMENT',
      payment: { source: 'Walking', method: 'CASH', amount: 100000 },
    });
    const service = await letanA.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'LAUNDRY', guestName: 'Khách', price: 50000 },
    });
    expect(pay.status).toBe(201);
    expect(service.status).toBe(201);
    const active = await letanA.get('/api/reception/reports/active');
    expect(active.body.reports.map((r: { category: string }) => r.category)).not.toContain('PAYMENT');
    expect(active.body.reports.map((r: { category: string }) => r.category)).not.toContain('ROOM_SERVICE');
    at('2026-09-26', '08:00');
    const archive = await letanA.get('/api/reception/reports/archive');
    expect(archive.body.reports).toHaveLength(0);
  });

  it('moves nothing: the same rows, the same times, before and after the line', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '08:30');
    const req = await request(letanA);
    at('2026-09-25', '09:00');
    await complete(letanA, req, { resolution: 'OK' });
    const before = await testPrisma.receptionOperationalReport.findUniqueOrThrow({
      where: { id: req },
      include: { guestRequest: true },
    });
    const rowsBefore = await testPrisma.receptionOperationalReport.count();

    at('2026-09-25', '21:00');
    expect(await archiveIds(letanA)).toContain(req);
    const after = await testPrisma.receptionOperationalReport.findUniqueOrThrow({
      where: { id: req },
      include: { guestRequest: true },
    });
    expect(await testPrisma.receptionOperationalReport.count()).toBe(rowsBefore);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.guestRequest?.completedAt).toEqual(before.guestRequest?.completedAt);
    expect(after.guestRequest?.resolution).toBe('OK');
  });

  it('shows the open shift its own withdrawn rows, struck through — and not another shift\'s', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    const req = await request(letanA);
    expect((await letanA.post(`/api/reception/reports/${req}/void`).send({ reason: 'Nhập nhầm' })).status).toBe(200);
    expect(await activeIds(letanA)).toContain(req);
    at('2026-09-25', '14:00');
    await closeShift(letanA);
    at('2026-09-25', '14:05');
    await checkIn(letanB, 'B', 'Lan');
    expect(await activeIds(letanB)).not.toContain(req);
  });

  /**
   * THE ACTIVE SET IS CROSS-SHIFT, SO A VOID CAN BE TOO. Ca B withdrawing what
   * Ca A recorded is Ca B's act: the row stays in front of Ca B, struck through,
   * though its own shift is still Ca A's — and is gone for the shift after.
   */
  it('keeps a row the open shift withdrew — even one an earlier shift recorded — struck through', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    const req = await request(letanA, 'Khách ca A');
    at('2026-09-25', '14:00');
    await closeShift(letanA);

    at('2026-09-25', '14:05');
    await checkIn(letanB, 'B', 'Lan');
    expect((await letanB.post(`/api/reception/reports/${req}/void`).send({ reason: 'Trùng' })).status).toBe(200);
    const active = await letanB.get('/api/reception/reports/active');
    const row = (active.body.reports as { id: string; voided: boolean; voidReason: string; shiftSessionId: string }[]).find(
      (r) => r.id === req,
    );
    expect(row).toMatchObject({ voided: true, voidReason: 'Trùng' });
    expect(await archiveIds(letanB)).not.toContain(req);

    at('2026-09-25', '22:00');
    await closeShift(letanB);
    at('2026-09-25', '22:05');
    await checkIn(letanA, 'C', 'Minh');
    expect(await activeIds(letanA)).not.toContain(req);
  });

  it('returns each category\'s full count with the active page', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    await request(letanA);
    await request(letanA, 'Khách C');
    await complaint(letanA);
    const res = await letanA.get('/api/reception/reports/active');
    expect(res.body.totals).toEqual({ GUEST_REQUEST: 2, CUSTOMER_COMPLAINT: 1 });
    expect(res.body.reports).toHaveLength(3);
  });
});

/* ================================================================== */
/* "Hoàn thành vấn đề" by the day a record was received                 */
/* ================================================================== */

describe('the completion archive, narrowed by the day a record was RECEIVED', () => {
  const archiveIn = (agent: Agent, from: string, to: string) =>
    agent.get(`/api/reception/reports/archive?from=${from}&to=${to}`);
  const idsOf = (res: { body: { reports: { id: string }[] } }) => res.body.reports.map((r) => r.id).sort();

  /** Receipts at the edges of 25/09 (HCM), all completed shortly after. */
  async function edges() {
    at('2026-09-24', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-24', '23:59');
    const lateOn24 = await request(letanA, 'Tối 24');
    at('2026-09-25', '00:00');
    const first25 = await request(letanA, 'Đầu ngày 25');
    at('2026-09-25', '23:59');
    const last25 = await complaint(letanA, 'Cuối ngày 25');
    at('2026-09-26', '00:00');
    const first26 = await request(letanA, 'Đầu ngày 26');
    at('2026-09-26', '00:30');
    for (const id of [lateOn24, first25, last25, first26]) await complete(letanA, id);
    return { lateOn24, first25, last25, first26 };
  }

  it('takes a same-day range as the whole Vietnamese calendar day, 00:00 to 23:59', async () => {
    const r = await edges();
    at('2026-09-27', '12:00'); // everything is well past 12 hours
    const res = await archiveIn(letanA, '2026-09-25', '2026-09-25');
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([r.first25, r.last25].sort());
    expect(res.body.totals).toEqual({ GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 1 });
    expect(res.body.range).toEqual({ from: '2026-09-25', to: '2026-09-25' });
  });

  it('takes a multi-day range inclusively, at both ends', async () => {
    const r = await edges();
    at('2026-09-27', '12:00');
    expect(idsOf(await archiveIn(letanA, '2026-09-24', '2026-09-25'))).toEqual(
      [r.lateOn24, r.first25, r.last25].sort(),
    );
    expect(idsOf(await archiveIn(letanA, '2026-09-24', '2026-09-26'))).toEqual(
      [r.lateOn24, r.first25, r.last25, r.first26].sort(),
    );
    // Without a range: the whole archive, as before.
    expect(await archiveIds(letanA)).toHaveLength(4);
  });

  it('returns nothing, and zero totals, for a range with no completed record', async () => {
    await edges();
    at('2026-09-27', '12:00');
    const res = await archiveIn(letanA, '2026-09-20', '2026-09-23');
    expect(res.status).toBe(200);
    expect(res.body.reports).toEqual([]);
    expect(res.body.totals).toEqual({ GUEST_REQUEST: 0, CUSTOMER_COMPLAINT: 0 });
  });

  it('matches the day it was RECEIVED, never the day it was completed', async () => {
    at('2026-09-24', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-24', '20:00');
    const req = await request(letanA);
    at('2026-09-25', '09:00'); // completed the next morning
    await complete(letanA, req);
    at('2026-09-26', '12:00');
    expect(idsOf(await archiveIn(letanA, '2026-09-24', '2026-09-24'))).toEqual([req]);
    expect(idsOf(await archiveIn(letanA, '2026-09-25', '2026-09-25'))).toEqual([]);
  });

  it('never admits a record the 12-hour rule keeps active, whatever the dates', async () => {
    at('2026-09-25', '06:00');
    await checkIn(letanA, 'A', 'Đức');
    at('2026-09-25', '10:00');
    const recent = await request(letanA, 'Mới hoàn thành');
    at('2026-09-25', '11:00');
    await complete(letanA, recent);
    at('2026-09-24', '10:00');
    const unfinished = await complaint(letanA, 'Chưa xong');

    at('2026-09-25', '21:59'); // under 12 hours after 10:00
    expect(idsOf(await archiveIn(letanA, '2026-09-24', '2026-09-25'))).toEqual([]);
    at('2026-09-25', '22:00'); // exactly 12 hours: now eligible — and in range
    expect(idsOf(await archiveIn(letanA, '2026-09-24', '2026-09-25'))).toEqual([recent]);
    // The unfinished one, received on the 24th, stays active however the dates are set.
    expect(await activeIds(letanA)).toContain(unfinished);
  });

  it('keeps branch isolation inside a range', async () => {
    const r = await edges();
    at('2026-09-27', '12:00');
    await checkIn(letanCn2, 'A', 'CN2');
    const res = await archiveIn(letanCn2, '2026-09-24', '2026-09-26');
    expect(res.status).toBe(200);
    expect(res.body.reports).toEqual([]);
    expect(idsOf(await archiveIn(letanA, '2026-09-25', '2026-09-25'))).toEqual([r.first25, r.last25].sort());
  });

  it('refuses half a range, a range backwards, or a malformed day', async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
    for (const q of ['from=2026-09-25', 'to=2026-09-25', 'from=2026-09-26&to=2026-09-25', 'from=25/09/2026&to=2026-09-25']) {
      expect((await letanA.get(`/api/reception/reports/archive?${q}`)).status, q).toBe(422);
    }
  });

  it('narrows the incident archive (III) by the day an incident was REPORTED', async () => {
    at('2026-09-25', '10:00');
    const on24 = await incidentAt(letanA, '2026-09-24', '09:00');
    const on25 = await incidentAt(letanA, '2026-09-25', '00:00');
    for (const id of [on24, on25]) {
      await assignTo(admin, id, tech);
      await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900' });
      expect((await tech.post(`/api/issues/${id}/complete`).send({})).status).toBe(200);
    }
    at('2026-09-26', '12:00');
    const day = async (from: string, to: string) =>
      ((await letanA.get(`/api/issues?scope=archive&from=${from}&to=${to}&pageSize=100`)).body.issues as { id: string }[])
        .map((i) => i.id)
        .sort();
    expect(await day('2026-09-25', '2026-09-25')).toEqual([on25]);
    expect(await day('2026-09-24', '2026-09-25')).toEqual([on24, on25].sort());
    expect(await day('2026-09-20', '2026-09-23')).toEqual([]);
    // CN2 sees none of CN1's, in any range.
    const cn2 = await letanCn2.get('/api/issues?scope=archive&from=2026-09-24&to=2026-09-25&pageSize=100');
    expect(cn2.body.issues).toEqual([]);
  });

  /**
   * THE WINDOW INTERSECTS THE 12-HOUR RULE FOR III TOO — its own code path
   * (`listIssues`), so it is proven on its own: an incident still open, and one
   * finished under 12 hours after its report, both reported INSIDE the window,
   * stay out of the archive and out of its total.
   */
  it('never admits an incident the 12-hour rule keeps active, whatever the dates', async () => {
    at('2026-09-25', '10:00');
    const open = await incidentAt(letanA, '2026-09-25', '08:00');
    const recent = await incidentAt(letanA, '2026-09-25', '09:00');
    await assignTo(admin, recent, tech);
    await tech.post(`/api/issues/${recent}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900' });
    at('2026-09-25', '11:00');
    expect((await tech.post(`/api/issues/${recent}/complete`).send({})).status).toBe(200);

    const inRange = () => letanA.get('/api/issues?scope=archive&from=2026-09-25&to=2026-09-25&pageSize=100');
    at('2026-09-25', '20:59'); // under 12 hours after the 09:00 report
    let res = await inRange();
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
    expect(res.body.pagination.total).toBe(0);

    at('2026-09-25', '21:00'); // exactly 12 hours: eligible — and in range
    res = await inRange();
    expect((res.body.issues as { id: string }[]).map((i) => i.id)).toEqual([recent]);
    expect(res.body.pagination.total).toBe(1);
    // Still open, however the dates are set.
    expect(await issueIds(letanA, 'active')).toContain(open);
  });
});

describe('the 12-hour completion archive (III, the incidents)', () => {
  it('follows the same rule, measured from when the incident was reported', async () => {
    at('2026-09-25', '10:00');
    const finished = await incidentAt(letanA, '2026-09-25', '10:00');
    const open = await incidentAt(letanA, '2026-09-24', '08:00'); // reported yesterday, still waiting
    at('2026-09-25', '10:30');
    await assignTo(admin, finished, tech);
    await tech.post(`/api/issues/${finished}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900' });
    at('2026-09-25', '11:00');
    expect((await tech.post(`/api/issues/${finished}/complete`).send({})).status).toBe(200);

    at('2026-09-25', '21:59');
    expect(await issueIds(letanA, 'active')).toEqual(expect.arrayContaining([finished, open]));
    expect(await issueIds(letanA, 'archive')).toEqual([]);

    at('2026-09-25', '22:00');
    expect(await issueIds(letanA, 'active')).toEqual([open]);
    expect(await issueIds(letanA, 'archive')).toEqual([finished]);
  });

  it('is scoped to the branch', async () => {
    at('2026-09-25', '08:00');
    const id = await incidentAt(letanA, '2026-09-25', '08:00');
    expect(await issueIds(letanCn2, 'active')).not.toContain(id);
  });
});

/* ================================================================== */
/* "Review" — a count, not a sale                                      */
/* ================================================================== */

describe('the "Review" room service', () => {
  beforeEach(async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
  });

  const review = (roomService: Record<string, unknown>) =>
    letanA.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'REVIEW', guestName: 'Guest A', ezCode: 'QA-REVIEW-01', ...roomService },
    });

  it('records two whole-number counts with the server time, and no price', async () => {
    const res = await review({ tripadvisorCount: 3, googleCount: 2, price: 999000, note: 'bỏ qua' });
    expect(res.status).toBe(201);
    expect(res.body.report.roomService).toMatchObject({
      serviceType: 'REVIEW',
      serviceTypeLabel: 'Review',
      guestName: 'Guest A',
      ezCode: 'QA-REVIEW-01',
      tripadvisorCount: 3,
      googleCount: 2,
      // Whatever a client sends, a review is never priced and never revenue.
      price: 0,
      note: null,
      countsAsRevenue: false,
    });
    expect(res.body.report.createdAt).toBe(hcm('2026-09-25', '08:00').toISOString());
  });

  it('refuses counts that are negative, fractional, or both zero', async () => {
    for (const bad of [
      { tripadvisorCount: -1, googleCount: 2 },
      { tripadvisorCount: 1.5, googleCount: 0 },
      { tripadvisorCount: 0, googleCount: 0 },
      {},
    ]) {
      expect((await review(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await testPrisma.roomServiceReport.count()).toBe(0);
  });

  it('corrects only its own fields — never a price it does not have', async () => {
    const id = (await review({ tripadvisorCount: 3, googleCount: 2 })).body.report.id as string;
    const res = await letanA
      .patch(`/api/reception/reports/${id}`)
      .send({ roomService: { tripadvisorCount: 4, price: 500000 } });
    expect(res.status).toBe(200);
    expect(res.body.report.roomService).toMatchObject({ tripadvisorCount: 4, googleCount: 2, price: 0 });
    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: id, action: 'EDIT' } });
    expect(audits.map((a) => a.field)).toEqual(['tripadvisorCount']);
  });

  it('refuses a correction that leaves no review at all, and changes nothing', async () => {
    const id = (await review({ tripadvisorCount: 3, googleCount: 2 })).body.report.id as string;
    for (const bad of [{ tripadvisorCount: 0, googleCount: 0 }, { tripadvisorCount: -1 }]) {
      const res = await letanA.patch(`/api/reception/reports/${id}`).send({ roomService: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    // One count to zero is fine while the other still holds a review…
    expect((await letanA.patch(`/api/reception/reports/${id}`).send({ roomService: { tripadvisorCount: 0 } })).status).toBe(200);
    // …but not the last one.
    const last = await letanA.patch(`/api/reception/reports/${id}`).send({ roomService: { googleCount: 0 } });
    expect(last.status).toBe(422);
    const stored = await testPrisma.roomServiceReport.findUniqueOrThrow({ where: { reportId: id } });
    expect([stored.tripadvisorCount, stored.googleCount]).toEqual([0, 2]);
    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: id, action: 'EDIT' } });
    expect(audits.map((a) => [a.field, a.oldValue, a.newValue])).toEqual([['tripadvisorCount', '3', '0']]);
  });

  it('leaves the other services exactly as they were — priced, and without counts', async () => {
    const noPrice = await letanA.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'LAUNDRY', guestName: 'Khách' },
    });
    expect(noPrice.status).toBe(422);
    const laundry = await letanA.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'LAUNDRY', guestName: 'Khách', price: 50000, tripadvisorCount: 9 },
    });
    expect(laundry.status).toBe(201);
    expect(laundry.body.report.roomService).toMatchObject({
      price: 50000,
      tripadvisorCount: null,
      googleCount: null,
      countsAsRevenue: true,
    });
  });

  it('is withdrawn with the ordinary void, and stays on record', async () => {
    const id = (await review({ tripadvisorCount: 1, googleCount: 1 })).body.report.id as string;
    const voided = await letanA.post(`/api/reception/reports/${id}/void`).send({ reason: 'QA' });
    expect(voided.status).toBe(200);
    expect(voided.body.report.voided).toBe(true);
    expect(await testPrisma.roomServiceReport.count()).toBe(1);
  });
});

/* ================================================================== */
/* Service quality: correct, complete                                  */
/* ================================================================== */

describe('a service-quality report', () => {
  beforeEach(async () => {
    at('2026-09-25', '08:00');
    await checkIn(letanA, 'A', 'Đức');
  });

  it('starts as "Đã tiếp nhận", and a correction touches only Tên khách, Mã EZ and Mô tả', async () => {
    at('2026-09-25', '08:30');
    const id = await complaint(letanA);
    const created = await testPrisma.receptionOperationalReport.findUniqueOrThrow({ where: { id } });

    at('2026-09-25', '09:00');
    const res = await letanA.patch(`/api/reception/reports/${id}`).send({
      complaint: { guestName: 'Khách Sửa', ezCode: 'EZ9', description: 'Phòng rất ồn', completedAt: '2020-01-01T00:00:00Z' },
    });
    expect(res.status).toBe(200);
    expect(res.body.report.complaint).toMatchObject({
      guestName: 'Khách Sửa',
      ezCode: 'EZ9',
      description: 'Phòng rất ồn',
      completed: false,
      completedAt: null,
    });
    expect(res.body.report.createdAt).toBe(created.createdAt.toISOString());
    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: id, action: 'EDIT' } });
    expect(audits.map((a) => a.field).sort()).toEqual(['description', 'ezCode', 'guestName']);
  });

  it('completes with no handling text, at the server\'s time', async () => {
    const id = await complaint(letanA);
    at('2026-09-25', '09:15');
    const done = await complete(letanA, id, { completedAt: '2020-01-01T00:00:00Z' });
    expect(done.complaint).toMatchObject({
      completed: true,
      resolution: null,
      completedAt: hcm('2026-09-25', '09:15').toISOString(),
    });
  });

  it('keeps its completion exactly as it was when corrected afterwards', async () => {
    const id = await complaint(letanA);
    at('2026-09-25', '09:15');
    await complete(letanA, id, { resolution: 'Đổi phòng' });
    at('2026-09-25', '09:30');
    const res = await letanA.patch(`/api/reception/reports/${id}`).send({ complaint: { description: 'Phòng ồn (đã sửa)' } });
    expect(res.status).toBe(200);
    expect(res.body.report.complaint).toMatchObject({
      description: 'Phòng ồn (đã sửa)',
      completed: true,
      resolution: 'Đổi phòng',
      completedAt: hcm('2026-09-25', '09:15').toISOString(),
    });
  });
});

/* ================================================================== */
/* Technical "Đã hoàn thành" — by the day the repair was FINISHED      */
/* ================================================================== */

describe('Technical "Đã hoàn thành" by completion date', () => {
  async function finishAt(id: string, day: string, hhmm: string) {
    at(day, hhmm);
    await assignTo(admin, id, tech);
    expect((await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900' })).status).toBe(200);
    expect((await tech.post(`/api/issues/${id}/complete`).send({})).status).toBe(200);
  }
  const done = async (q: string) => {
    const res = await tech.get(`/api/issues?stage=COMPLETED&pageSize=100&${q}`);
    expect(res.status, q).toBe(200);
    return (res.body.issues as { id: string }[]).map((i) => i.id).sort();
  };

  it('counts inclusive Vietnamese days of completion — not of the report — and keeps the branch filter', async () => {
    at('2026-09-20', '08:00');
    const reported24done25 = await incidentAt(letanA, '2026-09-24', '09:00');
    const lastMinute25 = await incidentAt(letanA, '2026-09-25', '08:00');
    const midnight26 = await incidentAt(letanA, '2026-09-25', '09:00');
    const open25 = await incidentAt(letanA, '2026-09-25', '10:00');
    const otherBranch = await incidentAt(letanCn2, '2026-09-25', '07:00');
    await finishAt(reported24done25, '2026-09-25', '00:00');
    await finishAt(lastMinute25, '2026-09-25', '23:59');
    await finishAt(midnight26, '2026-09-26', '00:00');
    await finishAt(otherBranch, '2026-09-25', '12:00');
    at('2026-09-27', '09:00');

    // The 25th, inclusive at both ends; the incident REPORTED on the 24th is in,
    // the one reported on the 25th but finished at midnight is not.
    const on25 = await done('completedFrom=2026-09-25&completedTo=2026-09-25');
    expect(on25).toEqual([reported24done25, lastMinute25, otherBranch].sort());
    expect(on25).not.toContain(open25);
    expect(await done('completedFrom=2026-09-24&completedTo=2026-09-24')).toEqual([]);
    expect(await done('completedFrom=2026-09-26&completedTo=2026-09-26')).toEqual([midnight26]);
    // Branch filter still applies inside the window.
    expect(await done(`branchId=${cn2}&completedFrom=2026-09-25&completedTo=2026-09-25`)).toEqual([otherBranch]);
    // No window: the whole history, as before.
    expect(await done('')).toEqual([reported24done25, lastMinute25, midnight26, otherBranch].sort());
  });

  it('refuses half a window, a window backwards, or a malformed day', async () => {
    for (const q of [
      'completedFrom=2026-09-25',
      'completedTo=2026-09-25',
      'completedFrom=2026-09-26&completedTo=2026-09-25',
      'completedFrom=25/09/2026&completedTo=2026-09-25',
    ]) {
      expect((await tech.get(`/api/issues?stage=COMPLETED&${q}`)).status, q).toBe(422);
    }
  });
});
