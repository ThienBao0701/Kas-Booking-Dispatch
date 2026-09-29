/**
 * "BUỒNG PHÒNG" — room inspections, and the collection Reception makes on them.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. One inspection yields several INDEPENDENT issue rows, saved atomically;
 *      the branch is the account's and nothing the browser sends changes it.
 *   2. A housekeeping account reaches the housekeeping and delivery endpoints
 *      and NOTHING else — not a booking, an incident or a report.
 *   3. Reception settles each issue on its own, on its own branch only. Đã thu
 *      needs a method, Không thu được needs a reason, and the database says so
 *      too.
 *   4. Collection is SEPARATE from the Payment Ledger: it never touches the
 *      drawer or the payment tables.
 *   5. Each role sees what it may: Housekeeping its own inspections without
 *      money, Reception its branch, the Admin everything — and only the Admin
 *      can void.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
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

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let hk1: Agent;
let hk1b: Agent;
let hk2: Agent;
let letan: Agent;
let letan2: Agent;
let admin: Agent;
let tech: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findFirstOrThrow({ where: { id: { not: cn1 } }, orderBy: { id: 'asc' } })).id;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  await createAdmin({ mustChangePassword: false });
  await createUser({ username: 'kythuat', password: RECEPTIONIST_PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  await createUser({ username: 'buong1', password: RECEPTIONIST_PASSWORD, fullName: 'Buồng Một', role: 'HOUSEKEEPING', branchId: cn1 });
  await createUser({ username: 'buong1b', password: RECEPTIONIST_PASSWORD, fullName: 'Buồng Một B', role: 'HOUSEKEEPING', branchId: cn1 });
  await createUser({ username: 'buong2', password: RECEPTIONIST_PASSWORD, fullName: 'Buồng Hai', role: 'HOUSEKEEPING', branchId: cn2 });
  for (const [name, set] of [
    ['letan1', (a: Agent) => (letan = a)],
    ['letan2', (a: Agent) => (letan2 = a)],
    ['buong1', (a: Agent) => (hk1 = a)],
    ['buong1b', (a: Agent) => (hk1b = a)],
    ['buong2', (a: Agent) => (hk2 = a)],
    ['kythuat', (a: Agent) => (tech = a)],
  ] as const) {
    set((await loginAgent(app, name, RECEPTIONIST_PASSWORD)).agent);
  }
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetIssueData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  setClock({ now: () => hcm('2026-09-19', '10:00') });
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

const inspect = (body: Record<string, unknown>, agent: Agent = hk1) =>
  agent.post('/api/housekeeping/inspections').send(body);

async function threeIssues(agent: Agent = hk1) {
  const res = await inspect(
    {
      roomNumber: '302',
      staffName: 'Chị Lan',
      issues: [
        { type: 'SMOKING' },
        { type: 'LOST_ITEM', note: 'Áo khoác đen' },
        { type: 'OTHER', note: 'Rèm bị rách' },
      ],
    },
    agent,
  );
  expect(res.status).toBe(201);
  return res.body.inspection.issues as { id: string; type: string }[];
}

const collect = (id: string, body: Record<string, unknown>, agent: Agent = letan) =>
  agent.put(`/api/housekeeping/issues/${id}/collection`).send(body);

describe('recording an inspection', () => {
  it('saves one inspection with several independent issues, on the account’s branch', async () => {
    const issues = await threeIssues();
    expect(issues.map((i) => i.type)).toEqual(['SMOKING', 'LOST_ITEM', 'OTHER']);
    expect(await testPrisma.roomInspection.count()).toBe(1);
    expect(await testPrisma.roomInspectionIssue.count()).toBe(3);
    const stored = await testPrisma.roomInspection.findFirstOrThrow();
    expect(stored).toMatchObject({ branchId: cn1, roomNumber: '302', staffName: 'Chị Lan', createdByNameSnapshot: 'Buồng Một' });
    expect(stored.createdAt.toISOString()).toBe(hcm('2026-09-19', '10:00').toISOString());
  });

  it('ignores a branch sent by the browser', async () => {
    const res = await inspect({ roomNumber: '101', staffName: 'X', branchId: cn2, issues: [{ type: 'ODOR' }] });
    expect(res.status).toBe(201);
    expect(res.body.inspection.issues[0].branchId).toBe(cn1);
  });

  it('saves nothing when any one issue is invalid', async () => {
    const res = await inspect({ roomNumber: '101', staffName: 'X', issues: [{ type: 'SMOKING' }, { type: 'OTHER' }] });
    expect(res.status).toBe(422);
    expect(await testPrisma.roomInspection.count()).toBe(0);
  });

  it.each([
    ['no issues', { roomNumber: '101', staffName: 'X', issues: [] }],
    ['no room', { roomNumber: '  ', staffName: 'X', issues: [{ type: 'ODOR' }] }],
    ['no person', { roomNumber: '101', staffName: '', issues: [{ type: 'ODOR' }] }],
    ['an unknown type', { roomNumber: '101', staffName: 'X', issues: [{ type: 'FIRE' }] }],
    ['"Vấn đề khác" with no description', { roomNumber: '101', staffName: 'X', issues: [{ type: 'OTHER', note: ' ' }] }],
  ])('refuses %s', async (_label, body) => {
    expect((await inspect(body)).status).toBe(422);
  });

  it('is for Bộ phận buồng phòng only', async () => {
    const body = { roomNumber: '101', staffName: 'X', issues: [{ type: 'ODOR' }] };
    expect((await inspect(body, letan)).status).toBe(403);
    expect((await inspect(body, admin)).status).toBe(403);
    expect((await inspect(body, tech)).status).toBe(403);
  });

  it('tells the branch’s receptionists — and only them', async () => {
    await threeIssues();
    const own = await testPrisma.notification.findMany({ where: { user: { username: 'letan1' } } });
    expect(own).toHaveLength(1);
    expect(own[0]!.body).toContain('Phòng 302');
    expect(await testPrisma.notification.count({ where: { user: { username: 'letan2' } } })).toBe(0);
  });
});

describe('what a housekeeping account may reach', () => {
  it.each([
    '/api/bookings/new',
    '/api/bookings/history',
    '/api/issues',
    '/api/issues/summary',
    '/api/reception/reports',
    '/api/reception/shifts/cash',
    '/api/branches',
    '/api/chat/channels',
    '/api/admin/users',
    '/api/charge-documents',
  ])('is refused %s', async (path) => {
    expect((await hk1.get(path)).status).toBe(403);
  });

  it('may sign in, read its profile, and use its own endpoints', async () => {
    expect((await hk1.get('/api/auth/me')).status).toBe(200);
    expect((await hk1.get('/api/housekeeping/options')).status).toBe(200);
    expect((await hk1.get('/api/housekeeping/issues')).status).toBe(200);
    expect((await hk1.get('/api/hotel-deliveries')).status).toBe(200);
    const badges = await hk1.get('/api/nav-badges');
    expect(badges.status).toBe(200);
    expect(badges.body.counts).toMatchObject({ new: 0, pendingReview: 0, chat: 0 });
  });

  it('cannot settle or void an issue', async () => {
    const [issue] = await threeIssues();
    expect((await collect(issue!.id, { status: 'PENDING' }, hk1)).status).toBe(403);
    expect((await hk1.post(`/api/housekeeping/issues/${issue!.id}/void`).send({ reason: 'x' })).status).toBe(403);
  });
});

describe('settling an issue', () => {
  it('settles each issue on its own', async () => {
    const [smoking, lost, other] = await threeIssues();
    const res = await collect(smoking!.id, { status: 'COLLECTED', amount: 500_000, method: 'CASH', note: 'Phạt hút thuốc' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      collectionStatus: 'COLLECTED',
      collection: { amount: 500_000, method: 'CASH', methodLabel: 'Tiền mặt' },
    });
    // The siblings from the same inspection are untouched.
    expect((await letan.get('/api/housekeeping/issues')).body.issues.filter(
      (i: { id: string; collectionStatus: string }) => [lost!.id, other!.id].includes(i.id),
    ).map((i: { collectionStatus: string }) => i.collectionStatus)).toEqual(['PENDING', 'PENDING']);
    expect(await testPrisma.roomIssueCollection.count()).toBe(1);
  });

  it('needs a method for Đã thu, and only one of the three', async () => {
    const [issue] = await threeIssues();
    expect((await collect(issue!.id, { status: 'COLLECTED', amount: 1000 })).status).toBe(422);
    expect((await collect(issue!.id, { status: 'COLLECTED', amount: 1000, method: 'DEBT' })).status).toBe(422);
    for (const method of ['CASH', 'TRANSFER', 'CARD']) {
      expect((await collect(issue!.id, { status: 'COLLECTED', amount: 1000, method })).status).toBe(200);
    }
  });

  it('needs a reason for Không thu được', async () => {
    const [issue] = await threeIssues();
    expect((await collect(issue!.id, { status: 'UNCOLLECTIBLE', amount: 200_000 })).status).toBe(422);
    expect((await collect(issue!.id, { status: 'UNCOLLECTIBLE', amount: 200_000, reason: '   ' })).status).toBe(422);
    const ok = await collect(issue!.id, { status: 'UNCOLLECTIBLE', amount: 200_000, reason: 'Khách đã rời đi' });
    expect(ok.status).toBe(200);
    expect(ok.body.issue.collection).toMatchObject({ status: 'UNCOLLECTIBLE', reason: 'Khách đã rời đi', method: null });
  });

  it('refuses a negative or fractional amount', async () => {
    const [issue] = await threeIssues();
    expect((await collect(issue!.id, { status: 'PENDING', amount: -1 })).status).toBe(422);
    expect((await collect(issue!.id, { status: 'PENDING', amount: 10.5 })).status).toBe(422);
  });

  it('drops a method or reason that does not belong to the status', async () => {
    const [issue] = await threeIssues();
    const res = await collect(issue!.id, { status: 'PENDING', amount: 100_000, method: 'CASH', reason: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.issue.collection).toMatchObject({ status: 'PENDING', method: null, reason: null });
  });

  it('keeps every save in a trail', async () => {
    const [issue] = await threeIssues();
    await collect(issue!.id, { status: 'PENDING', amount: 300_000 });
    setClock({ now: () => hcm('2026-09-19', '11:00') });
    await collect(issue!.id, { status: 'COLLECTED', amount: 300_000, method: 'CARD' });
    const res = await letan.get('/api/housekeeping/issues');
    expect(res.body.issues[0].history.map((h: { statusLabel: string }) => h.statusLabel)).toEqual(['Chưa thu', 'Đã thu']);
    expect(await testPrisma.roomIssueCollectionEvent.count()).toBe(2);
  });

  it('is limited to the receptionist’s own branch', async () => {
    const [issue] = await threeIssues();
    expect((await collect(issue!.id, { status: 'PENDING' }, letan2)).status).toBe(403);
    expect((await collect(issue!.id, { status: 'PENDING' }, admin)).status).toBe(200);
  });

  it('is enforced by the database as well, for a caller that skips the service', async () => {
    const [issue] = await threeIssues();
    const user = await testPrisma.user.findFirstOrThrow({ where: { username: 'letan1' } });
    const base = {
      issueId: issue!.id,
      amount: 1,
      recordedByUserId: user.id,
      recordedByNameSnapshot: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await expect(testPrisma.roomIssueCollection.create({ data: { ...base, status: 'COLLECTED' } })).rejects.toThrow();
    await expect(testPrisma.roomIssueCollection.create({ data: { ...base, status: 'UNCOLLECTIBLE', reason: '  ' } })).rejects.toThrow();
  });
});

describe('collection is not a payment', () => {
  it('never touches the drawer or the payment tables', async () => {
    setClock({ now: () => hcm('2026-09-19', '07:00') });
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 1_000_000 });
    const [issue] = await threeIssues();
    await collect(issue!.id, { status: 'COLLECTED', amount: 800_000, method: 'CASH' });

    const cash = (await letan.get('/api/reception/shifts/cash')).body.cash;
    expect(cash).toMatchObject({ cashCollected: 0, endingCash: 1_000_000, paymentCount: 0 });
    expect(await testPrisma.receptionPayment.count()).toBe(0);
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
  });
});

describe('who sees what', () => {
  beforeEach(async () => {
    const [smoking] = await threeIssues(hk1);
    await inspect({ roomNumber: '201', staffName: 'Chị Hoa', issues: [{ type: 'ODOR' }] }, hk1b);
    await inspect({ roomNumber: '505', staffName: 'Anh Nam', issues: [{ type: 'DAMAGED_FACILITY', note: 'Vỡ đèn' }] }, hk2);
    await collect(smoking!.id, { status: 'COLLECTED', amount: 500_000, method: 'TRANSFER' });
  });

  it('shows Housekeeping its own inspections, without money', async () => {
    const res = await hk1.get('/api/housekeeping/issues');
    expect(res.body.issues).toHaveLength(3);
    expect(res.body.summary).toBeNull();
    for (const issue of res.body.issues) {
      expect(issue.collection).toBeNull();
      expect(issue.history).toEqual([]);
    }
    expect(res.body.issues.find((i: { type: string }) => i.type === 'SMOKING').collectionStatusLabel).toBe('Đã thu');
    // A colleague on the same branch, and a branch that is not theirs, are not theirs to read.
    expect((await hk1b.get('/api/housekeeping/issues')).body.issues).toHaveLength(1);
    expect((await hk2.get('/api/housekeeping/issues')).body.issues).toHaveLength(1);
  });

  it('shows Reception its own branch, with money', async () => {
    const own = await letan.get('/api/housekeeping/issues');
    expect(own.body.issues).toHaveLength(4);
    expect(own.body.issues.every((i: { branchId: number }) => i.branchId === cn1)).toBe(true);
    expect((await letan2.get('/api/housekeeping/issues')).body.issues).toHaveLength(1);
  });

  it('shows the Admin every branch, filterable, with totals over all of it', async () => {
    const all = await admin.get('/api/housekeeping/issues');
    expect(all.body.total).toBe(5);
    expect(all.body.summary).toMatchObject({
      total: 5,
      byStatus: { PENDING: 4, COLLECTED: 1, UNCOLLECTIBLE: 0 },
      collectedByMethod: { CASH: 0, TRANSFER: 500_000, CARD: 0 },
      collectedTotal: 500_000,
    });
    expect((await admin.get(`/api/housekeeping/issues?branchId=${cn2}`)).body.issues).toHaveLength(1);
    expect((await admin.get('/api/housekeeping/issues?type=ODOR')).body.issues).toHaveLength(1);
    expect((await admin.get('/api/housekeeping/issues?status=COLLECTED')).body.issues).toHaveLength(1);
    expect((await admin.get('/api/housekeeping/issues?status=PENDING')).body.issues).toHaveLength(4);
    expect((await admin.get('/api/housekeeping/issues?from=2026-09-20&to=2026-09-20')).body.issues).toHaveLength(0);
    expect((await admin.get('/api/housekeeping/issues?from=2026-09-19&to=2026-09-19')).body.issues).toHaveLength(5);
  });

  it('refuses a role with no part in it', async () => {
    expect((await tech.get('/api/housekeeping/issues')).status).toBe(403);
  });
});

describe('voiding', () => {
  it('is the Admin’s alone, needs a reason, and keeps the record', async () => {
    const [issue] = await threeIssues();
    const url = `/api/housekeeping/issues/${issue!.id}/void`;
    expect((await letan.post(url).send({ reason: 'Nhập nhầm' })).status).toBe(403);
    expect((await admin.post(url).send({ reason: '  ' })).status).toBe(422);
    const res = await admin.post(url).send({ reason: 'Nhập nhầm phòng' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ voided: true, voidReason: 'Nhập nhầm phòng', voidedByName: 'Quản trị viên' });
    expect((await admin.post(url).send({ reason: 'lần hai' })).status).toBe(409);
    expect(await testPrisma.roomInspectionIssue.count()).toBe(3);
  });

  it('leaves the totals and the reading roles’ lists, and stops the issue being settled', async () => {
    const [issue] = await threeIssues();
    await admin.post(`/api/housekeeping/issues/${issue!.id}/void`).send({ reason: 'Nhập nhầm' });
    expect((await letan.get('/api/housekeeping/issues')).body.issues).toHaveLength(2);
    expect((await hk1.get('/api/housekeeping/issues')).body.issues).toHaveLength(2);
    const all = (await admin.get('/api/housekeeping/issues')).body;
    expect(all.issues).toHaveLength(3);
    expect(all.summary.total).toBe(2);
    expect((await collect(issue!.id, { status: 'PENDING' })).status).toBe(409);
  });
});
