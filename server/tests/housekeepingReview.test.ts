/**
 * QUALITY REVIEW AND CLEANING CYCLES — "Hoàn thành" means "waiting for the
 * manager", and the manager's "Đạt" / "Không đạt" decides what comes next:
 *
 *   1–3    a finished room leaves the worker's list and waits in "Chờ đánh giá"
 *   4–6    "Đạt": evaluator and time stored; the room is released ("Thêm phòng")
 *   7–17   "Không đạt": a reason is required; "Yêu cầu dọn lại" opens a NEW
 *          cycle (same or another worker of the branch) — the failed cycle,
 *          its form and its review are never rewritten — and both stay in history
 *   18–19  the report, the PDF and the Excel carry every cycle and its review
 *   20–21  another branch's manager, another branch's worker, and the worker
 *          itself are refused by the server
 *   22     findings and collections stay credited exactly as before
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-06';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let manager1: Agent;
let manager2: Agent;
let lan: Agent;
let hoa: Agent;
let lanId = 0;
let hoaId = 0;
let maiId = 0;
let manager1Id = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  for (const [username, branchId] of [['qlbp1', cn1], ['qlbp2', cn2]] as const) {
    const res = await admin.post('/api/admin/users').send({ username, fullName: `Quản lý ${username}`, temporaryPassword: PASSWORD, role: 'HOUSEKEEPING_MANAGER', branchId });
    expect(res.status).toBe(201);
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  manager1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  manager2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  manager1Id = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'qlbp1' } })).id;
  lanId = (await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  hoaId = (await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  maiId = (await createUser({ username: 'mai', password: PASSWORD, fullName: 'Chị Mai', role: 'HOUSEKEEPING', branchId: cn2 })).id;
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetShiftData();
  setClock({ now: () => hcm(DAY, '07:30') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

const at = (hhmm: string) => setClock({ now: () => hcm(DAY, hhmm) });
const iso = (hhmm: string) => hcm(DAY, hhmm).toISOString();

async function setUp(room: string, assignee: number | null) {
  const res = await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: [room], statusCode: 'OUT', assigneeUserId: assignee });
  expect(res.status).toBe(201);
  return res.body as { created: number; skipped: string[] };
}

async function boardTasks(agent: Agent = manager1) {
  return (await agent.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks as {
    id: string;
    roomNumber: string;
    cycleNumber: number;
    state: string;
    review: { status: string; reviewedByName: string | null; failureReason: string | null; recleanRequested: boolean } | null;
    reclean: { cycleNumber: number; reason: string } | null;
    assignee: { id: number; name: string } | null;
  }[];
}

async function onShift(agent: Agent) {
  const res = await agent.post('/api/housekeeping/shift/start').send({});
  expect([201, 409]).toContain(res.status);
}

/** One cycle from the worker's side: "Kiểm phòng" at `from`, "Hoàn thành" at `to`. */
async function clean(agent: Agent, id: string, from: string, to: string, form: Record<string, unknown>, issues: { type: string }[] = []) {
  await onShift(agent);
  at(from);
  expect((await agent.post(`/api/housekeeping/work/tasks/${id}/inspect`).send({ issues })).status).toBe(201);
  at(to);
  const done = await agent.post(`/api/housekeeping/work/tasks/${id}/complete`).send(form);
  expect(done.status).toBe(200);
  return done.body.task;
}

const review = (id: string, body: Record<string, unknown>, agent: Agent = manager1) => agent.post(`/api/housekeeping/manager/tasks/${id}/review`).send(body);

const FORM_1 = { linen: { BED_SHEET: { size: 'K', quantity: 2 } }, quantities: { BATH_TOWEL: 1 }, replaced: ['SHAMPOO'], special: ['DND'], note: 'Lần 1' };
const FORM_2 = { linen: { BED_SHEET: { size: 'K', quantity: 2 } }, quantities: { BATH_TOWEL: 2 }, replaced: ['SHAMPOO', 'HAND_WASH'], special: [], note: 'Lần 2' };

describe('"Hoàn thành" waits for the manager', () => {
  it('1–3. leaves the worker’s list and appears in "Chờ đánh giá" — the room stays taken', async () => {
    await setUp('101', lanId);
    const [task] = await boardTasks();
    await clean(lan, task!.id, '08:00', '08:30', FORM_1);
    // 2. Off the worker's list of rooms to clean — but still its own record.
    expect((await lan.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks).toEqual([]);
    expect((await lan.get(`/api/housekeeping/work/tasks/${task!.id}`)).body.task).toMatchObject({ state: 'COMPLETED', review: { status: 'PENDING', label: 'Chờ đánh giá' } });
    // 1, 3. The manager's review queue.
    const [pending] = await boardTasks();
    expect(pending).toMatchObject({ id: task!.id, cycleNumber: 1, state: 'COMPLETED', review: { status: 'PENDING', reviewedByName: null } });
    // Not released yet: the room cannot be added again.
    expect(await setUp('101', null)).toEqual({ created: 0, skipped: ['101'] });
  });
});

describe('"Đạt"', () => {
  it('4–6. stores the evaluator and the time, releases the room, and is never changed', async () => {
    await setUp('101', lanId);
    const [task] = await boardTasks();
    // Nothing to review before "Hoàn thành".
    expect((await review(task!.id, { result: 'PASSED' })).status).toBe(409);
    await clean(lan, task!.id, '08:00', '08:30', FORM_1);
    expect((await review(task!.id, { result: 'PASSED', reclean: true })).status).toBe(422);
    at('08:40');
    const passed = await review(task!.id, { result: 'PASSED' });
    expect(passed.status).toBe(200);
    expect(passed.body.task.review).toMatchObject({ status: 'PASSED', label: 'Đạt', reviewedByName: 'Quản lý qlbp1', reviewedAt: iso('08:40'), failureReason: null, recleanRequested: false });
    expect(passed.body.reclean).toBeNull();
    expect(await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id } })).toMatchObject({ reviewResult: 'PASSED', reviewedByUserId: manager1Id });

    // Once only: no second review, no edit, no reassignment, no void.
    expect((await review(task!.id, { result: 'FAILED', reason: 'x' })).status).toBe(409);
    expect((await manager1.patch(`/api/housekeeping/manager/tasks/${task!.id}`).send({ priority: true })).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: hoaId })).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/void`).send({})).status).toBe(409);

    // 6. Released: the room can be added again — as the next cycle, by choice, not automatically.
    expect((await boardTasks()).filter((t) => t.review?.status !== 'PASSED')).toEqual([]);
    expect(await setUp('101', hoaId)).toEqual({ created: 1, skipped: [] });
    const again = (await boardTasks()).find((t) => t.cycleNumber === 2)!;
    expect(again).toMatchObject({ roomNumber: '101', state: 'NOT_STARTED', review: null, reclean: null, assignee: { id: hoaId } });
  });
});

describe('"Không đạt" and the re-clean cycle', () => {
  it('7–17. needs a reason, opens a new cycle for the chosen worker, and keeps both cycles whole', async () => {
    await setUp('101', lanId);
    const [first] = await boardTasks();
    await clean(lan, first!.id, '08:00', '08:30', FORM_1);
    const before = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: first!.id } });

    // 8. A reason is required.
    expect((await review(first!.id, { result: 'FAILED' })).status).toBe(422);
    expect((await review(first!.id, { result: 'FAILED', reason: '   ', reclean: true })).status).toBe(422);
    // 9–10, 13. Accepted with its reason; the re-clean goes to Chị Hoa, of the same branch.
    at('08:35');
    const failed = await review(first!.id, { result: 'FAILED', reason: 'Thiếu khăn tắm', reclean: true, assigneeUserId: hoaId });
    expect(failed.status).toBe(200);
    expect(failed.body.task.review).toMatchObject({ status: 'FAILED', label: 'Không đạt', failureReason: 'Thiếu khăn tắm', recleanRequested: true, reviewedByName: 'Quản lý qlbp1', reviewedAt: iso('08:35') });
    expect(failed.body.reclean).toMatchObject({
      roomNumber: '101',
      cycleNumber: 2,
      state: 'NOT_STARTED',
      startedAt: null,
      cleaning: null,
      review: null,
      assignee: { id: hoaId, name: 'Chị Hoa' },
      reclean: { cycleNumber: 1, reason: 'Thiếu khăn tắm', reviewedByName: 'Quản lý qlbp1' },
    });
    expect(failed.body.task.nextCycleId).toBe(failed.body.reclean.id);

    // 11. The failed cycle is exactly as it was — only its review was added.
    const after = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: first!.id } });
    for (const field of ['cleaning', 'startedAt', 'completedAt', 'durationSeconds', 'cleanedByUserId', 'inspectionId', 'assigneeUserId', 'state'] as const) {
      expect(after[field]).toEqual(before[field]);
    }
    // 10. Back on the manager's board; the room is taken by the open re-clean.
    expect((await boardTasks()).map((t) => [t.cycleNumber, t.state, t.review?.status ?? null])).toEqual([
      [1, 'COMPLETED', 'FAILED'],
      [2, 'NOT_STARTED', null],
    ]);
    expect(await setUp('101', null)).toEqual({ created: 0, skipped: ['101'] });

    // 14. Chị Hoa sees "cần dọn lại" and the reason; Chị Lan sees nothing.
    expect((await lan.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks).toEqual([]);
    const mine = (await hoa.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks;
    expect(mine).toEqual([expect.objectContaining({ id: failed.body.reclean.id, cycleNumber: 2, reclean: expect.objectContaining({ reason: 'Thiếu khăn tắm' }) })]);
    // The manager's reassignment of the open re-clean is kept in its history.
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${failed.body.reclean.id}/assign`).send({ assigneeUserId: lanId })).status).toBe(200);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${failed.body.reclean.id}/assign`).send({ assigneeUserId: hoaId })).status).toBe(200);

    // 15. The second cycle — its own inspection, times and form.
    const second = await clean(hoa, failed.body.reclean.id, '08:45', '09:05', FORM_2);
    expect(second).toMatchObject({ startedAt: iso('08:45'), completedAt: iso('09:05'), durationSeconds: 20 * 60, cleanedBy: { id: hoaId } });
    expect(second.inspection.id).not.toBe(after.inspectionId);
    // 16. Reviewed "Đạt".
    at('09:10');
    expect((await review(second.id, { result: 'PASSED' })).status).toBe(200);

    // 12, 17. The full history — both cycles, each whole.
    const history = (await manager1.get(`/api/housekeeping/manager/tasks/${second.id}/history`)).body.cycles;
    expect(history.map((c: { cycleNumber: number }) => c.cycleNumber)).toEqual([1, 2]);
    expect(history[0]).toMatchObject({
      cleanedBy: { name: 'Chị Lan' },
      startedAt: iso('08:00'),
      completedAt: iso('08:30'),
      durationSeconds: 30 * 60,
      cleaning: { note: 'Lần 1', special: ['DND'] },
      review: { status: 'FAILED', failureReason: 'Thiếu khăn tắm', recleanRequested: true, reviewedByName: 'Quản lý qlbp1', reviewedAt: iso('08:35') },
    });
    expect(history[1]).toMatchObject({
      cleanedBy: { name: 'Chị Hoa' },
      startedAt: iso('08:45'),
      completedAt: iso('09:05'),
      cleaning: { note: 'Lần 2' },
      review: { status: 'PASSED', reviewedAt: iso('09:10') },
      reclean: { cycleNumber: 1, reason: 'Thiếu khăn tắm' },
    });
    expect(history[0].events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'INSPECTED', 'COMPLETED', 'REVIEWED']);
    expect(history[1].events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'ASSIGNED', 'ASSIGNED', 'INSPECTED', 'COMPLETED', 'REVIEWED']);
    // The Admin reads the same history.
    expect((await admin.get(`/api/housekeeping/manager/tasks/${first!.id}/history`)).body.cycles).toHaveLength(2);

    // 18. The report carries both cycles, never one summary row.
    const rooms = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body.rooms;
    expect(rooms.map((r: Record<string, unknown>) => [r.roomNumber, r.cycleNumber, r.employee, r.outcome, r.failureReason, r.recleanRequested, r.reviewedByName, r.recleanCount, r.finalOutcome, r.isReclean])).toEqual([
      ['101', 1, 'Chị Lan', 'Không đạt — dọn lại', 'Thiếu khăn tắm', true, 'Quản lý qlbp1', 1, 'Đạt', false],
      ['101', 2, 'Chị Hoa', 'Đạt', null, false, 'Quản lý qlbp1', 1, 'Đạt', true],
    ]);
    expect(rooms[0]).toMatchObject({ inspectedAt: iso('08:00'), startedAt: iso('08:00'), completedAt: iso('08:30'), durationSeconds: 1800, cycleCount: 2 });

    // 19. The Excel sheet: a row per cycle, with the review.
    const xlsx = await fileOf(manager1, `/api/housekeeping/manager/report.xlsx?from=${DAY}&to=${DAY}`);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const sheet = wb.getWorksheet('Chi tiết dọn phòng')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    const rowOf = (n: number) => {
      const values = (sheet.getRow(n).values as unknown[]).slice(1);
      return (h: string) => values[header.indexOf(h)];
    };
    const [one, two] = [rowOf(2), rowOf(3)];
    expect([one('Phòng'), one('Lần dọn'), one('Nhân viên'), one('Kết quả đánh giá'), one('Người đánh giá'), one('Lý do không đạt'), one('Yêu cầu dọn lại'), one('Số lần dọn lại'), one('Kết quả cuối')]).toEqual([
      '101', 1, 'Chị Lan', 'Không đạt', 'Quản lý qlbp1', 'Thiếu khăn tắm', 'Có', 1, 'Đạt',
    ]);
    expect([two('Phòng'), two('Lần dọn'), two('Nhân viên'), two('Kết quả đánh giá'), two('Time In'), two('Time Out'), two('Thời gian dọn')]).toEqual([
      '101', 2, 'Chị Hoa', 'Đạt', '08:45', '09:05', '20 phút',
    ]);

    // 19. The PDF: both cycles and their review, drawn.
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    let drawn: string[] = [];
    try {
      const pdf = await fileOf(manager1, `/api/housekeeping/manager/report.pdf?from=${DAY}&to=${DAY}`);
      expect(pdf.status).toBe(200);
      drawn = text.mock.calls.map((c) => String(c[0]));
    } finally {
      text.mockRestore();
    }
    for (const value of ['Đánh giá chất lượng', '101\nLần 1', '101\nLần 2', 'Chị Lan', 'Chị Hoa', 'Không đạt', 'Đạt', 'Thiếu khăn tắm', 'Quản lý qlbp1', 'Có', '08:30', '09:05', '30 phút', '20 phút']) {
      expect(drawn).toContain(value);
    }
    expect(drawn.some((t) => t.includes('1 phòng · 2 lần dọn'))).toBe(true);
  });

  it('"Không đạt" without a re-clean ends the cycle and releases the room', async () => {
    await setUp('102', lanId);
    const [task] = await boardTasks();
    await clean(lan, task!.id, '08:00', '08:20', FORM_1);
    const failed = await review(task!.id, { result: 'FAILED', reason: 'Khách đã nhận phòng' });
    expect(failed.status).toBe(200);
    expect(failed.body.task.review).toMatchObject({ status: 'FAILED', recleanRequested: false });
    expect(failed.body.reclean).toBeNull();
    expect(await setUp('102', null)).toEqual({ created: 1, skipped: [] });
  });

  it('keeps the rules in the database too: one open cycle per room, and no "Không đạt" without a reason', async () => {
    await setUp('103', lanId);
    const [task] = await boardTasks();
    const base = { branchId: cn1, workDate: DAY, roomNumber: '103', statusCode: 'OUT', createdByUserId: manager1Id, createdByNameSnapshot: 'x', createdAt: hcm(DAY, '07:00') };
    await expect(testPrisma.housekeepingRoomTask.create({ data: { ...base, cycleNumber: 2 } })).rejects.toThrow();
    await clean(lan, task!.id, '08:00', '08:20', FORM_1);
    await expect(testPrisma.housekeepingRoomTask.update({ where: { id: task!.id }, data: { reviewResult: 'FAILED' } })).rejects.toThrow();
  });
});

describe('who may review and assign', () => {
  it('20–21. refuses another branch’s manager, another branch’s worker, and the worker itself', async () => {
    await setUp('101', lanId);
    const [task] = await boardTasks();
    await clean(lan, task!.id, '08:00', '08:30', FORM_1);
    // 20. Another branch's manager: no review, no history.
    expect((await review(task!.id, { result: 'PASSED' }, manager2)).status).toBe(403);
    expect((await manager2.get(`/api/housekeeping/manager/tasks/${task!.id}/history`)).status).toBe(403);
    // 20. A re-clean for a worker of another branch is refused — and nothing is recorded.
    expect((await review(task!.id, { result: 'FAILED', reason: 'Thiếu khăn', reclean: true, assigneeUserId: maiId })).status).toBe(422);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id } })).reviewResult).toBeNull();
    // 21. The worker cannot review — its own room or any other — nor read the manager's history.
    expect((await review(task!.id, { result: 'PASSED' }, lan)).status).toBe(403);
    expect((await lan.get(`/api/housekeeping/manager/tasks/${task!.id}/history`)).status).toBe(403);
    // The Admin may, for every branch.
    expect((await review(task!.id, { result: 'PASSED' }, admin)).status).toBe(200);
  });
});

describe('findings and collections', () => {
  it('22. stay credited to the worker who found them, through a failed cycle and its re-clean', async () => {
    await setUp('101', lanId);
    const [first] = await boardTasks();
    const done = await clean(lan, first!.id, '08:00', '08:30', FORM_1, [{ type: 'SMOKING' }]);
    const finding = done.inspection.findings[0].id as string;
    expect((await letan1.put(`/api/housekeeping/issues/${finding}/collection`).send({ status: 'COLLECTED', amount: 500000, method: 'CASH' })).status).toBe(200);
    const failed = await review(first!.id, { result: 'FAILED', reason: 'Còn tóc trên sàn', reclean: true, assigneeUserId: hoaId });
    await clean(hoa, failed.body.reclean.id, '08:45', '09:00', FORM_2);

    const kpi = (await manager1.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}`)).body;
    const byName = Object.fromEntries(kpi.rows.map((r: { fullName: string }) => [r.fullName, r]));
    expect(byName['Chị Lan']).toMatchObject({ inspections: 1, findings: 1, collectedCount: 1, collectedAmount: 500000 });
    expect(byName['Chị Hoa']).toMatchObject({ inspections: 1, findings: 0, collectedAmount: 0 });
    expect(kpi.totals).toMatchObject({ findings: 1, collectedAmount: 500000 });
    expect((await lan.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(500000);
    expect((await hoa.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(0);
  });
});

function fileOf(agent: Agent, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}
