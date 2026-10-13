/**
 * "TẠO CÔNG VIỆC", "VÀO CA" BY ADDRESS, "NHẬN", AND "GIAO LẠI" — the
 * housekeeping work order rules, each pinned at the API:
 *
 *   1. "Chọn khu vực" is the branch's own inventory: its floors and rooms, the
 *      rooms whose floor cannot be read under "Phòng chưa xác định tầng", and
 *      the shared areas.
 *   2. One submission saves one row PER ITEM; a shared area and "Khác" need
 *      their note; a repeated submission creates nothing twice.
 *   3. "Vào ca" takes a typed address. The answer never names a branch that is
 *      not the account's: too little is "nhập thêm", another hotel's address
 *      and nonsense get the SAME refusal; the attempts are bounded.
 *   4. Before "Vào ca" there is no list. After it, "Nhận" takes exactly the
 *      selected items, all or none, never two owners; it starts nothing.
 *   5. "Kiểm tra" → "Chờ dọn phòng" → "Dọn phòng" → "Hoàn thành", per item.
 *   6. "Giao lại" in "Chờ dọn phòng": Admin, Quản lý buồng phòng and Quản lý lễ
 *      tân, in their branches, to a housekeeper of the item's branch — never
 *      once the cleaning has begun; kept in the item's history.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { addressOf } from './helpers/workplace';
import { UNPLACED_LABEL, workAreasFor } from '../src/housekeeping/workAreas';
import {
  WORKPLACE_AMBIGUOUS,
  WORKPLACE_NOT_FOUND,
  WORKPLACE_REQUIRED,
  normalizeAddress,
  resolveWorkplace,
} from '../src/housekeeping/workplaceAddress';
import request from 'supertest';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-07';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let manager1: Agent;
let receptionManager: Agent;
let general: Agent;
let tech: Agent;
let lan: Agent;
let hoa: Agent;
let mai: Agent;
let lanId = 0;
let hoaId = 0;
let maiId = 0;

type Task = {
  id: string;
  branchId: number;
  roomNumber: string;
  areaKind: string;
  areaLabel: string;
  floor: string | null;
  statusCode: string;
  taskName: string | null;
  taskLabel: string;
  note: string | null;
  state: string;
  phase: string;
  assignee: { id: number; name: string } | null;
  acceptedAt: string | null;
  inspectionStartedAt: string | null;
  inspectedAt: string | null;
  inspectionNote: string | null;
  startedAt: string | null;
};

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  for (const [username, role, body] of [
    ['qlbp1', 'HOUSEKEEPING_MANAGER', { branchId: cn1 }],
    ['quanly1', 'RECEPTION_MANAGER', { branchIds: [cn1] }],
  ] as const) {
    const res = await admin.post('/api/admin/users').send({ username, fullName: `QL ${username}`, temporaryPassword: PASSWORD, role, ...body });
    expect(res.status).toBe(201);
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  manager1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  receptionManager = (await loginAgent(app, 'quanly1', PASSWORD)).agent;
  await createUser({ username: 'tongql', password: PASSWORD, fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER' });
  general = (await loginAgent(app, 'tongql', PASSWORD)).agent;
  await createUser({ username: 'kythuat', password: PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  tech = (await loginAgent(app, 'kythuat', PASSWORD)).agent;

  lanId = (await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  hoaId = (await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING', branchId: cn1 })).id;
  maiId = (await createUser({ username: 'mai', password: PASSWORD, fullName: 'Chị Mai', role: 'HOUSEKEEPING', branchId: cn2 })).id;
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
  mai = (await loginAgent(app, 'mai', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  setClock({ now: () => hcm(DAY, '08:00') });
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

const create = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}, agent: Agent = manager1) =>
  agent.post('/api/housekeeping/manager/work-items').send({ workDate: DAY, items, ...extra });

async function created(items: Record<string, unknown>[], extra: Record<string, unknown> = {}, agent: Agent = manager1): Promise<Task[]> {
  const res = await create(items, extra, agent);
  expect(res.status).toBe(201);
  return res.body.tasks as Task[];
}

async function onShift(agent: Agent, branchId: number) {
  const res = await agent.post('/api/housekeeping/shift/start').send({ address: await addressOf(branchId) });
  expect(res.status).toBe(201);
}

const workItems = async (agent: Agent) => (await agent.get(`/api/housekeeping/work/items?date=${DAY}`)).body as { working: boolean; tasks: Task[] };
const claim = (agent: Agent, taskIds: string[]) => agent.post('/api/housekeeping/work/claim').send({ taskIds });
const url = (id: string) => `/api/housekeeping/work/tasks/${id}`;
const eventsOf = (taskId: string) => testPrisma.housekeepingRoomTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });

const ROOM_502 = { areaKind: 'ROOM', roomNumber: '502', taskCode: 'OC' };
const HALL_5 = { areaKind: 'HALLWAY', floor: '5', taskName: 'Hút bụi thảm', note: 'Thảm trước phòng 502' };

/** A room item taken by `agent` and inspected: "Chờ dọn phòng". */
async function awaitingCleaning(agent: Agent = lan, room = '502'): Promise<Task> {
  const [task] = await created([{ areaKind: 'ROOM', roomNumber: room, taskCode: 'OUT' }]);
  await onShift(agent, cn1);
  expect((await claim(agent, [task!.id])).status).toBe(200);
  const inspected = await agent.post(`${url(task!.id)}/inspect`).send({ issues: [] });
  expect(inspected.status).toBe(201);
  expect(inspected.body.task.phase).toBe('AWAITING_CLEANING');
  return inspected.body.task as Task;
}

describe('1. "Chọn khu vực" — the branch’s own inventory', () => {
  it('groups rooms by the floor read from the number, only when that floor exists', () => {
    const cn1Areas = workAreasFor('TRUONG_DINH_05');
    expect(cn1Areas.floors.map((f) => f.floor)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(cn1Areas.floors.find((f) => f.floor === '5')!.rooms.sort()).toEqual(['501', '502']);
    expect(cn1Areas.floors[0]!.label).toBe('Tầng 1');
    expect(cn1Areas.unplacedRooms).toEqual([]);
    expect(cn1Areas.sharedAreas.map((a) => a.kind)).toEqual(['HALLWAY', 'STAIRCASE', 'OTHER']);
    expect(cn1Areas.roomTaskCodes.map((c) => c.code)).toEqual(['OUT', 'OC', 'VC', 'OTHER']);

    // "001" has no floor 0: it is listed, not guessed.
    const cn5 = workAreasFor('LE_THANH_TON_278');
    expect(cn5.unplacedRooms).toEqual(['001']);
    expect(cn5.unplacedLabel).toBe(UNPLACED_LABEL);
    // Chi nhánh 4's floors name their building: no room is placed by a guess.
    const cn4 = workAreasFor('NGUYEN_THAI_BINH_170');
    expect(cn4.floors.map((f) => f.label)).toContain('Tầng 2 (Khu Suite)');
    expect(cn4.floors.every((f) => f.rooms.length === 0)).toBe(true);
    expect(cn4.unplacedRooms).toContain('502');
    // A branch with no catalog says so.
    expect(workAreasFor('NO_SUCH_BRANCH')).toMatchObject({ hasRoomCatalog: false, hasFloorCatalog: false, floors: [], unplacedRooms: [] });
  });

  it('serves the manager its branch only, the Admin any, and nobody else', async () => {
    const own = await manager1.get('/api/housekeeping/manager/areas');
    expect(own.status).toBe(200);
    expect(own.body.areas.branchId).toBe(cn1);
    expect((await manager1.get(`/api/housekeeping/manager/areas?branchId=${cn2}`)).status).toBe(403);
    const other = await admin.get(`/api/housekeeping/manager/areas?branchId=${cn2}`);
    expect(other.status).toBe(200);
    expect(other.body.areas.floors).toHaveLength(8);
    expect((await lan.get('/api/housekeeping/manager/areas')).status).toBe(403);
    expect((await letan1.get('/api/housekeeping/manager/areas')).status).toBe(403);
  });
});

describe('2. "Tạo công việc" — one row per item', () => {
  it('saves one item', async () => {
    const [task, ...rest] = await created([{ ...ROOM_502, priority: true, note: 'Khách về sớm' }]);
    expect(rest).toEqual([]);
    expect(task).toMatchObject({
      branchId: cn1,
      roomNumber: '502',
      areaKind: 'ROOM',
      areaLabel: 'Phòng - 502',
      floor: '5',
      statusCode: 'OC',
      phase: 'UNCLAIMED',
      assignee: null,
      note: 'Khách về sớm',
    });
    const events = await eventsOf(task!.id);
    expect(events.map((e) => e.type)).toEqual(['CREATED']);
  });

  it('saves several items of one submission, each its own row — two of one room included', async () => {
    const tasks = await created([
      ROOM_502,
      { areaKind: 'ROOM', roomNumber: '502', taskCode: 'OTHER', note: 'Thay rèm cửa sổ' },
      HALL_5,
      { areaKind: 'STAIRCASE', floor: '3', taskName: 'Lau tay vịn', note: 'Từ tầng 3 xuống tầng 2' },
      { areaKind: 'OTHER', taskName: 'Dọn sân thượng', note: 'Sân thượng, gom rác' },
    ]);
    expect(tasks.map((t) => [t.areaLabel, t.taskLabel])).toEqual([
      ['Phòng - 502', 'OC'],
      ['Phòng - 502', 'Khác'],
      ['Hành lang - Tầng 5', 'Hút bụi thảm'],
      ['Cầu thang - Tầng 3', 'Lau tay vịn'],
      ['Khác', 'Dọn sân thượng'],
    ].map(([a, l]) => [a, expect.stringContaining(l!)]));
    expect(new Set(tasks.map((t) => t.id)).size).toBe(5);
    expect(await testPrisma.housekeepingRoomTask.count({ where: { branchId: cn1, workDate: DAY } })).toBe(5);
    expect(tasks[2]).toMatchObject({ areaKind: 'HALLWAY', floor: '5', note: 'Thảm trước phòng 502' });
  });

  it('requires the note of a shared area and of "Khác", and refuses what the branch does not have', async () => {
    for (const [item, message] of [
      [{ areaKind: 'HALLWAY', floor: '5', taskName: 'Hút bụi' }, 'cần ghi chú'],
      [{ areaKind: 'STAIRCASE', floor: '2', taskName: 'Lau', note: '   ' }, 'cần ghi chú'],
      [{ areaKind: 'OTHER', taskName: 'Dọn kho' }, 'cần ghi chú'],
      [{ areaKind: 'ROOM', roomNumber: '502', taskCode: 'OTHER' }, 'cần ghi chú'],
      [{ areaKind: 'HALLWAY', taskName: 'Hút bụi', note: 'x' }, 'chọn tầng'],
      [{ areaKind: 'HALLWAY', floor: '9', taskName: 'Hút bụi', note: 'x' }, 'Tầng 9 không thuộc'],
      [{ areaKind: 'HALLWAY', floor: '5', note: 'x' }, 'tên công việc'],
      [{ areaKind: 'ROOM', roomNumber: '999', taskCode: 'OC' }, 'không thuộc chi nhánh'],
      [{ areaKind: 'ROOM', roomNumber: '502' }, 'việc cần làm'],
      [{ areaKind: 'ROOM' }, 'chọn phòng'],
      [{ areaKind: 'ROOF', note: 'x' }, 'khu vực không hợp lệ'],
    ] as const) {
      const res = await create([ROOM_502, item]);
      expect(res.status, JSON.stringify(item)).toBe(422);
      // The catalog's own refusals name the room or floor; the rest name the item.
      if (!message.includes('không thuộc')) expect(res.body.error.message).toContain('Công việc 2');
      expect(res.body.error.message).toContain(message);
    }
    // Nothing of a refused submission is saved — not even its valid item.
    expect(await testPrisma.housekeepingRoomTask.count()).toBe(0);
    expect((await create([])).status).toBe(422);
  });

  it('creates nothing twice: the same submission again, or the same room code while open', async () => {
    const requestId = 'f3b8c2a0-1111-4222-8333-944445555666';
    const first = await create([ROOM_502, HALL_5], { requestId });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(2);
    const again = await create([ROOM_502, HALL_5], { requestId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: 0, duplicate: true });
    expect(again.body.tasks.map((t: Task) => t.id)).toEqual(first.body.tasks.map((t: Task) => t.id));
    // A double click racing itself saves one group.
    const raceId = 'a1b2c3d4-0000-4000-8000-000000000001';
    const [r1, r2] = await Promise.all([create([HALL_5], { requestId: raceId }), create([HALL_5], { requestId: raceId })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(await testPrisma.housekeepingRoomTask.count({ where: { groupId: raceId } })).toBe(1);

    const twice = await create([ROOM_502]);
    expect(twice.status).toBe(409);
    expect(twice.body.error.message).toContain('Phòng 502 · OC');
    const sameSubmission = await create([{ areaKind: 'ROOM', roomNumber: '301', taskCode: 'VC' }, { areaKind: 'ROOM', roomNumber: '301', taskCode: 'VC' }]);
    expect(sameSubmission.status).toBe(422);
  });

  it('is the manager’s at its branch and the Admin’s anywhere — nobody else’s', async () => {
    expect((await create([ROOM_502], { branchId: cn2 })).status).toBe(403);
    expect((await create([{ areaKind: 'ROOM', roomNumber: '802', taskCode: 'VC' }], { branchId: cn2 }, admin)).status).toBe(201);
    for (const agent of [lan, letan1, receptionManager, tech]) {
      expect((await create([ROOM_502], {}, agent)).status).toBe(403);
    }
  });
});

describe('3. "Vào ca" names the hotel by its address — and learns nothing else', () => {
  it('resolves an address by word-start, without case, diacritics or punctuation', () => {
    const branches = BRANCHES.map((b, i) => ({ id: i + 1, address: b.address }));
    const id = (code: string) => BRANCHES.findIndex((b) => b.code === code) + 1;
    const ntb = id('NGUYEN_THAI_BINH_170');
    expect(normalizeAddress('170-172-174 Nguyễn Thái Bình')).toBe('170 172 174 nguyen thai binh');
    expect(resolveWorkplace('1', branches, ntb)).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('Bùi Thị Xuân', branches, id('BUI_THI_XUAN_13'))).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('17', branches, ntb)).toEqual({ status: 'RESOLVED', branchId: ntb });
    expect(resolveWorkplace('NGUYEN THAI', branches, ntb)).toEqual({ status: 'RESOLVED', branchId: ntb });
    expect(resolveWorkplace('uyen thai', branches, ntb)).toEqual({ status: 'NONE' });
    // One fit that is not the account's hotel reads exactly like no fit.
    expect(resolveWorkplace('13 Bùi Thị Xuân', branches, ntb)).toEqual({ status: 'NONE' });
  });

  it('opens the shift at the account’s branch from its own address, however it is typed', async () => {
    for (const typed of ['05 Trương Định', 'truong dinh', 'TRƯƠNG ĐỊNH', '05, truong-dinh']) {
      const res = await lan.post('/api/housekeeping/shift/start').send({ address: typed });
      expect(res.status, typed).toBe(201);
      expect(res.body.shift.current.branch.id).toBe(cn1);
      await lan.post('/api/housekeeping/shift/end').send({});
      await resetShiftData();
    }
  });

  it('answers too little, another hotel and nonsense without naming any branch', async () => {
    const start = (body: Record<string, unknown>) => lan.post('/api/housekeeping/shift/start').send(body);
    const missing = await start({});
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toBe(WORKPLACE_REQUIRED);
    const short = await start({ address: '1' });
    expect(short.status).toBe(422);
    expect(short.body.error.message).toBe(WORKPLACE_AMBIGUOUS);
    expect((await start({ address: 'Lê Thánh Tôn' })).body.error.message).toBe(WORKPLACE_AMBIGUOUS);

    const elsewhere = await start({ address: '260 Lý Tự Trọng' });
    const nonsense = await start({ address: 'không có đâu cả' });
    expect(elsewhere.status).toBe(422);
    expect(nonsense.status).toBe(422);
    expect(elsewhere.body.error).toEqual(nonsense.body.error);
    expect(elsewhere.body.error.message).toBe(WORKPLACE_NOT_FOUND);

    // No answer carries an address, a branch name or an id of any branch.
    const everything = JSON.stringify([missing.body, short.body, elsewhere.body, nonsense.body]);
    for (const b of BRANCHES) {
      expect(everything).not.toContain(b.address);
      expect(everything).not.toContain(b.code);
    }
    expect(everything).not.toMatch(/"branch(es|Id)?"/);
    // Nothing was opened, and the typed text is stored nowhere.
    expect(await testPrisma.housekeepingWorkSession.count()).toBe(0);
  });

  it('never lets the request pick the branch, and needs a signed-in housekeeper', async () => {
    const own = await addressOf(cn1);
    expect((await lan.post('/api/housekeeping/shift/start').send({ branchId: cn2, address: own })).status).toBe(403);
    expect((await lan.post('/api/housekeeping/shift/start').send({ branchId: cn2, address: await addressOf(cn2) })).status).toBe(403);
    expect((await request(app).post('/api/housekeeping/shift/start').send({ address: own })).status).toBe(401);
    expect((await letan1.post('/api/housekeeping/shift/start').send({ address: own })).status).toBe(403);
    expect((await manager1.post('/api/housekeeping/shift/start').send({ address: own })).status).toBe(403);
  });

  it('bounds the attempts of one account', async () => {
    await createUser({ username: 'thu', password: PASSWORD, fullName: 'Chị Thu', role: 'HOUSEKEEPING', branchId: cn1 });
    const thu = (await loginAgent(app, 'thu', PASSWORD)).agent;
    for (let i = 0; i < 30; i += 1) {
      expect((await thu.post('/api/housekeeping/shift/start').send({ address: `đường số ${i} xa lắm` })).status).toBe(422);
    }
    const blocked = await thu.post('/api/housekeeping/shift/start').send({ address: await addressOf(cn1) });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // Another account is counted on its own.
    await onShift(hoa, cn1);
    await testPrisma.user.delete({ where: { username: 'thu' } });
  });
});

describe('4. the housekeeper’s list and "Nhận"', () => {
  it('shows nothing before "Vào ca"; then one row per item of the shift’s branch', async () => {
    const tasks = await created([ROOM_502, { areaKind: 'ROOM', roomNumber: '502', taskCode: 'OTHER', note: 'Thay rèm' }, HALL_5]);
    await created([{ areaKind: 'ROOM', roomNumber: '502', taskCode: 'OC' }], { branchId: cn2 }, admin);
    expect(await workItems(lan)).toEqual({ working: false, tasks: [] });
    await onShift(lan, cn1);
    const list = await workItems(lan);
    expect(list.working).toBe(true);
    expect(list.tasks.map((t) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    expect(list.tasks.every((t) => t.phase === 'UNCLAIMED' && t.branchId === cn1)).toBe(true);
    expect((await manager1.get(`/api/housekeeping/work/items?date=${DAY}`)).status).toBe(403);
  });

  it('takes exactly the selected items — one item of a room leaves its sibling free', async () => {
    const [oc, other, hall] = await created([ROOM_502, { areaKind: 'ROOM', roomNumber: '502', taskCode: 'OTHER', note: 'Thay rèm' }, HALL_5]);
    await onShift(lan, cn1);
    await onShift(hoa, cn1);
    const taken = await claim(lan, [oc!.id, hall!.id]);
    expect(taken.status).toBe(200);
    expect(taken.body.tasks.map((t: Task) => t.id).sort()).toEqual([oc!.id, hall!.id].sort());
    for (const t of taken.body.tasks as Task[]) {
      expect(t).toMatchObject({ phase: 'ACCEPTED', assignee: { id: lanId, name: 'Chị Lan' }, state: 'NOT_STARTED', startedAt: null, inspectionStartedAt: null });
      expect(t.acceptedAt).not.toBeNull();
    }
    const sibling = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: other!.id } });
    expect(sibling.assigneeUserId).toBeNull();
    // Hoa sees the free sibling, not Lan's items.
    expect((await workItems(hoa)).tasks.map((t) => t.id)).toEqual([other!.id]);
    expect((await eventsOf(oc!.id)).map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED']);
    // Accepting started nothing.
    expect(await testPrisma.housekeepingWorkSegment.count({ where: { session: { userId: lanId } } })).toBe(1);
  });

  it('never gives one item two owners: the second claim is refused whole and recorded', async () => {
    const [a, b] = await created([ROOM_502, HALL_5]);
    await onShift(lan, cn1);
    await onShift(hoa, cn1);
    const [r1, r2] = await Promise.all([claim(lan, [a!.id]), claim(hoa, [a!.id])]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    const loserId = r1.status === 409 ? lanId : hoaId;
    expect(loser.body.error.details.taskIds).toEqual([a!.id]);
    expect(loser.body.error.message).toContain('Phòng - 502');

    // All or nothing: a free item claimed together with a taken one stays free.
    const winner = r1.status === 200 ? lan : hoa;
    const other = winner === lan ? hoa : lan;
    const mixed = await claim(other, [b!.id, a!.id]);
    expect(mixed.status).toBe(409);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: b!.id } })).assigneeUserId).toBeNull();
    const rejected = (await eventsOf(a!.id)).filter((e) => e.type === 'CLAIM_REJECTED');
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected[0]!.actorUserId).toBe(loserId);
    expect(await testPrisma.housekeepingRoomTaskEvent.count({ where: { taskId: a!.id, type: 'ACCEPTED' } })).toBe(1);
  });

  it('refuses a claim off shift, of another branch’s item, or by anyone but a housekeeper', async () => {
    const [mine] = await created([ROOM_502]);
    const [theirs] = await created([{ areaKind: 'ROOM', roomNumber: '802', taskCode: 'VC' }], { branchId: cn2 }, admin);
    expect((await claim(lan, [mine!.id])).status).toBe(409);
    await onShift(lan, cn1);
    expect((await claim(lan, [theirs!.id])).status).toBe(404);
    expect((await claim(lan, ['no-such-id'])).status).toBe(404);
    expect((await claim(lan, [])).status).toBe(422);
    await onShift(mai, cn2);
    expect((await claim(mai, [mine!.id])).status).toBe(404);
    expect((await claim(manager1, [mine!.id])).status).toBe(403);
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: mine!.id } })).assigneeUserId).toBeNull();
  });
});

describe('5. "Kiểm tra" → "Chờ dọn phòng" → "Dọn phòng" → "Hoàn thành"', () => {
  it('walks a room item through its stages, each kept in its history', async () => {
    const [oc, sibling] = await created([ROOM_502, { areaKind: 'ROOM', roomNumber: '502', taskCode: 'OTHER', note: 'Thay rèm' }]);
    await onShift(lan, cn1);
    expect((await claim(lan, [oc!.id, sibling!.id])).status).toBe(200);
    // Cleaning cannot begin before the inspection is saved.
    expect((await lan.post(`${url(oc!.id)}/start`)).status).toBe(409);

    setClock({ now: () => hcm(DAY, '08:10') });
    const begun = await lan.post(`${url(oc!.id)}/begin-inspection`);
    expect(begun.status).toBe(200);
    expect(begun.body.task.phase).toBe('INSPECTING');
    expect((await lan.post(`${url(oc!.id)}/begin-inspection`)).status).toBe(200);
    expect((await hoa.post(`${url(oc!.id)}/begin-inspection`)).status).toBe(403);

    setClock({ now: () => hcm(DAY, '08:15') });
    const inspected = await lan.post(`${url(oc!.id)}/inspect`).send({ issues: [] });
    expect(inspected.status).toBe(201);
    expect(inspected.body.task).toMatchObject({ phase: 'AWAITING_CLEANING', startedAt: null, inspectedAt: hcm(DAY, '08:15').toISOString() });
    expect((await lan.post(`${url(oc!.id)}/begin-inspection`)).status).toBe(409);

    setClock({ now: () => hcm(DAY, '08:20') });
    const started = await lan.post(`${url(oc!.id)}/start`);
    expect(started.status).toBe(200);
    expect(started.body.task.phase).toBe('CLEANING');
    setClock({ now: () => hcm(DAY, '08:50') });
    const done = await lan.post(`${url(oc!.id)}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.task.phase).toBe('COMPLETED');

    // The sibling item of the same room has not moved.
    const other = await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: sibling!.id } });
    expect(other).toMatchObject({ state: 'NOT_STARTED', inspectionStartedAt: null, startedAt: null });
    expect((await eventsOf(oc!.id)).map((e) => e.type)).toEqual(
      expect.arrayContaining(['CREATED', 'ACCEPTED', 'INSPECTION_STARTED', 'INSPECTED', 'STARTED', 'COMPLETED']),
    );
    // A completed item leaves the list; the sibling stays.
    expect((await workItems(lan)).tasks.map((t) => t.id)).toEqual([sibling!.id]);
  });

  it('inspects a shared area with a note, not room findings', async () => {
    const [hall] = await created([HALL_5]);
    await onShift(lan, cn1);
    expect((await claim(lan, [hall!.id])).status).toBe(200);
    expect((await lan.post(`${url(hall!.id)}/inspect`).send({ issues: [{ type: 'SMOKING' }] })).status).toBe(422);
    const saved = await lan.post(`${url(hall!.id)}/inspect`).send({ issues: [], note: 'Thảm bẩn trước 502' });
    expect(saved.status).toBe(201);
    expect(saved.body.task).toMatchObject({ phase: 'AWAITING_CLEANING', inspectionNote: 'Thảm bẩn trước 502' });
    expect(await testPrisma.roomInspection.count()).toBe(0);
    expect((await lan.post(`${url(hall!.id)}/start`)).status).toBe(200);
  });
});

describe('6. "Giao lại" while waiting for cleaning', () => {
  const reassign = (agent: Agent, id: string, body: Record<string, unknown>) => agent.post(`/api/housekeeping/work-orders/${id}/reassign`).send(body);

  it('lets the Admin, Quản lý buồng phòng and Quản lý lễ tân hand it to another housekeeper of the branch', async () => {
    for (const agent of [admin, manager1, receptionManager]) {
      await resetHousekeepingData();
      await resetShiftData();
      const task = await awaitingCleaning(lan);
      const res = await reassign(agent, task.id, { assigneeUserId: hoaId, reason: 'Chị Lan về sớm' });
      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({ phase: 'AWAITING_CLEANING', assignee: { id: hoaId, name: 'Chị Hoa' } });
      const event = (await eventsOf(task.id)).find((e) => e.type === 'ASSIGNED');
      expect(event!.detail).toMatchObject({ fromId: lanId, fromName: 'Chị Lan', toId: hoaId, toName: 'Chị Hoa', reason: 'Chị Lan về sớm', stage: 'AWAITING_CLEANING' });
      expect(event!.createdAt).toEqual(hcm(DAY, '08:00'));
      expect(await testPrisma.notification.count({ where: { userId: hoaId } })).toBeGreaterThan(0);
    }
    // The new housekeeper takes it from there.
    const task = await testPrisma.housekeepingRoomTask.findFirstOrThrow({ where: { assigneeUserId: hoaId } });
    await onShift(hoa, cn1);
    expect((await hoa.post(`${url(task.id)}/start`)).status).toBe(200);
    expect((await lan.post(`${url(task.id)}/start`)).status).toBe(403);
  });

  it('refuses every other role, another branch’s housekeeper, and an item not waiting for cleaning', async () => {
    const task = await awaitingCleaning(lan);
    for (const agent of [letan1, general, tech, lan, hoa]) {
      expect((await reassign(agent, task.id, { assigneeUserId: hoaId })).status).toBe(403);
    }
    expect((await reassign(admin, task.id, { assigneeUserId: maiId })).status).toBe(422);
    expect((await reassign(admin, task.id, { assigneeUserId: lanId })).status).toBe(422);
    expect((await reassign(admin, task.id, {})).status).toBe(422);

    const [fresh] = await created([HALL_5]);
    expect((await reassign(admin, fresh!.id, { assigneeUserId: hoaId })).status).toBe(409);

    // Once cleaning has begun the cleaner stays the cleaner.
    expect((await lan.post(`${url(task.id)}/start`)).status).toBe(200);
    const midway = await reassign(manager1, task.id, { assigneeUserId: hoaId });
    expect(midway.status).toBe(409);
    expect(midway.body.error.message).toContain('không thể đổi người thực hiện giữa chừng');
    expect((await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task.id } })).assigneeUserId).toBe(lanId);
  });

  it('keeps a reception manager to its branches', async () => {
    const [far] = await created([{ areaKind: 'ROOM', roomNumber: '802', taskCode: 'VC' }], { branchId: cn2 }, admin);
    await onShift(mai, cn2);
    expect((await claim(mai, [far!.id])).status).toBe(200);
    expect((await mai.post(`${url(far!.id)}/inspect`).send({ issues: [] })).status).toBe(201);
    expect((await reassign(receptionManager, far!.id, { assigneeUserId: maiId })).status).toBe(403);
    expect((await receptionManager.get(`/api/housekeeping/work-orders/staff?branchId=${cn2}`)).status).toBe(403);
    const staff = await receptionManager.get(`/api/housekeeping/work-orders/staff?branchId=${cn1}`);
    expect(staff.body.staff.map((s: { id: number }) => s.id).sort()).toEqual([lanId, hoaId].sort());
  });
});

describe('"Các công việc trong ngày" — the supervisors’ table', () => {
  it('lists each item of the reader’s branches with its stage and person, without money', async () => {
    const [oc] = await created([ROOM_502, HALL_5]);
    await created([{ areaKind: 'ROOM', roomNumber: '802', taskCode: 'VC' }], { branchId: cn2 }, admin);
    await onShift(lan, cn1);
    await claim(lan, [oc!.id]);

    const rows = async (agent: Agent, query = '') => {
      const res = await agent.get(`/api/housekeeping/work-orders?date=${DAY}${query}`);
      expect(res.status).toBe(200);
      return res.body.tasks as Task[];
    };
    const own = await rows(manager1);
    expect(own.map((t) => [t.areaLabel, t.phase, t.assignee?.name ?? null])).toEqual(
      expect.arrayContaining([
        ['Phòng - 502', 'ACCEPTED', 'Chị Lan'],
        ['Hành lang - Tầng 5', 'UNCLAIMED', null],
      ]),
    );
    expect(own).toHaveLength(2);
    expect((await rows(receptionManager)).every((t) => t.branchId === cn1)).toBe(true);
    expect(await rows(admin)).toHaveLength(3);
    expect(await rows(admin, `&branchId=${cn2}`)).toHaveLength(1);
    expect(await rows(general)).toHaveLength(3);
    expect(JSON.stringify(own)).not.toMatch(/"(amount|collection)"/);
    expect((await manager1.get(`/api/housekeeping/work-orders?date=${DAY}&branchId=${cn2}`)).status).toBe(403);
    expect((await letan1.get(`/api/housekeeping/work-orders?date=${DAY}`)).status).toBe(403);
    expect((await lan.get(`/api/housekeeping/work-orders?date=${DAY}`)).status).toBe(403);
  });
});
