/**
 * BỘ PHẬN BUỒNG PHÒNG'S OWN "BÁO CÁO VẤN ĐỀ" — the same journal, its records its own.
 *
 *   A. What it may record: guest requests, incidents, deliveries — at its own
 *      branch, stamped with its department; never payments, service quality or
 *      "Dịch vụ phòng, KPI" (Reception's).
 *   B. Reception follows it (marked with the department and the reporter) and
 *      cannot act on it; Housekeeping never sees Reception's; the Admin reads
 *      both, or Housekeeping's alone on request.
 *   C. Who sees and completes what: a housekeeper its own; the manager its
 *      branch's; never another branch's. "Hoàn thành vấn đề" after 12 hours.
 *   D. Deliveries and incidents through their existing workflows.
 *   E. "Mã EZ" → the guest's name, inside the reader's own scope.
 *   F. VII: a housekeeper writes to its branch's Quản lý buồng phòng and the Admin.
 *   I. "Xóa" a finding: the Admin; the reception managers and the Quản lý buồng
 *      phòng of its branch — never the desk, a housekeeper or another branch.
 *   K. "+ Báo cáo vấn đề" from a room: no guest from Housekeeping, ever; Reception
 *      (no shift needed) names the guest, keeping who reported it and when.
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
  agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName, ezCode, roomNumber: '301', note: `Thêm gối cho ${guestName}` } });
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
      sourceLabel: 'Buồng phòng · Chị Lan',
      createdByName: 'Chị Lan',
      createdByRole: 'HOUSEKEEPING',
      shiftSessionId: null,
    });
    // A branch named in the request is not read.
    const named = await lan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', branchId: cn2, guestRequest: { roomNumber: '301', note: 'x' } });
    expect(named.body.report.branchId).toBe(cn1);
    // The manager records at its own branch.
    expect((await guestRequest(qlbp1, 'Khách 303')).body.report).toMatchObject({ branchId: cn1, sourceLabel: 'Quản lý buồng phòng · QL Buồng 1', createdByRole: 'HOUSEKEEPING_MANAGER' });
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

describe('B. Reception follows Housekeeping’s records — it does not act on them', () => {
  it('shows Reception its branch’s housekeeping records, marked, read-only — and Housekeeping never Reception’s', async () => {
    await startShiftAt(lan, cn1);
    const hk = (await guestRequest(lan, 'Khách Buồng')).body.report.id as string;
    await checkIn(letan1);
    const desk = (await guestRequest(letan1, 'Khách Lễ tân')).body.report.id as string;
    // Reception's active list: both — the housekeeping one says where it came from and who sent it.
    const active = (await letan1.get('/api/reception/reports/active')).body.reports as { id: string; originDepartment: string; sourceLabel: string | null; createdByName: string }[];
    expect(active.map((r) => r.id).sort()).toEqual([desk, hk].sort());
    expect(active.find((r) => r.id === hk)).toMatchObject({ originDepartment: 'HOUSEKEEPING', sourceLabel: 'Buồng phòng · Chị Lan', createdByName: 'Chị Lan' });
    expect(active.find((r) => r.id === desk)).toMatchObject({ originDepartment: 'RECEPTION' });
    // Another branch's desk: neither.
    expect((await letan2.get('/api/reception/reports/active')).body.reports).toEqual([]);
    // Reception cannot complete or correct it, even at the same branch.
    expect((await letan1.post(`/api/reception/reports/${hk}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await letan1.patch(`/api/reception/reports/${hk}`).send({ guestRequest: { note: 'Sửa' } })).status).toBe(403);
    // Housekeeping sees its own, not the desk's — and cannot act on the desk's.
    expect((await hkJournal(lan)).map((r) => r.id)).toEqual([hk]);
    expect((await hkJournal(qlbp1)).map((r) => r.id)).toEqual([hk]);
    expect((await qlbp1.post(`/api/reception/reports/${desk}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await letan1.get('/api/reception/reports/housekeeping')).status).toBe(403);
    // The Admin reads both, each with its department; its housekeeping view narrows to Housekeeping's.
    const adminRes = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(adminRes.status).toBe(200);
    const adminReports = adminRes.body.reports as { id: string; originDepartment: string }[];
    expect(adminReports.map((r) => r.id).sort()).toEqual([desk, hk].sort());
    expect(adminReports.find((r) => r.id === hk)!.originDepartment).toBe('HOUSEKEEPING');
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
    // Twelve hours after it was received: "Hoàn thành vấn đề" — Housekeeping's own; Reception and the Admin follow it.
    at('2026-10-05', '22:00');
    const archived = (await qlbp1.get('/api/reception/reports/archive')).body.reports.map((r: { id: string }) => r.id);
    expect(archived).toEqual([mine]);
    expect((await hkJournal(qlbp1)).map((r) => r.id)).toEqual([hers]);
    expect((await letan1.get('/api/reception/reports/archive')).body.reports.map((r: { id: string }) => r.id)).toEqual([mine]);
    expect((await letan2.get('/api/reception/reports/archive')).body.reports).toEqual([]);
    expect((await admin.get('/api/reception/reports/archive')).body.reports.map((r: { id: string }) => r.id)).toEqual([mine]);
    expect((await admin.get('/api/reception/reports/archive?department=HOUSEKEEPING')).body.reports.map((r: { id: string }) => r.id)).toEqual([mine]);
    // A housekeeper's archive is its own.
    expect((await hoa.get('/api/reception/reports/archive')).body.reports).toEqual([]);
  });
});

describe('D. deliveries and incidents, through their own workflows', () => {
  it('shows a housekeeping delivery to its branch’s Reception and in the department’s own list — no other branch', async () => {
    await startShiftAt(lan, cn1);
    const res = await lan.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department: 'RECEPTION', itemName: 'Ga giường', quantity: 10 } });
    expect(res.status).toBe(201);
    const id = res.body.report.id as string;
    const ids = async (agent: Agent, query = '') => ((await agent.get(`/api/hotel-deliveries?scope=active${query}`)).body.deliveries as { id: string }[]).map((d) => d.id);
    expect(await ids(letan1)).toEqual([id]);
    expect(await ids(letan2)).toEqual([]);
    expect(await ids(admin)).toEqual([id]);
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

describe('G. completed records stay reachable by the Admin — and by no one outside their scope', () => {
  it('shows the Admin Housekeeping’s hand-overs in its housekeeping view — Reception’s to it, and its own — active and archived', async () => {
    await checkIn(letan1);
    const toHk = (await letan1.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department: 'HOUSEKEEPING', itemName: 'Ga giường', quantity: 20 } })).body.report.id as string;
    const toTech = (await letan1.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department: 'TECHNICAL', itemName: 'Bóng đèn', quantity: 2 } })).body.report.id as string;
    await startShiftAt(lan, cn1);
    const own = (await lan.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department: 'RECEPTION', itemName: 'Khăn', quantity: 5 } })).body.report.id as string;
    const ids = async (agent: Agent, query: string) => ((await agent.get(`/api/hotel-deliveries?${query}`)).body.deliveries as { id: string }[]).map((d) => d.id).sort();
    // The housekeeping view is what Bộ phận buồng phòng itself sees.
    expect(await ids(admin, 'scope=active&department=HOUSEKEEPING')).toEqual([toHk, own].sort());
    expect(await ids(qlbp1, 'scope=active')).toEqual([toHk, own].sort());
    expect(await ids(admin, `scope=active&department=HOUSEKEEPING&branchId=${cn2}`)).toEqual([]);
    // The Admin's whole view: every department's.
    expect(await ids(admin, 'scope=active')).toEqual([toHk, toTech, own].sort());
    // Twelve hours on: "Hoàn thành vấn đề", the same split.
    at('2026-10-05', '22:00');
    expect(await ids(admin, 'scope=archived&department=HOUSEKEEPING')).toEqual([toHk, own].sort());
    expect(await ids(admin, 'scope=archived')).toEqual([toHk, toTech, own].sort());
    expect(await ids(qlbp2, 'scope=archived')).toEqual([]);
  });

  it('keeps every completed request in the Admin’s "Hoàn thành vấn đề" of its department — never in another branch’s or department’s', async () => {
    await checkIn(letan1);
    const desk = (await guestRequest(letan1, 'Khách Lễ tân')).body.report.id as string;
    expect((await letan1.post(`/api/reception/reports/${desk}/complete`).send({ verdict: 'CORRECT' })).status).toBe(200);
    await startShiftAt(lan, cn1);
    const hk = (await guestRequest(lan, 'Khách Buồng')).body.report.id as string;
    expect((await qlbp1.post(`/api/reception/reports/${hk}/complete`).send({ verdict: 'INCORRECT', incorrectReason: 'Khách đã tự xử lý' })).status).toBe(200);
    at('2026-10-05', '22:00');
    const archive = async (agent: Agent, query = '') => ((await agent.get(`/api/reception/reports/archive${query}`)).body.reports as { id: string }[]).map((r) => r.id);
    // The Admin: both departments by default, Housekeeping's on request — each under its verdict.
    expect(await archive(admin, '?verdict=CORRECT')).toEqual([desk]);
    expect(await archive(admin, '?verdict=INCORRECT')).toEqual([hk]);
    expect(await archive(admin, '?department=HOUSEKEEPING&verdict=INCORRECT')).toEqual([hk]);
    expect(await archive(admin, `?department=HOUSEKEEPING&branchId=${cn2}`)).toEqual([]);
    // Reception follows its branch's (both departments'); Housekeeping only its own; never another branch's.
    expect((await archive(letan1)).sort()).toEqual([desk, hk].sort());
    expect(await archive(letan2)).toEqual([]);
    expect(await archive(qlbp1)).toEqual([hk]);
    expect(await archive(qlbp2)).toEqual([]);
    // A department named by a non-Admin is not read.
    expect((await archive(letan1, '?department=HOUSEKEEPING')).sort()).toEqual([desk, hk].sort());
    // "Loại vấn đề": one archived category at a time, on the server.
    expect((await archive(admin, '?category=GUEST_REQUEST')).sort()).toEqual([desk, hk].sort());
    expect(await archive(admin, '?category=CUSTOMER_COMPLAINT')).toEqual([]);
    expect((await admin.get('/api/reception/reports/archive?category=PAYMENT')).status).toBe(422);
  });
});

describe('H. who may give an incident to a technician', () => {
  it('lets the Admin, the Quản lý lễ tân and the Quản lý kỹ thuật assign — never the desk, Housekeeping or a technician', async () => {
    const app2 = createApp();
    const techId = (await createUser({ username: 'kythuat_h', password: PASSWORD, fullName: 'Kỹ thuật H', role: 'TECHNICAL' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: techId, branchId: cn1 } });
    const tech = (await loginAgent(app2, 'kythuat_h', PASSWORD)).agent;
    const rmId = (await createUser({ username: 'qllt_h', password: PASSWORD, fullName: 'QL Lễ tân H', role: 'RECEPTION_MANAGER' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: rmId, branchId: cn1 } });
    const rm = (await loginAgent(app2, 'qllt_h', PASSWORD)).agent;
    const tmId = (await createUser({ username: 'qlkt_h', password: PASSWORD, fullName: 'QL Kỹ thuật H', role: 'TECHNICAL_MANAGER' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: tmId, branchId: cn1 } });
    const tm = (await loginAgent(app2, 'qlkt_h', PASSWORD)).agent;
    const tm2Id = (await createUser({ username: 'qlkt_h2', password: PASSWORD, fullName: 'QL Kỹ thuật CN2', role: 'TECHNICAL_MANAGER' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: tm2Id, branchId: cn2 } });
    const tm2 = (await loginAgent(app2, 'qlkt_h2', PASSWORD)).agent;
    const report = async () => {
      const res = await letan1.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'WATER', description: 'Vòi sen rò nước' });
      expect(res.status).toBe(201);
      return res.body.issue.id as string;
    };
    await startShiftAt(lan, cn1);
    const id = await report();
    const assign = (agent: Agent, issueId: string) => agent.post(`/api/issues/${issueId}/assign`).send({ technicianUserId: techId });
    for (const agent of [letan1, lan, qlbp1, tech]) expect((await assign(agent, id)).status).toBe(403);
    // Another branch's Quản lý kỹ thuật: not its incident.
    expect([403, 404]).toContain((await assign(tm2, id)).status);
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } })).assignedTechnicianUserId).toBeNull();
    // The three authorised roles, each on an incident of its scope.
    expect((await assign(admin, id)).status).toBe(200);
    expect((await assign(rm, await report())).status).toBe(200);
    expect((await assign(tm, await report())).status).toBe(200);
  });
});

describe('I. "Xóa" a room finding on "Phát hiện & thu tiền"', () => {
  it('voids it — the Admin, and the reception managers and the Quản lý buồng phòng of its branch — keeping it, its reason, its collection and its inspection', async () => {
    const app2 = createApp();
    const rmId = (await createUser({ username: 'qllt_i', password: PASSWORD, fullName: 'QL Lễ tân I', role: 'RECEPTION_MANAGER' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: rmId, branchId: cn1 } });
    const rm = (await loginAgent(app2, 'qllt_i', PASSWORD)).agent;
    const rm2Id = (await createUser({ username: 'qllt_i2', password: PASSWORD, fullName: 'QL Lễ tân CN2', role: 'RECEPTION_MANAGER' })).id;
    await testPrisma.userBranchAssignment.create({ data: { userId: rm2Id, branchId: cn2 } });
    const rm2 = (await loginAgent(app2, 'qllt_i2', PASSWORD)).agent;
    await createUser({ username: 'tqllt_i', password: PASSWORD, fullName: 'Tổng QL Lễ tân', role: 'RECEPTION_GENERAL_MANAGER' });
    const gm = (await loginAgent(app2, 'tqllt_i', PASSWORD)).agent;
    await startShiftAt(lan, cn1);
    const inspect = async (roomNumber: string, issues: { type: string; note?: string }[]) => {
      const res = await lan.post('/api/housekeeping/inspections').send({ roomNumber, issues });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    };
    await inspect('101', [{ type: 'SMOKING', note: 'Mùi thuốc' }, { type: 'ODOR' }]);
    await inspect('102', [{ type: 'SMOKING' }, { type: 'ODOR' }]);
    const found = await testPrisma.roomInspectionIssue.findMany({ select: { id: true, type: true, inspection: { select: { roomNumber: true } } } });
    const issue = (room: string, type: string) => found.find((i) => i.type === type && i.inspection.roomNumber === room)!.id;
    const smoking = issue('101', 'SMOKING');
    await checkIn(letan1);
    expect((await letan1.put(`/api/housekeeping/issues/${smoking}/collection`).send({ status: 'COLLECTED', amount: 500000, method: 'CASH' })).status).toBe(200);
    const voidOf = (agent: Agent, id: string, reason = 'Ghi trùng') => agent.post(`/api/housekeeping/issues/${id}/void`).send({ reason });
    // Neither the desk nor a housekeeper; not another branch's managers; never without a reason.
    for (const agent of [letan1, lan, rm2, qlbp2]) expect((await voidOf(agent, smoking)).status).toBe(403);
    expect((await voidOf(rm, smoking, '  ')).status).toBe(422);
    expect(await testPrisma.roomInspectionIssue.count({ where: { voidedAt: { not: null } } })).toBe(0);
    // Its branch's Quản lý lễ tân: done — kept, with who, when and why.
    const done = await voidOf(rm, smoking);
    expect(done.status).toBe(200);
    const row = await testPrisma.roomInspectionIssue.findUniqueOrThrow({ where: { id: smoking }, include: { collection: true, inspection: true } });
    expect(row).toMatchObject({ voidedByUserId: rmId, voidedByNameSnapshot: 'QL Lễ tân I', voidReason: 'Ghi trùng' });
    expect(row.voidedAt).not.toBeNull();
    expect(row.collection).toMatchObject({ status: 'COLLECTED', amount: 500000 });
    expect(row.inspection).not.toBeNull();
    expect(await testPrisma.roomInspectionIssue.count()).toBe(4);
    // Once only.
    expect((await voidOf(admin, smoking)).status).toBe(409);
    // Its branch's Quản lý buồng phòng; the general manager (every branch); the Admin.
    const byHk = await voidOf(qlbp1, issue('101', 'ODOR'), 'Kiểm nhầm phòng');
    expect(byHk.status).toBe(200);
    expect(await testPrisma.roomInspectionIssue.findUniqueOrThrow({ where: { id: issue('101', 'ODOR') } })).toMatchObject({ voidedByUserId: qlbp1Id, voidReason: 'Kiểm nhầm phòng' });
    expect((await voidOf(gm, issue('102', 'SMOKING'))).status).toBe(200);
    expect((await voidOf(admin, issue('102', 'ODOR'))).status).toBe(200);
    // The Quản lý buồng phòng reads its branch's findings — not the money's controls (Reception's).
    expect((await qlbp1.get('/api/housekeeping/issues')).status).toBe(200);
    expect((await qlbp1.put(`/api/housekeeping/issues/${smoking}/collection`).send({ status: 'COLLECTED', amount: 1, method: 'CASH' })).status).toBe(403);
  });
});

describe('J. the technical report: branch, "Vấn đề còn tồn đọng" and "Mức độ" together', () => {
  it('returns only the open incidents of that level at that branch', async () => {
    const make = async (agent: Agent, severity: string, extra: Record<string, unknown> = {}) => {
      const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'WATER', description: 'Rò nước', severity, ...extra });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.issue.id as string;
    };
    const openHigh = await make(letan1, 'HIGH');
    const openLow = await make(letan1, 'LOW');
    const doneHigh = await make(letan1, 'HIGH');
    await testPrisma.hotelIssue.update({ where: { id: doneHigh }, data: { status: 'COMPLETED' } });
    const otherBranch = await make(admin, 'HIGH', { branchId: cn2, roomNumber: '201' });
    const ids = async (query: string) => ((await admin.get(`/api/issues?${query}&pageSize=500`)).body.issues as { id: string }[]).map((i) => i.id).sort();
    expect(await ids(`branchId=${cn1}&outstanding=true&severity=HIGH`)).toEqual([openHigh]);
    expect(await ids(`branchId=${cn1}&outstanding=true`)).toEqual([openHigh, openLow].sort());
    expect(await ids(`branchId=${cn1}&severity=HIGH`)).toEqual([openHigh, doneHigh].sort());
    expect(await ids(`outstanding=true&severity=HIGH`)).toEqual([openHigh, otherBranch].sort());
  });
});

describe('K. "+ Báo cáo vấn đề" from a room — no guest from Housekeeping; Reception names the guest', () => {
  let wg = 0;
  /** Room 101 given to `worker`, today. */
  const workItem = async (worker: Agent = lan, roomNumber = '101') => {
    wg += 1;
    const g = await qlbp1.post('/api/housekeeping/manager/work-groups').send({ workDate: '2026-10-05', requestId: `wg-k-${wg}`, items: [{ areaKind: 'ROOM', roomNumber, taskCodes: ['OUT'] }] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await worker.post(`/api/housekeeping/work/groups/${g.body.group.id}/accept`).send({})).status).toBe(200);
    return g.body.group.items[0].id as string;
  };
  const fromRoom = (agent: Agent, taskId: string, extra: Record<string, unknown> = {}) =>
    agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', taskId, guestRequest: { note: 'Khách xin thêm khăn', severity: 'HIGH', ...extra } });
  const setGuest = (agent: Agent, id: string, body: Record<string, unknown> = { guestName: 'Nguyễn Văn B', ezCode: 'EZ900' }) => agent.patch(`/api/reception/reports/${id}/guest`).send(body);

  it('1. records the request from the room with no guest — a guest name sent from Housekeeping is not stored', async () => {
    await startShiftAt(lan, cn1);
    const task = await workItem();
    at('2026-10-05', '09:15');
    const res = await fromRoom(lan, task, { guestName: 'Khách bịa', ezCode: 'EZ-X' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report).toMatchObject({
      category: 'GUEST_REQUEST',
      branchId: cn1,
      taskId: task,
      originDepartment: 'HOUSEKEEPING',
      createdByName: 'Chị Lan',
      createdAt: hcm('2026-10-05', '09:15').toISOString(),
      guestRequest: { guestName: null, ezCode: null, roomNumber: 'Phòng - 101', content: 'Khách xin thêm khăn', severity: 'HIGH' },
    });
    const stored = await testPrisma.guestRequestReport.findFirstOrThrow({ where: { reportId: res.body.report.id } });
    expect(stored).toMatchObject({ guestName: null, ezCode: null, roomNumber: 'Phòng - 101' });
    // Not the room's work and not the stock: the item is as it was.
    expect(await testPrisma.housekeepingRoomTask.findUniqueOrThrow({ where: { id: task } })).toMatchObject({ state: 'NOT_STARTED' });
    // Without an item: the content alone is enough — still no guest stored.
    const plain = await lan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { note: 'x', guestName: 'Khách bịa', ezCode: 'EZ-Y' } });
    expect(plain.status).toBe(201);
    expect(plain.body.report.guestRequest).toMatchObject({ guestName: null, ezCode: null, roomNumber: null });
  });

  it('2. shows it to its branch’s Reception — no shift needed — with who reported it and when; never to another branch', async () => {
    await startShiftAt(lan, cn1);
    const id = (await fromRoom(lan, await workItem())).body.report.id as string;
    // No "Vào ca" for the desk: it sees its branch's housekeeping requests all the same.
    const active = (await letan1.get('/api/reception/reports/active')).body.reports as { id: string; createdByName: string; sourceLabel: string; guestRequest: { guestName: string | null; roomNumber: string } }[];
    expect(active.find((r) => r.id === id)).toMatchObject({ createdByName: 'Chị Lan', sourceLabel: 'Buồng phòng · Chị Lan', guestRequest: { guestName: null, roomNumber: 'Phòng - 101' } });
    expect(((await letan2.get('/api/reception/reports/active')).body.reports as { id: string }[]).some((r) => r.id === id)).toBe(false);
  });

  it('3. lets Reception name the guest — the reporter, department, content and time unchanged, the change audited', async () => {
    await startShiftAt(lan, cn1);
    const created = (await fromRoom(lan, await workItem())).body.report;
    at('2026-10-05', '10:30');
    const named = await setGuest(letan1, created.id);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(named.body.report).toMatchObject({
      id: created.id,
      createdByName: 'Chị Lan',
      createdAt: created.createdAt,
      originDepartment: 'HOUSEKEEPING',
      taskId: created.taskId,
      guestRequest: { guestName: 'Nguyễn Văn B', ezCode: 'EZ900', roomNumber: 'Phòng - 101', content: 'Khách xin thêm khăn' },
    });
    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: created.id } });
    expect(audits.map((x) => [x.action, x.field, x.oldValue, x.newValue, x.reason]).sort()).toEqual([
      ['EDIT', 'ezCode', null, 'EZ900', 'Lễ tân nhập thông tin khách'],
      ['EDIT', 'guestName', null, 'Nguyễn Văn B', 'Lễ tân nhập thông tin khách'],
    ]);
    // Only the guest: no other edit, no completion, no void by Reception.
    expect((await letan1.patch(`/api/reception/reports/${created.id}`).send({ guestRequest: { note: 'Sửa' } })).status).toBe(403);
    expect((await letan1.post(`/api/reception/reports/${created.id}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    expect((await letan1.post(`/api/reception/reports/${created.id}/void`).send({ reason: 'x' })).status).toBe(403);
    // A request Reception recorded itself is not named this way.
    await checkIn(letan1);
    const desk = (await guestRequest(letan1)).body.report.id as string;
    expect((await setGuest(letan1, desk)).status).toBe(422);
    expect((await setGuest(letan1, created.id, { guestName: '  ' })).status).toBe(422);
  });

  it('4. never lets Housekeeping name the guest — nor read the name Reception gave', async () => {
    await startShiftAt(lan, cn1);
    const id = (await fromRoom(lan, await workItem())).body.report.id as string;
    for (const agent of [lan, qlbp1]) expect((await setGuest(agent, id)).status).toBe(403);
    expect((await setGuest(letan1, id)).status).toBe(200);
    for (const agent of [lan, qlbp1]) {
      const seen = ((await agent.get('/api/reception/reports/housekeeping')).body.reports as { id: string; guestRequest: { guestName: unknown; ezCode: unknown } }[]).find((r) => r.id === id)!;
      expect(seen.guestRequest).toMatchObject({ guestName: null, ezCode: null });
      expect(JSON.stringify(seen)).not.toContain('Nguyễn Văn B');
    }
  });

  it('5. refuses another branch — its desk, its manager, its work items', async () => {
    await startShiftAt(lan, cn1);
    const task = await workItem();
    const id = (await fromRoom(lan, task)).body.report.id as string;
    expect([403, 404]).toContain((await setGuest(letan2, id)).status);
    expect((await testPrisma.guestRequestReport.findFirstOrThrow({ where: { reportId: id } })).guestName).toBeNull();
    // Another housekeeper's item, or one of another branch: not reported from.
    await startShiftAt(hoa, cn1);
    expect((await fromRoom(hoa, task)).status).toBe(403);
    expect((await fromRoom(qlbp2, task)).status).toBe(422);
    // Reception never ties a report to a housekeeping item.
    await checkIn(letan1);
    expect((await letan1.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', taskId: task, guestRequest: { guestName: 'K', note: 'x' } })).status).toBe(422);
  });

  it('6. shows the Admin the request and its guest — and lets it name one too', async () => {
    await startShiftAt(lan, cn1);
    const id = (await fromRoom(lan, await workItem())).body.report.id as string;
    const before = ((await admin.get(`/api/admin/reports/operational?branchId=${cn1}`)).body.reports as { id: string; guestRequest: { guestName: string | null } }[]).find((r) => r.id === id)!;
    expect(before.guestRequest.guestName).toBeNull();
    expect((await setGuest(admin, id, { guestName: 'Khách Admin' })).status).toBe(200);
    const after = ((await hkJournal(admin, `?branchId=${cn1}`)) as unknown as { id: string; guestRequest: { guestName: string } }[]).find((r) => r.id === id)!;
    expect(after.guestRequest.guestName).toBe('Khách Admin');
  });

  it('ties an incident reported from a room to its item, through the incident workflow', async () => {
    await startShiftAt(lan, cn1);
    const task = await workItem();
    const created = await lan.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '101', description: 'Vòi sen rò nước' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const logged = await lan.post('/api/reception/reports').send({ category: 'FACILITY_ISSUE', taskId: task, facility: { issueId: created.body.issue.id } });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    expect(logged.body.report).toMatchObject({ taskId: task, originDepartment: 'HOUSEKEEPING' });
  });
});

describe('L. a Housekeeping request: the content and "Mức độ" — nothing else asked', () => {
  const report = (agent: Agent, guestRequest: Record<string, unknown>) =>
    agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest });

  it('records it from content and severity alone — no room, guest or Mã EZ, no reception shift; branch, reporter and time from the server', async () => {
    await startShiftAt(lan, cn1);
    at('2026-10-05', '09:44');
    const res = await report(lan, { note: 'Khách cần thêm nước', severity: 'HIGH' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.report).toMatchObject({
      branchId: cn1,
      originDepartment: 'HOUSEKEEPING',
      sourceLabel: 'Buồng phòng · Chị Lan',
      createdByName: 'Chị Lan',
      shiftSessionId: null,
      createdAt: hcm('2026-10-05', '09:44').toISOString(),
      guestRequest: { content: 'Khách cần thêm nước', severity: 'HIGH', guestName: null, ezCode: null, roomNumber: null },
    });
    // A time sent from the browser is not read.
    const timed = await lan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', createdAt: '2020-01-01T00:00:00.000Z', guestRequest: { note: 'x' } });
    expect(timed.body.report.createdAt).toBe(hcm('2026-10-05', '09:44').toISOString());
    // The manager too.
    expect((await report(qlbp1, { note: 'Khách hỏi giờ dọn phòng' })).status).toBe(201);
    // Still nothing without content.
    expect((await report(lan, { note: ' ' })).status).toBe(422);
  });

  it('shows Reception the same record — reporter, department and time — and keeps them when it names the guest; status actions as before', async () => {
    await startShiftAt(lan, cn1);
    const created = (await report(lan, { note: 'Khách cần thêm nước' })).body.report;
    const seen = ((await letan1.get('/api/reception/reports/active')).body.reports as { id: string; createdByName: string; sourceLabel: string; createdAt: string; summary: string }[]).find((r) => r.id === created.id)!;
    expect(seen).toMatchObject({ createdByName: 'Chị Lan', sourceLabel: 'Buồng phòng · Chị Lan', createdAt: created.createdAt });
    expect(seen.summary).toContain('Chưa xác định khách');
    at('2026-10-05', '11:00');
    const named = await letan1.patch(`/api/reception/reports/${created.id}/guest`).send({ guestName: 'Trần Thị C', ezCode: 'EZ5' });
    expect(named.body.report).toMatchObject({ createdAt: created.createdAt, createdByName: 'Chị Lan', originDepartment: 'HOUSEKEEPING', guestRequest: { guestName: 'Trần Thị C', ezCode: 'EZ5', content: 'Khách cần thêm nước' } });
    // Housekeeping reads none of it — list, summary or trail.
    const hk = ((await qlbp1.get('/api/reception/reports/housekeeping')).body.reports as { id: string }[]).find((r) => r.id === created.id)!;
    expect(JSON.stringify(hk)).not.toMatch(/Trần Thị C|EZ5/);
    // Completed by Housekeeping, as before; Reception still cannot.
    expect((await letan1.post(`/api/reception/reports/${created.id}/complete`).send({ verdict: 'CORRECT' })).status).toBe(403);
    const done = await qlbp1.post(`/api/reception/reports/${created.id}/complete`).send({ verdict: 'CORRECT', resolution: 'Đã mang nước' });
    expect(done.status).toBe(200);
    expect(done.body.report.guestRequest).toMatchObject({ completed: true });
  });

  it('keeps a historical request’s room readable, and a request made from a room keeps that room', async () => {
    await startShiftAt(lan, cn1);
    const old = await report(lan, { note: 'Bản ghi cũ', roomNumber: '301' });
    expect(old.body.report.guestRequest.roomNumber).toBe('301');
    expect(((await letan1.get('/api/reception/reports/active')).body.reports as { id: string; guestRequest: { roomNumber: string } }[]).find((r) => r.id === old.body.report.id)!.guestRequest.roomNumber).toBe('301');
  });
});

describe('M. one table per category, and possible duplicates across departments', () => {
  const request = (agent: Agent, note: string, extra: Record<string, unknown> = {}) =>
    agent.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { note, ...extra } });

  it('keeps Bộ phận buồng phòng’s shiftless requests beside a chosen Reception shift — never a shift invented, each record once', async () => {
    await checkIn(letan1);
    const desk = (await guestRequest(letan1, 'Khách Lễ tân')).body.report.id as string;
    await startShiftAt(lan, cn1);
    const hk = (await request(lan, 'Khách cần nước')).body.report.id as string;
    const list = async (q: string) =>
      ((await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=GUEST_REQUEST&from=2026-10-05&to=2026-10-05${q}`)).body.reports as { id: string; shiftSessionId: string | null }[]);
    const all = await list('');
    expect(all.map((r) => r.id).sort()).toEqual([desk, hk].sort());
    expect(all.find((r) => r.id === hk)!.shiftSessionId).toBeNull();
    // Ca A chosen: the desk's Ca A record and the shiftless housekeeping one, once each.
    expect((await list('&shiftType=A')).map((r) => r.id).sort()).toEqual([desk, hk].sort());
    // Another shift: the desk's record is not in it; the housekeeping one still is.
    expect((await list('&shiftType=B')).map((r) => r.id)).toEqual([hk]);
    // Another day: neither.
    expect((await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=GUEST_REQUEST&from=2026-10-04&to=2026-10-04&shiftType=A`)).body.reports).toEqual([]);
  });

  it('warns Bộ phận buồng phòng of a possible duplicate — of either department — without its details; confirmed, it is recorded', async () => {
    await checkIn(letan1);
    expect((await letan1.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'Khách VIP 909', ezCode: 'EZ909', note: 'Khách cần thêm 2 chai nước!' } })).status).toBe(201);
    await startShiftAt(lan, cn1);
    // The same content, written differently.
    const dup = await request(lan, '  khách cần thêm 2 chai nước ');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.error.message).toContain('lễ tân');
    expect(JSON.stringify(dup.body)).not.toMatch(/VIP 909|EZ909|chai nước|Lễ tân Một/);
    // Confirmed as a separate issue: recorded, nothing merged.
    const confirmed = await lan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { note: 'Khách cần thêm 2 chai nước' }, confirmDuplicate: true });
    expect(confirmed.status).toBe(201);
    expect(await testPrisma.receptionOperationalReport.count()).toBe(2);
    // The same department's own: warned too.
    expect((await request(lan, 'Phòng 302 cần thay rèm')).status).toBe(201);
    const same = await request(qlbp1, 'phòng 302 cần thay rèm.');
    expect(same.status).toBe(409);
    expect(same.body.error.message).toContain('Bộ phận buồng phòng');
    // Not a duplicate: other content, another branch, or a day later.
    expect((await request(lan, 'Khách cần thêm gối')).status).toBe(201);
    await startShiftAt(hoa, cn2);
    expect((await request(hoa, 'Khách cần thêm 2 chai nước')).status).toBe(201);
    at('2026-10-06', '10:30');
    expect((await request(lan, 'Khách cần thêm 2 chai nước')).status).toBe(201);
    // Reception is not stopped by this check.
    expect((await letan1.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'K', note: 'Khách cần thêm gối' } })).status).toBe(201);
  });

  it('warns of the same delivery for the same department — not for another department', async () => {
    await startShiftAt(lan, cn1);
    const deliver = (department: string, extra: Record<string, unknown> = {}) =>
      lan.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery: { department, itemName: 'Ga giường', quantity: 10 }, ...extra });
    expect((await deliver('RECEPTION')).status).toBe(201);
    expect((await deliver('RECEPTION')).body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect((await deliver('TECHNICAL')).status).toBe(201);
    expect((await deliver('RECEPTION', { confirmDuplicate: true })).status).toBe(201);
  });

  it('keeps Housekeeping’s lists to its own department’s records', async () => {
    await checkIn(letan1);
    const desk = (await guestRequest(letan1, 'Khách Lễ tân')).body.report.id as string;
    await startShiftAt(lan, cn1);
    const hk = (await request(lan, 'Khách cần nước')).body.report.id as string;
    for (const agent of [lan, qlbp1]) {
      const ids = ((await agent.get('/api/reception/reports/housekeeping')).body.reports as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(hk);
      expect(ids).not.toContain(desk);
    }
  });
});
