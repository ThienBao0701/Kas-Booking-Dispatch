/**
 * "MỨC ĐỘ" — Cao / Trung bình / Thấp on three record types, and only three:
 *
 *    7  "Vấn đề khách yêu cầu", "Sự cố cơ sở vật chất" and "Vấn đề về chất
 *       lượng và dịch vụ" carry a level; nothing else does
 *    8  exactly three values; anything else is refused
 *    9  the filter is the server's (journal, incidents, Admin report)
 *   10  what needs doing comes first, by level; finished work keeps its date order
 *   11  only who may correct the record may change its level — audited
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const DAY = '2026-10-07';

let cn1 = 0;
let admin: Agent;
let letan1: Agent;
let letan2: Agent;
let tech: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  const cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  await createUser({ username: 'kythuat', password: 'Kythuat123', fullName: 'Kỹ thuật', role: 'TECHNICAL', branchId: null, mustChangePassword: false });
  tech = (await loginAgent(app, 'kythuat', 'Kythuat123')).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  at('08:00');
  for (const [agent, name] of [[letan1, 'Nguyễn A'], [letan2, 'Trần B']] as const) {
    expect((await agent.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: name })).status).toBe(201);
  }
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

const at = (hhmm: string) => setClock({ now: () => hcm(DAY, hhmm) });

async function request(guestName: string, severity?: string, agent: Agent = letan1) {
  const res = await agent
    .post('/api/reception/reports')
    .send({ category: 'GUEST_REQUEST', guestRequest: { guestName, note: 'Cần thêm gối', ...(severity ? { severity } : {}) } });
  expect(res.status).toBe(201);
  return res.body.report as { id: string; guestRequest: { severity: string | null; severityLabel: string } };
}

async function incident(roomNumber: string, severity?: string) {
  const res = await letan1
    .post('/api/issues')
    .send({ areaCategory: 'ROOM', roomNumber, category: 'TV', description: 'TV hỏng', ...(severity ? { severity } : {}) });
  expect(res.status).toBe(201);
  return res.body.issue as { id: string; severity: string | null; severityLabel: string };
}

describe('which records carry a level', () => {
  it('7. requests, incidents and service-quality reports do — Trung bình unless chosen; nothing else does', async () => {
    expect((await request('Khách A', 'HIGH')).guestRequest).toMatchObject({ severity: 'HIGH', severityLabel: 'Cao' });
    expect((await request('Khách B')).guestRequest).toMatchObject({ severity: 'MEDIUM', severityLabel: 'Trung bình' });
    const complaint = await letan1
      .post('/api/reception/reports')
      .send({ category: 'CUSTOMER_COMPLAINT', complaint: { guestName: 'Khách C', description: 'Phòng ồn', severity: 'LOW' } });
    expect(complaint.body.report.complaint).toMatchObject({ severity: 'LOW', severityLabel: 'Thấp' });
    expect(await incident('301', 'HIGH')).toMatchObject({ severity: 'HIGH', severityLabel: 'Cao' });

    // A room service or a payment has no level, whatever the request carries.
    const service = await letan1
      .post('/api/reception/reports')
      .send({ category: 'ROOM_SERVICE', roomService: { serviceType: 'LAUNDRY', guestName: 'Khách D', price: 50_000, severity: 'HIGH' } });
    expect(service.status).toBe(201);
    expect(service.body.report.roomService).not.toHaveProperty('severity');
    const payment = await letan1.post('/api/reception/reports').send({ category: 'PAYMENT', payment: { source: 'Agoda', method: 'CASH', amount: 1 } });
    const patched = await letan1.patch(`/api/reception/reports/${payment.body.report.id}`).send({ payment: { severity: 'HIGH' } });
    expect(patched.body.report.payment).not.toHaveProperty('severity');
    expect(await testPrisma.receptionReportAudit.count({ where: { field: 'severity' } })).toBe(0);

    // A record from before the level existed is not given one.
    const legacy = await request('Khách cũ');
    await testPrisma.guestRequestReport.update({ where: { reportId: legacy.id }, data: { severity: null } });
    const list = await letan1.get('/api/reception/reports/active');
    const row = list.body.reports.find((r: { id: string }) => r.id === legacy.id);
    expect(row.guestRequest).toMatchObject({ severity: null, severityLabel: 'Chưa phân mức' });
  });

  it('8. Cao, Trung bình and Thấp are the only values', async () => {
    const bad = await letan1
      .post('/api/reception/reports')
      .send({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'X', note: 'Y', severity: 'URGENT' } });
    expect(bad.status).toBe(422);
    expect((await letan1.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', description: 'x', severity: 'critical' })).status).toBe(422);
    const ok = await request('Khách A');
    expect((await letan1.patch(`/api/reception/reports/${ok.id}`).send({ guestRequest: { severity: 'Cao' } })).status).toBe(422);
    expect((await letan1.get('/api/reception/reports/active').query({ severity: 'TOP' })).status).toBe(422);
    expect((await letan1.get('/api/issues').query({ severity: 'TOP' })).status).toBe(422);
  });
});

describe('filtering and order', () => {
  it('9. the level filter is applied by the server — journal, incidents and the Admin report', async () => {
    await request('Cao 1', 'HIGH');
    await request('Thấp 1', 'LOW');
    await request('Khác chi nhánh', 'HIGH', letan2);
    const high = await letan1.get('/api/reception/reports/active').query({ severity: 'HIGH' });
    expect(high.body.reports.map((r: { guestRequest: { guestName: string } }) => r.guestRequest.guestName)).toEqual(['Cao 1']);

    await incident('301', 'LOW');
    const tv = await incident('302', 'HIGH');
    const issues = await admin.get('/api/issues').query({ severity: 'HIGH', branchId: cn1 });
    expect(issues.body.issues.map((i: { id: string }) => i.id)).toEqual([tv.id]);

    const report = await admin
      .get('/api/admin/reports/operational')
      .query({ branchId: cn1, category: 'GUEST_REQUEST', severity: 'LOW', from: DAY, to: DAY });
    expect(report.body.reports.map((r: { guestRequest: { guestName: string } }) => r.guestRequest.guestName)).toEqual(['Thấp 1']);
  });

  it('10. what still needs doing comes first, Cao → Trung bình → Thấp; finished work after, by date', async () => {
    at('08:01');
    await request('Thấp', 'LOW');
    at('08:02');
    const done = await request('Cao — xong', 'HIGH');
    at('08:03');
    await request('Trung bình', 'MEDIUM');
    at('08:04');
    await request('Cao', 'HIGH');
    at('08:05');
    expect((await letan1.post(`/api/reception/reports/${done.id}/complete`).send({ verdict: 'CORRECT' })).status).toBe(200);
    const names = (await letan1.get('/api/reception/reports/active')).body.reports.map(
      (r: { guestRequest: { guestName: string } }) => r.guestRequest.guestName,
    );
    expect(names).toEqual(['Cao', 'Trung bình', 'Thấp', 'Cao — xong']);

    // The Admin's category page reads the same order.
    const admins = await admin.get('/api/admin/reports/operational').query({ branchId: cn1, category: 'GUEST_REQUEST', from: DAY, to: DAY });
    expect(admins.body.reports.map((r: { guestRequest: { guestName: string } }) => r.guestRequest.guestName)).toEqual(names);

    // Incidents: the unresolved queue by level, newest first within a level.
    at('09:00');
    const low = await incident('301', 'LOW');
    at('09:01');
    const high = await incident('302', 'HIGH');
    at('09:02');
    const medium = await incident('401');
    const outstanding = await admin.get('/api/issues').query({ outstanding: 'true', branchId: cn1 });
    expect(outstanding.body.issues.map((i: { id: string }) => i.id)).toEqual([high.id, medium.id, low.id]);
  });
});

describe('changing a level', () => {
  it('11. only who may correct the record may change it — and the change is audited', async () => {
    const req = await request('Khách A');
    const changed = await letan1.patch(`/api/reception/reports/${req.id}`).send({ guestRequest: { severity: 'HIGH' } });
    expect(changed.body.report.guestRequest.severity).toBe('HIGH');
    const audit = await testPrisma.receptionReportAudit.findFirstOrThrow({ where: { reportId: req.id, field: 'severity' } });
    expect([audit.oldValue, audit.newValue]).toEqual(['Trung bình', 'Cao']);
    // Another branch's desk, and Bộ phận kỹ thuật, cannot.
    expect((await letan2.patch(`/api/reception/reports/${req.id}`).send({ guestRequest: { severity: 'LOW' } })).status).toBe(403);
    expect((await tech.patch(`/api/reception/reports/${req.id}`).send({ guestRequest: { severity: 'LOW' } })).status).toBe(403);

    const issue = await incident('301', 'LOW');
    expect((await tech.put(`/api/issues/${issue.id}`).send({ severity: 'HIGH' })).status).toBe(403);
    expect((await letan2.put(`/api/issues/${issue.id}`).send({ severity: 'HIGH' })).status).toBe(403);
    const fixed = await letan1.put(`/api/issues/${issue.id}`).send({ severity: 'HIGH' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.issue).toMatchObject({ severity: 'HIGH', severityLabel: 'Cao' });
    expect(fixed.body.issue.edits).toEqual([expect.objectContaining({ field: 'severity', fieldLabel: 'Mức độ', oldValue: 'Thấp', newValue: 'Cao' })]);
    // The same incident, the same level, for every role that reads it.
    const asAdmin = await admin.get(`/api/issues/${issue.id}`);
    expect(asAdmin.body.issue).toMatchObject({ id: issue.id, severity: 'HIGH' });
  });
});
