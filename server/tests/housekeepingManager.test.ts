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
 *         Buồng phòng accounts the Admin assigned to it, and nothing else.
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
import type { CleaningDetailRow } from '../src/housekeeping/housekeepingKpi';
import { BEDDING_COLUMNS, REPLACEMENT_COLUMNS, ROOM_COLUMNS } from '../src/report/housekeepingCleaningPdf';
import type { Column } from '../src/report/pdf';

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

  it('4. keeps a worker to its own rooms at its own branch — whatever the request says', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker2, cn1);
    expect((await worker2.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(403);
    expect((await worker2.get(`/api/housekeeping/work/tasks/${task!.id}`)).status).toBe(403);
    // The branch is the account's: "Vào ca" or "Đổi chi nhánh" to CN2 is refused.
    expect((await worker.post('/api/housekeeping/shift/start').send({ branchId: cn2 })).status).toBe(403);
    await onShift(worker, cn1);
    expect((await worker.post('/api/housekeeping/shift/switch').send({ branchId: cn2 })).status).toBe(403);

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

describe('the branch’s staff — the accounts the Admin assigned to it', () => {
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

  it('9. assigns a new account at once — no shift at the branch first', async () => {
    const res = await admin.post('/api/admin/users').send({ username: 'buong_moi', fullName: 'Chị Nga', temporaryPassword: PASSWORD, role: 'HOUSEKEEPING', branchId: cn1 });
    expect(res.status).toBe(201);
    const id = res.body.user.id as number;
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan', 'Chị Nga']);
    const [task] = await setUp(manager1, ['103'], id);
    const row = (await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`)).body.tasks.find((t: { id: string }) => t.id === task!.id);
    expect(row.assignee).toMatchObject({ id, name: 'Chị Nga' });
    await resetHousekeepingData();
    await testPrisma.notification.deleteMany({ where: { userId: id } });
    await testPrisma.user.delete({ where: { id } });
  });

  it('10. reads the account’s branch only — shift history and old rooms count for nothing', async () => {
    // Chị Mai (CN2) worked a CN1 shift today and still holds a CN1 room: she is not CN1's.
    await workedAt(worker3Id, cn1, DAY);
    await testPrisma.housekeepingRoomTask.create({
      data: { branchId: cn1, workDate: DAY, roomNumber: '102', statusCode: 'OUT', assigneeUserId: worker3Id, assigneeNameSnapshot: 'Chị Mai', createdByUserId: manager1Id, createdByNameSnapshot: 'Quản lý qlbp1', createdAt: hcm(DAY, '07:00') },
    });
    expect(await names(manager1)).toEqual(['Chị Hoa', 'Chị Lan']);
    const [task] = await setUp(manager1, ['101'], workerId);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker3Id })).status).toBe(422);
    // A CN1 account with no shift history at all is assignable.
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task!.id}/assign`).send({ assigneeUserId: worker2Id })).status).toBe(200);
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

    // The form, validated against the catalog: ONE type per linen item, with its count.
    const cleaning = (body: Record<string, unknown>) => worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send(body);
    expect((await cleaning({ quantities: { BATH_TOWEL: -1 } })).status).toBe(422);
    expect((await cleaning({ linen: { BED_SHEET: ['K', 'Q'] } })).status).toBe(422);
    expect((await cleaning({ linen: { BED_SHEET: { size: 'X', quantity: 1 } } })).status).toBe(422);
    expect((await cleaning({ linen: { BED_SHEET: { size: 'K' } } })).status).toBe(422);
    expect((await cleaning({ replaced: ['COMB'] })).status).toBe(422);
    expect((await cleaning({ special: ['VIP'] })).status).toBe(422);
    const form = {
      linen: { BED_SHEET: { size: 'K', quantity: 2 }, DUVET_COVER: { size: 'T', quantity: 1 } },
      quantities: { BATH_TOWEL: 2, WATER: 4 },
      replaced: ['SHAMPOO', 'COMB_COTTON_CAP'],
      special: ['DND', 'LB'],
      note: 'Rèm hơi bẩn',
    };

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
      linen: { BED_SHEET: { size: 'K', quantity: 2 }, DUVET_COVER: { size: 'T', quantity: 1 } },
      quantities: { BATH_TOWEL: 2, WATER: 4 },
      replaced: ['COMB_COTTON_CAP', 'SHAMPOO'],
      special: ['LB', 'DND'],
      note: 'Rèm hơi bẩn',
      savedByUserId: workerId,
    });

    // 12. The manager sees every step and every value the worker entered.
    const seen = (await manager1.get(`/api/housekeeping/manager/staff/${workerId}?from=${DAY}&to=${DAY}`)).body;
    expect(seen.tasks[0].events.map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ASSIGNED', 'OPENED', 'INSPECTED', 'COMPLETED']);
    expect(seen.tasks[0].cleaning).toMatchObject({ quantities: { BATH_TOWEL: 2, WATER: 4 }, special: ['LB', 'DND'], linen: { BED_SHEET: { size: 'K', quantity: 2 } } });
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
    const form = {
      linen: { BED_SHEET: { size: 'Q', quantity: 2 }, MATTRESS_PROTECTOR: { size: 'K', quantity: 1 } },
      quantities: { PILLOWCASE: 4 },
      replaced: ['TEA_COFFEE_SUGAR', 'HAND_WASH'],
      special: ['SO', 'OOO', 'LNL'],
      note: 'Ổ cắm hỏng',
    };
    expect((await worker.put(`/api/housekeeping/work/tasks/${task!.id}/cleaning`).send(form)).status).toBe(200);
    // Reloaded, and stored as data — not as text.
    expect((await worker.get(`/api/housekeeping/work/tasks/${task!.id}`)).body.task.cleaning).toMatchObject(form);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task!.id } })).cleaning).toMatchObject(form);

    setClock({ now: () => hcm(DAY, '08:40') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send(form)).status).toBe(200);
    const report = (await manager1.get(`/api/housekeeping/manager/report?from=${DAY}&to=${DAY}`)).body;
    expect(report.rooms).toEqual([
      {
        branchLabel: expect.stringContaining('Chi nhánh'),
        workDate: DAY,
        roomNumber: '101',
        statusCode: 'OUT',
        employee: 'Chị Lan',
        state: 'COMPLETED',
        startedAt: hcm(DAY, '08:00').toISOString(),
        completedAt: hcm(DAY, '08:40').toISOString(),
        durationSeconds: 40 * 60,
        linen: [
          { item: 'BED_SHEET', label: 'Ga giường', size: 'Q', sizeLabel: 'Queen', quantity: 2 },
          { item: 'MATTRESS_PROTECTOR', label: 'Bảo vệ nệm', size: 'K', sizeLabel: 'King', quantity: 1 },
        ],
        quantities: [{ item: 'PILLOWCASE', label: 'Áo gối', quantity: 4 }],
        replaced: [
          { code: 'TEA_COFFEE_SUGAR', label: 'Trà, cà phê, đường. Miễn phí' },
          { code: 'HAND_WASH', label: 'Nước rửa tay' },
        ],
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
    expect(cell('Ga giường')).toBe('Queen × 2');
    expect(cell('Bảo vệ nệm')).toBe('King × 1');
    expect(cell('Số lượng')).toBe('Áo gối: 4');
    expect(cell('Đồ thay thế')).toBe('Trà, cà phê, đường. Miễn phí; Nước rửa tay');
    expect(cell('Ghi nhận đặc biệt')).toBe('SO : Phòng có đồ nhưng khách không ngủ; OOO : Không thể bán phòng; LNL : Hàng thất lạc');
    expect(cell('Ghi chú')).toBe('Ổ cắm hỏng');
  });

  it('prints the PDF from the "Dọn phòng" data — King and its count, replacements, special statuses, note, worker, times', async () => {
    const [task] = await setUp(manager1, ['101'], workerId);
    await onShift(worker, cn1);
    setClock({ now: () => hcm(DAY, '09:00') });
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/inspect`).send({ issues: [] })).status).toBe(201);
    setClock({ now: () => hcm(DAY, '09:42') });
    const form = {
      linen: { BED_SHEET: { size: 'K', quantity: 2 } },
      quantities: { BATH_TOWEL: 3 },
      replaced: ['SHAMPOO', 'HAND_WASH'],
      special: ['DND', 'LNL'],
      note: 'Vòi sen rỉ nước',
    };
    expect((await worker.post(`/api/housekeeping/work/tasks/${task!.id}/complete`).send(form)).status).toBe(200);

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
    expect(drawn.some((t) => /^Chi nhánh: Chi nhánh \d+ — /.test(t))).toBe(true);
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
