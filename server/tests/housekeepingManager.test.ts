/**
 * "QUẢN LÝ BUỒNG PHÒNG" AND THE DAILY ROOM WORK — each rule pinned:
 *
 *   1–4   the manager's ONE branch; the Admin's every branch; a worker reaches
 *         only the rooms given to it.
 *   5–8   "Kiểm phòng" starts the timer (and nothing else does); completion
 *         records start, end and duration; the account is the person.
 *   9–11  a finding → Reception's "Đã thu" → credited to the worker who found
 *         it, once.
 *   12–13 the manager sees everything entered; "Xóa" keeps the evidence.
 *   +     a branch's staff — the only people its rooms can be given to — are the
 *         workers who work there (a shift there in the last 30 days, or now).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-05';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let manager1: Agent;
let manager2: Agent;
let worker: Agent;
let worker2: Agent;
let workerId = 0;
let worker2Id = 0;
let worker3Id = 0;
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

  // The Quản lý buồng phòng is created as the Admin creates it: exactly one branch.
  for (const [username, branchId] of [['qlbp1', cn1], ['qlbp2', cn2]] as const) {
    const res = await admin.post('/api/admin/users').send({
      username,
      fullName: `Quản lý ${username}`,
      temporaryPassword: PASSWORD,
      role: 'HOUSEKEEPING_MANAGER',
      branchId,
    });
    expect(res.status).toBe(201);
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  manager1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  manager2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  workerId = (await createUser({ username: 'buong1', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING', branchId: null })).id;
  worker2Id = (await createUser({ username: 'buong2', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING', branchId: null })).id;
  worker3Id = (await createUser({ username: 'buong3', password: PASSWORD, fullName: 'Chị Mai', role: 'HOUSEKEEPING', branchId: null })).id;
  manager1Id = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'qlbp1' } })).id;
  worker = (await loginAgent(app, 'buong1', PASSWORD)).agent;
  worker2 = (await loginAgent(app, 'buong2', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetShiftData();
  setClock({ now: () => hcm(DAY, '08:00') });
  // Both workers worked at CN1 yesterday: they are its staff.
  await workedAt(workerId, cn1, '2026-10-04');
  await workedAt(worker2Id, cn1, '2026-10-04');
});

/** A workday at one branch — ended at 16:00 unless `open`. */
async function workedAt(userId: number, branchId: number, day: string, open = false) {
  const startedAt = hcm(day, '07:00');
  const endedAt = open ? null : hcm(day, '16:00');
  await testPrisma.housekeepingWorkSession.create({
    data: { userId, startedAt, endedAt, segments: { create: { branchId, staffName: 'x', startedAt, endedAt } } },
  });
}

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function setUp(agent: Agent, rooms: string[], assignee: number | null, body: Record<string, unknown> = {}) {
  const res = await agent.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: rooms, statusCode: 'OUT', assigneeUserId: assignee, ...body });
  expect(res.status).toBe(201);
  const list = await agent.get(`/api/housekeeping/manager/tasks?date=${DAY}`);
  return list.body.tasks as { id: string; roomNumber: string }[];
}

async function onShift(agent: Agent, branchId: number) {
  expect((await agent.post('/api/housekeeping/shift/start').send({ branchId })).status).toBe(201);
}

describe('the account and its one branch', () => {
  it('needs exactly one branch, and none of the multi-branch set', async () => {
    const base = { fullName: 'X', temporaryPassword: PASSWORD, role: 'HOUSEKEEPING_MANAGER' };
    expect((await admin.post('/api/admin/users').send({ ...base, username: 'qlbp_none' })).status).toBe(422);
    expect((await admin.post('/api/admin/users').send({ ...base, username: 'qlbp_many', branchIds: [cn1, cn2] })).status).toBe(422);
    const me = (await manager1.get('/api/auth/me')).body.user;
    expect(me).toMatchObject({ role: 'HOUSEKEEPING_MANAGER' });
    expect(me.branch.id).toBe(cn1);
  });

  it('1–2. a manager reads only its branch; the Admin reads both', async () => {
    await setUp(manager1, ['101'], null);
    await setUp(manager2, ['102'], null);
    const one = await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`);
    expect(one.body.tasks.map((t: { roomNumber: string }) => t.roomNumber)).toEqual(['101']);
    expect((await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}&branchId=${cn2}`)).status).toBe(403);
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ branchId: cn2, workDate: DAY, roomNumbers: ['101'], statusCode: 'VC' })).status).toBe(403);
    expect((await manager1.get(`/api/branches/${cn2}/rooms`)).status).toBe(403);
    const all = await admin.get(`/api/housekeeping/manager/tasks?date=${DAY}`);
    expect(all.body.tasks).toHaveLength(2);
    // The manager's branch list is its one branch; it reaches nothing outside housekeeping.
    expect((await manager1.get('/api/branches')).body.branches.map((b: { id: number }) => b.id)).toEqual([cn1]);
    expect((await manager1.get('/api/bookings/new')).status).toBe(403);
    // A manager cannot edit another branch's item.
    const other = (await manager2.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks[0];
    expect((await manager1.patch(`/api/housekeeping/manager/tasks/${other.id}`).send({ priority: true })).status).toBe(403);
  });

  it('keeps the room code and the cleaning state apart, and refuses an unknown code — CC included', async () => {
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['101'], statusCode: 'XX' })).status).toBe(422);
    // OUT, OC and VC only: there is no CC.
    expect((await manager1.get('/api/housekeeping/catalog')).body.statusCodes).toEqual(['OUT', 'OC', 'VC']);
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['101'], statusCode: 'CC' })).status).toBe(422);
    const [task] = await setUp(manager1, ['101'], null, { statusCode: 'VC', priority: true, note: 'Dọn trước 14:00' });
    const row = (await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks[0];
    expect(row).toMatchObject({ id: task!.id, statusCode: 'VC', state: 'NOT_STARTED', priority: true, note: 'Dọn trước 14:00' });
    // A room already on the day's board is left as it is.
    const again = await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['101'], statusCode: 'OUT' });
    expect(again.body).toMatchObject({ created: 0, skipped: ['101'] });
  });
});

describe('assignment', () => {
  it('3. assigns and reassigns, keeping every assignment in the history', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    const moved = await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker2Id });
    expect(moved.status).toBe(200);
    expect(moved.body.task.assignee).toMatchObject({ id: worker2Id, name: 'Chị Hoa' });
    const assigned = moved.body.task.events.filter((e: { type: string }) => e.type === 'ASSIGNED');
    expect(assigned.map((e: { detail: { toName: string } }) => e.detail.toName)).toEqual(['Chị Lan', 'Chị Hoa']);
    expect(assigned[1].detail.fromName).toBe('Chị Lan');
    // The first worker no longer has it; the second does.
    expect((await worker.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks).toHaveLength(0);
    expect((await worker2.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks).toHaveLength(1);
  });

  it('4. refuses a worker another worker’s room, and a branch off its shift', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker2, cn1);
    expect((await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(403);
    expect((await worker2.get(`/api/housekeeping/work/tasks/${task!.id}`)).status).toBe(403);
    // Its own room, but the shift is at another branch.
    await onShift(worker, cn2);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(409);
    // A worker is no manager.
    expect((await worker.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).status).toBe(403);
  });
});

describe('the branch’s staff', () => {
  const names = async (agent: Agent, q = '') => {
    const res = await agent.get(`/api/housekeeping/manager/staff${q}`);
    expect(res.status).toBe(200);
    return res.body.staff.map((s: { fullName: string }) => s.fullName);
  };

  it('lists, and lets the manager assign, only the workers who work at its branch', async () => {
    // Chị Mai works at CN2; her one CN1 shift was two months ago.
    await workedAt(worker3Id, cn2, '2026-10-03');
    await workedAt(worker3Id, cn1, '2026-08-01');
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    expect(await names(manager2)).toEqual(['Chị Mai']);
    expect((await manager1.get(`/api/housekeeping/manager/staff?branchId=${cn2}`)).status).toBe(403);
    // The Admin: every worker, or one branch's.
    expect(await names(admin)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Mai']);
    expect(await names(admin, `?branchId=${cn2}`)).toEqual(['Chị Mai']);

    // The server refuses her for a CN1 room, set up or reassigned.
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['101'], statusCode: 'OUT', assigneeUserId: worker3Id })).status).toBe(422);
    const [task] = await setUp(manager1, ['101'], workerId);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker3Id })).status).toBe(422);

    // On shift at CN1 now, she is one of its staff — and can be given the room.
    await workedAt(worker3Id, cn1, DAY, true);
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Mai']);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker3Id })).status).toBe(200);
  });

  it('keeps whoever already holds a room that day in that day’s list', async () => {
    await testPrisma.housekeepingRoomTask.create({
      data: { branchId: cn1, workDate: DAY, roomNumber: '102', statusCode: 'OUT', assigneeUserId: worker3Id, assigneeNameSnapshot: 'Chị Mai', createdByUserId: manager1Id, createdByNameSnapshot: 'Quản lý qlbp1', createdAt: hcm(DAY, '07:00') },
    });
    expect(await names(manager1, `?date=${DAY}`)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Mai']);
    expect(await names(manager1, '?date=2026-10-06')).toEqual(['Chị Hoa', 'Chị Lan']);
  });
});

describe('the room work', () => {
  it('5–8. the inspection starts the timer; completion records start, end, duration and the account', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    // 6. Opening the room, or saving "Dọn phòng" before "Kiểm phòng", starts nothing.
    setClock({ now: () => hcm(DAY, '08:30') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/open`)).body.task).toMatchObject({ state: 'NOT_STARTED', startedAt: null });
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send({})).status).toBe(409);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({})).status).toBe(409);

    // 5. "Lưu kiểm tra" — no name typed; the account is the inspector.
    setClock({ now: () => hcm(DAY, '09:00') });
    const inspected = await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [{ type: 'SMOKING' }] });
    expect(inspected.status).toBe(201);
    expect(inspected.body.task).toMatchObject({ state: 'IN_PROGRESS', startedAt: hcm(DAY, '09:00').toISOString() });
    expect(inspected.body.task.inspection).toMatchObject({ inspectorId: workerId, inspectorName: 'Chị Lan' });
    const stored = await testPrisma.roomInspection.findUniqueOrThrow({ where: { id: inspected.body.task.inspection.id } });
    expect(stored).toMatchObject({ createdByUserId: workerId, staffName: 'Chị Lan', branchId: cn1, roomNumber: '101' });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(409);

    // The form, validated against the catalog.
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send({ quantities: { BATH_TOWEL: -1 } })).status).toBe(422);
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send({ linen: { BED_SHEET: ['X'] } })).status).toBe(422);
    const form = { linen: { BED_SHEET: ['K', 'Q'], DUVET_COVER: ['T'] }, quantities: { BATH_TOWEL: 2, WATER: 4 }, replaced: ['SHAMPOO', 'COMB'], note: 'Rèm hơi bẩn' };

    // 7. Completion: the end time and the duration from the inspection.
    setClock({ now: () => hcm(DAY, '09:42') });
    const done = await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send(form);
    expect(done.status).toBe(200);
    expect(done.body.task).toMatchObject({
      state: 'COMPLETED',
      startedAt: hcm(DAY, '09:00').toISOString(),
      completedAt: hcm(DAY, '09:42').toISOString(),
      durationSeconds: 42 * 60,
      cleanedBy: { id: workerId, name: 'Chị Lan' },
    });
    expect(done.body.task.cleaning).toMatchObject({ linen: { BED_SHEET: ['K', 'Q'], DUVET_COVER: ['T'] }, quantities: { BATH_TOWEL: 2, WATER: 4 }, replaced: ['COMB', 'SHAMPOO'], note: 'Rèm hơi bẩn', savedByUserId: workerId });

    // 12. The manager sees every step and every value the worker entered.
    const seen = (await manager1.get(`/api/housekeeping/manager/staff/${workerId}?from=${DAY}&to=${DAY}`)).body;
    expect(seen.tasks[0].events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'OPENED', 'INSPECTED', 'COMPLETED']);
    expect(seen.tasks[0].cleaning.quantities).toEqual({ BATH_TOWEL: 2, WATER: 4 });
    expect(seen.findings.map((f: { typeLabel: string }) => f.typeLabel)).toEqual(['Hút thuốc']);
    expect(seen.shifts).toHaveLength(1);
    const progress = (await manager1.get(`/api/housekeeping/manager/staff-progress?from=${DAY}&to=${DAY}`)).body.rows;
    expect(progress[0]).toMatchObject({ userId: workerId, assigned: 1, completed: 1, completionRate: 100, inspections: 1, findings: 1 });
  });
});

describe('a finding, Reception’s collection, and the worker’s KPI', () => {
  it('9–11. credits the collected money to the worker who found it — once', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    const inspected = await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [{ type: 'SMOKING' }, { type: 'ODOR' }] });
    const [smoking, odor] = inspected.body.task.inspection.findings as { id: string }[];

    // 9–10. Reception settles each finding in its own workflow.
    expect((await letan1.put(`/api/housekeeping/issues/${smoking!.id}/collection`).send({ status: 'COLLECTED', amount: 500000, method: 'CASH' })).status).toBe(200);
    expect((await letan1.put(`/api/housekeeping/issues/${odor!.id}/collection`).send({ status: 'PENDING', amount: 200000 })).status).toBe(200);
    // 11. Settled again (a correction) — still one collection, counted once.
    expect((await letan1.put(`/api/housekeeping/issues/${smoking!.id}/collection`).send({ status: 'COLLECTED', amount: 600000, method: 'TRANSFER' })).status).toBe(200);

    const mine = (await worker.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body;
    expect(mine.summary).toMatchObject({ inspections: 1, findings: 2, collectedCount: 1, pendingCount: 1, collectedAmount: 600000 });
    const branch = (await manager1.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}`)).body;
    expect(branch.rows).toEqual([expect.objectContaining({ userId: workerId, collectedAmount: 600000, pendingAmount: 200000 })]);
    expect(branch.totals.collectedAmount).toBe(600000);
    // Another worker's KPI is not in this worker's; another branch's manager sees none of it.
    expect((await worker2.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(0);
    expect((await manager2.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}`)).body.rows).toEqual([]);
    expect((await admin.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}`)).body.totals.collectedAmount).toBe(600000);

    // The report states the same figures, and exports in the manager's scope.
    const report = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body.rows;
    expect(report[0]).toMatchObject({ employee: 'Chị Lan', assigned: 1, inspections: 1, findings: 2, collectedAmount: 600000, pendingAmount: 200000 });
    const pdf = await manager1.get(`/api/housekeeping/manager/report.pdf?from=${DAY}&to=${DAY}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xlsx = await manager1.get(`/api/housekeeping/manager/report.xlsx?from=${DAY}&to=${DAY}`);
    expect(xlsx.status).toBe(200);
    expect((await manager1.get(`/api/housekeeping/manager/report.pdf?from=${DAY}&to=${DAY}&branchId=${cn2}`)).status).toBe(403);
  });
});

describe('"Xóa" a room work item', () => {
  it('13. voids it and keeps the inspection, findings, collection and history', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    const inspected = await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [{ type: 'SMOKING' }] });
    const finding = inspected.body.task.inspection.findings[0].id as string;
    await letan1.put(`/api/housekeeping/issues/${finding}/collection`).send({ status: 'COLLECTED', amount: 300000, method: 'CASH' });

    expect((await worker.post(`/api/housekeeping/manager/tasks/${task!.id}/void`).send({})).status).toBe(403);
    expect((await manager2.post(`/api/housekeeping/manager/tasks/${task!.id}/void`).send({})).status).toBe(403);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/void`).send({ reason: 'Nhập nhầm phòng' })).status).toBe(200);

    expect((await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks).toHaveLength(0);
    const kept = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id }, include: { events: true } });
    expect(kept).toMatchObject({ voidReason: 'Nhập nhầm phòng', state: 'IN_PROGRESS' });
    expect(kept.events.map((e) => e.type)).toContain('VOIDED');
    expect(await testPrisma.roomInspection.count()).toBe(1);
    expect(await testPrisma.roomIssueCollection.count({ where: { status: 'COLLECTED' } })).toBe(1);
    // The KPI still explains the collection.
    expect((await worker.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(300000);
    // A voided item cannot be worked.
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({})).status).toBe(409);
  });
});
