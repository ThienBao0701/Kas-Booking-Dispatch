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
 *         Buồng phòng accounts that worked a shift there in the last 30 days:
 *         a housekeeping account has no permanent branch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { addressOf, workedRecentlyAt } from './helpers/workplace';
import type { CleaningDetailRow } from '../src/housekeeping/housekeepingKpi';
import { BEDDING_COLUMNS, REPLACEMENT_COLUMNS, ROOM_COLUMNS } from '../src/report/housekeepingCleaningPdf';
import type { Column } from '../src/report/pdf';

const app = createApp();

let itemSeq = 0;
/** An item on the branch's room-cleaning list, with `available` on hand. */
async function cleaningItem(branchId: number, name: string, available: number): Promise<string> {
  itemSeq += 1;
  const item = await testPrisma.inventoryItem.create({
    data: { branchId, warehouse: 'LINEN', name, variant: '', unit: 'cái', code: `3.${String(itemSeq).padStart(3, '0')}`, cleaningOrder: itemSeq, createdByUserId: manager1Id, createdByNameSnapshot: 'Test' },
  });
  await testPrisma.inventoryBalance.create({ data: { itemId: item.id, state: 'AVAILABLE', quantity: available } });
  return item.id;
}
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
  // Each worker belongs to the one branch the Admin gave its account.
  workerId = (await createUser({ username: 'buong1', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  worker2Id = (await createUser({ username: 'buong2', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  worker3Id = (await createUser({ username: 'buong3', password: PASSWORD, fullName: 'Chị Mai', role: 'HOUSEKEEPING', branchId: cn2 })).id;
  manager1Id = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'qlbp1' } })).id;
  worker = (await loginAgent(app, 'buong1', PASSWORD)).agent;
  worker2 = (await loginAgent(app, 'buong2', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetShiftData();
  setClock({ now: () => hcm(DAY, '08:00') });
  // Each worker worked lately at its branch: that is what makes it the branch's staff.
  for (const [userId, branchId] of [[workerId, cn1], [worker2Id, cn1], [worker3Id, cn2]] as const) {
    await workedRecentlyAt(userId, branchId, hcm(DAY, '08:00'));
  }
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
  expect((await agent.post('/api/housekeeping/shift/start').send({ address: await addressOf(branchId) })).status).toBe(201);
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
    await onShift(worker, cn1);
    await onShift(worker2, cn1);
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

  it('4. keeps a worker to its own rooms at its own branch — whatever the request says', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker2, cn1);
    expect((await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(403);
    expect((await worker2.get(`/api/housekeeping/work/tasks/${task!.id}`)).status).toBe(403);
    // The branch is the shift's: a branch id the request names picks nothing, and
    // "Đổi chi nhánh" by an id is no longer offered.
    await onShift(worker, cn1);
    expect((await worker.post('/api/housekeeping/shift/switch').send({ branchId: cn2 })).status).toBe(409);
    expect((await worker.get('/api/auth/me')).body.user.branch.id).toBe(cn1);

    // A CN2 room — even one wrongly given to it in the database — stays out of reach.
    const foreign = await testPrisma.housekeepingRoomTask.create({
      data: { branchId: cn2, workDate: DAY, roomNumber: '201', statusCode: 'OUT', assigneeUserId: workerId, assigneeNameSnapshot: 'Chị Lan', createdByUserId: manager1Id, createdByNameSnapshot: 'x', createdAt: hcm(DAY, '07:00') },
    });
    const url = `/api/housekeeping/work/tasks/${foreign.id}`;
    expect((await worker.get(url)).status).toBe(403);
    expect((await worker.post(`${url}/open`)).status).toBe(403);
    expect((await worker.post(`${url}/inspect`).send({ issues: [] })).status).toBe(403);
    expect((await worker.put(`${url}/cleaning`).send({})).status).toBe(403);
    expect((await worker.post(`${url}/complete`).send({})).status).toBe(403);
    expect((await worker.get(`/api/housekeeping/work?date=${DAY}`)).body.tasks.map((t: { roomNumber: string }) => t.roomNumber)).toEqual(['101']);
    // A worker is no manager: no room set up, no list, no branch KPI — at either branch.
    expect((await worker.post('/api/housekeeping/manager/tasks').send({ branchId: cn2, workDate: DAY, roomNumbers: ['201'], statusCode: 'OUT' })).status).toBe(403);
    expect((await worker.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).status).toBe(403);
    expect((await worker.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}&branchId=${cn2}`)).status).toBe(403);
  });
});

describe('the branch’s staff — the housekeepers who worked there lately', () => {
  const names = async (agent: Agent, q = '') => {
    const res = await agent.get(`/api/housekeeping/manager/staff${q}`);
    expect(res.status).toBe(200);
    return res.body.staff.map((s: { fullName: string }) => s.fullName);
  };

  it('7–8. lists, and lets the manager assign, only its branch’s accounts', async () => {
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    expect(await names(manager2)).toEqual(['Chị Mai']);
    expect((await manager1.get(`/api/housekeeping/manager/staff?branchId=${cn2}`)).status).toBe(403);
    // The Admin: every worker, or one branch's.
    expect(await names(admin)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Mai']);
    expect(await names(admin, `?branchId=${cn2}`)).toEqual(['Chị Mai']);

    // The server refuses the CN2 worker for a CN1 room, set up or reassigned.
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['101'], statusCode: 'OUT', assigneeUserId: worker3Id })).status).toBe(422);
    const [task] = await setUp(manager1, ['101'], workerId);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker3Id })).status).toBe(422);
  });

  it('9. makes a new account a branch’s staff by its first shift there — no branch from the Admin', async () => {
    const res = await admin.post('/api/admin/users').send({ username: 'buong_moi', fullName: 'Chị Nga', temporaryPassword: PASSWORD, role: 'HOUSEKEEPING' });
    expect(res.status).toBe(201);
    const id = res.body.user.id as number;
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    expect((await manager1.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: ['103'], statusCode: 'OUT', assigneeUserId: id })).status).toBe(422);
    await workedRecentlyAt(id, cn1, hcm(DAY, '08:00'));
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Nga']);
    const [task] = await setUp(manager1, ['103'], id);
    const row = (await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks.find((t: { id: string }) => t.id === task!.id);
    expect(row.assignee).toMatchObject({ id, name: 'Chị Nga' });
    await resetHousekeepingData();
    await testPrisma.notification.deleteMany({ where: { userId: id } });
    await testPrisma.user.delete({ where: { id } });
  });

  it('10. reads the shift history — a permanent branch, or a shift over 30 days old, counts for nothing', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    // An older account carrying CN1 as its permanent branch, with no shift: not CN1's staff.
    const old = await createUser({ username: 'buong_cu', password: PASSWORD, fullName: 'Chị Cũ', role: 'HOUSEKEEPING', branchId: cn1 });
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: old.id })).status).toBe(422);
    // A CN1 shift 31 days ago: still not.
    await workedRecentlyAt(old.id, cn1, hcm('2026-09-05', '08:00'));
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    // Chị Mai (CN2) worked a CN1 shift today: she is CN1's staff now, as well as CN2's.
    await workedAt(worker3Id, cn1, DAY);
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Mai']);
    expect(await names(manager2)).toEqual(['Chị Mai']);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker3Id })).status).toBe(200);
    await resetHousekeepingData();
    await testPrisma.user.delete({ where: { id: old.id } });
  });
});

describe('the room work', () => {
  it('keeps inspection and cleaning apart: an inspected room can go to another housekeeper, who starts it', async () => {
    const [task] = await setUp(manager1, ['102'], workerId);
    await onShift(worker, cn1);
    setClock({ now: () => hcm(DAY, '08:00') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(201);

    // The manager gives the INSPECTED room to Chị Hoa; the inspection stays Chị Lan's.
    const moved = await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker2Id });
    expect(moved.status).toBe(200);
    expect(moved.body.task).toMatchObject({ state: 'INSPECTED', assignee: { id: worker2Id }, inspection: { inspectorId: workerId } });

    // Only the housekeeper the room is given to can start it.
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/start`)).status).toBe(403);
    await onShift(worker2, cn1);
    setClock({ now: () => hcm(DAY, '08:20') });
    const started = await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.task).toMatchObject({ state: 'IN_PROGRESS', startedAt: hcm(DAY, '08:20').toISOString() });

    setClock({ now: () => hcm(DAY, '08:50') });
    const done = await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({});
    expect(done.status).toBe(200);
    // The cleaning time runs from the start, not from the inspection.
    expect(done.body.task).toMatchObject({ durationSeconds: 30 * 60, cleanedBy: { id: worker2Id }, inspection: { inspectorId: workerId } });
    // Its only room, nothing left to take: the shift ended by itself (shiftAutoEnd).
    expect(done.body.task.shiftEnded).toBe(true);
    // A duplicate completion — even back on shift — writes nothing twice.
    await onShift(worker2, cn1);
    expect((await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({})).status).toBe(409);
    expect(await testPrisma.housekeepingRoomTaskEvent.count({ where: { taskId: task!.id, type: 'COMPLETED' } })).toBe(1);
  });

  it('5–8. the inspection is saved as "Đã kiểm tra"; only "Bắt đầu dọn" starts the timer; completion records start, end, duration and the account', async () => {
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
    // "Đã kiểm tra": the inspection is saved and NOTHING has started.
    expect(inspected.body.task).toMatchObject({ state: 'INSPECTED', stateLabel: 'Đã kiểm tra', startedAt: null, elapsedSeconds: null });
    expect(inspected.body.task.inspection).toMatchObject({ inspectorId: workerId, inspectorName: 'Chị Lan' });
    const stored = await testPrisma.roomInspection.findUniqueOrThrow({ where: { id: inspected.body.task.inspection.id } });
    expect(stored).toMatchObject({ createdByUserId: workerId, staffName: 'Chị Lan', branchId: cn1, roomNumber: '101' });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(409);
    // Saving or completing the form before "Bắt đầu dọn" is refused — it starts nothing either.
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send({})).status).toBe(409);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({})).status).toBe(409);
    expect((await worker.get(`/api/housekeeping/work/tasks/${task!.id}`)).body.task).toMatchObject({ state: 'INSPECTED', startedAt: null });

    // "Bắt đầu dọn" — the explicit start, once; a second press changes nothing.
    const started = await worker.post(`/api/housekeeping/work/tasks/${task!.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.task).toMatchObject({ state: 'IN_PROGRESS', startedAt: hcm(DAY, '09:00').toISOString() });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/start`)).status).toBe(409);

    // The form, validated: counts of the branch's room-cleaning items, the catalog's special flags.
    const towel = await cleaningItem(cn1, 'Khăn tắm', 10);
    const cleaning = (body: Record<string, unknown>) => worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send(body);
    expect((await cleaning({ items: { [towel]: -1 } })).status).toBe(422);
    expect((await cleaning({ items: { [towel]: 1.5 } })).status).toBe(422);
    expect((await cleaning({ items: { 'không hợp lệ': 1 } })).status).toBe(422);
    expect((await cleaning({ special: ['VIP'] })).status).toBe(422);
    const form = { items: { [towel]: 2 }, special: ['DND', 'LB'], note: 'Rèm hơi bẩn' };

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
    expect(done.body.task.cleaning).toMatchObject({
      items: [{ itemId: towel, label: 'Khăn tắm', quantity: 2 }],
      special: ['LB', 'DND'],
      note: 'Rèm hơi bẩn',
      savedByUserId: workerId,
    });

    // 12. The manager sees every step and every value the worker entered.
    const seen = (await manager1.get(`/api/housekeeping/manager/staff/${workerId}?from=${DAY}&to=${DAY}`)).body;
    expect(seen.tasks[0].events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'OPENED', 'INSPECTED', 'STARTED', 'COMPLETED']);
    expect(seen.tasks[0].cleaning).toMatchObject({ items: [{ itemId: towel, quantity: 2 }], special: ['LB', 'DND'] });
    expect(seen.findings.map((f: { typeLabel: string }) => f.typeLabel)).toEqual(['Hút thuốc']);
    expect(seen.shifts).toHaveLength(1);
    const progress = (await manager1.get(`/api/housekeeping/manager/staff-progress?from=${DAY}&to=${DAY}`)).body.rows;
    expect(progress[0]).toMatchObject({ userId: workerId, assigned: 1, completed: 1, completionRate: 100, inspections: 1, findings: 1 });
  });
});

describe('"Dọn phòng" — the form’s fields, as data', () => {
  const fileOf = (agent: Agent, url: string) =>
    agent
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const xlsxOf = async (agent: Agent, url: string) => {
    const res = await fileOf(agent, url);
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    return wb;
  };

  it('serves King / Queen / Twin, the six replacement items and the six special statuses — exactly', async () => {
    const cat = (await worker.get('/api/housekeeping/catalog')).body;
    expect(cat.linenSizes).toEqual([
      { code: 'K', label: 'King' },
      { code: 'Q', label: 'Queen' },
      { code: 'T', label: 'Twin' },
    ]);
    expect(cat.replacements.map((r: { label: string }) => r.label)).toEqual([
      'Lược, tăm bông, chụp tóc',
      'Trà, cà phê, đường. Miễn phí',
      'Giấy ăn, lau tay',
      'Nước rửa tay',
      'Dầu gội',
      'Sữa tắm',
    ]);
    expect(cat.specialStatuses.map((x: { short: string; label: string }) => `${x.short} : ${x.label}`)).toEqual([
      'L/B : Khách có hành lý gọn nhẹ',
      'SO : Phòng có đồ nhưng khách không ngủ',
      'DND : Không làm phiền',
      'OOO : Không thể bán phòng',
      'OS : Phòng ngưng tạm',
      'LNL : Hàng thất lạc',
    ]);
  });

  it('keeps every field through "Lưu tạm" and a reload, and hands them to the report', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(201);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/start`)).status).toBe(200);
    const pillowcase = await cleaningItem(cn1, 'Áo gối', 10);
    const form = { items: { [pillowcase]: 4 }, special: ['SO', 'OOO', 'LNL'], note: 'Ổ cắm hỏng' };
    const saved = { items: [{ itemId: pillowcase, label: 'Áo gối', quantity: 4 }], special: ['SO', 'OOO', 'LNL'], note: 'Ổ cắm hỏng' };
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send(form)).status).toBe(200);
    // Reloaded, and stored as data — not as text.
    expect((await worker.get(`/api/housekeeping/work/tasks/${task!.id}`)).body.task.cleaning).toMatchObject(saved);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id } })).cleaning).toMatchObject(saved);

    setClock({ now: () => hcm(DAY, '08:40') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send(form)).status).toBe(200);
    const report = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body;
    expect(report.rooms).toEqual([
      {
        branchLabel: '05 Trương Định',
        workDate: DAY,
        roomNumber: '101',
        statusCode: 'OUT',
        employee: 'Chị Lan',
        state: 'COMPLETED',
        startedAt: hcm(DAY, '08:00').toISOString(),
        completedAt: hcm(DAY, '08:40').toISOString(),
        durationSeconds: 40 * 60,
        cycleNumber: 1,
        cycleCount: 1,
        inspectedAt: hcm(DAY, '08:00').toISOString(),
        outcome: 'Chờ đánh giá',
        isReclean: false,
        reviewResult: null,
        reviewedAt: null,
        reviewedByName: null,
        failureReason: null,
        recleanRequested: false,
        recleanCount: 0,
        finalOutcome: 'Chờ đánh giá',
        linen: [],
        quantities: [{ item: pillowcase, label: 'Áo gối', quantity: 4 }],
        replaced: [],
        special: [
          { code: 'SO', short: 'SO', label: 'Phòng có đồ nhưng khách không ngủ' },
          { code: 'OOO', short: 'OOO', label: 'Không thể bán phòng' },
          { code: 'LNL', short: 'LNL', label: 'Hàng thất lạc' },
        ],
        note: 'Ổ cắm hỏng',
      },
    ]);
    // The workbook's "Chi tiết dọn phòng": one row per room, every field in words.
    const wb = await xlsxOf(manager1, `/api/housekeeping/manager/report.xlsx?from=${DAY}&to=${DAY}`);
    const sheet = wb.getWorksheet('Chi tiết dọn phòng')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    const values = (sheet.getRow(2).values as unknown[]).slice(1);
    const cell = (h: string) => values[header.indexOf(h)];
    expect(cell('Phòng')).toBe('101');
    expect(cell('Mã')).toBe('OUT');
    expect(cell('Nhân viên')).toBe('Chị Lan');
    expect(cell('Time In')).toBe('08:00');
    expect(cell('Time Out')).toBe('08:40');
    expect(cell('Thời gian dọn')).toBe('40 phút');
    expect(cell('Số lượng')).toBe('Áo gối: 4');
    expect(cell('Ghi nhận đặc biệt')).toBe('SO : Phòng có đồ nhưng khách không ngủ; OOO : Không thể bán phòng; LNL : Hàng thất lạc');
    expect(cell('Ghi chú')).toBe('Ổ cắm hỏng');
  });

  it('prints the PDF from a saved "Dọn phòng" — an older save’s King and its count, replacements, special statuses, note, worker, times', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    setClock({ now: () => hcm(DAY, '09:00') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(201);
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/start`)).status).toBe(200);
    setClock({ now: () => hcm(DAY, '09:42') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({ special: ['DND', 'LNL'], note: 'Vòi sen rỉ nước' })).status).toBe(200);
    // The fixed fields of the form before the room-cleaning list, as an older save holds them — still printed.
    const before = (await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id } })).cleaning as Record<string, unknown>;
    await testPrisma.housekeepingRoomTask.update({
      where: { id: task!.id },
      data: { cleaning: { ...before, linen: { BED_SHEET: { size: 'K', quantity: 2 } }, quantities: { BATH_TOWEL: 3 }, replaced: ['SHAMPOO', 'HAND_WASH'] } },
    });

    // The PDF's boxes read the very rows the report (and the Excel sheet) is made of.
    const [row] = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body.rooms as CleaningDetailRow[];
    const ticked = (columns: Column<CleaningDetailRow>[]) => columns.filter((c) => c.mark?.(row!)).map((c) => c.header);
    expect(ticked(BEDDING_COLUMNS)).toEqual(['Ga giường\nKing']);
    expect(ticked(REPLACEMENT_COLUMNS)).toEqual(['Nước rửa tay', 'Dầu gội']);
    expect(ticked(ROOM_COLUMNS)).toEqual(['DND', 'LNL']);

    // The generated PDF: every value written into it, and one drawn check mark per ticked box.
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const marks = vi.spyOn(PDFDocument.prototype, 'path');
    let drawn: string[] = [];
    try {
      const pdf = await fileOf(manager1, `/api/housekeeping/manager/report.pdf?from=${DAY}&to=${DAY}`);
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.headers['content-disposition']).toContain('Bao cao kiem tra don phong_05-10-2026.pdf');
      drawn = text.mock.calls.map((c) => String(c[0]));
      expect(marks).toHaveBeenCalledTimes(5);
    } finally {
      text.mockRestore();
      marks.mockRestore();
    }
    for (const value of [
      'KAS – BÁO CÁO KIỂM TRA & DỌN PHÒNG',
      'Ngày nghiệp vụ: 05/10/2026',
      'Nhân viên: Chị Lan',
      'Phòng',
      'Người thực hiện',
      'Time In',
      'Time Out',
      'Thời gian dọn',
      '101',
      'OUT',
      'Chị Lan',
      '09:00',
      '09:42',
      '42 phút',
      'Hoàn thành',
      'Ga giường\nKing',
      'Bọc chăn\nQueen',
      'Bảo vệ nệm\nTwin',
      'Lược, tăm bông, chụp tóc',
      'Trà, cà phê, đường. Miễn phí',
      'Sữa tắm',
      'L/B',
      'OOO',
      'Ghi chú',
      'Vòi sen rỉ nước',
    ]) {
      expect(drawn).toContain(value);
    }
    // The Quản lý buồng phòng's file names its hotel by address — no branch number.
    expect(drawn).toContain('Chi nhánh: 05 Trương Định');
    expect(drawn.some((t) => /Chi nhánh \d+ — /.test(t))).toBe(false);
    expect(drawn.some((t) => t.startsWith('Xuất lúc: '))).toBe(true);
    // The bedding row: the room, then Ga giường's count beside its ticked King.
    const bedding = drawn.indexOf('Bảo vệ nệm\nSố lượng');
    expect(drawn.slice(bedding + 1, bedding + 3)).toEqual(['101', '2']);
    // The counted items, in the form's order: Áo gối, Bảo vệ gối, Khăn tắm = 3.
    const counted = drawn.indexOf('Laundrybag');
    expect(drawn.slice(counted + 1, counted + 5)).toEqual(['101', ' ', ' ', '3']);
    // The KPI figures belong to "KPI & Thu tiền", not to this report.
    for (const kpi of ['Được giao', 'Tỷ lệ', 'Đã thu', 'Chưa thu', 'Phát sinh']) expect(drawn.join('|')).not.toContain(kpi);
    // And every character written is one the embedded font can draw.
    for (const file of ['BeVietnamPro-Regular.ttf', 'BeVietnamPro-SemiBold.ttf']) {
      const doc = new PDFDocument();
      doc.registerFont('F', fs.readFileSync(path.join(__dirname, '..', 'src', 'report', 'fonts', file)));
      doc.font('F');
      const font = (doc as unknown as { _font: { font: { hasGlyphForCodePoint(cp: number): boolean } } })._font.font;
      const missing = [...new Set(drawn.join(''))].filter((ch) => ch !== '\n' && !font.hasGlyphForCodePoint(ch.codePointAt(0)!));
      expect(missing).toEqual([]);
    }
  });

  it('reads a form saved before these fields existed — without rewriting it', async () => {
    const legacy = {
      linen: { BED_SHEET: ['K'], DUVET_COVER: ['Q'] },
      quantities: { WATER: 2 },
      replaced: ['COTTON_BUDS', 'SHOWER_CAP', 'TISSUE'],
      note: 'Cũ',
      savedAt: hcm(DAY, '08:30').toISOString(),
      savedByUserId: workerId,
      savedByName: 'Chị Lan',
    };
    const t = await testPrisma.housekeepingRoomTask.create({
      data: {
        branchId: cn1,
        workDate: DAY,
        roomNumber: '104',
        statusCode: 'OUT',
        assigneeUserId: workerId,
        assigneeNameSnapshot: 'Chị Lan',
        state: 'COMPLETED',
        startedAt: hcm(DAY, '08:00'),
        completedAt: hcm(DAY, '08:30'),
        durationSeconds: 1800,
        cleaning: legacy,
        cleanedByUserId: workerId,
        cleanedByNameSnapshot: 'Chị Lan',
        createdByUserId: manager1Id,
        createdByNameSnapshot: 'Quản lý qlbp1',
        createdAt: hcm(DAY, '07:00'),
      },
    });
    const read = (await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks.find((x: { id: string }) => x.id === t.id).cleaning;
    expect(read).toMatchObject({
      linen: { BED_SHEET: { size: 'K', quantity: null }, DUVET_COVER: { size: 'Q', quantity: null } },
      quantities: { WATER: 2 },
      replaced: ['COMB_COTTON_CAP', 'TISSUE'],
      special: [],
      note: 'Cũ',
    });
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: t.id } })).cleaning).toEqual(legacy);
    const rooms = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body.rooms;
    expect(rooms[0].linen.map((l: { sizeLabel: string; quantity: number | null }) => [l.sizeLabel, l.quantity])).toEqual([
      ['King', null],
      ['Queen', null],
    ]);
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
    // Each finding in scope, with where its collection stands — the chart's data.
    expect(branch.findings.map((f: { collectionStatus: string }) => f.collectionStatus).sort()).toEqual(['COLLECTED', 'PENDING']);
    // Another worker's KPI is not in this worker's; another branch's manager sees none of it.
    expect((await worker2.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(0);
    const other = (await manager2.get(`/api/housekeeping/manager/kpi?from=${DAY}&to=${DAY}`)).body;
    expect(other.rows).toEqual([]);
    expect(other.findings).toEqual([]);
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

describe('"Báo cáo": its filters — worker, type, search — on the screen and in both files, never outside the branch', () => {
  const fileOf = (agent: Agent, url: string) =>
    agent
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const PERIOD = `from=${DAY}&to=${DAY}`;
  const report = async (agent: Agent, extra = '') => agent.get(`/api/housekeeping/manager/report?${PERIOD}${extra}`);

  /** Room 101 for Chị Lan (inspected: one finding collected, one not collectible); room 102 for Chị Hoa. */
  async function day() {
    await setUp(manager1, ['101'], workerId);
    const tasks = await setUp(manager1, ['102'], worker2Id);
    const t101 = tasks.find((t) => t.roomNumber === '101')!;
    await onShift(worker, cn1);
    const inspected = await worker.post(`/api/housekeeping/work/tasks/${t101.id}/inspect`).send({ issues: [{ type: 'SMOKING' }, { type: 'ODOR' }] });
    expect(inspected.status).toBe(201);
    const [smoking, odor] = inspected.body.task.inspection.findings as { id: string }[];
    expect((await letan1.put(`/api/housekeeping/issues/${smoking!.id}/collection`).send({ status: 'COLLECTED', amount: 500000, method: 'CASH' })).status).toBe(200);
    expect((await letan1.put(`/api/housekeeping/issues/${odor!.id}/collection`).send({ status: 'UNCOLLECTIBLE', amount: 200000, reason: 'Khách đã rời đi' })).status).toBe(200);
    return { smoking: smoking!, odor: odor! };
  }

  it('narrows the figures, the rooms and the findings by worker, type and search', async () => {
    const { smoking } = await day();
    const names = (body: { rows: { employee: string }[] }) => body.rows.map((r) => r.employee).sort();

    // Everything: both workers; "Không thu được" counted per row (no amount is recorded for it).
    const all = (await report(manager1)).body;
    expect(names(all)).toEqual(['Chị Hoa', 'Chị Lan']);
    expect(all.rows.find((r: { employee: string }) => r.employee === 'Chị Lan')).toMatchObject({ assigned: 1, inspections: 1, findings: 2, collectedAmount: 500000, uncollectibleCount: 1 });
    expect(all.filters).toEqual({ type: 'ALL', typeLabel: 'Tổng hợp vận hành', employee: null, q: null });
    expect(all.findings).toHaveLength(2);

    // One worker: its rooms and its inspections only.
    const lan = (await report(manager1, `&userId=${workerId}`)).body;
    expect(names(lan)).toEqual(['Chị Lan']);
    expect(lan.rooms.map((r: { roomNumber: string }) => r.roomNumber)).toEqual(['101']);
    expect(lan.filters.employee).toBe('Chị Lan');
    const hoa = (await report(manager1, `&userId=${worker2Id}`)).body;
    expect(hoa.rows).toEqual([expect.objectContaining({ employee: 'Chị Hoa', assigned: 1, inspections: 0, findings: 0 })]);
    expect(hoa.findings).toEqual([]);

    // The type: the rooms' work only, or the inspections only.
    const cleaning = (await report(manager1, '&type=CLEANING')).body;
    expect(cleaning.rows.every((r: { inspections: number; findings: number }) => r.inspections === 0 && r.findings === 0)).toBe(true);
    expect(cleaning.rooms).toHaveLength(2);
    expect(cleaning.findings).toEqual([]);
    const inspection = (await report(manager1, '&type=INSPECTION')).body;
    expect(inspection.rows).toEqual([expect.objectContaining({ employee: 'Chị Lan', assigned: 0, inspections: 1, findings: 2 })]);
    expect(inspection.rooms).toEqual([]);
    expect(inspection.filters.typeLabel).toBe('Kiểm phòng & thu tiền');

    // The search: a room, a name without its marks, a finding's id.
    expect(names((await report(manager1, '&q=102')).body)).toEqual(['Chị Hoa']);
    expect(names((await report(manager1, `&q=${encodeURIComponent('chi lan')}`)).body)).toEqual(['Chị Lan']);
    const one = (await report(manager1, `&q=${smoking.id}`)).body;
    expect(one.findings.map((f: { id: string }) => f.id)).toEqual([smoking.id]);
    expect(one.rows).toEqual([expect.objectContaining({ employee: 'Chị Lan', inspections: 1, findings: 1, collectedAmount: 500000, uncollectibleCount: 0 })]);
    expect((await report(manager1, '&q=khong-co-phong-nay')).body.rows).toEqual([]);
  });

  it('refuses a worker outside the reader’s branches, an unknown worker and an unknown type — on the screen and for the files', async () => {
    await day();
    // Chị Mai works at the other branch: not this manager's to report on.
    expect((await report(manager1, `&userId=${worker3Id}`)).status).toBe(403);
    expect((await fileOf(manager1, `/api/housekeeping/manager/report.pdf?${PERIOD}&userId=${worker3Id}`)).status).toBe(403);
    expect((await fileOf(manager1, `/api/housekeeping/manager/report.xlsx?${PERIOD}&userId=${worker3Id}`)).status).toBe(403);
    // Nor is Chị Lan the other branch's manager's.
    expect((await report(manager2, `&userId=${workerId}`)).status).toBe(403);
    // The branch is still checked first, and an id is never taken on trust.
    expect((await report(manager1, `&branchId=${cn2}`)).status).toBe(403);
    expect((await report(manager1, '&userId=999999')).status).toBe(404);
    expect((await report(manager1, '&type=EVERYTHING')).status).toBe(422);
    expect((await report(manager1, `&q=${'x'.repeat(101)}`)).status).toBe(422);
    // The Admin reads any branch's worker.
    expect((await report(admin, `&userId=${worker3Id}`)).status).toBe(200);
  });

  it('writes the same filtered report into the Excel workbook and the PDF', async () => {
    await day();
    // Excel, "Kiểm phòng & thu tiền" for Chị Lan: the figures, the findings — and the filters, written down.
    const res = await fileOf(manager1, `/api/housekeeping/manager/report.xlsx?${PERIOD}&type=INSPECTION&userId=${workerId}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('Bao cao kiem phong phat sinh_05-10-2026.xlsx');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Vận hành buồng phòng', 'Phát sinh & thu tiền']);
    const ops = wb.getWorksheet('Vận hành buồng phòng')!;
    const cells = ops.getColumn(1).values.map(String);
    expect(cells).toContain('Loại báo cáo: Kiểm phòng & thu tiền');
    expect(cells).toContain('Nhân viên: Chị Lan');
    expect(ops.getRow(2).getCell(3).value).toBe('Chị Lan');
    expect(ops.getRow(3).getCell(3).value).toBe(null);
    const findings = wb.getWorksheet('Phát sinh & thu tiền')!;
    expect(findings.rowCount).toBe(3);
    expect(findings.getColumn(7).values.slice(2).map(String).sort()).toEqual(['Không thu được', 'Đã thu']);

    // A search narrows the workbook as it narrows the screen: room 102 only.
    const searched = await fileOf(manager1, `/api/housekeeping/manager/report.xlsx?${PERIOD}&q=102`);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(searched.body as unknown as Parameters<typeof wb2.xlsx.load>[0]);
    expect(wb2.getWorksheet('Vận hành buồng phòng')!.getRow(2).getCell(3).value).toBe('Chị Hoa');
    expect(wb2.getWorksheet('Vận hành buồng phòng')!.getColumn(1).values.map(String)).toContain('Tìm kiếm: "102"');
    expect(wb2.getWorksheet('Chi tiết dọn phòng')!.getColumn(3).values.slice(2).map(String)).toEqual(['102']);

    // The PDF of "Kiểm phòng & thu tiền": its findings, and what it was filtered by.
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    let drawn: string[] = [];
    try {
      const pdf = await fileOf(manager1, `/api/housekeeping/manager/report.pdf?${PERIOD}&type=INSPECTION&userId=${workerId}`);
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.headers['content-disposition']).toContain('Bao cao kiem phong phat sinh_05-10-2026.pdf');
      drawn = text.mock.calls.map((c) => String(c[0]));
    } finally {
      text.mockRestore();
    }
    const joined = drawn.join('\n');
    for (const value of ['KAS – BÁO CÁO KIỂM PHÒNG & PHÁT SINH', 'Loại báo cáo: Kiểm phòng & thu tiền', 'Nhân viên: Chị Lan', 'Đã thu', 'Không thu được', '500.000']) {
      expect(joined).toContain(value);
    }
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
    // Inspected but never started: "Đã kiểm tra" — and it stays that way, voided.
    expect(kept).toMatchObject({ voidReason: 'Nhập nhầm phòng', state: 'INSPECTED' });
    expect(kept.events.map((e) => e.type)).toContain('VOIDED');
    expect(await testPrisma.roomInspection.count()).toBe(1);
    expect(await testPrisma.roomIssueCollection.count({ where: { status: 'COLLECTED' } })).toBe(1);
    // The KPI still explains the collection.
    expect((await worker.get(`/api/housekeeping/kpi/me?from=${DAY}&to=${DAY}`)).body.summary.collectedAmount).toBe(300000);
    // A voided item cannot be worked.
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send({})).status).toBe(409);
  });
});
