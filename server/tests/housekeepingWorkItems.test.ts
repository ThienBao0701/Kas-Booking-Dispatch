/**
 * HOUSEKEEPING WORK GROUPS — "Công việc 1, 2, …" — and the shift that decides
 * where a housekeeper works. Each rule pinned at the API:
 *
 *   A. Branches: the Admin gives a branch to the Quản lý buồng phòng only; a
 *      Bộ phận buồng phòng account has none — its branch is its open shift's.
 *   B. "Vào ca" by address: only the ONE hotel the typed text identifies is
 *      named back; too little or several is a generic "nhập thêm"; the server
 *      resolves it again at "Vào ca"; the shift's branch scopes every request.
 *   C. Floors from the catalog: Chi nhánh 4's Suite rooms 001–003 on their own
 *      Suite floors, its 2xx–8xx rooms on "Tầng 2" … "Tầng 8"; Rooftop only at
 *      Chi nhánh 2, 3 and 4.
 *   D. One group, many places, each with its own codes, note and priority —
 *      saved in one transaction; invalid groups save nothing; numbers are per
 *      branch and day and never reused.
 *   E. "Chỉnh sửa": rename, add, edit one place, take one out (soft, with its
 *      history), give the whole group — never one room of it.
 *   F. "Nhận công việc": the WHOLE group, by one housekeeper on shift there;
 *      a second (even at the same moment) is refused and sees who has it.
 *   G. "Không cần dọn": a reason, then the manager of the branch decides;
 *      approval takes the place out of the work without erasing anything.
 *   H. The supervisors' table and "Giao lại" in "Chờ dọn phòng".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { resetAll, resetHousekeepingData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { addressOf, startShiftAt } from './helpers/workplace';
import { UNPLACED_LABEL, workAreasFor } from '../src/housekeeping/workAreas';
import { catalogFloor } from '../src/room/branchRooms';
import { WORKPLACE_AMBIGUOUS, WORKPLACE_NOT_FOUND, normalizeAddress, resolveWorkplace } from '../src/housekeeping/workplaceAddress';

const app = createApp();
// A second app — its own login limiter — for the accounts a test signs in on its own.
const app2 = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-07';

let cn1 = 0;
let cn2 = 0;
let cn4 = 0;
let admin: Agent;
let letan1: Agent;
let manager1: Agent;
let manager2: Agent;
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
  taskCodes: string[];
  note: string | null;
  priority: boolean;
  state: string;
  phase: string;
  voided: boolean;
  assignee: { id: number; name: string } | null;
  workGroup: { id: string; number: number; name: string | null } | null;
  noClean: { status: string; reason: string | null; requestedByName: string | null; decidedByName: string | null } | null;
  inspection: unknown;
  events: { type: string }[];
};
type Group = {
  id: string;
  number: number;
  title: string;
  name: string | null;
  branchId: number;
  assignee: { id: number; name: string } | null;
  status: { code: string; label: string };
  floors: string[];
  counts: { items: number; completed: number; noCleanPending: number };
  items: Task[];
};

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const id = async (code: string) => (await testPrisma.branch.findUniqueOrThrow({ where: { code } })).id;
  cn1 = await id('TRUONG_DINH_05');
  cn2 = await id('LY_TU_TRONG_260');
  cn4 = await id('NGUYEN_THAI_BINH_170');
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  for (const [username, role, body] of [
    ['qlbp1', 'HOUSEKEEPING_MANAGER', { branchId: cn1 }],
    ['qlbp2', 'HOUSEKEEPING_MANAGER', { branchId: cn2 }],
    ['quanly1', 'RECEPTION_MANAGER', { branchIds: [cn1] }],
  ] as const) {
    const res = await admin.post('/api/admin/users').send({ username, fullName: `QL ${username}`, temporaryPassword: PASSWORD, role, ...body });
    expect(res.status).toBe(201);
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  manager1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  manager2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  receptionManager = (await loginAgent(app, 'quanly1', PASSWORD)).agent;
  await createUser({ username: 'tongql', password: PASSWORD, fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER' });
  general = (await loginAgent(app, 'tongql', PASSWORD)).agent;
  await createUser({ username: 'kythuat', password: PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  tech = (await loginAgent(app, 'kythuat', PASSWORD)).agent;
  // Housekeepers have NO branch — "Vào ca" decides where they work.
  lanId = (await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING' })).id;
  hoaId = (await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING' })).id;
  maiId = (await createUser({ username: 'mai', password: PASSWORD, fullName: 'Chị Mai', role: 'HOUSEKEEPING' })).id;
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
  mai = (await loginAgent(app, 'mai', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await testPrisma.housekeepingWorkGroup.deleteMany();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  setClock({ now: () => hcm(DAY, '08:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.housekeepingWorkGroup.deleteMany();
  await resetAll();
});

const createGroup = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}, agent: Agent = manager1) =>
  agent.post('/api/housekeeping/manager/work-groups').send({ workDate: DAY, items, ...extra });

async function group(items: Record<string, unknown>[], extra: Record<string, unknown> = {}, agent: Agent = manager1): Promise<Group> {
  const res = await createGroup(items, extra, agent);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.group as Group;
}

const room = (roomNumber: string, taskCodes: string[], extra: Record<string, unknown> = {}) => ({ areaKind: 'ROOM', roomNumber, taskCodes, ...extra });
const workerGroups = async (agent: Agent) => (await agent.get(`/api/housekeeping/work/groups?date=${DAY}`)).body as { working: boolean; groups: Group[] };
const accept = (agent: Agent, id: string) => agent.post(`/api/housekeeping/work/groups/${id}/accept`).send({});
const url = (id: string) => `/api/housekeeping/work/tasks/${id}`;
const task = (id: string) => testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id } });
const eventsOf = (taskId: string) => testPrisma.housekeepingRoomTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
const lookup = (agent: Agent, address: string) => agent.post('/api/housekeeping/shift/lookup').send({ address });

describe('A. branches — the manager has one, the housekeeper has its shift', () => {
  it('creates a housekeeping account with no branch, and refuses one', async () => {
    const base = { fullName: 'Buồng mới', temporaryPassword: PASSWORD, role: 'HOUSEKEEPING' };
    const ok = await admin.post('/api/admin/users').send({ ...base, username: 'buong_moi' });
    expect(ok.status).toBe(201);
    expect(ok.body.user.branch).toBeNull();
    expect((await admin.post('/api/admin/users').send({ ...base, username: 'buong_x', branchId: cn1 })).status).toBe(422);
    expect((await admin.put(`/api/admin/users/${ok.body.user.id}`).send({ branchId: cn1 })).status).toBe(422);
    await testPrisma.user.delete({ where: { id: ok.body.user.id } });
  });

  it('keeps the Quản lý buồng phòng to exactly one branch, which the Admin can move', async () => {
    const base = { fullName: 'QL', temporaryPassword: PASSWORD, role: 'HOUSEKEEPING_MANAGER' };
    expect((await admin.post('/api/admin/users').send({ ...base, username: 'qlbp_x' })).status).toBe(422);
    const ok = await admin.post('/api/admin/users').send({ ...base, username: 'qlbp_y', branchId: cn1 });
    expect(ok.status).toBe(201);
    const moved = await admin.put(`/api/admin/users/${ok.body.user.id}`).send({ branchId: cn2 });
    expect(moved.status).toBe(200);
    expect(moved.body.user.branch.id).toBe(cn2);
    await testPrisma.user.delete({ where: { id: ok.body.user.id } });
  });

  it('ignores a permanent branch an older account still carries: off shift there is none', async () => {
    const old = await createUser({ username: 'buong_cu', password: PASSWORD, fullName: 'Buồng cũ', role: 'HOUSEKEEPING', branchId: cn1 });
    const agent = (await loginAgent(app2, 'buong_cu', PASSWORD)).agent;
    expect((await agent.get('/api/auth/me')).body.user.branch).toBeNull();
    expect(await workerGroups(agent)).toEqual({ working: false, groups: [] });
    expect((await agent.post('/api/housekeeping/inspections').send({ roomNumber: '101', issues: [] })).status).toBe(403);
    // It can work at any hotel it names — here Chi nhánh 2, not its old branch.
    await startShiftAt(agent, cn2);
    expect((await agent.get('/api/auth/me')).body.user.branch.id).toBe(cn2);
    await agent.post('/api/housekeeping/shift/end').send({});
    await testPrisma.housekeepingWorkSegment.deleteMany({ where: { session: { userId: old.id } } });
    await testPrisma.housekeepingWorkSession.deleteMany({ where: { userId: old.id } });
    await testPrisma.user.delete({ where: { id: old.id } });
  });
});

describe('B. "Vào ca" by address — one hotel named back, never a list', () => {
  const branches = BRANCHES.map((b, i) => ({ id: i + 1, address: b.address }));
  const idOf = (code: string) => BRANCHES.findIndex((b) => b.code === code) + 1;

  it('resolves a typed start to the one branch it fits, ignoring case, accents and leading zeros', () => {
    expect(normalizeAddress('05 Trương Định')).toBe('5 truong dinh');
    expect(resolveWorkplace('1', branches)).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('17', branches)).toEqual({ status: 'RESOLVED', branchId: idOf('NGUYEN_THAI_BINH_170') });
    expect(resolveWorkplace('13', branches)).toEqual({ status: 'RESOLVED', branchId: idOf('BUI_THI_XUAN_13') });
    // One character names nothing — a digit neither ("5" alone, "4" alone).
    expect(resolveWorkplace('5', branches)).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('4', branches)).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('05', branches)).toEqual({ status: 'RESOLVED', branchId: idOf('TRUONG_DINH_05') });
    expect(resolveWorkplace('Bùi Thị Xuân', branches)).toEqual({ status: 'AMBIGUOUS' });
    expect(resolveWorkplace('uyen thai', branches)).toEqual({ status: 'NONE' });
    expect(resolveWorkplace('x', branches)).toEqual({ status: 'AMBIGUOUS' });
    // Every branch is reachable by its own address, and only it.
    for (const b of branches) expect(resolveWorkplace(b.address, branches)).toEqual({ status: 'RESOLVED', branchId: b.id });
  });

  it('names back only the matched hotel — "17" shows 170-172-174 and never 13 Bùi Thị Xuân', async () => {
    const one = await lookup(lan, '1');
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ status: 'AMBIGUOUS', message: WORKPLACE_AMBIGUOUS });
    const seventeen = await lookup(lan, '17');
    // The address only — never the branch number.
    expect(seventeen.body).toEqual({ status: 'RESOLVED', branch: { address: '170-172-174 Nguyễn Thái Bình' } });
    expect((await lookup(lan, '4')).body).toEqual({ status: 'AMBIGUOUS', message: WORKPLACE_AMBIGUOUS });
    const nothing = await lookup(lan, 'không có đâu');
    expect(nothing.body).toEqual({ status: 'NONE', message: WORKPLACE_NOT_FOUND });
    // No answer carries another branch: not an address, not a code, not a count.
    const everything = JSON.stringify([one.body, seventeen.body, nothing.body]);
    for (const b of BRANCHES.filter((x) => x.code !== 'NGUYEN_THAI_BINH_170')) {
      expect(everything).not.toContain(b.address);
      expect(everything).not.toContain(b.code);
    }
    expect(everything).not.toMatch(/"(id|branchId|branchNumber|branches|count)"/);
  });

  it('opens the shift at the hotel the address names — the shift decides every branch check', async () => {
    const started = await lan.post('/api/housekeeping/shift/start').send({ address: '17' });
    expect(started.status).toBe(201);
    expect(started.body.shift.current.branch.id).toBe(cn4);
    expect((await lan.get('/api/auth/me')).body.user.branch.id).toBe(cn4);
    expect((await lan.get('/api/branches')).body.branches.map((b: { id: number }) => b.id)).toEqual([cn4]);
    // A branch id sent by the browser picks nothing.
    await lan.post('/api/housekeeping/shift/end').send({});
    const sneaky = await lan.post('/api/housekeeping/shift/start').send({ address: await addressOf(cn2), branchId: cn1 });
    expect(sneaky.status).toBe(201);
    expect(sneaky.body.shift.current.branch.id).toBe(cn2);
    // To work elsewhere: "Kết thúc ca", then "Vào ca" there.
    expect((await lan.post('/api/housekeeping/shift/switch').send({ branchId: cn1 })).status).toBe(409);
    expect((await lan.post('/api/housekeeping/shift/start').send({ address: '05' })).status).toBe(409);
    await lan.post('/api/housekeeping/shift/end').send({});
    expect((await lan.get('/api/auth/me')).body.user.branch).toBeNull();
    expect((await lan.post('/api/housekeeping/shift/start').send({ address: '1' })).body.error.message).toBe(WORKPLACE_AMBIGUOUS);
  });

  it('needs a signed-in housekeeper, and bounds the lookups of one account', async () => {
    expect((await request(app).post('/api/housekeeping/shift/lookup').send({ address: '17' })).status).toBe(401);
    for (const agent of [letan1, manager1, admin]) expect((await lookup(agent, '17')).status).toBe(403);
    await createUser({ username: 'thu', password: PASSWORD, fullName: 'Chị Thu', role: 'HOUSEKEEPING' });
    const thu = (await loginAgent(app2, 'thu', PASSWORD)).agent;
    for (let i = 0; i < 40; i += 1) expect((await lookup(thu, `${i}`)).status).toBe(200);
    const blocked = await lookup(thu, '17');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await lookup(hoa, '17')).status).toBe(200);
    await testPrisma.user.delete({ where: { username: 'thu' } });
  });
});

describe('C. floors and areas — from the catalog', () => {
  it('puts Chi nhánh 4\'s Suite rooms on the Suite floors and its 2xx–8xx rooms on Tầng 2–8', () => {
    const cnb4 = workAreasFor('NGUYEN_THAI_BINH_170');
    const floor = (value: string) => cnb4.floors.find((f) => f.floor === value);
    expect(floor('1 (Khu Suite)')).toMatchObject({ label: 'Tầng 1 (Khu Suite)', rooms: ['001'] });
    expect(floor('2 (Khu Suite)')!.rooms).toEqual(['002']);
    expect(floor('3 (Khu Suite)')!.rooms).toEqual(['003']);
    expect(floor('2')).toMatchObject({ label: 'Tầng 2', rooms: ['201', '202', '203', '204', '205', '206'] });
    expect(floor('3')!.rooms).toEqual(['301', '302', '303', '304', '305', '306']);
    expect(floor('8')!.rooms).toEqual(['801', '802', '803', '804', '805', '806']);
    // Suite 002 is never mixed into the main building's Tầng 2.
    expect(floor('2')!.rooms).not.toContain('002');
    expect(cnb4.unplacedRooms).toEqual([]);
    expect(cnb4.floors.map((f) => f.label).join()).not.toContain('Tòa bên cạnh');
    // Older rows' floor values are read as the plain floor.
    expect(catalogFloor('NGUYEN_THAI_BINH_170', '5 (Tòa bên cạnh)')).toBe('5');
  });

  it('places regular rooms by number everywhere, and lists only what cannot be placed', () => {
    const td = workAreasFor('TRUONG_DINH_05');
    expect(td.floors.find((f) => f.floor === '1')!.rooms).toEqual(['101', '102', '103']);
    expect(td.floors.find((f) => f.floor === '3')!.rooms).toEqual(['301', '302']);
    expect(td.unplacedRooms).toEqual([]);
    expect(workAreasFor('LY_TU_TRONG_260').floors.find((f) => f.floor === '8')!.rooms).toEqual(['801', '802']);
    // A ground-floor "001" with no floor 0 elsewhere: listed, not guessed.
    const cn5 = workAreasFor('LE_THANH_TON_278');
    expect(cn5.unplacedRooms).toEqual(['001']);
    expect(cn5.unplacedLabel).toBe(UNPLACED_LABEL);
  });

  it('offers a Rooftop at Chi nhánh 2, 3 and 4 only', () => {
    const rooftop = Object.fromEntries(BRANCHES.map((b) => [b.code, workAreasFor(b.code).hasRooftop]));
    expect(rooftop).toEqual({
      TRUONG_DINH_05: false,
      LY_TU_TRONG_260: true,
      NGUYEN_TRAI_47A: true,
      NGUYEN_THAI_BINH_170: true,
      LE_THANH_TON_278: false,
      BUI_THI_XUAN_40: false,
      BUI_THI_XUAN_13: false,
      LE_THANH_TON_191: false,
    });
  });
});

describe('D. "Tạo công việc" — one group, many places, each its own', () => {
  it('saves one group with independent codes, notes and priorities, numbered per branch and day', async () => {
    const g = await group(
      [
        room('101', ['OUT'], { note: 'Khách về sớm', priority: true }),
        room('102', ['OC', 'OTHER'], { note: 'Thay rèm' }),
        { areaKind: 'HALLWAY', floor: '1', note: 'Lau sàn hành lang' },
      ],
      { name: 'Tầng 1 buổi sáng' },
    );
    expect(g).toMatchObject({ number: 1, title: 'Công việc 1', name: 'Tầng 1 buổi sáng', branchId: cn1, assignee: null, status: { code: 'UNASSIGNED' } });
    expect(g.floors).toEqual(['Tầng 1']);
    expect(g.items.map((t) => [t.roomNumber, t.floor, t.taskCodes, t.statusCode, t.note, t.priority])).toEqual([
      ['101', '1', ['OUT'], 'OUT', 'Khách về sớm', true],
      ['102', '1', ['OC', 'OTHER'], 'OC', 'Thay rèm', false],
      ['Hành lang - Tầng 1', '1', ['OTHER'], 'OTHER', 'Lau sàn hành lang', false],
    ]);
    expect(g.items.every((t) => t.workGroup?.number === 1 && t.phase === 'UNCLAIMED')).toBe(true);
    expect((await group([room('201', ['VC'])])).number).toBe(2);
    expect((await group([room('801', ['OUT'])], { branchId: cn2 }, admin)).number).toBe(1);
  });

  it('refuses an empty or invalid group, and saves nothing of it', async () => {
    for (const [items, message] of [
      [[], 'ít nhất một'],
      [[room('101', [])], 'việc cần làm'],
      [[room('101', ['OUT', 'OC'])], 'chỉ chọn một'],
      [[room('101', ['OTHER'])], '"Khác" cần ghi chú'],
      [[room('101', ['OUT']), { areaKind: 'HALLWAY', floor: '1' }], 'cần ghi chú'],
      [[{ areaKind: 'ROOFTOP', note: 'Quét' }], 'không có Rooftop'],
      [[room('101', ['OUT']), room('101', ['OC'])], 'hai lần'],
      [[room('999', ['OUT'])], 'không thuộc chi nhánh'],
    ] as const) {
      const res = await createGroup(items as unknown as Record<string, unknown>[]);
      expect(res.status, JSON.stringify(items)).toBe(422);
      expect(res.body.error.message).toContain(message);
    }
    expect(await testPrisma.housekeepingWorkGroup.count()).toBe(0);
    expect(await testPrisma.housekeepingRoomTask.count()).toBe(0);
  });

  it('keeps a room in one open group a day, saves a Rooftop where there is one, and never twice', async () => {
    await group([room('101', ['OUT'])]);
    const again = await createGroup([room('102', ['OC']), room('101', ['VC'])]);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('Phòng 101 (Công việc 1)');
    expect(await testPrisma.housekeepingRoomTask.count({ where: { roomNumber: '102' } })).toBe(0);

    const top = await group([{ areaKind: 'ROOFTOP', note: 'Quét lá, dọn bàn ghế' }], { branchId: cn2 }, admin);
    expect(top.items[0]).toMatchObject({ areaKind: 'ROOFTOP', areaLabel: 'Rooftop', floor: null, note: 'Quét lá, dọn bàn ghế' });
    expect(top.floors).toEqual(['Rooftop']);

    const requestId = 'f3b8c2a0-1111-4222-8333-944445555666';
    const first = await createGroup([room('201', ['OC'])], { requestId });
    const repeat = await createGroup([room('201', ['OC'])], { requestId });
    expect([first.status, repeat.status]).toEqual([201, 200]);
    expect(repeat.body).toMatchObject({ duplicate: true, group: { id: first.body.group.id } });
  });

  it('is the manager\'s at its branch and the Admin\'s anywhere — nobody else\'s', async () => {
    expect((await createGroup([room('801', ['OUT'])], { branchId: cn2 })).status).toBe(403);
    for (const agent of [lan, letan1, receptionManager, tech, general]) expect((await createGroup([room('101', ['OUT'])], {}, agent)).status).toBe(403);
  });
});

describe('E. "Chỉnh sửa" — the group, one place at a time', () => {
  it('renames, adds, edits one place, and takes one out without touching the catalog or its history', async () => {
    const g = await group([room('101', ['OUT'], { note: 'A' }), room('102', ['OC'], { note: 'B' })]);
    const [p101, p102] = g.items;
    expect((await manager1.patch(`/api/housekeeping/manager/work-groups/${g.id}`).send({ name: 'Sáng' })).body.group.name).toBe('Sáng');
    const added = await manager1.post(`/api/housekeeping/manager/work-groups/${g.id}/items`).send({ items: [room('103', ['VC'])] });
    expect(added.status).toBe(201);
    expect(added.body.group.items.map((t: Task) => t.roomNumber)).toEqual(['101', '102', '103']);

    // One place's codes and note — the other place is untouched.
    const edited = await manager1.patch(`/api/housekeeping/manager/tasks/${p101!.id}`).send({ taskCodes: ['VC', 'OTHER'], note: 'Đổi việc' });
    expect(edited.status).toBe(200);
    expect(edited.body.task).toMatchObject({ taskCodes: ['VC', 'OTHER'], statusCode: 'VC', note: 'Đổi việc' });
    expect(await task(p102!.id)).toMatchObject({ note: 'B', statusCode: 'OC' });
    expect((await manager1.patch(`/api/housekeeping/manager/tasks/${p101!.id}`).send({ taskCodes: ['OUT', 'OC'] })).status).toBe(422);

    // Taking 102 out: a soft removal; the room stays in the catalog.
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p102!.id}/void`).send({ reason: 'Khách ở thêm' })).status).toBe(200);
    const removed = await task(p102!.id);
    expect(removed.voidedAt).not.toBeNull();
    expect(removed.workGroupId).toBe(g.id);
    // The rename is in each place's history too.
    expect((await eventsOf(p102!.id)).map((e) => e.type)).toEqual(['CREATED', 'UPDATED', 'VOIDED']);
    expect(workAreasFor('TRUONG_DINH_05').floors.find((f) => f.floor === '1')!.rooms).toContain('102');
    const list = (await manager1.get(`/api/housekeeping/manager/work-groups?date=${DAY}`)).body.groups as Group[];
    expect(list[0]!.counts.items).toBe(2);
    expect(list[0]!.items.find((t) => t.id === p102!.id)).toMatchObject({ voided: true, phase: 'VOIDED' });
    // The room can be given out again in another group once taken out.
    expect((await group([room('102', ['OC'])])).number).toBe(2);
  });

  it('protects work in hand: a reason once held, never mid-cleaning, never room by room', async () => {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    const [p101, p102] = g.items;
    await startShiftAt(lan, cn1);
    expect((await accept(lan, g.id)).status).toBe(200);
    // A grouped room is given out with its group.
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/assign`).send({ assigneeUserId: hoaId })).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p102!.id}/void`).send({})).status).toBe(422);
    await lan.post(`${url(p101!.id)}/inspect`).send({ issues: [] });
    await lan.post(`${url(p101!.id)}/start`);
    const midway = await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/void`).send({ reason: 'x' });
    expect(midway.status).toBe(409);
    expect(midway.body.error.message).toContain('đang được dọn');
  });

  it('gives the whole group to a housekeeper who worked at the branch — and only such a one', async () => {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    // Never on shift at Chi nhánh 1: not its staff.
    expect((await manager1.post(`/api/housekeeping/manager/work-groups/${g.id}/assign`).send({ assigneeUserId: hoaId })).status).toBe(422);
    await startShiftAt(hoa, cn1);
    const given = await manager1.post(`/api/housekeeping/manager/work-groups/${g.id}/assign`).send({ assigneeUserId: hoaId });
    expect(given.status).toBe(200);
    expect(given.body.group.assignee).toEqual({ id: hoaId, name: 'Chị Hoa' });
    expect(given.body.group.items.every((t: Task) => t.assignee?.id === hoaId)).toBe(true);
    const staff = (await manager1.get('/api/housekeeping/manager/staff?branchId=' + cn1)).body.staff.map((s: { id: number }) => s.id);
    expect(staff).toEqual([hoaId]);
    expect((await manager2.post(`/api/housekeeping/manager/work-groups/${g.id}/assign`).send({ assigneeUserId: null })).status).toBe(403);
  });
});

describe('F. "Nhận công việc" — the whole group, one housekeeper', () => {
  it('lists the shift branch\'s groups and who holds each; one accept takes every place', async () => {
    const g1 = await group([room('101', ['OUT']), { areaKind: 'STAIRCASE', floor: '1', note: 'Lau tay vịn' }]);
    await group([room('801', ['OUT'])], { branchId: cn2 }, admin);
    expect(await workerGroups(lan)).toEqual({ working: false, groups: [] });
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    expect((await workerGroups(lan)).groups.map((g) => g.number)).toEqual([1]);

    const taken = await accept(lan, g1.id);
    expect(taken.status).toBe(200);
    expect(taken.body.group).toMatchObject({ assignee: { id: lanId, name: 'Chị Lan' }, status: { code: 'ACCEPTED' } });
    expect(taken.body.group.items.every((t: Task) => t.assignee?.id === lanId && t.phase === 'ACCEPTED')).toBe(true);
    // Colleagues see who has it — and cannot take it.
    const seen = (await workerGroups(hoa)).groups[0]!;
    expect(seen.assignee).toEqual({ id: lanId, name: 'Chị Lan' });
    expect(seen.items[0]!.inspection).toBeNull();
    const second = await accept(hoa, g1.id);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('Chị Lan');
    // No room of it can be claimed alone.
    expect((await hoa.post('/api/housekeeping/work/claim').send({ taskIds: [g1.items[0]!.id] })).status).toBe(409);
    expect((await eventsOf(g1.items[0]!.id)).map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED', 'CLAIM_REJECTED']);
  });

  it('gives a group to exactly one of two housekeepers pressing at the same moment', async () => {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    const [r1, r2] = await Promise.all([accept(lan, g.id), accept(hoa, g.id)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? lanId : hoaId;
    const rows = await testPrisma.housekeepingRoomTask.findMany({ where: { workGroupId: g.id } });
    expect(rows.every((r) => r.assigneeUserId === winner)).toBe(true);
    expect((await testPrisma.housekeepingWorkGroup.findUniqueOrThrow({ where: { id: g.id } })).assigneeUserId).toBe(winner);
  });

  it('refuses off shift and at another branch', async () => {
    const g = await group([room('101', ['OUT'])]);
    expect((await accept(lan, g.id)).status).toBe(409);
    await startShiftAt(mai, cn2);
    expect((await accept(mai, g.id)).status).toBe(404);
    // Not a housekeeping role at all: refused. (A Quản lý buồng phòng off shift: section J.)
    expect((await accept(letan1, g.id)).status).toBe(403);
    expect((await accept(manager1, g.id)).status).toBe(409);
  });

  it('works each room through the usual lifecycle and keeps the day\'s history', async () => {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    const [p101, p102] = g.items;
    await startShiftAt(lan, cn1);
    await accept(lan, g.id);
    expect((await lan.post(`${url(p101!.id)}/start`)).status).toBe(409);
    setClock({ now: () => hcm(DAY, '08:10') });
    expect((await lan.post(`${url(p101!.id)}/begin-inspection`)).body.task.phase).toBe('INSPECTING');
    expect((await lan.post(`${url(p101!.id)}/inspect`).send({ issues: [] })).body.task.phase).toBe('AWAITING_CLEANING');
    setClock({ now: () => hcm(DAY, '08:20') });
    expect((await lan.post(`${url(p101!.id)}/start`)).body.task.phase).toBe('CLEANING');
    setClock({ now: () => hcm(DAY, '08:50') });
    expect((await lan.post(`${url(p101!.id)}/complete`).send({})).body.task.phase).toBe('COMPLETED');
    expect((await task(p102!.id)).state).toBe('NOT_STARTED');

    const board = (await manager1.get(`/api/housekeeping/manager/work-groups?date=${DAY}`)).body.groups[0] as Group;
    expect(board.counts).toMatchObject({ items: 2, completed: 1 });
    expect(board.status.code).toBe('IN_PROGRESS');
    const history = (await lan.get(`/api/housekeeping/work/history?date=${DAY}`)).body;
    expect(history.items.map((t: Task) => t.id)).toEqual([p101!.id]);
    expect(history.totals).toEqual({ completed: 1, noClean: 0 });
    expect(history.shifts).toHaveLength(1);
    expect((await hoa.get(`/api/housekeeping/work/history?date=${DAY}`)).body.items).toEqual([]);
  });
});

describe('G. "Không cần dọn" — a reason, then the manager decides', () => {
  async function accepted() {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    await startShiftAt(lan, cn1);
    await accept(lan, g.id);
    return g.items;
  }

  it('needs the reason and the room\'s own housekeeper, and holds the room while waiting', async () => {
    const [p101] = await accepted();
    expect((await lan.post(`${url(p101!.id)}/no-clean`).send({ reason: '   ' })).status).toBe(422);
    await startShiftAt(hoa, cn1);
    expect((await hoa.post(`${url(p101!.id)}/no-clean`).send({ reason: 'x' })).status).toBe(403);
    const asked = await lan.post(`${url(p101!.id)}/no-clean`).send({ reason: 'Khách không muốn dọn' });
    expect(asked.status).toBe(200);
    expect(asked.body.task).toMatchObject({ phase: 'NO_CLEAN_PENDING', noClean: { status: 'PENDING', reason: 'Khách không muốn dọn', requestedByName: 'Chị Lan' } });
    expect((await lan.post(`${url(p101!.id)}/inspect`).send({ issues: [] })).status).toBe(409);
    const board = (await manager1.get(`/api/housekeeping/manager/work-groups?date=${DAY}`)).body.groups[0] as Group;
    expect(board.counts.noCleanPending).toBe(1);
  });

  it('on approval takes the room out of the work, keeping the request, decision and history', async () => {
    const [p101, p102] = await accepted();
    await lan.post(`${url(p101!.id)}/no-clean`).send({ reason: 'Khách không muốn dọn' });
    // Not the other branch's manager.
    expect((await manager2.post(`/api/housekeeping/manager/tasks/${p101!.id}/no-clean-decision`).send({ approve: true })).status).toBe(403);
    expect((await lan.post(`/api/housekeeping/manager/tasks/${p101!.id}/no-clean-decision`).send({ approve: true })).status).toBe(403);
    const ok = await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/no-clean-decision`).send({ approve: true, note: 'Đồng ý' });
    expect(ok.status).toBe(200);
    expect(ok.body.task).toMatchObject({ phase: 'NO_CLEAN', voided: true, noClean: { status: 'APPROVED', decidedByName: 'QL qlbp1' } });
    const row = await task(p101!.id);
    expect(row.voidReason).toBe('Không cần dọn: Khách không muốn dọn');
    expect((await eventsOf(p101!.id)).map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED', 'NO_CLEAN_REQUESTED', 'NO_CLEAN_APPROVED']);
    const mine = (await workerGroups(lan)).groups[0]!;
    expect(mine.counts.items).toBe(1);
    expect(mine.items.find((t) => t.id === p101!.id)!.phase).toBe('NO_CLEAN');
    expect((await task(p102!.id)).voidedAt).toBeNull();
    expect((await lan.get(`/api/housekeeping/work/history?date=${DAY}`)).body.totals).toEqual({ completed: 0, noClean: 1 });
    expect(await testPrisma.notification.count({ where: { userId: lanId } })).toBe(1);
    // Decided once.
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/no-clean-decision`).send({ approve: false })).status).toBe(409);
  });

  it('on rejection returns the room to work, and the housekeeper goes on', async () => {
    const [p101] = await accepted();
    await lan.post(`${url(p101!.id)}/inspect`).send({ issues: [] });
    await lan.post(`${url(p101!.id)}/no-clean`).send({ reason: 'Khách đang ngủ' });
    const no = await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/no-clean-decision`).send({ approve: false, note: 'Khách đã đồng ý dọn' });
    expect(no.body.task).toMatchObject({ phase: 'AWAITING_CLEANING', voided: false, noClean: { status: 'REJECTED' } });
    expect((await lan.post(`${url(p101!.id)}/start`)).status).toBe(200);
    // Too late to ask once cleaning has begun.
    expect((await lan.post(`${url(p101!.id)}/no-clean`).send({ reason: 'x' })).status).toBe(409);
  });
});

describe('H. the supervisors\' table and "Giao lại"', () => {
  it('lists every place with its group, and hands one waiting for cleaning to a branch housekeeper', async () => {
    const g = await group([room('101', ['OUT']), { areaKind: 'HALLWAY', floor: '1', note: 'Lau' }]);
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    await accept(lan, g.id);
    const p101 = g.items[0]!;
    await lan.post(`${url(p101.id)}/inspect`).send({ issues: [] });

    const rows = (await receptionManager.get(`/api/housekeeping/work-orders?date=${DAY}`)).body.tasks as Task[];
    expect(rows.map((t) => [t.areaLabel, t.workGroup?.number])).toEqual(
      expect.arrayContaining([
        ['Phòng - 101', 1],
        ['Hành lang - Tầng 1', 1],
      ]),
    );
    expect((await letan1.get(`/api/housekeeping/work-orders?date=${DAY}`)).status).toBe(403);
    const staff = (await receptionManager.get(`/api/housekeeping/work-orders/staff?branchId=${cn1}`)).body.staff.map((s: { id: number }) => s.id);
    expect(staff.sort()).toEqual([lanId, hoaId].sort());
    expect((await receptionManager.post(`/api/housekeeping/work-orders/${p101.id}/reassign`).send({ assigneeUserId: maiId })).status).toBe(422);
    const moved = await receptionManager.post(`/api/housekeeping/work-orders/${p101.id}/reassign`).send({ assigneeUserId: hoaId, reason: 'Chị Lan về sớm' });
    expect(moved.status).toBe(200);
    expect(moved.body.task.assignee).toEqual({ id: hoaId, name: 'Chị Hoa' });
    expect((await hoa.post(`${url(p101.id)}/start`)).status).toBe(200);
  });
});

describe('I. one group across floors', () => {
  it('saves rooms and areas of several floors — and the Rooftop — as ONE group, or nothing at all', async () => {
    const g = await group(
      [room('101', ['OUT']), { areaKind: 'HALLWAY', floor: '1', note: 'Lau sàn' }, room('201', ['OC']), room('802', ['VC']), { areaKind: 'ROOFTOP', note: 'Quét lá' }],
      { branchId: cn2, name: 'Tổng vệ sinh buổi sáng' },
      admin,
    );
    expect(g).toMatchObject({ number: 1, name: 'Tổng vệ sinh buổi sáng' });
    expect(g.floors).toEqual(['Tầng 1', 'Tầng 2', 'Tầng 8', 'Rooftop']);
    expect(new Set(g.items.map((t) => t.workGroup?.id))).toEqual(new Set([g.id]));
    expect(await testPrisma.housekeepingWorkGroup.count()).toBe(1);
    // One bad place on another floor: no group, no place saved.
    const bad = await createGroup([room('301', ['OUT']), room('401', ['OUT', 'VC'])], { branchId: cn2 }, admin);
    expect(bad.status).toBe(422);
    expect(await testPrisma.housekeepingRoomTask.count({ where: { roomNumber: '301' } })).toBe(0);
    // The same room twice — wherever in the form it was picked — is refused.
    expect((await createGroup([room('301', ['OUT']), room('301', ['OC'])], { branchId: cn2 }, admin)).status).toBe(422);
  });
});

describe('J. the Quản lý buồng phòng takes a group and does the work itself', () => {
  it('works a shift at its OWN branch only — no address, nothing the request names', async () => {
    const g = await group([room('101', ['OUT'])]);
    // Off shift: no work taken.
    const off = await accept(manager1, g.id);
    expect(off.status).toBe(409);
    expect(off.body.error.message).toContain('Vào ca làm việc');
    const started = await manager1.post('/api/housekeeping/shift/start').send({ address: await addressOf(cn2), branchId: cn2 });
    expect(started.status).toBe(201);
    expect(started.body.shift.current.branch.id).toBe(cn1);
    expect((await lookup(manager1, '17')).status).toBe(403);
    // Another branch's manager, on its own shift, cannot take CN1's group.
    await manager2.post('/api/housekeeping/shift/start').send({});
    expect((await accept(manager2, g.id)).status).toBe(404);
    // Only the managers of housekeeping work a shift.
    expect((await admin.post('/api/housekeeping/shift/start').send({})).status).toBe(403);
    expect((await letan1.post('/api/housekeeping/shift/start').send({})).status).toBe(403);
  });

  it('accepts a free group and takes each room through the usual lifecycle, recorded on its shift', async () => {
    const g = await group([room('101', ['OUT']), { areaKind: 'HALLWAY', floor: '1', note: 'Lau sàn' }]);
    const [p101, hallway] = g.items;
    await manager1.post('/api/housekeeping/shift/start').send({});
    const taken = await accept(manager1, g.id);
    expect(taken.status).toBe(200);
    expect(taken.body.group.assignee).toEqual({ id: (await testPrisma.user.findUniqueOrThrow({ where: { username: 'qlbp1' } })).id, name: 'QL qlbp1' });
    // Colleagues see who has it and cannot take it.
    await startShiftAt(lan, cn1);
    const seen = (await workerGroups(lan)).groups[0]!;
    expect(seen.assignee?.name).toBe('QL qlbp1');
    expect((await accept(lan, g.id)).status).toBe(409);

    setClock({ now: () => hcm(DAY, '08:10') });
    expect((await manager1.post(`${url(p101!.id)}/begin-inspection`)).body.task.phase).toBe('INSPECTING');
    const inspected = await manager1.post(`${url(p101!.id)}/inspect`).send({ issues: [{ type: 'ODOR' }] });
    expect(inspected.status).toBe(201);
    const inspection = await testPrisma.roomInspection.findFirstOrThrow({ where: { roomNumber: '101' } });
    expect(inspection.branchId).toBe(cn1);
    expect(inspection.workSegmentId).not.toBeNull();
    setClock({ now: () => hcm(DAY, '08:20') });
    expect((await manager1.post(`${url(p101!.id)}/start`)).body.task.phase).toBe('CLEANING');
    setClock({ now: () => hcm(DAY, '08:45') });
    const done = await manager1.post(`${url(p101!.id)}/complete`).send({});
    expect(done.body.task).toMatchObject({ phase: 'COMPLETED', cleanedBy: { name: 'QL qlbp1' } });
    // A shared area has no "Dọn phòng": its check completes it.
    expect((await manager1.post(`${url(hallway!.id)}/start`)).status).toBe(409);
    setClock({ now: () => hcm(DAY, '08:55') });
    const area = await manager1.post(`${url(hallway!.id)}/inspect`).send({ issues: [], note: 'Sàn sạch' });
    expect(area.status).toBe(201);
    expect(area.body.task).toMatchObject({ phase: 'COMPLETED', inspectionNote: 'Sàn sạch', cleanedBy: { name: 'QL qlbp1' } });
    expect(await task(hallway!.id)).toMatchObject({ state: 'COMPLETED', reviewResult: 'PASSED', durationSeconds: 0 });
    // Saved once: a second check is refused.
    expect((await manager1.post(`${url(hallway!.id)}/inspect`).send({ issues: [] })).status).toBe(409);
    // "Không cần dọn" stays the housekeeper's to ask and the manager's to decide.
    expect((await manager1.post(`${url(hallway!.id)}/no-clean`).send({ reason: 'x' })).status).toBe(403);
    // Its own cleaning needs no review of its own: recorded "Đạt" as it completed.
    expect(await task(p101!.id)).toMatchObject({ reviewResult: 'PASSED', reviewedByNameSnapshot: 'QL qlbp1' });
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/review`).send({ result: 'PASSED' })).status).toBe(409);
  });

  it('never gives one group to both a manager and a housekeeper pressing at the same moment', async () => {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    await manager1.post('/api/housekeeping/shift/start').send({});
    await startShiftAt(hoa, cn1);
    const [r1, r2] = await Promise.all([accept(manager1, g.id), accept(hoa, g.id)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const owner = (await testPrisma.housekeepingWorkGroup.findUniqueOrThrow({ where: { id: g.id } })).assigneeUserId;
    const rows = await testPrisma.housekeepingRoomTask.findMany({ where: { workGroupId: g.id } });
    expect(rows.every((r) => r.assigneeUserId === owner)).toBe(true);
    // After "Kết thúc ca" the manager takes nothing more.
    await manager1.post('/api/housekeeping/shift/end').send({});
    const g2 = await group([room('201', ['VC'])]);
    expect((await accept(manager1, g2.id)).status).toBe(409);
  });
});

describe('K. a place in an open item is not given to a second group — until its work is resolved', () => {
  const openRows = (roomNumber: string) => testPrisma.housekeepingRoomTask.count({ where: { roomNumber, voidedAt: null, reviewResult: null } });

  it('refuses a room or a fixed area already in an open group — and lets "Khác" be described twice', async () => {
    await group([room('101', ['OUT']), { areaKind: 'HALLWAY', floor: '1', note: 'Lau sàn' }]);
    const again = await createGroup([room('101', ['OC'])]);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('Phòng 101 (Công việc 1)');
    const hallway = await createGroup([{ areaKind: 'HALLWAY', floor: '1', note: 'Lau kính' }]);
    expect(hallway.status).toBe(409);
    expect(hallway.body.error.message).toContain('Hành lang - Tầng 1');
    // Another floor's hallway is another place; "Khác" is a free description.
    await group([{ areaKind: 'HALLWAY', floor: '2', note: 'Lau sàn' }, { areaKind: 'OTHER', floor: '1', note: 'Gom rác' }]);
    await group([{ areaKind: 'OTHER', floor: '1', note: 'Thay bóng đèn' }]);
    // Adding to a group is held to the same rule.
    const g = await group([room('103', ['VC'])]);
    expect((await manager1.post(`/api/housekeeping/manager/work-groups/${g.id}/items`).send({ items: [room('101', ['VC'])] })).status).toBe(409);
  });

  it('saves a room of an untouched floor — room 401, as reported — and refuses it to a second group with a clear 409', async () => {
    // Nothing on floor 4 yet: the save must work (it used to fail with a 500 in the place lock).
    expect(await openRows('401')).toBe(0);
    const g = await group([room('401', ['OUT'])]);
    expect(g.items.map((i) => i.roomNumber)).toEqual(['401']);
    expect(await openRows('401')).toBe(1);
    // A genuine conflict: 409, naming the room and its group — never a system error.
    const again = await createGroup([room('401', ['OC'])]);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain(`Phòng 401 (Công việc ${g.number})`);
    // Room 402, untouched, is still free.
    expect((await createGroup([room('402', ['OUT'])])).status).toBe(201);
  });

  it('gives a room to ONE of two managers saving it at the same moment — whatever code each picked', async () => {
    const [a, b] = await Promise.all([createGroup([room('201', ['OUT'])]), createGroup([room('201', ['OC'])], {}, manager1)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await openRows('201')).toBe(1);
    const [c, d] = await Promise.all([
      createGroup([{ areaKind: 'STAIRCASE', floor: '2', note: 'Lau' }]),
      createGroup([{ areaKind: 'STAIRCASE', floor: '2', note: 'Quét' }]),
    ]);
    expect([c.status, d.status].sort()).toEqual([201, 409]);
    expect(await openRows('Cầu thang - Tầng 2')).toBe(1);
  });

  it('offers the room again once its work is resolved: reviewed, "Không cần dọn" approved, or removed — not before', async () => {
    // 1. Cleaned by a housekeeper: held while it waits for "Đạt / Không đạt", free once reviewed.
    const g1 = await group([room('101', ['OUT'])]);
    await startShiftAt(lan, cn1);
    expect((await accept(lan, g1.id)).status).toBe(200);
    const [p101] = g1.items;
    expect((await lan.post(`${url(p101!.id)}/begin-inspection`)).status).toBe(200);
    expect((await lan.post(`${url(p101!.id)}/inspect`).send({ issues: [] })).status).toBe(201);
    expect((await lan.post(`${url(p101!.id)}/start`)).status).toBe(200);
    expect((await lan.post(`${url(p101!.id)}/complete`).send({})).status).toBe(200);
    expect((await createGroup([room('101', ['VC'])])).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p101!.id}/review`).send({ result: 'PASSED' })).status).toBe(200);
    expect((await createGroup([room('101', ['VC'])])).status).toBe(201);

    // 2. "Không cần dọn": held while it waits for the manager, free once approved.
    const g2 = await group([room('102', ['OC'])]);
    expect((await accept(lan, g2.id)).status).toBe(200);
    const [p102] = g2.items;
    expect((await lan.post(`${url(p102!.id)}/no-clean`).send({ reason: 'Khách không muốn dọn' })).status).toBe(200);
    expect((await createGroup([room('102', ['OC'])])).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${p102!.id}/no-clean-decision`).send({ approve: true })).status).toBe(200);
    expect((await createGroup([room('102', ['OC'])])).status).toBe(201);

    // 3. Removed from its group: free at once.
    const g3 = await group([room('103', ['OUT'])]);
    expect((await createGroup([room('103', ['OUT'])])).status).toBe(409);
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${g3.items[0]!.id}/void`).send({ reason: 'Khách ở thêm' })).status).toBe(200);
    expect((await createGroup([room('103', ['OUT'])])).status).toBe(201);
  });
});

describe('L. "Chưa dọn — chuyển người khác dọn" and the manager told of "Không cần dọn"', () => {
  async function inspectedByLan() {
    const g = await group([room('101', ['OUT']), room('102', ['OC'])]);
    await startShiftAt(lan, cn1);
    await accept(lan, g.id);
    const p101 = g.items[0]!;
    expect((await lan.post(`${url(p101.id)}/inspect`).send({ issues: [] })).status).toBe(201);
    return { g, p101 };
  }
  const managerId = async () => (await testPrisma.user.findUniqueOrThrow({ where: { username: 'qlbp1' } })).id;

  it('releases an inspected room to the branch — inspection kept, nothing cleaned, no stock moved', async () => {
    const { p101 } = await inspectedByLan();
    await startShiftAt(hoa, cn1);
    const released = await lan.post(`${url(p101.id)}/release`).send({ reason: 'Hết ca' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.task).toMatchObject({ state: 'INSPECTED', phase: 'AWAITING_CLEANING', assignee: null, workGroup: null, handoff: { byName: 'Chị Lan', reason: 'Hết ca' } });
    const row = await task(p101.id);
    expect(row).toMatchObject({ assigneeUserId: null, workGroupId: null, startedAt: null, completedAt: null, voidedAt: null, noCleanStatus: null });
    // Chị Lan's inspection stays hers.
    expect((await testPrisma.roomInspection.findUniqueOrThrow({ where: { id: row.inspectionId! } })).createdByUserId).toBe(lanId);
    expect((await eventsOf(p101.id)).map((e) => e.type)).toEqual(['CREATED', 'ACCEPTED', 'INSPECTED', 'RELEASED']);
    expect(await testPrisma.inventoryMovement.count({ where: { taskId: p101.id } })).toBe(0);
    // The colleague on shift there and the branch's manager are told; Chị Lan's other room stays hers.
    expect(await testPrisma.notification.count({ where: { userId: hoaId, title: { contains: 'Cần người dọn' } } })).toBe(1);
    expect(await testPrisma.notification.count({ where: { userId: await managerId(), title: { contains: 'Cần người dọn' } } })).toBe(1);
    expect(await testPrisma.notification.count({ where: { userId: maiId } })).toBe(0);
    // It no longer opens for Chị Lan; the room is still taken for the day.
    expect((await lan.get(url(p101.id))).status).toBe(403);
    expect((await createGroup([room('101', ['OC'])])).status).toBe(409);
  });

  it('lets ONE colleague of the branch take it, who then cleans it — and records who did what', async () => {
    const { p101 } = await inspectedByLan();
    await lan.post(`${url(p101.id)}/release`).send({});
    await startShiftAt(hoa, cn1);
    await startShiftAt(mai, cn1);
    const list = (await hoa.get(`/api/housekeeping/work/items?date=${DAY}`)).body.tasks as (Task & { handoff: { byName: string } | null })[];
    expect(list.find((t) => t.id === p101.id)).toMatchObject({ assignee: null, handoff: { byName: 'Chị Lan' } });
    const [a, b] = await Promise.all([
      hoa.post('/api/housekeeping/work/claim').send({ taskIds: [p101.id] }),
      mai.post('/api/housekeeping/work/claim').send({ taskIds: [p101.id] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [winner, winnerId] = a.status === 200 ? [hoa, hoaId] : [mai, maiId];
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error.message).toContain('vừa được người khác nhận');
    expect((await winner.post(`${url(p101.id)}/start`)).status).toBe(200);
    expect((await winner.post(`${url(p101.id)}/complete`).send({})).status).toBe(200);
    const done = await task(p101.id);
    expect(done).toMatchObject({ state: 'COMPLETED', cleanedByUserId: winnerId, assigneeUserId: winnerId });
    expect((await testPrisma.roomInspection.findUniqueOrThrow({ where: { id: done.inspectionId! } })).createdByUserId).toBe(lanId);
    // The test clock stands still, so the history is checked by what it holds, not by its order.
    const events = await eventsOf(p101.id);
    const count = (type: string) => events.filter((e) => e.type === type).length;
    expect([count('RELEASED'), count('ACCEPTED'), count('CLAIM_REJECTED'), count('STARTED'), count('COMPLETED')]).toEqual([1, 2, 1, 1, 1]);
    expect(events.find((e) => e.type === 'RELEASED')).toMatchObject({ actorUserId: lanId });
    expect(events.filter((e) => e.type === 'ACCEPTED').map((e) => e.actorUserId).sort()).toEqual([lanId, winnerId].sort());
  });

  it('refuses a release before the inspection, by another, by the manager, once cleaning began, or while "Không cần dọn" waits', async () => {
    const { g, p101 } = await inspectedByLan();
    const p102 = g.items[1]!;
    expect((await lan.post(`${url(p102.id)}/release`).send({})).status).toBe(409);
    await startShiftAt(hoa, cn1);
    expect((await hoa.post(`${url(p101.id)}/release`).send({})).status).toBe(403);
    expect((await manager1.post(`${url(p101.id)}/release`).send({})).status).toBe(403);
    await lan.post(`${url(p102.id)}/inspect`).send({ issues: [] });
    await lan.post(`${url(p102.id)}/no-clean`).send({ reason: 'Khách không muốn dọn' });
    expect((await lan.post(`${url(p102.id)}/release`).send({})).status).toBe(409);
    expect((await lan.post(`${url(p101.id)}/start`)).status).toBe(200);
    expect((await lan.post(`${url(p101.id)}/release`).send({})).status).toBe(409);
    expect((await task(p101.id)).assigneeUserId).toBe(lanId);
  });

  it('tells the branch\'s Quản lý buồng phòng of a "Không cần dọn" request — and no other branch\'s', async () => {
    const { p101 } = await inspectedByLan();
    expect((await lan.post(`${url(p101.id)}/no-clean`).send({ reason: 'Khách không muốn dọn' })).status).toBe(200);
    const told = await testPrisma.notification.findMany({ where: { title: { contains: 'Duyệt không cần dọn' } }, select: { userId: true, body: true, link: true } });
    expect(told).toEqual([{ userId: await managerId(), body: expect.stringContaining('Khách không muốn dọn'), link: '/app/hk/rooms' }]);
    // Asked once: a second request while it waits is refused.
    expect((await lan.post(`${url(p101.id)}/no-clean`).send({ reason: 'Lần nữa' })).status).toBe(409);
  });
});
