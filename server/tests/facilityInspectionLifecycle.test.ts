/**
 * Facility issue lifecycle v2 — cause, repair result and "Nghiệm thu".
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Reception may report with or without a cause, and what it reported is
 *      never overwritten — a technician's determination lives on their attempt.
 *   2. "Hoàn thành" is NOT "Đã hoàn thành". The technician's finish stops the
 *      timer and waits for Quản lý kỹ thuật; only a passed inspection closes it.
 *   3. A failed inspection needs a reason, leaves the judged attempt exactly as
 *      it was, and sends the incident back so the next "Tiếp nhận" opens a NEW
 *      attempt — Lần 1, its verdict, and Lần 2 are separate, permanent facts.
 *   4. Every timestamp is the server's. Nothing the client sends becomes one.
 *   5. Only Quản lý kỹ thuật inspects, and Quản lý kỹ thuật does nothing else
 *      of the technician's. The API is the control, so the API is what is tested.
 *   6. Work completed before inspection existed reads "Chưa có dữ liệu" — no
 *      verdict is invented for it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { getClock, resetClock, setClock } from '../src/lib/clock';
import { setInspectionEnabledForTests } from '../src/issue/issueLifecycle';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';
const TECHNICAL2_PASSWORD = 'Technical2';
const MANAGER_PASSWORD = 'Manager1';

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const at = (hhmm: string) => setClock({ now: () => hcm('2026-09-25', hhmm) });

let cn1 = 0;
let cn5 = 0;
let letan1: Agent;
let letan5: Agent;
let letan1Id = 0;
let tech: Agent;
let tech2: Agent;
let techId = 0;
let manager: Agent;
let managerId = 0;
let admin: Agent;

beforeAll(async () => {
  // Inspection is DORMANT by default; this suite exercises the implementation
  // that is kept for the day it is switched on. The dormant default has its own
  // block at the end of the file.
  setInspectionEnabledForTests(true);
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;

  letan1Id = (
    await createReceptionist(cn1, { username: 'letan1', fullName: 'test', mustChangePassword: false })
  ).id;
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn5, { username: 'letan5', fullName: 'Lễ tân CN5', mustChangePassword: false });
  letan5 = (await loginAgent(app, 'letan5', RECEPTIONIST_PASSWORD)).agent;

  techId = (
    await createUser({
      username: 'kythuat',
      password: TECHNICAL_PASSWORD,
      fullName: 'Kỹ thuật viên trực',
      role: 'TECHNICAL',
      branchId: null,
      mustChangePassword: false,
    })
  ).id;
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;
  await createUser({
    username: 'kythuat2',
    password: TECHNICAL2_PASSWORD,
    fullName: 'Kỹ thuật viên hai',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech2 = (await loginAgent(app, 'kythuat2', TECHNICAL2_PASSWORD)).agent;

  managerId = (
    await createUser({
      username: 'quanlykythuat',
      password: MANAGER_PASSWORD,
      fullName: 'Quản lý Hùng',
      role: 'TECHNICAL_MANAGER',
      branchId: null,
      mustChangePassword: false,
    })
  ).id;
  // Its branches are ticked on the account; it sees and inspects only those.
  await testPrisma.userBranchAssignment.createMany({ data: [cn1, cn5].map((branchId) => ({ userId: managerId, branchId })) });
  manager = (await loginAgent(app, 'quanlykythuat', MANAGER_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await testPrisma.notification.deleteMany();
  await resetShiftData();
  at('10:00');
});

afterAll(async () => {
  setInspectionEnabledForTests(null);
  resetClock();
  await testPrisma.$disconnect();
});

/** Reports "Máy lạnh không lạnh" in room 301 at CN1 and returns its id. */
async function report(extra: Record<string, unknown> = {}, agent: Agent = letan1): Promise<string> {
  const res = await agent.post('/api/issues').send({
    areaCategory: 'ROOM',
    roomNumber: '301',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không lạnh',
    ...extra,
  });
  expect(res.status).toBe(201);
  const id = res.body.issue.id as string;
  // The report time is a DB default (the real clock). Pin it to the test clock,
  // so date-ranged reads (the Admin's 2026-09-25) do not depend on today's date.
  await testPrisma.hotelIssue.update({ where: { id }, data: { createdAt: getClock().now() } });
  return id;
}

async function accept(agent: Agent, id: string, name = 'Bảo', phone = '0369852177') {
  const me = (await agent.get('/api/auth/me')).body.user.id as number;
  const held = (await admin.get(`/api/issues/${id}`)).body.issue.assignedTechnician?.id;
  if (held !== me) {
    expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: me })).status).toBe(200);
  }
  const res = await agent.post(`/api/issues/${id}/accept`).send({ technicianName: name, technicianPhone: phone });
  expect(res.status).toBe(200);
  return res.body.issue;
}

async function complete(agent: Agent, id: string, body: Record<string, unknown> = { result: 'Đã nạp gas' }) {
  const res = await agent.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', ...body });
  expect(res.status).toBe(200);
  return res.body.issue;
}

async function inspect(id: string, body: Record<string, unknown>) {
  return manager.post(`/api/issues/${id}/inspect`).send(body);
}

/** Straight to "Chờ nghiệm thu": reported, accepted at 10:30, finished at 11:10. */
async function awaitingInspection(extra: Record<string, unknown> = {}): Promise<string> {
  const id = await report(extra);
  at('10:30');
  await accept(tech, id);
  at('11:10');
  await complete(tech, id, { cause: 'Thiếu gas', result: 'Đã nạp gas' });
  return id;
}

/* ================================================================== */
/* Reception: the report                                               */
/* ================================================================== */

describe('Reception reports a facility issue', () => {
  it('may give the cause when it is already known', async () => {
    const id = await report({ cause: 'Thiếu gas' });

    const res = await letan1.get(`/api/issues/${id}`);
    expect(res.body.issue).toMatchObject({
      description: 'Máy lạnh không lạnh',
      reportedCause: 'Thiếu gas',
      cause: 'Thiếu gas',
      stage: 'WAITING',
      stageLabel: 'Chờ kỹ thuật',
      inspectionState: 'PENDING',
    });
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.cause).toBe('Thiếu gas');
  });

  it('may leave the cause empty — whitespace is empty too', async () => {
    const without = await report();
    const blank = await report({ cause: '   ' });

    for (const id of [without, blank]) {
      const res = await letan1.get(`/api/issues/${id}`);
      expect(res.body.issue.reportedCause).toBeNull();
      expect(res.body.issue.cause).toBeNull();
    }
  });

  it('stamps the report time on the server, ignoring any time the client sends', async () => {
    const before = Date.now();
    // Posted directly: `report()` pins the time to the test clock, and this test
    // is about the time the server stamps on its own.
    const res = await letan1.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '301',
      category: 'AIR_CONDITIONER',
      description: 'Máy lạnh không lạnh',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: res.body.issue.id as string } });
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(stored.createdAt.getUTCFullYear()).not.toBe(2020);
  });

  /**
   * "Người báo: Đức", not "test (Đức)". The serializer composes it from the
   * shift the receptionist checked in to; no screen parses the old string.
   */
  it('names the receptionist on the shift as the reporter, and keeps the account for audit', async () => {
    at('08:10');
    const checkIn = await letan1.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Đức' });
    expect(checkIn.status).toBe(201);
    const id = await report();

    const res = await admin.get(`/api/issues/${id}`);
    expect(res.body.issue.reporterName).toBe('Đức');
    expect(res.body.issue.reportedByName).toBe('test');
  });

  it('names the account when nobody was checked in', async () => {
    const id = await report();
    const res = await admin.get(`/api/issues/${id}`);
    expect(res.body.issue.reporterName).toBe('test');
  });
});

/* ================================================================== */
/* The technician                                                      */
/* ================================================================== */

describe('the technician repairs', () => {
  it('sees the new incident in the fresh queue once it is assigned to it', async () => {
    const id = await report();
    expect((await tech.get('/api/issues?stage=WAITING')).body.issues).toHaveLength(0);
    expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: techId })).status).toBe(200);
    const list = await tech.get('/api/issues?stage=WAITING');
    expect(list.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);

    const counts = await tech.get('/api/issues/counts');
    expect(counts.body.counts).toMatchObject({ newCount: 1, reworkCount: 0, awaitingInspectionCount: 0 });
  });

  it('starts the timer at "Tiếp nhận", not at the report', async () => {
    const id = await report();
    at('10:30');
    const accepted = await accept(tech, id);
    expect(accepted.attempts).toHaveLength(1);
    expect(accepted.attempts[0].acceptedAt).toBe(hcm('2026-09-25', '10:30').toISOString());

    at('10:45');
    const running = await tech.get(`/api/issues/${id}`);
    expect(running.body.issue.durationLabel).toBe('15 phút');
    expect(running.body.issue.repairerName).toBe('Bảo');
  });

  it('can record the missing cause during the repair, without touching the reported one', async () => {
    const id = await report();
    await accept(tech, id);

    const res = await tech.post(`/api/issues/${id}/cause`).send({ cause: 'Thiếu gas' });
    expect(res.status).toBe(200);
    expect(res.body.issue.cause).toBe('Thiếu gas');
    expect(res.body.issue.reportedCause).toBeNull();
    expect(res.body.issue.attempts[0].cause).toBe('Thiếu gas');

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.cause).toBeNull();
  });

  it('keeps the reported cause beside a different determination', async () => {
    const id = await report({ cause: 'Hết gas' });
    await accept(tech, id);
    const done = await complete(tech, id, { cause: 'Hỏng tụ điện', result: 'Đã thay tụ điện' });

    expect(done.reportedCause).toBe('Hết gas');
    // The latest technical determination is THE cause.
    expect(done.cause).toBe('Hỏng tụ điện');
  });

  it('refuses a cause on an incident nobody is repairing', async () => {
    const id = await report();
    // Its own job, assigned but not yet taken.
    expect((await admin.post(`/api/issues/${id}/assign`).send({ technicianUserId: techId })).status).toBe(200);
    const res = await tech.post(`/api/issues/${id}/cause`).send({ cause: 'Thiếu gas' });
    expect(res.status).toBe(409);
  });

  it('needs a result to finish — whitespace is not a result', async () => {
    const id = await report();
    await accept(tech, id);
    for (const body of [{}, { result: '   ' }]) {
      const res = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', ...body });
      expect(res.status).toBe(422);
    }
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('IN_PROGRESS');
  });

  it('finishing stops the timer, records the result, and waits for inspection', async () => {
    const id = await report();
    at('10:30');
    await accept(tech, id);
    await tech.post(`/api/issues/${id}/cause`).send({ cause: 'Thiếu gas' });
    at('11:10');
    // A client-sent completion time is ignored; an empty cause keeps the one
    // recorded during the repair.
    const done = await complete(tech, id, { result: 'Đã nạp gas', cause: '', completedAt: '2020-01-01T00:00:00Z' });

    expect(done).toMatchObject({
      status: 'AWAITING_INSPECTION',
      stage: 'AWAITING_INSPECTION',
      stageLabel: 'Chờ nghiệm thu',
      inspectionState: 'PENDING',
      inspectionLabel: 'Chưa nghiệm thu',
      completedAt: hcm('2026-09-25', '11:10').toISOString(),
      durationLabel: '40 phút',
      cause: 'Thiếu gas',
    });
    expect(done.attempts[0]).toMatchObject({
      attemptNumber: 1,
      technicianName: 'Bảo',
      outcome: 'COMPLETED',
      outcomeAt: hcm('2026-09-25', '11:10').toISOString(),
      cause: 'Thiếu gas',
      result: 'Đã nạp gas',
      inspection: null,
    });

    // Quản lý kỹ thuật is told; the reporter is not told "hoàn thành" yet.
    const managerNotes = await testPrisma.notification.findMany({ where: { userId: managerId } });
    expect(managerNotes.map((n) => n.title)).toContain('Sự cố chờ nghiệm thu');
    const reporterNotes = await testPrisma.notification.findMany({ where: { userId: letan1Id } });
    expect(reporterNotes.map((n) => n.title)).not.toContain('Sự cố đã hoàn thành');
  });
});

/* ================================================================== */
/* Inspection passes                                                   */
/* ================================================================== */

describe('"Nghiệm thu đạt"', () => {
  it('the manager sees the finished repair in the inspection queue', async () => {
    const id = await awaitingInspection();
    const list = await manager.get('/api/issues?stage=AWAITING_INSPECTION');
    expect(list.status).toBe(200);
    expect(list.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);
    const counts = await manager.get('/api/issues/counts');
    expect(counts.body.counts.awaitingInspectionCount).toBe(1);
  });

  it('records the verdict, the inspector and the server time, and closes the incident', async () => {
    const id = await awaitingInspection();
    at('11:30');
    const res = await inspect(id, { result: 'PASSED', note: 'Máy lạnh chạy tốt', inspectedAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'COMPLETED',
      stageLabel: 'Đã hoàn thành',
      inspectionState: 'PASSED',
      inspectionLabel: 'Đạt',
      // The repair's completion time is the technician's, not the inspection's.
      completedAt: hcm('2026-09-25', '11:10').toISOString(),
    });
    expect(res.body.issue.attempts[0].inspection).toEqual({
      result: 'PASSED',
      resultLabel: 'Đạt',
      inspectedByName: 'Quản lý Hùng',
      inspectedAt: hcm('2026-09-25', '11:30').toISOString(),
      note: 'Máy lạnh chạy tốt',
    });

    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt.inspectedByUserId).toBe(managerId);

    // NOW the reporter hears it is done.
    const notes = await testPrisma.notification.findMany({ where: { userId: letan1Id } });
    expect(notes.map((n) => n.title)).toContain('Sự cố đã hoàn thành');
  });

  it('the note is optional on a pass', async () => {
    const id = await awaitingInspection();
    const res = await inspect(id, { result: 'PASSED' });
    expect(res.status).toBe(200);
    expect(res.body.issue.attempts[0].inspection.note).toBeNull();
  });

  it('Reception sees the pass on its own branch', async () => {
    const id = await awaitingInspection();
    await inspect(id, { result: 'PASSED' });
    const res = await letan1.get(`/api/issues/${id}`);
    expect(res.body.issue).toMatchObject({
      stageLabel: 'Đã hoàn thành',
      inspectionLabel: 'Đạt',
      repairerName: 'Bảo',
      cause: 'Thiếu gas',
    });
    expect(res.body.issue.attempts).toHaveLength(1);
  });

  it('Admin sees the full inspection record in the incident report', async () => {
    const id = await awaitingInspection();
    at('11:30');
    await inspect(id, { result: 'PASSED', note: 'OK' });
    const res = await admin.get('/api/admin/reports/incidents?from=2026-09-25&to=2026-09-25');
    expect(res.status).toBe(200);
    const issue = res.body.issues.find((i: { id: string }) => i.id === id);
    expect(issue.attempts[0].inspection).toMatchObject({
      result: 'PASSED',
      inspectedByName: 'Quản lý Hùng',
      inspectedAt: hcm('2026-09-25', '11:30').toISOString(),
      note: 'OK',
    });

    const pdf = await admin.get('/api/admin/reports/incidents.pdf?from=2026-09-25&to=2026-09-25');
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('cannot be judged twice', async () => {
    const id = await awaitingInspection();
    await inspect(id, { result: 'PASSED' });
    const again = await inspect(id, { result: 'FAILED', note: 'Đổi ý' });
    expect(again.status).toBe(409);
    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt.inspectionResult).toBe('PASSED');
  });

  it('refuses to judge work that is not finished', async () => {
    const fresh = await report();
    expect((await inspect(fresh, { result: 'PASSED' })).status).toBe(409);
    await accept(tech, fresh);
    expect((await inspect(fresh, { result: 'PASSED' })).status).toBe(409);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: fresh } });
    expect(stored.status).toBe('IN_PROGRESS');
  });
});

/* ================================================================== */
/* Inspection fails, and the rework                                    */
/* ================================================================== */

describe('"Không đạt / Yêu cầu sửa lại"', () => {
  it('requires a reason — whitespace is not a reason', async () => {
    const id = await awaitingInspection();
    for (const body of [{ result: 'FAILED' }, { result: 'FAILED', note: '   ' }]) {
      const res = await inspect(id, body);
      expect(res.status).toBe(422);
    }
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('AWAITING_INSPECTION');
  });

  it('records the verdict and sends the incident back, leaving the repair as it was', async () => {
    const id = await awaitingInspection();
    const before = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });

    at('11:40');
    const res = await inspect(id, { result: 'FAILED', note: 'Vẫn chưa lạnh' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'NEW',
      stage: 'REWORK',
      stageLabel: 'Cần sửa lại',
      needsRework: true,
      inspectionState: 'FAILED',
      inspectionLabel: 'Không đạt',
      // The current assignment is cleared — nobody is on it now…
      technicianName: null,
      completedAt: null,
    });
    // …and the attempt keeps every fact it had, plus the verdict.
    const after = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(after).toMatchObject({
      attemptNumber: before.attemptNumber,
      technicianNameSnapshot: before.technicianNameSnapshot,
      acceptedAt: before.acceptedAt,
      outcome: 'COMPLETED',
      outcomeAt: before.outcomeAt,
      cause: 'Thiếu gas',
      result: 'Đã nạp gas',
      inspectionResult: 'FAILED',
      inspectedByUserId: managerId,
      inspectedAt: hcm('2026-09-25', '11:40'),
      inspectionNote: 'Vẫn chưa lạnh',
    });

    // Bộ phận kỹ thuật is told, with the reason.
    const notes = await testPrisma.notification.findMany({ where: { userId: techId } });
    expect(notes.some((n) => n.title === 'Sự cố cần sửa lại' && n.body.includes('Vẫn chưa lạnh'))).toBe(true);

    // It sits in "Cần sửa lại", not in the fresh queue.
    const counts = await tech.get('/api/issues/counts');
    expect(counts.body.counts).toMatchObject({ newCount: 0, reworkCount: 1 });
    const rework = await tech.get('/api/issues?stage=REWORK');
    expect(rework.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);
    const fresh = await tech.get('/api/issues?stage=WAITING');
    expect(fresh.body.issues).toHaveLength(0);
  });

  it('the next "Tiếp nhận" opens attempt 2 with its own timer; a second inspection can pass', async () => {
    const id = await awaitingInspection();
    at('11:40');
    await inspect(id, { result: 'FAILED', note: 'Vẫn chưa lạnh' });

    at('12:20');
    const second = await accept(tech2, id, 'Minh', '0911222333');
    expect(second.attempts).toHaveLength(2);
    expect(second.attempts[1]).toMatchObject({
      attemptNumber: 2,
      technicianName: 'Minh',
      acceptedAt: hcm('2026-09-25', '12:20').toISOString(),
      outcome: null,
    });
    // The timer restarts: the current assignment is measured from 12:20.
    expect(second.acceptedAt).toBe(hcm('2026-09-25', '12:20').toISOString());
    expect(second.inspectionState).toBe('FAILED');

    at('13:00');
    const done = await complete(tech2, id, { cause: 'Rò rỉ ống đồng', result: 'Đã hàn ống, nạp lại gas' });
    expect(done.stage).toBe('AWAITING_INSPECTION');
    expect(done.durationLabel).toBe('40 phút');
    const queue = await manager.get('/api/issues?stage=AWAITING_INSPECTION');
    expect(queue.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);

    at('13:20');
    const passed = await inspect(id, { result: 'PASSED' });
    expect(passed.status).toBe(200);
    const issue = passed.body.issue;
    expect(issue).toMatchObject({
      status: 'COMPLETED',
      inspectionState: 'PASSED',
      repairerName: 'Minh',
      cause: 'Rò rỉ ống đồng',
      completedAt: hcm('2026-09-25', '13:00').toISOString(),
    });
    expect(issue.attempts).toHaveLength(2);
    // Lần 1 and its failed verdict are still exactly there.
    expect(issue.attempts[0]).toMatchObject({
      attemptNumber: 1,
      technicianName: 'Bảo',
      cause: 'Thiếu gas',
      result: 'Đã nạp gas',
      outcomeAt: hcm('2026-09-25', '11:10').toISOString(),
      inspection: { result: 'FAILED', note: 'Vẫn chưa lạnh', inspectedByName: 'Quản lý Hùng' },
    });
    expect(issue.attempts[1]).toMatchObject({
      attemptNumber: 2,
      technicianName: 'Minh',
      result: 'Đã hàn ống, nạp lại gas',
      inspection: { result: 'PASSED', inspectedAt: hcm('2026-09-25', '13:20').toISOString() },
    });
  });

  it('Admin sees both attempts, both verdicts and the rejection reason', async () => {
    const id = await awaitingInspection();
    await inspect(id, { result: 'FAILED', note: 'Vẫn chưa lạnh' });
    await accept(tech2, id, 'Minh', '0911222333');
    await complete(tech2, id, { result: 'Đã hàn ống' });
    await inspect(id, { result: 'PASSED' });

    const res = await admin.get('/api/admin/reports/incidents?from=2026-09-25&to=2026-09-25');
    const issue = res.body.issues.find((i: { id: string }) => i.id === id);
    expect(issue.attempts.map((a: { inspection: { result: string } }) => a.inspection.result)).toEqual([
      'FAILED',
      'PASSED',
    ]);
    expect(issue.attempts[0].inspection.note).toBe('Vẫn chưa lạnh');
    expect(issue.reporterName).toBe('test');

    const summary = await admin.get('/api/admin/reports/incidents/summary?from=2026-09-25&to=2026-09-25');
    expect(summary.body.summary).toMatchObject({ completedCount: 1, failedInspections: 1, awaitingInspectionCount: 0 });
  });

  /**
   * "SỬA VẤN ĐỀ" replaced the old "refuse edits once worked" rule: an incident
   * that failed inspection is open again, so Reception may correct what the
   * report says — and nothing about the repairs that were made changes.
   */
  it('lets Reception correct a report that came back for rework, keeping its repair history', async () => {
    const id = await awaitingInspection();
    await inspect(id, { result: 'FAILED', note: 'Vẫn chưa lạnh' });
    const res = await letan1.put(`/api/issues/${id}`).send({ description: 'Đổi mô tả' });
    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('NEW');
    expect(res.body.issue.attempts).toHaveLength(1);
    expect(res.body.issue.edits).toEqual([expect.objectContaining({ field: 'description', newValue: 'Đổi mô tả' })]);
  });

  it('refuses to correct a report whose repair is finished and awaiting inspection', async () => {
    const id = await awaitingInspection();
    const res = await letan1.put(`/api/issues/${id}`).send({ description: 'Đổi mô tả' });
    expect(res.status).toBe(409);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.description).not.toBe('Đổi mô tả');
  });
});

/* ================================================================== */
/* Who may do what                                                     */
/* ================================================================== */

describe('only Quản lý kỹ thuật inspects', () => {
  it('refuses Reception, the technician and the Admin', async () => {
    const id = await awaitingInspection();
    for (const agent of [letan1, tech, admin]) {
      const pass = await agent.post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' });
      expect(pass.status).toBe(403);
      const fail = await agent.post(`/api/issues/${id}/inspect`).send({ result: 'FAILED', note: 'x' });
      expect(fail.status).toBe(403);
    }
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('AWAITING_INSPECTION');
    expect(await testPrisma.technicalRepairAttempt.count({ where: { inspectionResult: { not: null } } })).toBe(0);
  });

  it('refuses an anonymous caller', async () => {
    const id = await awaitingInspection();
    const { default: request } = await import('supertest');
    const res = await request(app).post(`/api/issues/${id}/inspect`).send({ result: 'PASSED' });
    expect(res.status).toBe(401);
  });
});

describe('Quản lý kỹ thuật does not do the technician’s work, or anyone else’s', () => {
  it('cannot accept, record a cause, complete or give up a repair', async () => {
    const id = await report();
    expect(
      (await manager.post(`/api/issues/${id}/accept`).send({ technicianName: 'X', technicianPhone: '1' })).status,
    ).toBe(403);
    await accept(tech, id);
    expect((await manager.post(`/api/issues/${id}/cause`).send({ cause: 'x' })).status).toBe(403);
    expect((await manager.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', result: 'x' })).status).toBe(403);
    expect((await manager.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' })).status).toBe(403);

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('IN_PROGRESS');
  });

  it('has no Admin surface, no reception journal and no booking queue', async () => {
    expect((await manager.get('/api/admin/users')).status).toBe(403);
    expect((await manager.get('/api/admin/reports/incidents?from=2026-09-25&to=2026-09-25')).status).toBe(403);
    expect(
      (
        await manager
          .post('/api/reception/reports')
          .send({ category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'A', description: 'B' } })
      ).status,
    ).toBe(403);
    // No booking queue: the server confines the role to its technical routes.
    expect((await manager.get('/api/bookings/new')).status).toBe(403);
    const badges = await manager.get('/api/nav-badges');
    expect(badges.body.counts).toMatchObject({ new: 0, pendingReview: 0, rejected: 0 });
  });

  it('sees the incidents of its ticked branches — and follows the Admin moving them', async () => {
    await report();
    await report({}, letan5);
    const res = await manager.get('/api/issues');
    expect(res.status).toBe(200);
    expect(res.body.issues.map((i: { branchId: number }) => i.branchId).sort()).toEqual([cn1, cn5].sort());

    expect((await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn1] })).status).toBe(200);
    try {
      const narrowed = await manager.get('/api/issues');
      expect(narrowed.body.issues.map((i: { branchId: number }) => i.branchId)).toEqual([cn1]);
      expect((await manager.get(`/api/issues?branchId=${cn5}`)).status).toBe(403);
    } finally {
      await admin.put(`/api/admin/users/${managerId}`).send({ branchIds: [cn1, cn5] });
    }
  });
});

describe('branch isolation for Reception is unchanged', () => {
  it('another branch cannot read, list or edit the incident', async () => {
    const id = await awaitingInspection();
    expect((await letan5.get(`/api/issues/${id}`)).status).toBe(403);
    const list = await letan5.get('/api/issues');
    expect(list.body.issues).toHaveLength(0);
    expect((await letan5.put(`/api/issues/${id}`).send({ description: 'x' })).status).toBe(403);
  });
});

/* ================================================================== */
/* Work done before inspection existed                                 */
/* ================================================================== */

describe('historical incidents', () => {
  it('read "Chưa có dữ liệu" and are never given a verdict', async () => {
    const id = await report();
    // A completed incident exactly as the previous release left one: COMPLETED,
    // one COMPLETED attempt, and no inspection columns at all.
    await testPrisma.hotelIssue.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        acceptedAt: hcm('2026-09-20', '09:00'),
        technicianName: 'Cũ',
        technicianPhone: '0900000000',
        completedAt: hcm('2026-09-20', '09:30'),
      },
    });
    await testPrisma.technicalRepairAttempt.create({
      data: {
        issueId: id,
        attemptNumber: 1,
        technicianNameSnapshot: 'Cũ',
        technicianPhone: '0900000000',
        acceptedAt: hcm('2026-09-20', '09:00'),
        outcome: 'COMPLETED',
        outcomeAt: hcm('2026-09-20', '09:30'),
      },
    });

    const res = await admin.get(`/api/issues/${id}`);
    expect(res.body.issue).toMatchObject({
      stageLabel: 'Đã hoàn thành',
      inspectionState: 'NO_DATA',
      inspectionLabel: 'Chưa có dữ liệu',
      repairerName: 'Cũ',
    });
    expect(res.body.issue.attempts[0].inspection).toBeNull();

    // And nobody can retro-fit one.
    expect((await inspect(id, { result: 'PASSED' })).status).toBe(409);
    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt.inspectionResult).toBeNull();
  });
});

/* ================================================================== */
/* The account                                                         */
/* ================================================================== */

describe('the Admin creates a Quản lý kỹ thuật account', () => {
  it('with its ticked branches — never none', async () => {
    const base = { username: 'qlkt_moi', fullName: 'Quản lý mới', temporaryPassword: 'TempPass123', role: 'TECHNICAL_MANAGER' };
    expect((await admin.post('/api/admin/users').send(base)).status).toBe(422);
    const res = await admin.post('/api/admin/users').send({ ...base, branchIds: [cn1, cn5] });
    expect(res.status).toBe(201);
    const stored = await testPrisma.user.findUniqueOrThrow({
      where: { username: 'qlkt_moi' },
      include: { branchAssignments: true },
    });
    expect(stored.role).toBe('TECHNICAL_MANAGER');
    expect(stored.branchId).toBeNull();
    expect(stored.branchAssignments.map((a) => a.branchId).sort()).toEqual([cn1, cn5].sort());
    await testPrisma.user.delete({ where: { id: stored.id } });
  });

  it('refuses to bind it to one branch', async () => {
    const res = await admin.post('/api/admin/users').send({
      username: 'qlkt_sai',
      fullName: 'Quản lý sai',
      temporaryPassword: 'TempPass123',
      role: 'TECHNICAL_MANAGER',
      branchId: cn1,
    });
    expect(res.status).toBe(422);
  });
});

/* ================================================================== */
/* Found by the independent review — each pinned so it cannot return   */
/* ================================================================== */

/** An incident exactly as the OLD workflow left one: IN_PROGRESS, no attempt. */
async function legacyInProgress(columns: Record<string, unknown>): Promise<string> {
  const id = await report();
  await testPrisma.hotelIssue.update({ where: { id }, data: { status: 'IN_PROGRESS', assignedTechnicianUserId: techId, ...columns } });
  return id;
}

describe('incidents accepted before repair attempts existed', () => {
  /**
   * NEVER STRANDED. With no acceptance time on file there is no repair record a
   * verdict could be stamped on, so "Hoàn thành" closes it as it did before
   * inspection existed — instead of parking it in "Chờ nghiệm thu", where
   * inspection would 409 and no transition could ever move it again.
   */
  it('with no acceptance on file, "Hoàn thành" closes it rather than leaving it uninspectable', async () => {
    const id = await legacyInProgress({ acceptedAt: null, technicianName: null });
    const res = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT', result: 'Đã sửa' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'COMPLETED',
      inspectionState: 'NO_DATA',
      inspectionLabel: 'Chưa có dữ liệu',
    });
    // Nothing invented for it…
    expect(res.body.issue.attempts).toHaveLength(0);
    // …and it is not waiting for anybody.
    const counts = await manager.get('/api/issues/counts');
    expect(counts.body.counts.awaitingInspectionCount).toBe(0);
  });

  it('with an acceptance on file, the attempt is rebuilt from it and inspection works', async () => {
    const id = await legacyInProgress({
      acceptedAt: hcm('2026-09-24', '09:00'),
      technicianName: 'Cũ',
      technicianPhone: '0900000000',
    });
    at('10:30');
    const done = await complete(tech, id, { result: 'Đã thay bóng đèn' });
    expect(done.status).toBe('AWAITING_INSPECTION');
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts[0]).toMatchObject({
      technicianName: 'Cũ',
      acceptedAt: hcm('2026-09-24', '09:00').toISOString(),
      outcome: 'COMPLETED',
      result: 'Đã thay bóng đèn',
    });
    const passed = await inspect(id, { result: 'PASSED' });
    expect(passed.status).toBe(200);
    expect(passed.body.issue.status).toBe('COMPLETED');
  });

  it('names its technician as "Người sửa" from the incident itself', async () => {
    const id = await legacyInProgress({ acceptedAt: hcm('2026-09-24', '09:00'), technicianName: 'Cũ' });
    const res = await letan1.get(`/api/issues/${id}`);
    expect(res.body.issue.attempts).toHaveLength(0);
    expect(res.body.issue.repairerName).toBe('Cũ');
  });

  it('"Nguyên nhân" opens its attempt from the acceptance columns instead of refusing', async () => {
    const id = await legacyInProgress({ acceptedAt: hcm('2026-09-24', '09:00'), technicianName: 'Cũ' });
    const res = await tech.post(`/api/issues/${id}/cause`).send({ cause: 'Chập điện' });
    expect(res.status).toBe(200);
    expect(res.body.issue.attempts).toHaveLength(1);
    expect(res.body.issue.attempts[0]).toMatchObject({ technicianName: 'Cũ', outcome: null, cause: 'Chập điện' });
    expect(res.body.issue.cause).toBe('Chập điện');
  });

  it('"Nguyên nhân" says why when there is no acceptance to open an attempt from', async () => {
    const id = await legacyInProgress({ acceptedAt: null, technicianName: null });
    const res = await tech.post(`/api/issues/${id}/cause`).send({ cause: 'Chập điện' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('trước khi có lịch sử sửa chữa');
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(0);
  });
});

describe('only Reception and the Admin report or rewrite an incident', () => {
  const body = { areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'x', branchId: 0 };

  it('refuses Quản lý kỹ thuật and Bộ phận kỹ thuật, at any branch', async () => {
    for (const agent of [manager, tech]) {
      const created = await agent.post('/api/issues').send({ ...body, branchId: cn5 });
      expect(created.status).toBe(403);
    }
    const id = await report();
    for (const agent of [manager, tech]) {
      const edited = await agent.put(`/api/issues/${id}`).send({ description: 'Viết lại' });
      expect(edited.status).toBe(403);
    }
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.description).toBe('Máy lạnh không lạnh');
    expect(await testPrisma.hotelIssue.count({ where: { branchId: cn5 } })).toBe(0);
  });

  it('still lets the Admin report at any branch', async () => {
    const res = await admin.post('/api/issues').send({ ...body, branchId: cn5 });
    expect(res.status).toBe(201);
    expect(res.body.issue.branchId).toBe(cn5);
  });
});

describe('the Excel export states only the verdict its "Nghiệm thu" column describes', () => {
  async function facilitySheetRow(issueId: string) {
    const xlsx = await admin
      .get('/api/admin/reports/operational.xlsx?from=2026-09-25&to=2026-09-25')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const sheet = wb.getWorksheet('Sự cố cơ sở vật chất đang xử lý')!;
    const header = sheet.getRow(1);
    const col = (h: string) => {
      for (let i = 1; i <= header.cellCount; i += 1) if (String(header.getCell(i).value ?? '') === h) return i;
      throw new Error(`no column ${h}`);
    };
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      if (String(row.getCell(col('Mã sự cố')).value ?? '') === issueId) {
        const cell = (h: string) => String(row.getCell(col(h)).value ?? '');
        return {
          inspection: cell('Nghiệm thu'),
          inspector: cell('Người nghiệm thu'),
          note: cell('Ghi chú nghiệm thu'),
        };
      }
    }
    throw new Error('incident not in the export');
  }

  it('leaves an earlier round\'s inspector and reason out while the rework awaits inspection', async () => {
    at('08:10');
    expect(
      (await letan1.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Đức' })).status,
    ).toBe(201);
    const id = await report();
    expect(
      (await letan1.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: id } })).status,
    ).toBe(201);
    expect((await letan1.post('/api/reception/shifts/close').send({})).status).toBe(200);

    at('10:30');
    await accept(tech, id);
    await complete(tech, id);
    expect((await inspect(id, { result: 'FAILED', note: 'Vẫn chưa lạnh' })).status).toBe(200);
    await accept(tech2, id, 'Minh', '0911222333');
    await complete(tech2, id, { result: 'Đã hàn ống' });

    // Repair 2 waits: no verdict is stated, so none is shown beside it.
    expect(await facilitySheetRow(id)).toEqual({ inspection: 'Chưa nghiệm thu', inspector: '', note: '' });

    await inspect(id, { result: 'PASSED', note: 'OK' });
    expect(await facilitySheetRow(id)).toEqual({ inspection: 'Đạt', inspector: 'Quản lý Hùng', note: 'OK' });
  });
});

/* ================================================================== */
/* The DEFAULT: inspection implemented but dormant                     */
/* ================================================================== */

describe('while inspection is dormant (the operational default)', () => {
  beforeEach(() => setInspectionEnabledForTests(false));
  afterEach(() => setInspectionEnabledForTests(true));

  it('"Hoàn thành" closes the incident, as it always has — no result required, no inspection', async () => {
    const id = await report();
    at('10:30');
    await accept(tech, id);
    at('11:10');
    const res = await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'COMPLETED',
      stageLabel: 'Đã hoàn thành',
      inspectionEnabled: false,
      completedAt: hcm('2026-09-25', '11:10').toISOString(),
    });
    // The reporter hears it is done; nobody is asked to inspect it.
    const reporter = await testPrisma.notification.findMany({ where: { userId: letan1Id } });
    expect(reporter.map((n) => n.title)).toContain('Sự cố đã hoàn thành');
    const managers = await testPrisma.notification.findMany({ where: { userId: managerId } });
    expect(managers.map((n) => n.title)).not.toContain('Sự cố chờ nghiệm thu');
  });

  it('"Không sửa được" still sends it back to the queue', async () => {
    const id = await report();
    await accept(tech, id);
    const res = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'NEW', stageLabel: 'Cần sửa lại' });
  });

  it('refuses every inspection, so no verdict can change an incident', async () => {
    const id = await report();
    await accept(tech, id);
    await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });
    for (const body of [{ result: 'PASSED' }, { result: 'FAILED', note: 'x' }]) {
      const res = await inspect(id, body);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('chưa được kích hoạt');
    }
    expect(await testPrisma.technicalRepairAttempt.count({ where: { inspectionResult: { not: null } } })).toBe(0);
  });

  it('has no "Chờ nghiệm thu" queue — even with a row stored as awaiting inspection', async () => {
    // A row the old workflow left behind, so an empty queue proves the filter,
    // not an empty table.
    const id = await report();
    await accept(tech, id);
    await testPrisma.hotelIssue.update({
      where: { id },
      data: { status: 'AWAITING_INSPECTION', completedAt: hcm('2026-09-25', '10:40'), completedByUserId: techId },
    });

    const counts = await tech.get('/api/issues/counts');
    expect(counts.body.counts).toMatchObject({ awaitingInspectionCount: 0, inspectionEnabled: false });
    const queue = await tech.get('/api/issues?stage=AWAITING_INSPECTION');
    expect(queue.status).toBe(200);
    expect(queue.body.issues).toHaveLength(0);
    // Switched on, the same row IS the queue — the filter, not the data, decides.
    setInspectionEnabledForTests(true);
    try {
      const live = await tech.get('/api/issues?stage=AWAITING_INSPECTION');
      expect(live.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);
    } finally {
      setInspectionEnabledForTests(false);
    }
  });

  /**
   * A repair finished while the inspection workflow was being tried stays in
   * the database as AWAITING_INSPECTION — nothing rewrites it — and READS as
   * what it is under the active workflow: finished.
   */
  it('reads a repair finished during the inspection trial as finished, without rewriting it', async () => {
    const id = await report();
    await accept(tech, id);
    await testPrisma.hotelIssue.update({
      where: { id },
      data: { status: 'AWAITING_INSPECTION', completedAt: hcm('2026-09-25', '10:40'), completedByUserId: techId },
    });

    const res = await letan1.get(`/api/issues/${id}`);
    expect(res.body.issue).toMatchObject({ status: 'AWAITING_INSPECTION', stage: 'COMPLETED', stageLabel: 'Đã hoàn thành' });
    const counts = await tech.get('/api/issues/counts');
    expect(counts.body.counts).toMatchObject({ completedCount: 1, awaitingInspectionCount: 0 });
    const summary = await admin.get('/api/issues/summary');
    expect(summary.body.summary.totalUnresolved).toBe(0);
    const done = await tech.get('/api/issues?stage=COMPLETED');
    expect(done.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('AWAITING_INSPECTION');
  });
});
