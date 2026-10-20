/**
 * BỘ PHẬN BUỒNG PHÒNG'S OWN "BÁO CÁO VẤN ĐỀ" — the same journal, kept apart.
 *
 *   A. What it may record: guest requests, incidents, deliveries — at its own
 *      branch, stamped with its department; never payments, service quality or
 *      "Dịch vụ phòng, KPI" (Reception's).
 *   B. Separation: Reception's lists, totals and actions never see it; it never
 *      sees Reception's; the Admin reads it only when it asks for it.
 *   C. Who sees and completes what: a housekeeper its own; the manager its
 *      branch's; never another branch's. "Hoàn thành vấn đề" after 12 hours.
 *   D. Deliveries and incidents through their existing workflows.
 *   E. "Mã EZ" → the guest's name, inside the reader's own scope.
 *   F. VII: a housekeeper writes to its branch's Quản lý buồng phòng and the Admin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { startShiftAt } from './helpers/workplace';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const PASSWORD = 'Matkhau123';
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const at = (day: string, hhmm: string) => setClock({ now: () => hcm(day, hhmm) });

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let qlbp1: Agent;
let qlbp2: Agent;
let lan: Agent;
let hoa: Agent;
let qlbp1Id = 0;
let qlbp2Id = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân Hai', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  qlbp1Id = (await createUser({ username: 'qlbp1', password: PASSWORD, fullName: 'QL Buồng 1', role: 'HOUSEKEEPING_MANAGER', branchId: cn1 })).id;
  qlbp2Id = (await createUser({ username: 'qlbp2', password: PASSWORD, fullName: 'QL Buồng 2', role: 'HOUSEKEEPING_MANAGER', branchId: cn2 })).id;
  qlbp1 = (await loginAgent(app, 'qlbp1', PASSWORD)).agent;
  qlbp2 = (await loginAgent(app, 'qlbp2', PASSWORD)).agent;
  await createUser({ username: 'lan', password: PASSWORD, fullName: 'Chị Lan', role: 'HOUSEKEEPING' });
  await createUser({ username: 'hoa', password: PASSWORD, fullName: 'Chị Hoa', role: 'HOUSEKEEPING' });
  lan = (await loginAgent(app, 'lan', PASSWORD)).agent;
  hoa = (await loginAgent(app, 'hoa', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  await resetHousekeepingData();
  await testPrisma.confidentialReportRecipient.deleteMany();
  await testPrisma.confidentialReport.deleteMany();
  await testPrisma.notification.deleteMany();
  at('2026-10-05', '09:00');
});

afterAll(async () => {
  resetClock();
  await testPrisma.confidentialReportRecipient.deleteMany();
  await testPrisma.confidentialReport.deleteMany();
  await resetAll();
});

const guestRequest = (agent: Agent, guestName = 'Khách 301', ezCode = 'EZ301') =>
  agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName, ezCode, note: 'Thêm gối' } });
const hkJournal = async (agent: Agent, query = '') =>
  ((await agent.get(`/api/reception/reports/housekeeping${query}`)).body.reports ?? []) as { id: string; category: string }[];
const checkIn = async (agent: Agent) =>
  expect((await agent.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Lễ tân' })).status).toBe(201);

describe('A. what Bộ phận buồng phòng records', () => {
  it('records a guest request at its shift’s branch — its department, its account, its role, no reception shift', async () => {
    // Off shift: no branch, nothing recorded.
    expect((await guestRequest(lan)).status).toBe(409);
    await startShiftAt(lan, cn1);
    const res = await guestRequest(lan);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report).toMatchObject({
      category: 'GUEST_REQUEST',
      branchId: cn1,
      originDepartment: 'HOUSEKEEPING',
      departmentLabel: 'Buồng phòng',
      sourceLabel: 'Buồng phòng',
      createdByName: 'Chị Lan',
      createdByRole: 'HOUSEKEEPING',
      shiftSessionId: null,
    });
    // A branch named in the request is not read.
    const named = await lan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', branchId: cn2, guestRequest: { guestName: 'K', note: 'x' } });
    expect(named.body.report.branchId).toBe(cn1);
    // The manager records at its own branch.
    expect((await guestRequest(qlbp1)).body.report).toMatchObject({ branchId: cn1, sourceLabel: 'Quản lý buồng phòng', createdByRole: 'HOUSEKEEPING_MANAGER' });
  });

  it('refuses payments, service quality and "Dịch vụ phòng, KPI" — Reception’s categories', async () => {
    await startShiftAt(lan, cn1);
    const bodies = [
      { category: 'PAYMENT', payment: { guestName: 'K', method: 'CASH', amount: 100000 } },
      { category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'K', description: 'Ồn' } },
      { category: 'ROOM_SERVICE', roomService: { serviceType: 'LAUNDRY', guestName: 'K', price: 50000 } },
      { category: 'ROOM_SERVICE', roomServices: [{ serviceType: 'LAUNDRY', guestName: 'K', price: 50000 }] },
    ];
    for (const body of bodies) {
      for (const agent of [lan, qlbp1]) expect((await agent.post('/api/reception/reports').send(body)).status, body.category).toBe(403);
    }
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
  });
});

describe('B. kept apart from Reception', () => {
  it('never shows Reception a housekeeping record, nor lets it act on one — and the other way round', async () => {
    await startShiftAt(lan, cn1);
    const hk = (await guestRequest(lan, 'Khách Buồng')).body.report.id as string;
    await checkIn(letan1);
    const desk = (await guestRequest(letan1, 'Khách Lễ tân')).body.report.id as string;
    // Reception's journal, its active list and its counts.
    const active = (await letan1.get('/api/reception/reports/active')).body.reports.map((r: { id: string }) => r.id);
    expect(active).toEqual([desk]);
    const listed = (await letan1.get('/api/reception/reports')).body;
    expect(listed.reports.map((r: { id: string }) => r.id)).toEqual([desk]);
    expect(listed.counts.GUEST_REQUEST).toBe(1);
    // Reception cannot complete or correct it, even at the same branch.
    expect((await letan1.post(`/api/reception/reports/${hk}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await letan1.patch(`/api/reception/reports/${hk}`).send({ guestRequest: { note: 'Sửa' } })).status).toBe(403);
    // Housekeeping sees its own, not the desk's — and cannot act on the desk's.
    expect((await hkJournal(lan)).map((r) => r.id)).toEqual([hk]);
    expect((await hkJournal(qlbp1)).map((r) => r.id)).toEqual([hk]);
    expect((await qlbp1.post(`/api/reception/reports/${desk}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await letan1.get('/api/reception/reports/housekeeping')).status).toBe(403);
    // The Admin's reception report is Reception's; its housekeeping view is asked for.
    const adminRes = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(adminRes.status).toBe(200);
    const adminReception = (adminRes.body.reports as { id: string }[]).map((r) => r.id);
    expect(adminReception).toContain(desk);
    expect(adminReception).not.toContain(hk);
    expect((await hkJournal(admin, `?branchId=${cn1}`)).map((r) => r.id)).toEqual([hk]);
    expect(await hkJournal(admin, `?branchId=${cn2}`)).toEqual([]);
  });
});

describe('C. who sees and completes what', () => {
  it('a housekeeper follows its own; the manager its branch’s — completes them — and never another branch’s', async () => {
    await startShiftAt(lan, cn1);
    await startShiftAt(hoa, cn1);
    const mine = (await guestRequest(lan)).body.report.id as string;
    const hers = (await guestRequest(hoa, 'Khách 302')).body.report.id as string;
    expect((await hkJournal(lan)).map((r) => r.id)).toEqual([mine]);
    expect((await hkJournal(qlbp1)).map((r) => r.id).sort()).toEqual([mine, hers].sort());
    expect(await hkJournal(qlbp2)).toEqual([]);
    expect((await qlbp2.post(`/api/reception/reports/${mine}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await lan.post(`/api/reception/reports/${hers}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    const done = await qlbp1.post(`/api/reception/reports/${mine}/complete`).send({ verdict: 'CORRECT', resolution: 'Đã mang gối' });
    expect(done.status).toBe(200);
    expect(done.body.report.guestRequest).toMatchObject({ completed: true, completedByName: 'QL Buồng 1' });
    // Completed once.
    expect((await qlbp1.post(`/api/reception/reports/${mine}/complete`).send({ verdict: 'CORRECT' })).status).toBe(409);
    // Twelve hours after it was received: "Hoàn thành vấn đề" — housekeeping's, never Reception's.
    at('2026-10-05', '22:00');
    const archived = (await qlbp1.get('/api/reception/reports/archive')).body.reports.map((r: { id: string }) => r.id);
    expect(archived).toEqual([mine]);
    expect((await hkJournal(qlbp1)).map((r) => r.id)).toEqual([hers]);
    expect((await letan1.get('/api/reception/reports/archive')).body.reports).toEqual([]);
    expect((await admin.get('/api/reception/reports/archive')).body.reports).toEqual([]);
    expect((await admin.get('/api/reception/reports/archive?department=HOUSEKEEPING')).body.reports.map((r: { id: string }) => r.id)).toEqual([mine]);
    // A housekeeper's archive is its own.
    expect((await hoa.get('/api/reception/reports/archive')).body.reports).toEqual([]);
  });
});

describe('D. deliveries and incidents, through their own workflows', () => {
  it('keeps a housekeeping delivery out of Reception’s list, in the department’s own', async () => {
    await startShiftAt(lan, cn1);
    const res = await lan.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department: 'RECEPTION', itemName: 'Ga giường', quantity: 10 } });
    expect(res.status).toBe(201);
    const id = res.body.report.id as string;
    const ids = async (agent: Agent, query = '') => ((await agent.get(`/api/hotel-deliveries?scope=active${query}`)).body.deliveries as { id: string }[]).map((d) => d.id);
    expect(await ids(letan1)).toEqual([]);
    expect(await ids(admin)).toEqual([]);
    expect(await ids(admin, '&department=HOUSEKEEPING')).toEqual([id]);
    expect(await ids(qlbp1)).toEqual([id]);
    expect(await ids(qlbp2)).toEqual([]);
  });

  it('reports an incident at its own branch into the shared incident workflow, and points its journal at it', async () => {
    await startShiftAt(lan, cn1);
    const created = await lan.post('/api/issues').send({ branchId: cn2, areaCategory: 'ROOM', roomNumber: '301', category: 'WATER', description: 'Vòi sen rò nước' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issue = created.body.issue as { id: string; branchId: number };
    // Its own branch, whatever the request named.
    expect(issue.branchId).toBe(cn1);
    const logged = await lan.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } });
    expect(logged.status).toBe(201);
    expect(logged.body.report.originDepartment).toBe('HOUSEKEEPING');
    // The branch's incidents are its to follow — not another branch's.
    expect(((await qlbp1.get('/api/issues?scope=active')).body.issues as { id: string }[]).map((i) => i.id)).toEqual([issue.id]);
    expect((await qlbp2.get('/api/issues?scope=active')).body.issues).toEqual([]);
    // It reports; it does not correct, reassign or delete incidents.
    expect((await lan.put(`/api/issues/${issue.id}`).send({ description: 'Sửa' })).status).toBe(403);
    await startShiftAt(hoa, cn2);
    expect((await hoa.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } })).status).toBe(403);
  });
});

describe('E. "Mã EZ" → the guest’s name', () => {
  it('finds the newest name recorded with the code, inside the reader’s own scope only', async () => {
    await checkIn(letan1);
    await letan1.post('/api/reception/reports').send({ category: 'ROOM_SERVICE', roomService: { serviceType: 'LAUNDRY', guestName: 'Nguyễn Văn A', ezCode: 'EZ77', price: 50000 } });
    at('2026-10-05', '10:00');
    await guestRequest(letan1, 'Nguyễn Văn A (phòng 301)', 'EZ77');
    const lookup = async (agent: Agent, ez: string) => (await agent.get(`/api/reception/reports/guest?ez=${encodeURIComponent(ez)}`)).body;
    expect((await lookup(letan1, 'ez77')).guest).toMatchObject({ guestName: 'Nguyễn Văn A (phòng 301)', ezCode: 'EZ77' });
    expect((await lookup(letan1, 'EZ-KHONG-CO')).guest).toBeNull();
    // Another branch's desk, and another department, do not read it.
    expect((await lookup(letan2, 'EZ77')).guest).toBeNull();
    await startShiftAt(lan, cn1);
    expect((await lookup(lan, 'EZ77')).guest).toBeNull();
    expect((await lookup(admin, 'EZ77')).guest).toMatchObject({ ezCode: 'EZ77' });
  });

  it('saves several services of one guest all or none', async () => {
    await checkIn(letan1);
    const res = await letan1.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomServices: [
        { serviceType: 'SMOKING', guestName: 'Khách', ezCode: 'EZ1', price: 500000 },
        { serviceType: 'LAUNDRY', guestName: 'Khách', ezCode: 'EZ1' },
      ],
    });
    expect(res.status).toBe(422);
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
  });
});

describe('F. "Báo cáo các vấn đề và tình hình quan trọng" from Bộ phận buồng phòng', () => {
  it('lets a housekeeper write to its branch’s Quản lý buồng phòng and the Admin — never another branch’s manager', async () => {
    await startShiftAt(lan, cn1);
    const options = (await lan.get('/api/confidential-reports/options')).body;
    expect(options.canSend).toBe(true);
    expect(options.recipientRoles).toEqual(['HOUSEKEEPING_MANAGER', 'ADMIN']);
    expect(options.recipients.map((r: { id: number }) => r.id)).toContain(qlbp1Id);
    expect(options.recipients.map((r: { id: number }) => r.id)).not.toContain(qlbp2Id);
    expect((await lan.post('/api/confidential-reports').send({ category: 'COLLEAGUES', content: 'Nội dung', recipientIds: [qlbp2Id] })).status).toBe(403);
    const sent = await lan.post('/api/confidential-reports').send({ category: 'COLLEAGUES', content: 'Nội dung', recipientIds: [qlbp1Id] });
    expect(sent.status).toBe(201);
    const inbox = (await qlbp1.get('/api/confidential-reports')).body.reports as { id: string; sender: { roleLabel: string } }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.sender.roleLabel).toBe('Buồng phòng');
    expect((await qlbp2.get('/api/confidential-reports')).body.reports).toEqual([]);
  });
});
