/**
 * HOUSEKEEPING WAREHOUSES — Kho Linens, Kho Amenities, Kho đồ dùng, thiết bị.
 *
 *   A  items: per branch, warehouse and variant; never-used removed, used archived
 *   B  "Lưu phiếu nhập": many lines, all or none, once per request
 *   C  the room cleaning moves the stock — room 102: clean towels 20 → 18, dirty 0 → 2
 *   D  a shortage refuses the completion whole; a retry never moves stock twice
 *   E  two completions racing for the last towels: one wins, never below zero
 *   F  the Quản lý buồng phòng's own cleaning needs no review
 *   G  tomorrow's work: its own day, accepted today, worked tomorrow
 *   H  "Kiểm kho": recorded vs counted, a reason for a difference, never stale
 *   I  the laundry: dirty → washing → clean, the same pieces
 *   J  "Báo hỏng": out of the usable stock at once, the Admin told once, rejected by reversal
 *   K  who may: branch scope and roles, on every request
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { startShiftAt } from './helpers/workplace';
import { settlePushes } from '../src/push/pushService';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-07';
const TOMORROW = '2026-10-08';
const INV = '/api/housekeeping/inventory';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let manager1: Agent;
let manager2: Agent;
let letan1: Agent;
let tech: Agent;
let lan: Agent;
let hoa: Agent;
let adminId = 0;

let seq = 0;
const rid = () => `req-${Date.now()}-${(seq += 1)}`;

type Item = { id: string; name: string; variant: string; label: string; catalogKey: string | null; balances: Record<string, number>; archived: boolean; lowStock: boolean };

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const id = async (code: string) => (await testPrisma.branch.findUniqueOrThrow({ where: { code } })).id;
  cn1 = await id('TRUONG_DINH_05');
  cn2 = await id('LY_TU_TRONG_260');
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  for (const [username, branchId] of [
    ['qlbp1', cn1],
    ['qlbp2', cn2],
  ] as const) {
    const res = await admin.post('/api/admin/users').send({ username, fullName: `QL ${username}`, temporaryPassword: PASSWORD, role: 'HOUSEKEEPING_MANAGER', branchId });
    expect(res.status).toBe(201);
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  manager1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  manager2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  await createUser({ username: 'kythuat', password: PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  tech = (await loginAgent(app, 'kythuat', PASSWORD)).agent;
  await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING' });
  await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING' });
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  setClock({ now: () => hcm(DAY, '08:00') });
});

afterAll(async () => {
  await settlePushes();
  resetClock();
  await resetAll();
});

/* ------------------------------ helpers ------------------------------ */

const items = async (agent: Agent = manager1, query = '') => (await agent.get(`${INV}/items${query}`)).body.items as Item[];
const byKey = async (key: string, agent: Agent = manager1) => (await items(agent)).find((i) => i.catalogKey === key)!;
const balance = async (key: string, state: string) => (await byKey(key)).balances[state];
const receive = (lines: { itemId: string; quantity: number }[], warehouse = 'LINEN', requestId = rid(), agent: Agent = manager1) =>
  agent.post(`${INV}/receipts`).send({ warehouse, requestId, reference: 'PN-01', lines });

/** CN1 keeps the "Dọn phòng" form's linen and amenities, and has received some. */
async function stock(towels: number, water = 0) {
  expect((await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' })).status).toBe(200);
  expect((await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'AMENITY' })).status).toBe(200);
  const towel = await byKey('QTY:BATH_TOWEL');
  if (towels > 0) expect((await receive([{ itemId: towel.id, quantity: towels }])).status).toBe(201);
  if (water > 0) expect((await receive([{ itemId: (await byKey('QTY:WATER')).id, quantity: water }], 'AMENITY')).status).toBe(201);
}

/** A room given to a worker and brought to "Đang dọn" — ready for "Hoàn thành". */
async function cleaning(roomNumber: string, worker: Agent = lan, workDate = DAY) {
  const g = await manager1.post('/api/housekeeping/manager/work-groups').send({
    workDate,
    requestId: rid(),
    items: [{ areaKind: 'ROOM', roomNumber, taskCodes: ['OUT'] }],
  });
  expect(g.status).toBe(201);
  const task = g.body.group.items[0] as { id: string };
  const shift = await worker.get('/api/housekeeping/shift');
  if (!shift.body.shift?.current) {
    if (worker === manager1) expect((await manager1.post('/api/housekeeping/shift/start').send({})).status).toBe(201);
    else await startShiftAt(worker, cn1);
  }
  expect((await worker.post(`/api/housekeeping/work/groups/${g.body.group.id}/accept`).send({})).status).toBe(200);
  const url = `/api/housekeeping/work/tasks/${task.id}`;
  expect((await worker.post(`${url}/begin-inspection`)).status).toBe(200);
  expect((await worker.post(`${url}/inspect`).send({ issues: [] })).status).toBe(201);
  expect((await worker.post(`${url}/start`)).status).toBe(200);
  return { id: task.id, complete: (form: Record<string, unknown>) => worker.post(`${url}/complete`).send(form) };
}

const movementsOf = (taskId: string) => testPrisma.inventoryMovement.findMany({ where: { taskId }, include: { item: true }, orderBy: [{ state: 'asc' }] });

/* --------------------------------- A --------------------------------- */

describe('A. items', () => {
  it('keeps each variant apart — a King and a Queen sheet are two items, two balances', async () => {
    expect((await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' })).body.added).toBeGreaterThan(0);
    const linen = await items(manager1, '?warehouse=LINEN');
    const sheets = linen.filter((i) => i.name === 'Ga giường').map((i) => i.variant);
    expect(sheets.sort()).toEqual(['King', 'Queen', 'Twin']);
    expect(linen.find((i) => i.catalogKey === 'QTY:BATH_TOWEL')!.balances).toEqual({ AVAILABLE: 0, DIRTY: 0, DAMAGED: 0 });
    // Water is a consumed supply, not linen.
    expect(linen.some((i) => i.catalogKey === 'QTY:WATER')).toBe(false);
    // Twice adds nothing; no opening balance is invented.
    expect((await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' })).body.added).toBe(0);
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
  });

  it('refuses a second active item of the same name and variant, removes a never-used one, and only archives a used one', async () => {
    const make = (body: Record<string, unknown>) => manager1.post(`${INV}/items`).send({ warehouse: 'EQUIPMENT', unit: 'cái', ...body });
    const mop = await make({ name: 'Cây lau nhà', code: 'CLN' });
    expect(mop.status).toBe(201);
    expect((await make({ name: 'cây lau nhà' })).status).toBe(409);
    expect((await make({ name: 'Xô', code: 'cln' })).status).toBe(409);
    const bucket = await make({ name: 'Xô' });
    // Never used: removed.
    expect((await manager1.delete(`${INV}/items/${bucket.body.item.id}`)).body).toEqual({ removed: true, archived: false });
    // Used: archived, its history kept, and no new receipt against it.
    expect((await receive([{ itemId: mop.body.item.id, quantity: 3 }], 'EQUIPMENT')).status).toBe(201);
    expect((await manager1.delete(`${INV}/items/${mop.body.item.id}`)).body).toEqual({ removed: false, archived: true });
    expect(await testPrisma.inventoryMovement.count({ where: { itemId: mop.body.item.id } })).toBe(1);
    const refused = await receive([{ itemId: mop.body.item.id, quantity: 1 }], 'EQUIPMENT');
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain('ngừng sử dụng');
    // Its name is free again for a new item.
    expect((await make({ name: 'Cây lau nhà' })).status).toBe(201);
  });
});

/* --------------------------------- B --------------------------------- */

describe('B. "Lưu phiếu nhập"', () => {
  it('receives many items in one receipt — once, whatever retries', async () => {
    await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    const towel = await byKey('QTY:BATH_TOWEL');
    const king = await byKey('LINEN:BED_SHEET:K');
    const queen = await byKey('LINEN:BED_SHEET:Q');
    const requestId = rid();
    const lines = [
      { itemId: towel.id, quantity: 20 },
      { itemId: king.id, quantity: 5 },
      { itemId: queen.id, quantity: 7 },
    ];
    const first = await receive(lines, 'LINEN', requestId);
    expect(first.status).toBe(201);
    expect(first.body.receipt.lines).toHaveLength(3);
    // A double tap: the same receipt, nothing received twice.
    const again = await receive(lines, 'LINEN', requestId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, receipt: { id: first.body.receipt.id } });
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(20);
    expect(await balance('LINEN:BED_SHEET:K', 'AVAILABLE')).toBe(5);
    expect(await balance('LINEN:BED_SHEET:Q', 'AVAILABLE')).toBe(7);
    expect(await testPrisma.inventoryReceipt.count()).toBe(1);
  });

  it('saves nothing when one line is wrong — a repeated item, a zero, another branch’s item or another warehouse', async () => {
    await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    await manager2.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    const towel = await byKey('QTY:BATH_TOWEL');
    const theirs = (await items(manager2)).find((i) => i.catalogKey === 'QTY:BATH_TOWEL')!;
    for (const bad of [
      [{ itemId: towel.id, quantity: 2 }, { itemId: towel.id, quantity: 3 }],
      [{ itemId: towel.id, quantity: 2 }, { itemId: (await byKey('QTY:HAND_TOWEL')).id, quantity: 0 }],
      [{ itemId: towel.id, quantity: 2 }, { itemId: theirs.id, quantity: 3 }],
      [],
    ]) {
      expect((await receive(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await receive([{ itemId: towel.id, quantity: 2 }], 'AMENITY')).status).toBe(422);
    expect(await testPrisma.inventoryReceipt.count()).toBe(0);
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
  });
});

/* --------------------------------- C --------------------------------- */

describe('C. the room cleaning moves the stock', () => {
  it('room 102: 2 clean towels put in, 2 dirty taken out — clean 20 → 18, dirty 0 → 2, traced to the room and task', async () => {
    await stock(20, 10);
    // This branch does not keep shampoo: its item removed (never used).
    expect((await manager1.delete(`${INV}/items/${(await byKey('REPLACED:SHAMPOO')).id}`)).body.removed).toBe(true);
    const room = await cleaning('102');
    setClock({ now: () => hcm(DAY, '09:00') });
    const done = await room.complete({ quantities: { BATH_TOWEL: 2, WATER: 2 }, collected: { BATH_TOWEL: 2 }, replaced: ['SHAMPOO'] });
    expect(done.status).toBe(200);
    expect(done.body.task.phase).toBe('COMPLETED');
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(18);
    expect(await balance('QTY:BATH_TOWEL', 'DIRTY')).toBe(2);
    // Water is consumed: out of the amenities, never dirty.
    expect(await balance('QTY:WATER', 'AVAILABLE')).toBe(8);
    const moves = await movementsOf(room.id);
    const dirty = moves.find((m) => m.state === 'DIRTY')!;
    expect(dirty).toMatchObject({ type: 'DIRTY_COLLECTED', delta: 2, balanceAfter: 2, roomNumber: '102', workDate: DAY, actorNameSnapshot: 'Chị Lan' });
    expect(dirty.item.catalogKey).toBe('QTY:BATH_TOWEL');
    expect(moves.filter((m) => m.item.catalogKey === 'QTY:WATER').map((m) => [m.state, m.delta])).toEqual([['AVAILABLE', -2]]);
    // Shampoo is not kept at this branch: not tracked, nothing invented — and no refusal.
    expect(moves.some((m) => m.item.catalogKey === 'REPLACED:SHAMPOO')).toBe(false);
  });

  it('collects bed linen in the size recorded for it, and refuses a dirty count with no size', async () => {
    await stock(0);
    const king = await byKey('LINEN:BED_SHEET:K');
    await receive([{ itemId: king.id, quantity: 4 }]);
    const room = await cleaning('103');
    expect((await room.complete({ collected: { BED_SHEET: 1 } })).status).toBe(422);
    expect((await room.complete({ linen: { BED_SHEET: { size: 'K', quantity: 1 } }, collected: { BED_SHEET: 1 } })).status).toBe(200);
    expect(await balance('LINEN:BED_SHEET:K', 'AVAILABLE')).toBe(3);
    expect(await balance('LINEN:BED_SHEET:K', 'DIRTY')).toBe(1);
    expect(await balance('LINEN:BED_SHEET:Q', 'DIRTY')).toBe(0);
  });

  it('collects nothing when nothing was taken out — topping up is not a replacement', async () => {
    await stock(10);
    const room = await cleaning('101');
    expect((await room.complete({ quantities: { BATH_TOWEL: 1 } })).status).toBe(200);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(9);
    expect(await balance('QTY:BATH_TOWEL', 'DIRTY')).toBe(0);
  });
});

/* --------------------------------- D --------------------------------- */

describe('D. a shortage, and a retry', () => {
  it('refuses the whole completion when the stock is short — the task and every balance untouched', async () => {
    await stock(1, 5);
    const room = await cleaning('102');
    const res = await room.complete({ quantities: { BATH_TOWEL: 2, WATER: 1 }, collected: { BATH_TOWEL: 2 } });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Không đủ tồn kho để hoàn thành: Khăn tắm cần 2, còn 1');
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: room.id } })).state).toBe('IN_PROGRESS');
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(1);
    expect(await balance('QTY:WATER', 'AVAILABLE')).toBe(5);
    expect(await movementsOf(room.id)).toHaveLength(0);
    // Stock received, the same press works.
    await receive([{ itemId: (await byKey('QTY:BATH_TOWEL')).id, quantity: 5 }]);
    expect((await room.complete({ quantities: { BATH_TOWEL: 2, WATER: 1 }, collected: { BATH_TOWEL: 2 } })).status).toBe(200);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(4);
  });

  it('never moves the stock twice — a repeated "Hoàn thành" is refused and changes nothing', async () => {
    await stock(20);
    const room = await cleaning('102');
    const form = { quantities: { BATH_TOWEL: 2 }, collected: { BATH_TOWEL: 2 } };
    const both = await Promise.all([room.complete(form), room.complete(form)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await room.complete(form)).status).toBe(409);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(18);
    expect(await balance('QTY:BATH_TOWEL', 'DIRTY')).toBe(2);
    expect(await movementsOf(room.id)).toHaveLength(2);
  });
});

/* --------------------------------- E --------------------------------- */

describe('E. two completions racing for the last towels', () => {
  it('lets exactly one take them — the stock never goes below zero', async () => {
    await stock(2);
    const a = await cleaning('101', lan);
    const b = await cleaning('102', hoa);
    const form = { quantities: { BATH_TOWEL: 2 } };
    const results = await Promise.all([a.complete(form), b.complete(form)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(0);
    const rows = await testPrisma.inventoryBalance.findMany();
    expect(rows.every((r) => r.quantity >= 0)).toBe(true);
  });
});

/* --------------------------------- F --------------------------------- */

describe('F. the Quản lý buồng phòng cleans a room itself', () => {
  it('needs no review of its own work — recorded "Đạt" by itself — and moves the stock like anyone’s', async () => {
    await stock(10);
    const room = await cleaning('101', manager1);
    expect((await room.complete({ quantities: { BATH_TOWEL: 2 }, collected: { BATH_TOWEL: 1 } })).status).toBe(200);
    const t = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: room.id } });
    expect(t).toMatchObject({ state: 'COMPLETED', reviewResult: 'PASSED', cleanedByNameSnapshot: 'QL qlbp1', reviewedByNameSnapshot: 'QL qlbp1' });
    const events = await testPrisma.housekeepingRoomTaskEvent.findMany({ where: { taskId: room.id, type: 'REVIEWED' } });
    expect(events.map((e) => e.detail)).toEqual([expect.objectContaining({ selfCleaned: true, result: 'PASSED' })]);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(8);
    expect(await balance('QTY:BATH_TOWEL', 'DIRTY')).toBe(1);
    // A worker's cleaning still waits for the manager's review.
    const other = await cleaning('102', lan);
    expect((await other.complete({})).status).toBe(200);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: other.id } })).reviewResult).toBeNull();
  });
});

/* --------------------------------- G --------------------------------- */

describe('G. tomorrow’s work', () => {
  it('stays on its own day — accepted today, never worked before its day — and a room is still held once per day', async () => {
    const create = (workDate: string) =>
      manager1.post('/api/housekeeping/manager/work-groups').send({ workDate, requestId: rid(), items: [{ areaKind: 'ROOM', roomNumber: '201', taskCodes: ['OUT'] }] });
    const tomorrow = await create(TOMORROW);
    expect(tomorrow.status).toBe(201);
    // The same room tomorrow twice: refused. Today's room 201 is free all the same.
    expect((await create(TOMORROW)).status).toBe(409);
    expect((await create(DAY)).status).toBe(201);
    await startShiftAt(lan, cn1);
    const today = (await lan.get(`/api/housekeeping/work/groups?date=${DAY}`)).body.groups as { id: string }[];
    expect(today.map((g) => g.id)).not.toContain(tomorrow.body.group.id);
    const next = (await lan.get(`/api/housekeeping/work/groups?date=${TOMORROW}`)).body.groups as { id: string }[];
    expect(next.map((g) => g.id)).toEqual([tomorrow.body.group.id]);
    // Accepted today …
    expect((await lan.post(`/api/housekeeping/work/groups/${tomorrow.body.group.id}/accept`).send({})).status).toBe(200);
    // … worked tomorrow.
    const url = `/api/housekeeping/work/tasks/${tomorrow.body.group.items[0].id}`;
    const early = await lan.post(`${url}/begin-inspection`);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain('08/10/2026');
    expect((await lan.post(`${url}/inspect`).send({ issues: [] })).status).toBe(409);
    setClock({ now: () => hcm(TOMORROW, '08:00') });
    await testPrisma.housekeepingWorkSegment.deleteMany();
    await testPrisma.housekeepingWorkSession.deleteMany();
    await startShiftAt(lan, cn1);
    expect((await lan.post(`${url}/begin-inspection`)).status).toBe(200);
  });
});

/* --------------------------------- H --------------------------------- */

describe('H. "Kiểm kho"', () => {
  const count = (lines: Record<string, unknown>[], agent: Agent = manager1, extra: Record<string, unknown> = {}) =>
    agent.post(`${INV}/counts`).send({ warehouse: 'LINEN', requestId: rid(), lines, ...extra });

  it('the Admin reconciles: the book it saw, the count, the difference with its reason — and a recount when stock moved meanwhile', async () => {
    await stock(18);
    const towel = await byKey('QTY:BATH_TOWEL');
    const line = { itemId: towel.id, state: 'AVAILABLE', systemQuantity: 18, countedQuantity: 17 };
    // The Admin names the branch.
    expect((await count([line], admin)).status).toBe(422);
    const noReason = await count([line], admin, { branchId: cn1 });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toContain('lý do chênh lệch');
    // The recorded figure the counter saw is no longer the figure: recount.
    expect((await count([{ ...line, systemQuantity: 20, reason: 'Mất 1' }], admin, { branchId: cn1 })).status).toBe(409);
    const ok = await count([{ ...line, reason: 'Mất 1 khăn' }, { itemId: towel.id, state: 'DIRTY', systemQuantity: 0, countedQuantity: 0 }], admin, { branchId: cn1 });
    expect(ok.status).toBe(201);
    expect(ok.body.count.lines.map((l: { systemQuantity: number; difference: number }) => [l.systemQuantity, l.difference])).toEqual([
      [18, -1],
      [0, 0],
    ]);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(17);
    const adj = await testPrisma.inventoryMovement.findMany({ where: { type: 'COUNT_ADJUSTMENT' } });
    expect(adj.map((m) => [m.state, m.delta, m.reason])).toEqual([['AVAILABLE', -1, 'Mất 1 khăn']]);
    // Every branch's counts, with their differences — one branch on request.
    const listed = (await admin.get(`${INV}/counts?onlyDifferences=true`)).body.counts as { branch: { id: number }; lines: { difference: number }[] }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.lines[0]).toMatchObject({ systemQuantity: 18, countedQuantity: 17, difference: -1 });
    expect((await admin.get(`${INV}/counts?branchId=${cn2}`)).body.counts).toEqual([]);
  });

  it('the Quản lý buồng phòng counts blind — never shown the book or the difference, in any response — and still gives the reason', async () => {
    await stock(18);
    const towel = await byKey('QTY:BATH_TOWEL');
    // A book quantity sent from the browser is not read: the server's is.
    const line = { itemId: towel.id, state: 'AVAILABLE', systemQuantity: 999, countedQuantity: 17 };
    const noReason = await count([line]);
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toContain('khác sổ sách');
    expect(noReason.body.error.message).not.toMatch(/18|-1/);
    const ok = await count([{ ...line, reason: 'Mất 1 khăn' }, { itemId: towel.id, state: 'DIRTY', countedQuantity: 0 }]);
    expect(ok.status).toBe(201);
    for (const l of ok.body.count.lines) {
      expect(l).not.toHaveProperty('systemQuantity');
      expect(l).not.toHaveProperty('difference');
    }
    // Still adjusted — by the audited movement, against the real book.
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(17);
    const stored = await testPrisma.inventoryCountLine.findMany({ orderBy: { state: 'asc' } });
    expect(stored.map((l) => [l.state, l.systemQuantity, l.countedQuantity, l.difference])).toEqual([
      ['AVAILABLE', 18, 17, -1],
      ['DIRTY', 0, 0, 0],
    ]);
    // Its list, its history and its movements carry neither the book nor the difference.
    const mine = (await manager1.get(`${INV}/counts`)).body.counts as { lines: Record<string, unknown>[] }[];
    expect(mine).toHaveLength(1);
    for (const l of mine[0]!.lines) expect(Object.keys(l)).not.toEqual(expect.arrayContaining(['systemQuantity']));
    expect(JSON.stringify(mine)).not.toContain('difference');
    const moves = (await manager1.get(`${INV}/movements`)).body.movements as { type: string }[];
    expect(moves.some((m) => m.type === 'COUNT_ADJUSTMENT')).toBe(false);
    expect(((await admin.get(`${INV}/movements`)).body.movements as { type: string }[]).some((m) => m.type === 'COUNT_ADJUSTMENT')).toBe(true);
    // Another branch's manager cannot count this branch's stock.
    expect((await count([{ itemId: towel.id, state: 'AVAILABLE', countedQuantity: 16, reason: 'x' }], manager2)).status).toBe(422);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(17);
  });
});

/* --------------------------------- I --------------------------------- */

describe('I. no laundry processing', () => {
  it('keeps dirty linen dirty — no "Gửi giặt", no "Giặt xong" — while clean linen still comes in by "Nhập kho"', async () => {
    await stock(20);
    const room = await cleaning('102');
    await room.complete({ quantities: { BATH_TOWEL: 2 }, collected: { BATH_TOWEL: 2 } });
    const towel = await byKey('QTY:BATH_TOWEL');
    const move = (kind: string, quantity: number) => manager1.post(`${INV}/transfers`).send({ kind, requestId: rid(), lines: [{ itemId: towel.id, quantity }] });
    expect((await byKey('QTY:BATH_TOWEL')).balances).toEqual({ AVAILABLE: 18, DIRTY: 2, DAMAGED: 0 });
    for (const kind of ['LAUNDRY_RETURN', 'LAUNDRY_SEND', 'STOCK_ISSUE']) expect((await move(kind, 1)).status).toBe(422);
    expect(await testPrisma.inventoryTransfer.count()).toBe(0);
    // The dirty pieces stay where the room put them; fresh clean stock is a receipt.
    expect((await receive([{ itemId: towel.id, quantity: 5 }])).status).toBe(201);
    expect((await byKey('QTY:BATH_TOWEL')).balances).toEqual({ AVAILABLE: 23, DIRTY: 2, DAMAGED: 0 });
    // Past laundry movements keep their names in the history.
    const catalog = (await manager1.get(`${INV}/catalog`)).body;
    expect(catalog.movements).toMatchObject({ LAUNDRY_SENT: 'Gửi giặt', LAUNDRY_RETURNED: 'Giặt xong' });
    expect(Object.keys(catalog.transfers).sort()).toEqual(['STOCK_ISSUE', 'STOCK_RETURN']);
  });
});

/* --------------------------------- J --------------------------------- */

describe('J. "Báo hỏng / Không thể tái sử dụng"', () => {
  it('takes the quantity out of the usable stock at once, tells the Admin once, and is reversed — never deleted — when rejected', async () => {
    await stock(20);
    const towel = await byKey('QTY:BATH_TOWEL');
    const requestId = rid();
    const body = { itemId: towel.id, quantity: 3, fromState: 'AVAILABLE', reason: 'Rách, ố màu không giặt được', roomNumber: '102', requestId };
    const first = await manager1.post(`${INV}/damage`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.report).toMatchObject({ status: 'PENDING', quantity: 3, label: 'Khăn tắm', roomNumber: '102', reportedBy: { name: 'QL qlbp1' } });
    // Retried: the same report, counted once.
    expect((await manager1.post(`${INV}/damage`).send(body)).body).toMatchObject({ duplicate: true, report: { id: first.body.report.id } });
    expect((await byKey('QTY:BATH_TOWEL')).balances).toMatchObject({ AVAILABLE: 17, DAMAGED: 3 });
    // The Admin is told — once — with the branch, item, quantity and a link.
    const notes = await testPrisma.notification.findMany({ where: { userId: adminId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Báo hỏng đồ buồng phòng', link: `/app/inventory?damage=${first.body.report.id}` });
    expect(notes[0]!.body).toContain('Khăn tắm: 3 cái');
    // The Admin sees it with every branch; the other manager does not.
    expect((await admin.get(`${INV}/damage?status=PENDING`)).body.reports.map((r: { id: string }) => r.id)).toEqual([first.body.report.id]);
    expect((await manager2.get(`${INV}/damage`)).body.reports).toEqual([]);
    // Only the Admin reviews.
    expect((await manager1.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT', note: 'x' })).status).toBe(403);
    expect((await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT' })).status).toBe(422);
    const rejected = await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT', note: 'Còn dùng được' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.report).toMatchObject({ status: 'REJECTED', reviewedBy: { id: adminId }, reviewNote: 'Còn dùng được' });
    const history = rejected.body.report.history.map((h: { type: string; state: string; delta: number }) => `${h.type} ${h.state} ${h.delta}`);
    expect(history.sort()).toEqual(['DAMAGE AVAILABLE -3', 'DAMAGE DAMAGED 3', 'DAMAGE_REVERSAL AVAILABLE 3', 'DAMAGE_REVERSAL DAMAGED -3']);
    expect((await byKey('QTY:BATH_TOWEL')).balances).toMatchObject({ AVAILABLE: 20, DAMAGED: 0 });
    // Reviewed once.
    expect((await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'ACKNOWLEDGE' })).status).toBe(409);
  });

  it('keeps an acknowledged write-off out of the usable stock, and refuses more than there is', async () => {
    await stock(2);
    const towel = await byKey('QTY:BATH_TOWEL');
    const report = (quantity: number) =>
      manager1.post(`${INV}/damage`).send({ itemId: towel.id, quantity, fromState: 'AVAILABLE', reason: 'Cháy', requestId: rid() });
    expect((await report(3)).status).toBe(409);
    const ok = await report(1);
    expect((await admin.post(`${INV}/damage/${ok.body.report.id}/review`).send({ decision: 'ACKNOWLEDGE' })).body.report.status).toBe('ACKNOWLEDGED');
    expect((await byKey('QTY:BATH_TOWEL')).balances).toMatchObject({ AVAILABLE: 1, DAMAGED: 1 });
  });
});

/* --------------------------------- K --------------------------------- */

describe('K. who may', () => {
  it('keeps every warehouse to its branch and its managers — the Admin reads all', async () => {
    await stock(5);
    await manager2.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    // The manager reads only its own branch, whatever it names.
    const mine = await items(manager1, `?branchId=${cn2}`);
    expect(mine.every((i) => (i as unknown as { branch: { id: number } }).branch.id === cn1)).toBe(true);
    // The Admin reads every branch, or one.
    const all = (await admin.get(`${INV}/items`)).body.items as { branch: { id: number } }[];
    expect(new Set(all.map((i) => i.branch.id))).toEqual(new Set([cn1, cn2]));
    expect(((await admin.get(`${INV}/items?branchId=${cn2}`)).body.items as { branch: { id: number } }[]).every((i) => i.branch.id === cn2)).toBe(true);
    // A receipt, a transfer, an item: the managers' own — not the Admin's, not Reception, Technical or the workers.
    const towel = await byKey('QTY:BATH_TOWEL');
    for (const agent of [admin, letan1, tech, lan]) {
      expect((await receive([{ itemId: towel.id, quantity: 1 }], 'LINEN', rid(), agent)).status).toBe(403);
    }
    for (const agent of [letan1, tech, lan]) {
      expect((await agent.get(`${INV}/items`)).status).toBe(403);
      expect((await agent.get(`${INV}/damage`)).status).toBe(403);
    }
    // Another branch's item id never moves this branch's stock — or its own.
    expect((await receive([{ itemId: towel.id, quantity: 1 }], 'LINEN', rid(), manager2)).status).toBe(422);
    expect((await manager2.delete(`${INV}/items/${towel.id}`)).status).toBe(404);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(5);
    expect((await request(app).get(`${INV}/items`)).status).toBe(401);
  });
});

/* --------------------------------- L --------------------------------- */

describe('L. keeping the items, and "Xuất Excel"', () => {
  const fileOf = (agent: Agent, url: string) =>
    agent
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('edits an item’s code, unit, threshold and note — "Sắp hết" only once a threshold is set — and lists archived items on request', async () => {
    await stock(5);
    const towel = await byKey('QTY:BATH_TOWEL');
    expect(towel.lowStock).toBe(false);
    const edited = await manager1.patch(`${INV}/items/${towel.id}`).send({ code: 'KT-01', unit: 'chiếc', lowStockThreshold: 5, note: 'Khăn trắng' });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ code: 'KT-01', unit: 'chiếc', lowStockThreshold: 5, lowStock: true, note: 'Khăn trắng' });
    // Another branch's manager edits nothing here.
    expect((await manager2.patch(`${INV}/items/${towel.id}`).send({ note: 'x' })).status).toBe(404);
    // Archived: off the list, on it when asked for.
    expect((await manager1.delete(`${INV}/items/${towel.id}`)).body.archived).toBe(true);
    expect((await items()).some((i) => i.id === towel.id)).toBe(false);
    expect((await items(manager1, '?includeArchived=true')).find((i) => i.id === towel.id)).toMatchObject({ archived: true });
    expect((await manager1.patch(`${INV}/items/${towel.id}`).send({ note: 'y' })).status).toBe(409);
  });

  it('exports the stock, damage reports and count differences of the reader’s scope only', async () => {
    await stock(20);
    await manager2.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    const towel = await byKey('QTY:BATH_TOWEL');
    await manager1.post(`${INV}/damage`).send({ itemId: towel.id, quantity: 2, fromState: 'AVAILABLE', reason: 'Rách', requestId: rid() });
    await manager1.post(`${INV}/counts`).send({
      warehouse: 'LINEN',
      requestId: rid(),
      lines: [{ itemId: towel.id, state: 'AVAILABLE', countedQuantity: 17, reason: 'Mất 1' }],
    });
    const res = await fileOf(manager1, `${INV}/export.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const rows = (name: string) => {
      const out: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
      return out;
    };
    const towelRow = rows('Tồn kho').find((r) => r[2] === 'Khăn tắm')!;
    // Chi nhánh, Kho, Mặt hàng, Mã, Đơn vị, Sẵn dùng, Bẩn, Đang sử dụng (not kept: blank), Hỏng.
    expect(towelRow.slice(0, 9)).toEqual(['05 Trương Định', 'Kho Linens', 'Khăn tắm', '', 'cái', 17, 0, undefined, 2]);
    // CN2's items are not this manager's to read.
    expect(rows('Tồn kho').some((r) => r[0] === '260 Lý Tự Trọng')).toBe(false);
    expect(rows('Báo hỏng')[1]).toEqual(expect.arrayContaining(['Khăn tắm', 2, 'Rách', 'Chờ Admin xem']));
    // The counting differences are the Admin's: no such sheet in the manager's file.
    expect(wb.getWorksheet('Chênh lệch kiểm kho')).toBeUndefined();
    // The Admin's file has every branch, and the differences.
    const adminFile = await fileOf(admin, `${INV}/export.xlsx`);
    const all = new ExcelJS.Workbook();
    await all.xlsx.load(adminFile.body as unknown as Parameters<typeof all.xlsx.load>[0]);
    const diff: unknown[][] = [];
    all.getWorksheet('Chênh lệch kiểm kho')!.eachRow((row) => diff.push((row.values as unknown[]).slice(1)));
    expect(diff[1]).toEqual(expect.arrayContaining(['Khăn tắm', 18, 17, -1, 'Mất 1']));
    const branches = new Set<unknown>();
    all.getWorksheet('Tồn kho')!.eachRow((row, n) => {
      if (n > 1) branches.add((row.values as unknown[])[1]);
    });
    expect([...branches]).toEqual(expect.arrayContaining(['05 Trương Định', '260 Lý Tự Trọng']));
    // Nobody outside housekeeping management.
    for (const agent of [letan1, tech, lan]) expect((await agent.get(`${INV}/export.xlsx`)).status).toBe(403);
  });
});

/* --------------------------------- M --------------------------------- */

describe('M. a damage report’s sources — this branch’s work item or incident, never another’s', () => {
  const incident = async (branchId: number, roomNumber: string | null, over: Record<string, unknown> = {}) =>
    (
      await testPrisma.hotelIssue.create({
        data: {
          branchId,
          areaCategory: roomNumber ? 'ROOM' : 'OTHER_AREA',
          roomNumber,
          locationDetail: roomNumber ? null : 'Kho tầng trệt',
          description: 'Ống nước rò làm ướt khăn',
          reportedByUserId: adminId,
          ...over,
        },
      })
    ).id;
  const workItem = async (roomNumber: string) => {
    const g = await manager1.post('/api/housekeeping/manager/work-groups').send({ workDate: DAY, requestId: rid(), items: [{ areaKind: 'ROOM', roomNumber, taskCodes: ['OUT'] }] });
    expect(g.status).toBe(201);
    return g.body.group.items[0].id as string;
  };
  const report = async (over: Record<string, unknown>, agent: Agent = manager1) => {
    const towel = await byKey('QTY:BATH_TOWEL');
    return agent.post(`${INV}/damage`).send({ itemId: towel.id, quantity: 1, fromState: 'AVAILABLE', reason: 'Ố bẩn', requestId: rid(), ...over });
  };

  it('links a same-branch work item (taking its room) and a same-branch incident, and shows both to the Admin', async () => {
    await stock(10);
    const task = await workItem('102');
    const issue = await incident(cn1, '102');
    // The sources on offer: this branch's, of the room asked for.
    const sources = (await manager1.get(`${INV}/damage/sources?roomNumber=102`)).body;
    expect(sources.tasks.map((t: { id: string }) => t.id)).toEqual([task]);
    expect(sources.issues.map((i: { id: string }) => i.id)).toEqual([issue]);
    const res = await report({ taskId: task, issueId: issue });
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({ roomNumber: '102', taskId: task, issueId: issue });
    const seen = (await admin.get(`${INV}/damage`)).body.reports[0];
    expect(seen.task).toMatchObject({ id: task, roomNumber: '102', label: expect.stringContaining('Phòng 102') });
    expect(seen.issue).toMatchObject({ id: issue, label: expect.stringContaining('Ống nước rò'), statusLabel: expect.any(String) });
    // No source at all is fine too.
    expect((await report({})).status).toBe(201);
  });

  it('refuses another branch’s work item or incident, another room’s, and a deleted incident — moving no stock', async () => {
    await stock(10);
    const task = await workItem('102');
    const otherIssue = await incident(cn2, '102');
    const deleted = await incident(cn1, '102', { voidedAt: new Date() });
    const mineIssue = await incident(cn1, '201');
    await manager2.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    const theirTowel = (await items(manager2)).find((i) => i.catalogKey === 'QTY:BATH_TOWEL')!;
    const cases: [string, () => Promise<{ status: number }>][] = [
      ['other branch’s incident', () => report({ issueId: otherIssue })],
      ['deleted incident', () => report({ issueId: deleted })],
      ['work item of room 102, report of room 103', () => report({ taskId: task, roomNumber: '103' })],
      ['incident of room 201, report of room 102', () => report({ issueId: mineIssue, roomNumber: '102' })],
      [
        'CN1’s work item from CN2’s manager',
        () => manager2.post(`${INV}/damage`).send({ itemId: theirTowel.id, quantity: 1, fromState: 'AVAILABLE', reason: 'x', taskId: task, requestId: rid() }),
      ],
    ];
    for (const [name, call] of cases) expect((await call()).status, name).toBe(422);
    expect(await testPrisma.inventoryDamageReport.count()).toBe(0);
    expect(await balance('QTY:BATH_TOWEL', 'AVAILABLE')).toBe(10);
    // The sources list is this branch's only; the Admin does not report damage.
    expect((await manager2.get(`${INV}/damage/sources`)).body.tasks).toEqual([]);
    expect((await admin.get(`${INV}/damage/sources`)).status).toBe(403);
  });

  it('reverses a rejected report ONCE, however many times it is pressed', async () => {
    await stock(10);
    const r = (await report({ quantity: 3 })).body.report as { id: string };
    const both = await Promise.all([
      admin.post(`${INV}/damage/${r.id}/review`).send({ decision: 'REJECT', note: 'Còn dùng được' }),
      admin.post(`${INV}/damage/${r.id}/review`).send({ decision: 'REJECT', note: 'Còn dùng được' }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await byKey('QTY:BATH_TOWEL')).balances).toMatchObject({ AVAILABLE: 10, DAMAGED: 0 });
    expect(await testPrisma.inventoryMovement.count({ where: { type: 'DAMAGE_REVERSAL' } })).toBe(2);
  });
});

/* --------------------------------- N --------------------------------- */

describe('N. the form → item mapping, explicit', () => {
  const map = (itemId: string, catalogKey: string | null, confirmKit?: boolean, agent: Agent = manager1) =>
    agent.put(`${INV}/items/${itemId}/mapping`).send({ catalogKey, ...(confirmKit === undefined ? {} : { confirmKit }) });
  const make = async (warehouse: string, name: string, extra: Record<string, unknown> = {}) => {
    const res = await manager1.post(`${INV}/items`).send({ warehouse, name, unit: 'bộ', ...extra });
    expect(res.status).toBe(201);
    return res.body.item as Item;
  };

  it('lists every form field with what it does to the stock and the one item it moves', async () => {
    await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'AMENITY' });
    const fields = (await manager1.get(`${INV}/mapping?warehouse=AMENITY`)).body.fields as {
      catalogKey: string;
      field: string;
      meaning: string;
      kit: boolean;
      item: Item | null;
    }[];
    // A grouped replacement is a KIT, created as the kit itself.
    expect(fields.find((f) => f.catalogKey === 'REPLACED:COMB_COTTON_CAP')).toMatchObject({
      field: '✓ Lược, tăm bông, chụp tóc',
      meaning: 'TICK',
      kit: true,
      item: { name: 'Bộ: Lược, tăm bông, chụp tóc' },
    });
    expect(fields.find((f) => f.catalogKey === 'REPLACED:SHAMPOO')).toMatchObject({ kit: false, item: { name: 'Dầu gội' } });
    expect(fields.find((f) => f.catalogKey === 'QTY:WATER')).toMatchObject({ meaning: 'CLEAN_ISSUE', item: { name: 'Nước suối' } });
    // Linen fields are not amenities; the Admin reads one branch at a time.
    expect(fields.some((f) => f.catalogKey.startsWith('LINEN:'))).toBe(false);
    expect((await admin.get(`${INV}/mapping`)).status).toBe(422);
    expect((await admin.get(`${INV}/mapping?branchId=${cn1}&warehouse=AMENITY`)).status).toBe(200);
  });

  it('ties a kit only to a confirmed kit, linen only to its size, a field only to its warehouse — one item per field', async () => {
    const bundle = await make('AMENITY', 'Túi lược và tăm bông');
    expect((await map(bundle.id, 'REPLACED:COMB_COTTON_CAP')).status).toBe(422);
    expect((await map(bundle.id, 'REPLACED:COMB_COTTON_CAP', true)).status).toBe(200);
    const queen = await make('LINEN', 'Ga giường loại mới', { variant: 'Queen', unit: 'cái' });
    const sizeless = await make('LINEN', 'Ga giường khác', { unit: 'cái' });
    expect((await map(queen.id, 'LINEN:BED_SHEET:K')).status).toBe(422);
    expect((await map(sizeless.id, 'LINEN:BED_SHEET:Q')).status).toBe(422);
    expect((await map(queen.id, 'LINEN:BED_SHEET:Q')).status).toBe(200);
    expect((await map(queen.id, 'QTY:WATER')).status).toBe(422);
    expect((await map(queen.id, 'NOT_A_FIELD')).status).toBe(422);
    // One item per field: a second is refused until the first is untied.
    const other = await make('AMENITY', 'Bộ lược khác');
    expect((await map(other.id, 'REPLACED:COMB_COTTON_CAP', true)).status).toBe(409);
    expect((await map(bundle.id, null)).status).toBe(200);
    expect((await map(other.id, 'REPLACED:COMB_COTTON_CAP', true)).status).toBe(200);
    // Another branch's manager ties nothing here.
    expect((await map(other.id, null, undefined, manager2)).status).toBe(404);
  });

  it('deducts a ✓ only through its mapped item — an unmapped ✓ moves nothing — and keeps clean-issued and dirty-collected apart', async () => {
    await stock(10);
    const amenity = async () => items(manager1, '?warehouse=AMENITY');
    const kit = (await amenity()).find((i) => i.catalogKey === 'REPLACED:COMB_COTTON_CAP')!;
    await receive([{ itemId: kit.id, quantity: 5 }], 'AMENITY');
    // Shampoo's field untied: its ✓ stays on the form and moves no stock.
    const shampoo = (await amenity()).find((i) => i.catalogKey === 'REPLACED:SHAMPOO')!;
    expect((await map(shampoo.id, null)).status).toBe(200);
    const room = await cleaning('102');
    expect((await room.complete({ quantities: { BATH_TOWEL: 2 }, collected: { BATH_TOWEL: 1 }, replaced: ['COMB_COTTON_CAP', 'SHAMPOO'] })).status).toBe(200);
    const moves = await movementsOf(room.id);
    expect(moves.map((m) => `${m.item.catalogKey} ${m.type} ${m.state} ${m.delta}`).sort()).toEqual(
      ['QTY:BATH_TOWEL DIRTY_COLLECTED DIRTY 1', 'QTY:BATH_TOWEL ROOM_ISSUE AVAILABLE -2', 'REPLACED:COMB_COTTON_CAP ROOM_ISSUE AVAILABLE -1'].sort(),
    );
    expect((await amenity()).find((i) => i.id === kit.id)!.balances.AVAILABLE).toBe(4);
  });
});

/* --------------------------------- O --------------------------------- */

describe('O. "Khai báo tồn đầu kỳ" — the opening balance, counted once', () => {
  type Opened = Item & { opened: boolean };
  const open = (lines: Record<string, unknown>[], requestId = rid(), agent: Agent = manager1) =>
    agent.post(`${INV}/counts`).send({ warehouse: 'LINEN', opening: true, requestId, lines });

  it('blocks a completion that needs an item whose stock was never set up — saying how to set it up', async () => {
    await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    expect(((await byKey('QTY:BATH_TOWEL')) as Opened).opened).toBe(false);
    const room = await cleaning('102');
    const refused = await room.complete({ quantities: { BATH_TOWEL: 2 } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('Khăn tắm cần 2, còn 0 (Kho Linens, chưa khai báo tồn đầu kỳ)');
    expect(refused.body.error.message).toContain('“Khai báo tồn đầu kỳ”');
    // A room that uses none of the set-up items completes as before.
    const other = await cleaning('103');
    expect((await other.complete({ special: ['DND'] })).status).toBe(200);
  });

  it('sets the opening balance by a counted, audited document — once per item, whatever retries or races', async () => {
    await manager1.post(`${INV}/items/from-catalog`).send({ warehouse: 'LINEN' });
    const towel = await byKey('QTY:BATH_TOWEL');
    const hand = await byKey('QTY:HAND_TOWEL');
    // Not an opening if the system already holds stock — the Admin's book says so, a manager's count is checked against it.
    expect((await admin.post(`${INV}/counts`).send({ branchId: cn1, warehouse: 'LINEN', opening: true, requestId: rid(), lines: [{ itemId: towel.id, state: 'AVAILABLE', systemQuantity: 5, countedQuantity: 20 }] })).status).toBe(422);
    const requestId = rid();
    const lines = [
      { itemId: towel.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 20 },
      { itemId: towel.id, state: 'DIRTY', systemQuantity: 0, countedQuantity: 3 },
      { itemId: hand.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 0 },
    ];
    const first = await open(lines, requestId);
    expect(first.status).toBe(201);
    expect(first.body.count).toMatchObject({ opening: true, note: 'Khai báo tồn đầu kỳ' });
    // The same press again: the same document.
    expect((await open(lines, requestId)).body).toMatchObject({ duplicate: true, count: { id: first.body.count.id } });
    // A second opening of the same item: refused, whatever its key.
    const again = await open([{ itemId: towel.id, state: 'DAMAGED', systemQuantity: 0, countedQuantity: 1 }]);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('đã có tồn đầu kỳ');
    expect((await byKey('QTY:BATH_TOWEL')).balances).toEqual({ AVAILABLE: 20, DIRTY: 3, DAMAGED: 0 });
    // "Đang giặt" is no state of the warehouse any more.
    expect((await open([{ itemId: hand.id, state: 'IN_LAUNDRY', systemQuantity: 0, countedQuantity: 1 }])).status).toBe(422);
    const moves = await testPrisma.inventoryMovement.findMany({ where: { itemId: towel.id } });
    expect(moves.map((m) => `${m.type} ${m.state} ${m.delta} ${m.reason}`).sort()).toEqual(
      ['COUNT_ADJUSTMENT AVAILABLE 20 Tồn đầu kỳ (đếm thực tế)', 'COUNT_ADJUSTMENT DIRTY 3 Tồn đầu kỳ (đếm thực tế)'].sort(),
    );
    // A zero counted is an answer too: the item is set up, with no movement.
    expect(((await byKey('QTY:HAND_TOWEL')) as Opened).opened).toBe(true);
    expect(await testPrisma.inventoryMovement.count({ where: { itemId: hand.id } })).toBe(0);
    // Two openings racing for one item: one wins.
    const mat = await byKey('QTY:BATH_MAT');
    const race = await Promise.all([
      open([{ itemId: mat.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 4 }]),
      open([{ itemId: mat.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 4 }]),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await byKey('QTY:BATH_MAT')).balances.AVAILABLE).toBe(4);
    // Set up: the room completes.
    const room = await cleaning('102');
    expect((await room.complete({ quantities: { BATH_TOWEL: 2 }, collected: { BATH_TOWEL: 2 } })).status).toBe(200);
    expect((await byKey('QTY:BATH_TOWEL')).balances).toMatchObject({ AVAILABLE: 18, DIRTY: 5 });
  });
});
