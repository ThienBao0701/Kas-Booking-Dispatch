/**
 * HOUSEKEEPING "KHO HÀNG" — Kho hóa chất & dụng cụ (1), Đồ dùng cho khách (2),
 * Kho đồ vải (3), Kho đồ dùng khác / Đồ tiêu hao (4).
 *
 *   A  items: by name only, coded by the server (3.001 …), never reused, archived when used
 *   B  "Lưu phiếu nhập": many lines, all or none, once per request
 *   C  the room-cleaning list: chosen per branch, in order, the only items a form may count
 *   D  "Hoàn thành" takes the counts out of the on-hand stock — once, never dirty
 *   E  a shortage refuses the completion whole; two completions racing for the last pieces
 *   F  the Quản lý buồng phòng's own cleaning needs no review
 *   G  tomorrow's work: its own day, accepted today, worked tomorrow
 *   H  "Kiểm kho": recorded vs counted, a reason for a difference, never stale
 *   I  no laundry, no transfers in the four warehouses; legacy balances flagged, not merged
 *   J  "Báo hỏng": out of the usable stock at once, the Admin told once, rejected by reversal
 *   K  who may: branch scope and roles, on every request
 *   L  editing, and "Xuất Excel"
 *   M  a damage report's sources
 *   N  classifying an item of the former equipment warehouse
 *   O  "Khai báo tồn đầu kỳ"
 *   P  the Admin's shared catalog, the branch's own items, and receipts for several branches
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

type Item = {
  id: string;
  name: string;
  code: string | null;
  scope: 'SYSTEM' | 'BRANCH';
  warehouse: string;
  label: string;
  balances: Record<string, number>;
  legacyBalances: { state: string; quantity: number }[];
  unclassified: boolean;
  cleaningOrder: number | null;
  archived: boolean;
  lowStock: boolean;
  opened: boolean;
};

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
const byName = async (name: string, agent: Agent = manager1) => (await items(agent, '?includeArchived=true')).find((i) => i.name === name)!;
const balance = async (name: string, state: string) => (await byName(name)).balances[state];
const receive = (lines: { itemId: string; quantity: number }[], warehouse = 'LINEN', requestId = rid(), agent: Agent = manager1) =>
  agent.post(`${INV}/receipts`).send({ warehouse, requestId, reference: 'PN-01', lines });
const create = async (warehouse: string, names: string[], agent: Agent = manager1) => {
  const res = await agent.post(`${INV}/items/batch`).send({ warehouse, items: names.map((name) => ({ name })) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.items as Item[];
};
const setList = (itemIds: string[], agent: Agent = manager1, extra: Record<string, unknown> = {}) => agent.put(`${INV}/cleaning-items`).send({ itemIds, ...extra });

/** CN1 keeps towels (Kho đồ vải) and water (Đồ tiêu hao) on its room-cleaning list, with some received. */
async function stock(towels: number, water = 0) {
  const [towel] = await create('LINEN', ['Khăn tắm']);
  const [bottle] = await create('AMENITY', ['Nước suối']);
  expect((await setList([towel!.id, bottle!.id])).status).toBe(200);
  if (towels > 0) expect((await receive([{ itemId: towel!.id, quantity: towels }])).status).toBe(201);
  if (water > 0) expect((await receive([{ itemId: bottle!.id, quantity: water }], 'AMENITY')).status).toBe(201);
  return { towel: towel!, water: bottle! };
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
  return {
    id: task.id,
    url,
    complete: (form: Record<string, unknown>) => worker.post(`${url}/complete`).send(form),
    save: (form: Record<string, unknown>) => worker.put(`${url}/cleaning`).send(form),
  };
}

const movementsOf = (taskId: string) => testPrisma.inventoryMovement.findMany({ where: { taskId }, include: { item: true }, orderBy: [{ state: 'asc' }] });

/* --------------------------------- A --------------------------------- */

describe('A. items — by name, coded by the server', () => {
  it('creates several items at once from their names alone: unit "cái", stock 0, codes 1.001 … per warehouse and branch', async () => {
    const chem = await create('CHEMICAL_TOOLS', ['Nước lau sàn', 'Chổi']);
    expect(chem.map((i) => [i.name, i.code, i.warehouse])).toEqual([
      ['Nước lau sàn', '1.001', 'CHEMICAL_TOOLS'],
      ['Chổi', '1.002', 'CHEMICAL_TOOLS'],
    ]);
    expect(chem[0]).toMatchObject({ unclassified: false, cleaningOrder: null, balances: { AVAILABLE: 0, DAMAGED: 0 } });
    expect((await create('GUEST_SUPPLIES', ['Dép']))[0]!.code).toBe('2.001');
    expect((await create('LINEN', ['Khăn tắm']))[0]!.code).toBe('3.001');
    expect((await create('AMENITY', ['Bàn chải']))[0]!.code).toBe('4.001');
    // One numbering for the system: another branch's next item is the next number, never a second 1.001.
    expect((await create('CHEMICAL_TOOLS', ['Nước lau kính'], manager2))[0]!.code).toBe('1.003');
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
    // A hand-typed code is not taken: the server's is.
    const typed = await manager1.post(`${INV}/items/batch`).send({ warehouse: 'LINEN', items: [{ name: 'Khăn tay', code: 'X-9' }] });
    expect(typed.body.items[0].code).toBe('3.002');
    // The former equipment warehouse takes no new item.
    expect((await manager1.post(`${INV}/items/batch`).send({ warehouse: 'EQUIPMENT', items: [{ name: 'Xô' }] })).status).toBe(422);
  });

  it('saves all or none: a blank name or a repeated one saves nothing and spends no code', async () => {
    for (const bad of [[{ name: 'Gối' }, { name: '  ' }], [{ name: 'Gối' }, { name: 'gối' }], []]) {
      expect((await manager1.post(`${INV}/items/batch`).send({ warehouse: 'LINEN', items: bad })).status, JSON.stringify(bad)).toBe(422);
    }
    await create('LINEN', ['Gối']);
    // The same name again in the warehouse: refused, nothing saved — and the next code is still the next.
    const again = await manager1.post(`${INV}/items/batch`).send({ warehouse: 'LINEN', items: [{ name: 'Chăn' }, { name: 'gối' }] });
    expect(again.status).toBe(409);
    expect((await items(manager1, '?warehouse=LINEN')).map((i) => i.name)).toEqual(['Gối']);
    expect((await create('LINEN', ['Chăn']))[0]!.code).toBe('3.002');
  });

  it('gives every concurrent create its own code — unique, in sequence, never reused, past 999', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => manager1.post(`${INV}/items/batch`).send({ warehouse: 'LINEN', items: [{ name: `Khăn ${i}` }] })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.items[0].code as string).sort();
    expect(codes).toEqual(['3.001', '3.002', '3.003', '3.004', '3.005', '3.006', '3.007', '3.008']);
    // A removed (never used) item's code is not given again.
    const last = (await byName('Khăn 7'))!;
    expect((await manager1.delete(`${INV}/items/${last.id}`)).body.removed).toBe(true);
    expect((await create('LINEN', ['Khăn mới']))[0]!.code).toBe('3.009');
    // Past 999 the number simply grows.
    await testPrisma.inventoryGlobalCodeSequence.update({ where: { warehouse: 'LINEN' }, data: { lastNumber: 999 } });
    expect((await create('LINEN', ['Khăn 1000']))[0]!.code).toBe('3.1000');
  });

  it('removes a never-used item, only archives a used one, and keeps the code out of the workers’ view', async () => {
    const [mop, bucket] = await create('CHEMICAL_TOOLS', ['Cây lau nhà', 'Xô']);
    expect((await manager1.delete(`${INV}/items/${bucket!.id}`)).body).toEqual({ removed: true, archived: false });
    expect((await receive([{ itemId: mop!.id, quantity: 3 }], 'CHEMICAL_TOOLS')).status).toBe(201);
    expect((await manager1.delete(`${INV}/items/${mop!.id}`)).body).toEqual({ removed: false, archived: true });
    expect(await testPrisma.inventoryMovement.count({ where: { itemId: mop!.id } })).toBe(1);
    const refused = await receive([{ itemId: mop!.id, quantity: 1 }], 'CHEMICAL_TOOLS');
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain('ngừng sử dụng');
    // Its name is free again — with a new code.
    expect((await create('CHEMICAL_TOOLS', ['Cây lau nhà']))[0]!.code).toBe('1.003');
  });
});

/* --------------------------------- B --------------------------------- */

describe('B. "Lưu phiếu nhập"', () => {
  it('receives many items in one receipt — once, whatever retries', async () => {
    const [towel, sheet, pillow] = await create('LINEN', ['Khăn tắm', 'Ga giường King', 'Vỏ gối']);
    const requestId = rid();
    const lines = [
      { itemId: towel!.id, quantity: 20 },
      { itemId: sheet!.id, quantity: 5 },
      { itemId: pillow!.id, quantity: 7 },
    ];
    const first = await receive(lines, 'LINEN', requestId);
    expect(first.status).toBe(201);
    expect(first.body.receipt.lines).toHaveLength(3);
    const again = await receive(lines, 'LINEN', requestId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, receipt: { id: first.body.receipt.id } });
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(20);
    expect(await balance('Ga giường King', 'AVAILABLE')).toBe(5);
    expect(await balance('Vỏ gối', 'AVAILABLE')).toBe(7);
    expect(await testPrisma.inventoryReceipt.count()).toBe(1);
  });

  it('saves nothing when one line is wrong — a repeated item, a zero, another branch’s item or another warehouse', async () => {
    const [towel, hand] = await create('LINEN', ['Khăn tắm', 'Khăn tay']);
    const [theirs] = await create('LINEN', ['Khăn tắm'], manager2);
    for (const bad of [
      [{ itemId: towel!.id, quantity: 2 }, { itemId: towel!.id, quantity: 3 }],
      [{ itemId: towel!.id, quantity: 2 }, { itemId: hand!.id, quantity: 0 }],
      [{ itemId: towel!.id, quantity: 2 }, { itemId: theirs!.id, quantity: 3 }],
      [],
    ]) {
      expect((await receive(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await receive([{ itemId: towel!.id, quantity: 2 }], 'AMENITY')).status).toBe(422);
    expect(await testPrisma.inventoryReceipt.count()).toBe(0);
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
  });
});

/* --------------------------------- C --------------------------------- */

describe('C. the room-cleaning list', () => {
  it('is chosen per branch, in order, from the four warehouses — and the worker’s form loads exactly it, with no codes', async () => {
    const [soap] = await create('CHEMICAL_TOOLS', ['Nước tẩy']);
    const [towel] = await create('LINEN', ['Khăn tắm']);
    const [water] = await create('AMENITY', ['Nước suối']);
    await receive([{ itemId: towel!.id, quantity: 4 }]);
    // Water first, then the towel; soap stays off the list.
    const saved = await setList([water!.id, towel!.id]);
    expect(saved.status).toBe(200);
    const listed = saved.body.items as { id: string; code: string; cleaningOrder: number | null }[];
    expect(listed.find((i) => i.id === water!.id)).toMatchObject({ code: '4.001', cleaningOrder: 1 });
    expect(listed.find((i) => i.id === towel!.id)).toMatchObject({ code: '3.001', cleaningOrder: 2 });
    expect(listed.find((i) => i.id === soap!.id)).toMatchObject({ cleaningOrder: null });
    // The manager's own list again: the same.
    const own = (await manager1.get(`${INV}/cleaning-items`)).body.items as { id: string; cleaningOrder: number | null }[];
    expect(
      own
        .filter((i) => i.cleaningOrder)
        .sort((a, b) => a.cleaningOrder! - b.cleaningOrder!)
        .map((i) => i.id),
    ).toEqual([water!.id, towel!.id]);
    // The worker's room: the same list, in order, with what is on hand — never a code.
    const room = await cleaning('101');
    const form = await lan.get(`${room.url}/cleaning-items`);
    expect(form.status).toBe(200);
    expect(form.body.items).toEqual([
      { id: water!.id, label: 'Nước suối', unit: 'cái', warehouse: 'AMENITY', available: 0 },
      { id: towel!.id, label: 'Khăn tắm', unit: 'cái', warehouse: 'LINEN', available: 4 },
    ]);
    expect(JSON.stringify(form.body)).not.toContain('4.001');
    // The manager's form loads the same.
    expect((await manager1.get(`${room.url}/cleaning-items`)).body.items.map((i: { id: string }) => i.id)).toEqual([water!.id, towel!.id]);
    // Another worker's room is not Hoa's to read.
    await startShiftAt(hoa, cn1);
    expect((await hoa.get(`${room.url}/cleaning-items`)).status).toBe(403);
  });

  it('is the manager’s and the Admin’s to set — the Admin per branch, nobody else, nothing from another branch', async () => {
    const [towel] = await create('LINEN', ['Khăn tắm']);
    const [theirs] = await create('LINEN', ['Khăn tắm'], manager2);
    for (const agent of [lan, letan1, tech]) expect((await setList([towel!.id], agent)).status).toBe(403);
    expect((await setList([theirs!.id])).status).toBe(422);
    expect((await setList([towel!.id, towel!.id])).status).toBe(422);
    // The Admin names the branch.
    expect((await setList([towel!.id], admin)).status).toBe(422);
    expect((await setList([towel!.id], admin, { branchId: cn1 })).status).toBe(200);
    expect((await admin.get(`${INV}/cleaning-items?branchId=${cn1}`)).body.items[0]).toMatchObject({ id: towel!.id, cleaningOrder: 1 });
    // A manager cannot reach another branch's list by naming it.
    expect((await manager2.get(`${INV}/cleaning-items?branchId=${cn1}`)).body.branchId).toBe(cn2);
    // An empty list clears it.
    expect((await setList([])).status).toBe(200);
    expect((await byName('Khăn tắm')).cleaningOrder).toBeNull();
  });

  it('refuses, from the API, a count for an item off the list — the form cannot be bypassed', async () => {
    const { towel } = await stock(10);
    const [other] = await create('LINEN', ['Khăn tay']);
    await receive([{ itemId: other!.id, quantity: 10 }]);
    const room = await cleaning('101');
    const res = await room.complete({ items: { [other!.id]: 1 } });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('danh sách dọn phòng');
    expect((await room.save({ items: { [other!.id]: 1 } })).status).toBe(422);
    expect((await room.complete({ items: { [towel.id]: -1 } })).status).toBe(422);
    expect(await balance('Khăn tay', 'AVAILABLE')).toBe(10);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: room.id } })).state).toBe('IN_PROGRESS');
  });
});

/* --------------------------------- D --------------------------------- */

describe('D. "Hoàn thành" takes the counts out of the on-hand stock', () => {
  it('room 102: 2 towels and 2 bottles — on hand 20 → 18 and 10 → 8, traced to the room; nothing dirty, nothing at "Lưu tạm"', async () => {
    const { towel, water } = await stock(20, 10);
    const room = await cleaning('102');
    // "Lưu tạm" moves nothing.
    expect((await room.save({ items: { [towel.id]: 2, [water.id]: 2 }, special: ['DND'], note: 'Khách để đồ' })).status).toBe(200);
    expect(await movementsOf(room.id)).toHaveLength(0);
    setClock({ now: () => hcm(DAY, '09:00') });
    const done = await room.complete({ items: { [towel.id]: 2, [water.id]: 2 }, special: ['DND'], note: 'Khách để đồ' });
    expect(done.status).toBe(200);
    expect(done.body.task.phase).toBe('COMPLETED');
    expect(done.body.task.cleaning).toMatchObject({
      items: [expect.objectContaining({ itemId: towel.id, label: 'Khăn tắm', quantity: 2 }), expect.objectContaining({ itemId: water.id, quantity: 2 })],
      special: ['DND'],
      note: 'Khách để đồ',
    });
    expect((await byName('Khăn tắm')).balances).toEqual({ AVAILABLE: 18, DAMAGED: 0 });
    expect((await byName('Nước suối')).balances).toEqual({ AVAILABLE: 8, DAMAGED: 0 });
    const moves = await movementsOf(room.id);
    expect(moves.map((m) => `${m.item.name} ${m.type} ${m.state} ${m.delta}`).sort()).toEqual(['Khăn tắm ROOM_ISSUE AVAILABLE -2', 'Nước suối ROOM_ISSUE AVAILABLE -2']);
    expect(moves[0]).toMatchObject({ roomNumber: '102', workDate: DAY, actorNameSnapshot: 'Chị Lan' });
    expect(await testPrisma.inventoryMovement.count({ where: { state: 'DIRTY' } })).toBe(0);
    expect(await testPrisma.inventoryBalance.count({ where: { state: 'DIRTY' } })).toBe(0);
  });

  it('never moves the stock twice — a double "Hoàn thành" is one completion', async () => {
    const { towel } = await stock(20);
    const room = await cleaning('102');
    const form = { items: { [towel.id]: 2 } };
    const both = await Promise.all([room.complete(form), room.complete(form)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await room.complete(form)).status).toBe(409);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(18);
    expect(await movementsOf(room.id)).toHaveLength(1);
  });

  it('completes a room with nothing counted, moving nothing', async () => {
    await stock(5);
    const room = await cleaning('103');
    expect((await room.complete({ special: ['DND'] })).status).toBe(200);
    expect(await movementsOf(room.id)).toHaveLength(0);
  });
});

/* --------------------------------- E --------------------------------- */

describe('E. a shortage, and a race', () => {
  it('refuses the whole completion when the stock is short — the task and every balance untouched — in Vietnamese', async () => {
    const { towel, water } = await stock(1, 5);
    const room = await cleaning('102');
    const form = { items: { [towel.id]: 2, [water.id]: 1 } };
    const res = await room.complete(form);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Không đủ tồn kho để hoàn thành: Khăn tắm cần 2, còn 1');
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: room.id } })).state).toBe('IN_PROGRESS');
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(1);
    expect(await balance('Nước suối', 'AVAILABLE')).toBe(5);
    expect(await movementsOf(room.id)).toHaveLength(0);
    // Stock received, the same press works.
    await receive([{ itemId: towel.id, quantity: 5 }]);
    expect((await room.complete(form)).status).toBe(200);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(4);
  });

  it('lets exactly one of two completions take the last towels — the stock never goes below zero', async () => {
    const { towel } = await stock(2);
    const a = await cleaning('101', lan);
    const b = await cleaning('102', hoa);
    const form = { items: { [towel.id]: 2 } };
    const results = await Promise.all([a.complete(form), b.complete(form)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(0);
    const rows = await testPrisma.inventoryBalance.findMany();
    expect(rows.every((r) => r.quantity >= 0)).toBe(true);
  });
});

/* --------------------------------- F --------------------------------- */

describe('F. the Quản lý buồng phòng cleans a room itself', () => {
  it('needs no review of its own work — recorded "Đạt" by itself — and moves the stock like anyone’s', async () => {
    const { towel } = await stock(10);
    const room = await cleaning('101', manager1);
    expect((await room.complete({ items: { [towel.id]: 2 } })).status).toBe(200);
    const t = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: room.id } });
    expect(t).toMatchObject({ state: 'COMPLETED', reviewResult: 'PASSED', cleanedByNameSnapshot: 'QL qlbp1', reviewedByNameSnapshot: 'QL qlbp1' });
    const events = await testPrisma.housekeepingRoomTaskEvent.findMany({ where: { taskId: room.id, type: 'REVIEWED' } });
    expect(events.map((e) => e.detail)).toEqual([expect.objectContaining({ selfCleaned: true, result: 'PASSED' })]);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(8);
    const other = await cleaning('102', lan);
    expect((await other.complete({})).status).toBe(200);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: other.id } })).reviewResult).toBeNull();
  });
});

/* --------------------------------- G --------------------------------- */

describe('G. tomorrow’s work', () => {
  it('stays on its own day — accepted today, never worked before its day — and a room is still held once per day', async () => {
    const createGroup = (workDate: string) =>
      manager1.post('/api/housekeeping/manager/work-groups').send({ workDate, requestId: rid(), items: [{ areaKind: 'ROOM', roomNumber: '201', taskCodes: ['OUT'] }] });
    const tomorrow = await createGroup(TOMORROW);
    expect(tomorrow.status).toBe(201);
    expect((await createGroup(TOMORROW)).status).toBe(409);
    expect((await createGroup(DAY)).status).toBe(201);
    await startShiftAt(lan, cn1);
    const today = (await lan.get(`/api/housekeeping/work/groups?date=${DAY}`)).body.groups as { id: string }[];
    expect(today.map((g) => g.id)).not.toContain(tomorrow.body.group.id);
    const next = (await lan.get(`/api/housekeeping/work/groups?date=${TOMORROW}`)).body.groups as { id: string }[];
    expect(next.map((g) => g.id)).toEqual([tomorrow.body.group.id]);
    expect((await lan.post(`/api/housekeeping/work/groups/${tomorrow.body.group.id}/accept`).send({})).status).toBe(200);
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
    const { towel } = await stock(18);
    const line = { itemId: towel.id, state: 'AVAILABLE', systemQuantity: 18, countedQuantity: 17 };
    expect((await count([line], admin)).status).toBe(422);
    const noReason = await count([line], admin, { branchId: cn1 });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toContain('lý do chênh lệch');
    expect((await count([{ ...line, systemQuantity: 20, reason: 'Mất 1' }], admin, { branchId: cn1 })).status).toBe(409);
    // "Bẩn" is no state of the four warehouses.
    expect((await count([{ itemId: towel.id, state: 'DIRTY', systemQuantity: 0, countedQuantity: 0 }], admin, { branchId: cn1 })).status).toBe(422);
    const ok = await count([{ ...line, reason: 'Mất 1 khăn' }, { itemId: towel.id, state: 'DAMAGED', systemQuantity: 0, countedQuantity: 0 }], admin, { branchId: cn1 });
    expect(ok.status).toBe(201);
    expect(ok.body.count.lines.map((l: { systemQuantity: number; difference: number }) => [l.systemQuantity, l.difference])).toEqual([
      [18, -1],
      [0, 0],
    ]);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(17);
    const adj = await testPrisma.inventoryMovement.findMany({ where: { type: 'COUNT_ADJUSTMENT' } });
    expect(adj.map((m) => [m.state, m.delta, m.reason])).toEqual([['AVAILABLE', -1, 'Mất 1 khăn']]);
    const listed = (await admin.get(`${INV}/counts?onlyDifferences=true`)).body.counts as { lines: { difference: number }[] }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.lines[0]).toMatchObject({ systemQuantity: 18, countedQuantity: 17, difference: -1 });
    expect((await admin.get(`${INV}/counts?branchId=${cn2}`)).body.counts).toEqual([]);
  });

  it('the Quản lý buồng phòng counts blind — never shown the book or the difference — and still gives the reason', async () => {
    const { towel } = await stock(18);
    const line = { itemId: towel.id, state: 'AVAILABLE', systemQuantity: 999, countedQuantity: 17 };
    const noReason = await count([line]);
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toContain('khác sổ sách');
    expect(noReason.body.error.message).not.toMatch(/18|-1/);
    const ok = await count([{ ...line, reason: 'Mất 1 khăn' }, { itemId: towel.id, state: 'DAMAGED', countedQuantity: 0 }]);
    expect(ok.status).toBe(201);
    for (const l of ok.body.count.lines) {
      expect(l).not.toHaveProperty('systemQuantity');
      expect(l).not.toHaveProperty('difference');
    }
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(17);
    const mine = (await manager1.get(`${INV}/counts`)).body.counts as { lines: Record<string, unknown>[] }[];
    expect(JSON.stringify(mine)).not.toContain('difference');
    expect(((await manager1.get(`${INV}/movements`)).body.movements as { type: string }[]).some((m) => m.type === 'COUNT_ADJUSTMENT')).toBe(false);
    expect((await count([{ itemId: towel.id, state: 'AVAILABLE', countedQuantity: 16, reason: 'x' }], manager2)).status).toBe(422);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(17);
  });
});

/* --------------------------------- I --------------------------------- */

describe('I. one on-hand figure', () => {
  it('has no laundry and no transfers in the four warehouses — fresh stock is a receipt', async () => {
    const { towel } = await stock(20);
    const move = (kind: string) => manager1.post(`${INV}/transfers`).send({ kind, requestId: rid(), lines: [{ itemId: towel.id, quantity: 1 }] });
    for (const kind of ['LAUNDRY_RETURN', 'LAUNDRY_SEND', 'STOCK_ISSUE', 'STOCK_RETURN']) expect((await move(kind)).status, kind).toBe(422);
    expect(await testPrisma.inventoryTransfer.count()).toBe(0);
    expect((await receive([{ itemId: towel.id, quantity: 5 }])).status).toBe(201);
    expect((await byName('Khăn tắm')).balances).toEqual({ AVAILABLE: 25, DAMAGED: 0 });
  });

  it('flags a legacy dirty balance for review — never added to the on-hand figure, never spent by a room', async () => {
    const { towel } = await stock(3);
    // A dirty balance from before: kept on its own row, as the migration left it.
    await testPrisma.inventoryBalance.create({ data: { itemId: towel.id, state: 'DIRTY', quantity: 4 } });
    const item = await byName('Khăn tắm');
    expect(item.balances).toEqual({ AVAILABLE: 3, DAMAGED: 0 });
    expect(item.legacyBalances).toEqual([expect.objectContaining({ state: 'DIRTY', quantity: 4 })]);
    const room = await cleaning('102');
    expect((await room.complete({ items: { [towel.id]: 5 } })).status).toBe(409);
    expect((await room.complete({ items: { [towel.id]: 3 } })).status).toBe(200);
    expect((await testPrisma.inventoryBalance.findMany({ where: { itemId: towel.id }, orderBy: { state: 'asc' } })).map((b) => [b.state, b.quantity])).toEqual([
      ['AVAILABLE', 0],
      ['DIRTY', 4],
    ]);
  });
});

/* --------------------------------- J --------------------------------- */

describe('J. "Báo hỏng / Không thể tái sử dụng"', () => {
  it('takes the quantity out of the usable stock at once, tells the Admin once, and is reversed — never deleted — when rejected', async () => {
    const { towel } = await stock(20);
    const requestId = rid();
    const body = { itemId: towel.id, quantity: 3, fromState: 'AVAILABLE', reason: 'Rách, ố màu không giặt được', roomNumber: '102', requestId };
    const first = await manager1.post(`${INV}/damage`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.report).toMatchObject({ status: 'PENDING', quantity: 3, label: 'Khăn tắm', roomNumber: '102', reportedBy: { name: 'QL qlbp1' } });
    expect((await manager1.post(`${INV}/damage`).send(body)).body).toMatchObject({ duplicate: true, report: { id: first.body.report.id } });
    expect((await byName('Khăn tắm')).balances).toMatchObject({ AVAILABLE: 17, DAMAGED: 3 });
    const notes = await testPrisma.notification.findMany({ where: { userId: adminId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Báo hỏng đồ buồng phòng', link: `/app/inventory?damage=${first.body.report.id}` });
    expect(notes[0]!.body).toContain('Khăn tắm: 3 cái');
    expect((await admin.get(`${INV}/damage?status=PENDING`)).body.reports.map((r: { id: string }) => r.id)).toEqual([first.body.report.id]);
    expect((await manager2.get(`${INV}/damage`)).body.reports).toEqual([]);
    expect((await manager1.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT', note: 'x' })).status).toBe(403);
    expect((await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT' })).status).toBe(422);
    const rejected = await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'REJECT', note: 'Còn dùng được' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.report).toMatchObject({ status: 'REJECTED', reviewedBy: { id: adminId }, reviewNote: 'Còn dùng được' });
    expect((await byName('Khăn tắm')).balances).toMatchObject({ AVAILABLE: 20, DAMAGED: 0 });
    expect((await admin.post(`${INV}/damage/${first.body.report.id}/review`).send({ decision: 'ACKNOWLEDGE' })).status).toBe(409);
  });

  it('keeps an acknowledged write-off out of the usable stock, and refuses more than there is', async () => {
    const { towel } = await stock(2);
    const report = (quantity: number) => manager1.post(`${INV}/damage`).send({ itemId: towel.id, quantity, fromState: 'AVAILABLE', reason: 'Cháy', requestId: rid() });
    expect((await report(3)).status).toBe(409);
    const ok = await report(1);
    expect((await admin.post(`${INV}/damage/${ok.body.report.id}/review`).send({ decision: 'ACKNOWLEDGE' })).body.report.status).toBe('ACKNOWLEDGED');
    expect((await byName('Khăn tắm')).balances).toMatchObject({ AVAILABLE: 1, DAMAGED: 1 });
  });
});

/* --------------------------------- K --------------------------------- */

describe('K. who may', () => {
  it('keeps every warehouse to its branch and its managers — the Admin reads all; workers see no code anywhere', async () => {
    const { towel } = await stock(5);
    await create('LINEN', ['Khăn tắm'], manager2);
    const mine = await items(manager1, `?branchId=${cn2}`);
    expect(mine.every((i) => (i as unknown as { branch: { id: number } }).branch.id === cn1)).toBe(true);
    const all = (await admin.get(`${INV}/items`)).body.items as { branch: { id: number }; code: string }[];
    expect(new Set(all.map((i) => i.branch.id))).toEqual(new Set([cn1, cn2]));
    // The managers and the Admin see the codes.
    expect(all.every((i) => /^\d\.\d{3,}$/.test(i.code))).toBe(true);
    for (const agent of [admin, letan1, tech, lan]) {
      expect((await receive([{ itemId: towel.id, quantity: 1 }], 'LINEN', rid(), agent)).status).toBe(403);
    }
    // New items: the managers' (their branch's) and the Admin's (shared, P) — nobody else's.
    for (const agent of [letan1, tech, lan]) {
      expect((await agent.post(`${INV}/items/batch`).send({ warehouse: 'LINEN', items: [{ name: 'X' }] })).status).toBe(403);
    }
    for (const agent of [letan1, tech, lan]) {
      expect((await agent.get(`${INV}/items`)).status).toBe(403);
      expect((await agent.get(`${INV}/cleaning-items`)).status).toBe(403);
      expect((await agent.get(`${INV}/damage`)).status).toBe(403);
    }
    expect((await receive([{ itemId: towel.id, quantity: 1 }], 'LINEN', rid(), manager2)).status).toBe(422);
    expect((await manager2.delete(`${INV}/items/${towel.id}`)).status).toBe(404);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(5);
    expect((await request(app).get(`${INV}/items`)).status).toBe(401);
  });
});

/* --------------------------------- L --------------------------------- */

describe('L. editing, and "Xuất Excel"', () => {
  const fileOf = (agent: Agent, url: string) =>
    agent
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('edits the unit, threshold and note — never the code — and lists archived items on request', async () => {
    const { towel } = await stock(5);
    expect(towel.lowStock).toBe(false);
    const edited = await manager1.patch(`${INV}/items/${towel.id}`).send({ code: 'KT-01', unit: 'chiếc', lowStockThreshold: 5, note: 'Khăn trắng' });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ code: '3.001', unit: 'chiếc', lowStockThreshold: 5, lowStock: true, note: 'Khăn trắng' });
    expect((await manager2.patch(`${INV}/items/${towel.id}`).send({ note: 'x' })).status).toBe(404);
    expect((await manager1.delete(`${INV}/items/${towel.id}`)).body.archived).toBe(true);
    expect((await items()).some((i) => i.id === towel.id)).toBe(false);
    expect((await items(manager1, '?includeArchived=true')).find((i) => i.id === towel.id)).toMatchObject({ archived: true });
    expect((await manager1.patch(`${INV}/items/${towel.id}`).send({ note: 'y' })).status).toBe(409);
    // An item of the four warehouses is not moved to another.
    const [soap] = await create('CHEMICAL_TOOLS', ['Nước tẩy']);
    expect((await manager1.patch(`${INV}/items/${soap!.id}`).send({ warehouse: 'LINEN' })).status).toBe(409);
  });

  it('exports the stock, damage reports and count differences of the reader’s scope only, with the codes', async () => {
    const { towel } = await stock(20);
    await create('LINEN', ['Khăn tắm'], manager2);
    await manager1.post(`${INV}/damage`).send({ itemId: towel.id, quantity: 2, fromState: 'AVAILABLE', reason: 'Rách', requestId: rid() });
    await manager1.post(`${INV}/counts`).send({ warehouse: 'LINEN', requestId: rid(), lines: [{ itemId: towel.id, state: 'AVAILABLE', countedQuantity: 17, reason: 'Mất 1' }] });
    const res = await fileOf(manager1, `${INV}/export.xlsx`);
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const rows = (name: string) => {
      const out: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
      return out;
    };
    const towelRow = rows('Tồn kho').find((r) => r[2] === 'Khăn tắm')!;
    // Chi nhánh, Kho, Mặt hàng, Mã, Đơn vị, Sẵn dùng, (Bẩn and Đang sử dụng: not kept), Hỏng.
    expect(towelRow.slice(0, 9)).toEqual(['05 Trương Định', 'Kho đồ vải', 'Khăn tắm', '3.001', 'cái', 17, undefined, undefined, 2]);
    expect(rows('Tồn kho').some((r) => r[0] === '260 Lý Tự Trọng')).toBe(false);
    expect(rows('Báo hỏng')[1]).toEqual(expect.arrayContaining(['Khăn tắm', 2, 'Rách', 'Chờ Admin xem']));
    expect(wb.getWorksheet('Chênh lệch kiểm kho')).toBeUndefined();
    const adminFile = await fileOf(admin, `${INV}/export.xlsx`);
    const all = new ExcelJS.Workbook();
    await all.xlsx.load(adminFile.body as unknown as Parameters<typeof all.xlsx.load>[0]);
    const diff: unknown[][] = [];
    all.getWorksheet('Chênh lệch kiểm kho')!.eachRow((row) => diff.push((row.values as unknown[]).slice(1)));
    expect(diff[1]).toEqual(expect.arrayContaining(['Khăn tắm', 18, 17, -1, 'Mất 1']));
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
    const towel = await byName('Khăn tắm');
    return agent.post(`${INV}/damage`).send({ itemId: towel.id, quantity: 1, fromState: 'AVAILABLE', reason: 'Ố bẩn', requestId: rid(), ...over });
  };

  it('links a same-branch work item and a same-branch incident, and shows both to the Admin', async () => {
    await stock(10);
    const task = await workItem('102');
    const issue = await incident(cn1, '102');
    const sources = (await manager1.get(`${INV}/damage/sources?roomNumber=102`)).body;
    expect(sources.tasks.map((t: { id: string }) => t.id)).toEqual([task]);
    expect(sources.issues.map((i: { id: string }) => i.id)).toEqual([issue]);
    const res = await report({ taskId: task, issueId: issue });
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({ roomNumber: '102', taskId: task, issueId: issue });
    const seen = (await admin.get(`${INV}/damage`)).body.reports[0];
    expect(seen.task).toMatchObject({ id: task, roomNumber: '102' });
    expect(seen.issue).toMatchObject({ id: issue });
    expect((await report({})).status).toBe(201);
  });

  it('refuses another branch’s work item or incident, another room’s, and a deleted incident — moving no stock', async () => {
    await stock(10);
    const task = await workItem('102');
    const otherIssue = await incident(cn2, '102');
    const deleted = await incident(cn1, '102', { voidedAt: new Date() });
    const mineIssue = await incident(cn1, '201');
    const [theirTowel] = await create('LINEN', ['Khăn tắm'], manager2);
    const cases: [string, () => Promise<{ status: number }>][] = [
      ['other branch’s incident', () => report({ issueId: otherIssue })],
      ['deleted incident', () => report({ issueId: deleted })],
      ['work item of room 102, report of room 103', () => report({ taskId: task, roomNumber: '103' })],
      ['incident of room 201, report of room 102', () => report({ issueId: mineIssue, roomNumber: '102' })],
      ['CN1’s work item from CN2’s manager', () => manager2.post(`${INV}/damage`).send({ itemId: theirTowel!.id, quantity: 1, fromState: 'AVAILABLE', reason: 'x', taskId: task, requestId: rid() })],
    ];
    for (const [name, call] of cases) expect((await call()).status, name).toBe(422);
    expect(await testPrisma.inventoryDamageReport.count()).toBe(0);
    expect(await balance('Khăn tắm', 'AVAILABLE')).toBe(10);
  });
});

/* --------------------------------- N --------------------------------- */

describe('N. classifying an item of the former equipment warehouse', () => {
  const legacy = async (name: string, balances: Record<string, number> = {}) => {
    const item = await testPrisma.inventoryItem.create({
      data: { branchId: cn1, warehouse: 'EQUIPMENT', name, variant: '', unit: 'cái', createdByUserId: adminId, createdByNameSnapshot: 'Hệ thống', note: 'Mã cũ: TB-01' },
    });
    for (const [state, quantity] of Object.entries(balances)) await testPrisma.inventoryBalance.create({ data: { itemId: item.id, state: state as never, quantity } });
    return item.id;
  };

  it('lists it as waiting, never lost; moves it into one of the four with its stock and a new code — once', async () => {
    const id = await legacy('Máy hút bụi', { AVAILABLE: 2 });
    const waiting = (await items(manager1, '?warehouse=EQUIPMENT')).find((i) => i.id === id)!;
    expect(waiting).toMatchObject({ unclassified: true, code: null, balances: { AVAILABLE: 2 } });
    // Not on the room-cleaning list until classified.
    expect((await setList([id])).status).toBe(422);
    const moved = await manager1.patch(`${INV}/items/${id}`).send({ warehouse: 'CHEMICAL_TOOLS' });
    expect(moved.status).toBe(200);
    expect(moved.body.item).toMatchObject({ warehouse: 'CHEMICAL_TOOLS', code: '1.001', unclassified: false, balances: { AVAILABLE: 2, DAMAGED: 0 } });
    expect((await manager1.patch(`${INV}/items/${id}`).send({ warehouse: 'LINEN' })).status).toBe(409);
    expect((await manager2.patch(`${INV}/items/${id}`).send({ warehouse: 'LINEN' })).status).toBe(404);
  });

  it('refuses while pieces are still "Đang sử dụng" — a "Thu hồi" first', async () => {
    const id = await legacy('Bàn là', { AVAILABLE: 1, ISSUED: 2 });
    const refused = await manager1.patch(`${INV}/items/${id}`).send({ warehouse: 'GUEST_SUPPLIES' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('Đang sử dụng');
    expect((await manager1.post(`${INV}/transfers`).send({ kind: 'STOCK_RETURN', requestId: rid(), lines: [{ itemId: id, quantity: 2 }] })).status).toBe(201);
    const ok = await manager1.patch(`${INV}/items/${id}`).send({ warehouse: 'GUEST_SUPPLIES' });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ code: '2.001', balances: { AVAILABLE: 3, DAMAGED: 0 } });
  });
});

/* --------------------------------- O --------------------------------- */

describe('O. "Khai báo tồn đầu kỳ" — the opening balance, counted once', () => {
  const open = (lines: Record<string, unknown>[], requestId = rid(), agent: Agent = manager1) =>
    agent.post(`${INV}/counts`).send({ warehouse: 'LINEN', opening: true, requestId, lines });

  it('sets the opening balance by a counted, audited document — once per item, whatever retries or races', async () => {
    const [towel, hand, mat] = await create('LINEN', ['Khăn tắm', 'Khăn tay', 'Thảm chân']);
    expect((await byName('Khăn tắm')).opened).toBe(false);
    const requestId = rid();
    const lines = [
      { itemId: towel!.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 20 },
      { itemId: towel!.id, state: 'DAMAGED', systemQuantity: 0, countedQuantity: 3 },
      { itemId: hand!.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 0 },
    ];
    const first = await open(lines, requestId);
    expect(first.status).toBe(201);
    expect(first.body.count).toMatchObject({ opening: true, note: 'Khai báo tồn đầu kỳ' });
    expect((await open(lines, requestId)).body).toMatchObject({ duplicate: true, count: { id: first.body.count.id } });
    const again = await open([{ itemId: towel!.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 1 }]);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('đã có tồn đầu kỳ');
    expect((await byName('Khăn tắm')).balances).toEqual({ AVAILABLE: 20, DAMAGED: 3 });
    expect((await byName('Khăn tay')).opened).toBe(true);
    const race = await Promise.all([
      open([{ itemId: mat!.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 4 }]),
      open([{ itemId: mat!.id, state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 4 }]),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await byName('Thảm chân')).balances.AVAILABLE).toBe(4);
    // Set up and on the list: the room completes.
    await setList([towel!.id]);
    const room = await cleaning('102');
    expect((await room.complete({ items: { [towel!.id]: 2 } })).status).toBe(200);
    expect((await byName('Khăn tắm')).balances).toEqual({ AVAILABLE: 18, DAMAGED: 3 });
  });
});

/* --------------------------------- P --------------------------------- */

describe('P. the Admin’s shared catalog and the branch’s own items', () => {
  const shared = (names: string[], warehouse = 'LINEN', agent: Agent = admin) => agent.post(`${INV}/items/batch`).send({ warehouse, items: names.map((name) => ({ name })) });
  const activeBranches = () => testPrisma.branch.count({ where: { active: true } });

  it('creates a shared item once — a row in every active branch, one code, scope SYSTEM — and no stock anywhere', async () => {
    const res = await shared(['Khăn tắm', 'Khăn mặt']);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.items.map((i: Item) => [i.name, i.code, i.scope])).toEqual([
      ['Khăn tắm', '3.001', 'SYSTEM'],
      ['Khăn mặt', '3.002', 'SYSTEM'],
    ]);
    const rows = await testPrisma.inventoryItem.findMany({ where: { code: '3.001' } });
    expect(rows).toHaveLength(await activeBranches());
    expect(new Set(rows.map((r) => r.branchId)).size).toBe(rows.length);
    expect(rows.every((r) => r.scope === 'SYSTEM' && r.name === 'Khăn tắm')).toBe(true);
    // Creating it receives nothing.
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
    expect(await testPrisma.inventoryBalance.count()).toBe(0);
    // Each branch sees it once — as a shared item.
    for (const agent of [manager1, manager2]) {
      const towels = (await items(agent, '?warehouse=LINEN')).filter((i) => i.name === 'Khăn tắm');
      expect(towels).toHaveLength(1);
      expect(towels[0]).toMatchObject({ code: '3.001', scope: 'SYSTEM', balances: { AVAILABLE: 0, DAMAGED: 0 } });
    }
    // Only the Admin makes shared items; the manager's are its branch's.
    const local = await create('LINEN', ['Khăn lau kính']);
    expect(local[0]).toMatchObject({ code: '3.003', scope: 'BRANCH' });
    expect((await items(manager2, '?warehouse=LINEN')).some((i) => i.name === 'Khăn lau kính')).toBe(false);
    // A worker, Reception or Technical make neither.
    for (const agent of [lan, letan1, tech]) expect((await shared(['X'], 'LINEN', agent)).status).toBe(403);
  });

  it('never merges names: a branch’s own item of that name refuses the shared one — nothing saved', async () => {
    await create('LINEN', ['Ga giường'], manager2);
    const res = await shared(['Gối', 'ga giường']);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('260 Lý Tự Trọng');
    expect(await testPrisma.inventoryItem.count({ where: { scope: 'SYSTEM' } })).toBe(0);
    expect((await shared(['Gối', 'gối'])).status).toBe(422);
  });

  it('lets the branch receive, count and set its own threshold on a shared item — never remove it, rename it or change its unit', async () => {
    await shared(['Khăn tắm']);
    const towel = (await items(manager1, '?warehouse=LINEN'))[0]!;
    expect((await receive([{ itemId: towel.id, quantity: 7 }])).status).toBe(201);
    expect((await manager1.patch(`${INV}/items/${towel.id}`).send({ unit: 'cái', lowStockThreshold: 3, note: 'Tầng 2' })).status).toBe(200);
    expect((await manager1.patch(`${INV}/items/${towel.id}`).send({ unit: 'chiếc' })).status).toBe(403);
    expect((await manager1.delete(`${INV}/items/${towel.id}`)).status).toBe(403);
    // Its stock is this branch's alone.
    const theirs = (await items(manager2, '?warehouse=LINEN'))[0]!;
    expect(theirs.balances.AVAILABLE).toBe(0);
    expect((await byName('Khăn tắm')).balances.AVAILABLE).toBe(7);
    // The Admin removes it: unused rows go, the used one is archived with its history.
    expect((await admin.delete(`${INV}/items/${towel.id}`)).body).toEqual({ removed: false, archived: true });
    const left = await testPrisma.inventoryItem.findMany({ where: { code: '3.001' } });
    expect(left.map((r) => [r.branchId, r.archivedAt !== null])).toEqual([[cn1, true]]);
    expect(await testPrisma.inventoryMovement.count({ where: { itemId: towel.id } })).toBe(1);
  });

  it('receives for several branches at once — each its own quantities, all or none, once per request', async () => {
    await shared(['Khăn tắm', 'Khăn mặt']);
    const at = async (agent: Agent) => Object.fromEntries((await items(agent, '?warehouse=LINEN')).map((i) => [i.name, i.id]));
    const one = await at(manager1);
    const two = await at(manager2);
    const requestId = rid();
    const body = {
      warehouse: 'LINEN',
      requestId,
      reference: 'PN-TONG-01',
      branches: [
        { branchId: cn1, lines: [{ itemId: one['Khăn tắm'], quantity: 5 }, { itemId: one['Khăn mặt'], quantity: 2 }] },
        { branchId: cn2, lines: [{ itemId: two['Khăn tắm'], quantity: 3 }] },
      ],
    };
    const res = await admin.post(`${INV}/receipts/multi`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.receipts).toHaveLength(2);
    expect((await byName('Khăn tắm')).balances.AVAILABLE).toBe(5);
    expect((await byName('Khăn mặt')).balances.AVAILABLE).toBe(2);
    expect((await items(manager2, '?warehouse=LINEN')).find((i) => i.name === 'Khăn tắm')!.balances.AVAILABLE).toBe(3);
    // No other branch received anything.
    expect(await testPrisma.inventoryBalance.count({ where: { quantity: { gt: 0 } } })).toBe(3);
    // The same request again: the same receipts.
    const again = await admin.post(`${INV}/receipts/multi`).send(body);
    expect(again.body.duplicate).toBe(true);
    expect(await testPrisma.inventoryReceipt.count()).toBe(2);
    // One wrong line — another branch's item — saves nothing.
    const wrong = await admin.post(`${INV}/receipts/multi`).send({ ...body, requestId: rid(), branches: [{ branchId: cn1, lines: [{ itemId: one['Khăn tắm'], quantity: 1 }] }, { branchId: cn2, lines: [{ itemId: one['Khăn mặt'], quantity: 1 }] }] });
    expect(wrong.status).toBe(422);
    expect(await testPrisma.inventoryReceipt.count()).toBe(2);
    // Only the Admin.
    expect((await manager1.post(`${INV}/receipts/multi`).send({ ...body, requestId: rid() })).status).toBe(403);
    expect((await admin.post(`${INV}/receipts/multi`).send({ ...body, requestId: rid(), branches: [] })).status).toBe(422);
  });
});

describe('Q. a receipt naming new items — created and received in one save', () => {
  const shared = (names: string[], warehouse = 'LINEN', agent: Agent = admin) => agent.post(`${INV}/items/batch`).send({ warehouse, items: names.map((name) => ({ name })) });
  const activeBranches = () => testPrisma.branch.count({ where: { active: true } });
  const receiveNew = (body: Record<string, unknown>, agent: Agent = manager1) => agent.post(`${INV}/receipts`).send({ warehouse: 'LINEN', requestId: rid(), lines: [], ...body });
  const nothingSaved = async () => {
    expect(await testPrisma.inventoryReceipt.count()).toBe(0);
    expect(await testPrisma.inventoryMovement.count()).toBe(0);
  };

  it('the manager: ticked items and several new ones in ONE receipt — the new ones its branch’s own, coded by the server — once, whatever retries', async () => {
    const [towel] = await create('LINEN', ['Khăn tắm']);
    const requestId = rid();
    const body = { requestId, lines: [{ itemId: towel!.id, quantity: 4 }], newItems: [{ name: 'Gối ôm', quantity: 6 }, { name: 'Khăn mặt', quantity: 10 }] };
    const res = await receiveNew(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.receipt.lines.map((l: { label: string; quantity: number }) => [l.label, l.quantity])).toEqual([
      ['Khăn tắm', 4],
      ['Gối ôm', 6],
      ['Khăn mặt', 10],
    ]);
    const mine = (await items(manager1, '?warehouse=LINEN')).sort((x, y) => x.code!.localeCompare(y.code!));
    expect(mine.map((i) => [i.name, i.code, i.scope, i.balances.AVAILABLE])).toEqual([
      ['Khăn tắm', '3.001', 'BRANCH', 4],
      ['Gối ôm', '3.002', 'BRANCH', 6],
      ['Khăn mặt', '3.003', 'BRANCH', 10],
    ]);
    // Another branch sees none of them.
    expect(await items(manager2, '?warehouse=LINEN')).toEqual([]);
    // The same request again — or twice at once: no second item, no second piece of stock.
    const again = await Promise.all([receiveNew(body), receiveNew(body)]);
    expect(again.map((r) => r.body.duplicate)).toEqual([true, true]);
    expect(await testPrisma.inventoryItem.count()).toBe(3);
    expect(await testPrisma.inventoryReceipt.count()).toBe(1);
    expect(await testPrisma.inventoryMovement.count()).toBe(3);
    // The receipt carries no note of its own.
    expect((await testPrisma.inventoryReceipt.findFirstOrThrow()).note).toBeNull();
  });

  it('two identical first submissions racing: one receipt, the new item created once', async () => {
    const body = { requestId: rid(), newItems: [{ name: 'Gối ôm', quantity: 2 }] };
    const both = await Promise.all([receiveNew(body), receiveNew(body)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await testPrisma.inventoryItem.count({ where: { name: 'Gối ôm' } })).toBe(1);
    expect(await balance('Gối ôm', 'AVAILABLE')).toBe(2);
    // The losing attempt spent no code.
    expect((await create('LINEN', ['Chăn']))[0]!.code).toBe('3.002');
  });

  it('saves nothing when any part is wrong — no item, no code spent, no stock', async () => {
    const [towel] = await create('LINEN', ['Khăn tắm']);
    const ok = { name: 'Gối ôm', quantity: 2 };
    for (const bad of [
      { newItems: [ok, { name: '  ', quantity: 1 }] },
      { newItems: [ok, { name: 'Chăn', quantity: 0 }] },
      { newItems: [ok, { name: 'Chăn', quantity: 1.5 }] },
      { newItems: [ok, { name: 'Chăn' }] },
      { newItems: [ok, { name: 'gối ÔM', quantity: 1 }] },
      { newItems: [ok], lines: [{ itemId: towel!.id, quantity: 0 }] },
      { newItems: [ok], lines: [{ itemId: 'no-such-item', quantity: 1 }] },
      { newItems: [ok], warehouse: 'NOPE' },
      { newItems: [] },
    ]) {
      const res = await receiveNew(bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    await nothingSaved();
    expect((await items(manager1, '?warehouse=LINEN')).map((i) => i.name)).toEqual(['Khăn tắm']);
    expect((await create('LINEN', ['Chăn']))[0]!.code).toBe('3.002');
  });

  it('never creates a name already in use — it names the existing item for the screen to take — and never merges', async () => {
    const [towel] = await create('LINEN', ['Khăn tắm']);
    const res = await receiveNew({ newItems: [{ name: 'Gối', quantity: 1 }, { name: ' khăn TẮM ', quantity: 3 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('3.001 Khăn tắm');
    expect(res.body.error.details).toMatchObject({ existingItemId: towel!.id, code: '3.001' });
    await nothingSaved();
    expect(await testPrisma.inventoryItem.count()).toBe(1);
    // Another branch's own item of that name is not this branch's: its own is created.
    await create('LINEN', ['Ga giường'], manager2);
    expect((await receiveNew({ newItems: [{ name: 'Ga giường', quantity: 2 }] })).status).toBe(201);
    expect(await testPrisma.inventoryItem.count({ where: { name: 'Ga giường' } })).toBe(2);
  });

  it('keeps the manager to its own branch — a branch named in the body is ignored — and gives other roles nothing new', async () => {
    const res = await receiveNew({ branchId: cn2, newItems: [{ name: 'Gối ôm', quantity: 2 }] });
    expect(res.status).toBe(201);
    const row = await testPrisma.inventoryItem.findFirstOrThrow({ where: { name: 'Gối ôm' } });
    expect([row.branchId, row.scope]).toEqual([cn1, 'BRANCH']);
    expect(await items(manager2, '?warehouse=LINEN')).toEqual([]);
    // The several-branch receipt is the Admin's alone.
    const multi = { warehouse: 'LINEN', requestId: rid(), branches: [{ branchId: cn2, lines: [] }], newItems: [{ name: 'Chăn', quantities: [{ branchId: cn2, quantity: 1 }] }] };
    expect((await manager1.post(`${INV}/receipts/multi`).send(multi)).status).toBe(403);
    for (const agent of [lan, letan1, tech]) expect((await receiveNew({ newItems: [{ name: 'Chăn', quantity: 1 }] }, agent)).status).toBe(403);
    expect(await testPrisma.inventoryItem.count({ where: { name: 'Chăn' } })).toBe(0);
  });

  it('the Admin: a new item joins the shared catalog in every branch — stock only where a quantity was given — once per request', async () => {
    await shared(['Khăn tắm']);
    const towel1 = (await items(manager1, '?warehouse=LINEN'))[0]!;
    const body = {
      warehouse: 'LINEN',
      requestId: rid(),
      branches: [
        { branchId: cn1, lines: [{ itemId: towel1.id, quantity: 5 }] },
        { branchId: cn2, lines: [] },
      ],
      newItems: [
        { name: 'Gối ôm', quantities: [{ branchId: cn2, quantity: 6 }] },
        { name: 'Dép', quantities: [{ branchId: cn1, quantity: 2 }, { branchId: cn2, quantity: 3 }] },
      ],
    };
    const res = await admin.post(`${INV}/receipts/multi`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.receipts).toHaveLength(2);
    for (const [name, code] of [
      ['Gối ôm', '3.002'],
      ['Dép', '3.003'],
    ]) {
      const rows = await testPrisma.inventoryItem.findMany({ where: { name } });
      expect(rows).toHaveLength(await activeBranches());
      expect(rows.every((r) => r.scope === 'SYSTEM' && r.code === code)).toBe(true);
    }
    const stockOf = async (agent: Agent) => Object.fromEntries((await items(agent, '?warehouse=LINEN')).map((i) => [i.name, i.balances.AVAILABLE]));
    expect(await stockOf(manager1)).toEqual({ 'Khăn tắm': 5, 'Gối ôm': 0, Dép: 2 });
    expect(await stockOf(manager2)).toEqual({ 'Khăn tắm': 0, 'Gối ôm': 6, Dép: 3 });
    // No branch outside the receipt holds any stock.
    expect(await testPrisma.inventoryBalance.count({ where: { quantity: { gt: 0 }, item: { branchId: { notIn: [cn1, cn2] } } } })).toBe(0);
    // Again: the same receipts, nothing created twice.
    const again = await admin.post(`${INV}/receipts/multi`).send(body);
    expect(again.body.duplicate).toBe(true);
    expect(await testPrisma.inventoryItem.count({ where: { name: 'Gối ôm' } })).toBe(await activeBranches());
    expect(await testPrisma.inventoryMovement.count()).toBe(4);
  });

  it('the Admin: refuses the whole receipt for a wrong part — nothing created, nothing received', async () => {
    await create('LINEN', ['Ga giường'], manager2);
    const base = { warehouse: 'LINEN', branches: [{ branchId: cn1, lines: [] }] };
    const cases: [number, Record<string, unknown>][] = [
      [422, { newItems: [{ name: 'Gối ôm', quantities: [{ branchId: cn2, quantity: 1 }] }] }],
      [422, { newItems: [{ name: 'Gối ôm', quantities: [] }] }],
      [422, { newItems: [{ name: 'Gối ôm', quantities: [{ branchId: cn1, quantity: 0 }] }] }],
      [422, { newItems: [{ name: 'Gối ôm', quantities: [{ branchId: cn1, quantity: 1 }, { branchId: cn1, quantity: 2 }] }] }],
      [422, { branches: [{ branchId: cn1, lines: [] }, { branchId: cn2, lines: [] }], newItems: [{ name: 'Gối ôm', quantities: [{ branchId: cn1, quantity: 1 }] }] }],
      [422, {}],
      // Any branch's active item of that name — even a branch outside the receipt.
      [409, { newItems: [{ name: 'ga GIƯỜNG', quantities: [{ branchId: cn1, quantity: 1 }] }] }],
    ];
    for (const [status, bad] of cases) {
      const res = await admin.post(`${INV}/receipts/multi`).send({ ...base, requestId: rid(), ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(status);
    }
    await nothingSaved();
    expect(await testPrisma.inventoryItem.count({ where: { scope: 'SYSTEM' } })).toBe(0);
  });

  it('codes new items racing from several receipts uniquely and in sequence', async () => {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => receiveNew({ newItems: [{ name: `Mới ${i}`, quantity: 1 }] }, manager1)),
      ...Array.from({ length: 3 }, (_, i) => receiveNew({ newItems: [{ name: `Khác ${i}`, quantity: 1 }] }, manager2)),
      admin.post(`${INV}/receipts/multi`).send({ warehouse: 'LINEN', requestId: rid(), branches: [{ branchId: cn1, lines: [] }], newItems: [{ name: 'Chung', quantities: [{ branchId: cn1, quantity: 1 }] }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const codes = [...new Set((await testPrisma.inventoryItem.findMany({ select: { code: true } })).map((r) => r.code))].sort();
    expect(codes).toEqual(['3.001', '3.002', '3.003', '3.004', '3.005', '3.006', '3.007', '3.008']);
  });
});
