/**
 * "BÁO CÁO VẤN ĐỀ" — the reception operational journal.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Every record inherits its branch, shift, shift type and employee name
 *      from the OPEN SESSION, and a request that tries to name its own is
 *      ignored rather than believed. This is the whole accountability model.
 *   2. A CLOSED shift cannot write. Once "Kết thúc ca" runs, the journal of the
 *      shift that just ended is final.
 *   3. Exactly five categories exist, and each one stores the fields it was
 *      specified with — no priority, no severity and no status on a complaint.
 *   4. A guest request keeps its creator and its receiver SEPARATELY, even when
 *      they are the same person, and even across a shift change.
 *   5. A facility report REFERENCES an existing HotelIssue and creates no second
 *      incident.
 *   6. Branch isolation holds, and the two branchless roles are refused outright.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
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

const TECHNICAL_PASSWORD = 'Technical1';
const DEPT_PASSWORD = 'DatPhong1';

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letanB: Agent;
let letanCn2: Agent;
let admin: Agent;
let tech: Agent;
let dept: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  letanCn2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createUser({
    username: 'datphong',
    password: DEPT_PASSWORD,
    fullName: 'Bộ phận đặt phòng',
    role: 'BOOKING_DEPARTMENT',
    branchId: null,
    mustChangePassword: false,
  });
  dept = (await loginAgent(app, 'datphong', DEPT_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  resetClock();
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

/** Check in and ASSERT it worked — an unasserted fixture reports itself as an
 *  empty journal, which reads like a broken query in whichever test runs next. */
async function checkIn(agent: Agent, shiftType: string, name: string) {
  const res = await agent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session as { id: string };
}

async function createComplaint(agent: Agent, body: Record<string, unknown> = {}) {
  return agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Khách A', location: '101', description: 'Máy lạnh ồn', ...body },
  });
}

describe('the shift owns the record', () => {
  it('stamps branch, shift, shift type and the receptionist name from the session', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:10') });
    const session = await checkIn(letan, 'A', 'Nguyễn Văn A');

    const res = await createComplaint(letan);
    expect(res.status).toBe(201);

    const report = res.body.report;
    expect(report.branchId).toBe(cn1);
    expect(report.shiftSessionId).toBe(session.id);
    expect(report.shiftType).toBe('A');
    expect(report.shiftName).toBe('Ca A');
    expect(report.createdByName).toBe('Nguyễn Văn A');
    // The server's clock, not the browser's.
    expect(report.createdAt).toBe(hcm('2026-09-19', '08:10').toISOString());
  });

  it('ignores a branch, an employee and a timestamp sent by the browser', async () => {
    setClock({ now: () => hcm('2026-09-19', '09:25') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');

    const res = await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Khách B', location: '202', description: 'Wifi yếu' },
      // Every one of these is a field no schema in this feature declares.
      branchId: cn2,
      createdByUserId: 99999,
      createdByNameSnapshot: 'Người Khác',
      shiftType: 'C4',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);

    expect(res.body.report.branchId).toBe(cn1);
    expect(res.body.report.createdByName).toBe('Nguyễn Văn A');
    expect(res.body.report.shiftType).toBe('A');
    expect(res.body.report.createdAt).toBe(hcm('2026-09-19', '09:25').toISOString());
  });

  it('refuses a record when no shift is open', async () => {
    const res = await createComplaint(letan);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
  });

  it('refuses a record once the shift has been ended', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    expect((await createComplaint(letan)).status).toBe(201);

    const closed = await letan.post('/api/reception/shifts/close').send({});
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(1);

    const after = await createComplaint(letan);
    expect(after.status).toBe(422);
    expect(after.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
  });

  it('attaches the next shift’s records to the next shift, and rewrites nothing', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    const first = await checkIn(letan, 'A', 'Nguyễn Văn A');
    const early = await createComplaint(letan, { description: 'Ghi trong ca A' });
    expect(early.status).toBe(201);

    setClock({ now: () => hcm('2026-09-19', '14:05') });
    await letan.post('/api/reception/shifts/close').send({});
    const second = await checkIn(letan, 'B', 'Nguyễn Văn B');
    const late = await createComplaint(letan, { description: 'Ghi trong ca B' });
    expect(late.status).toBe(201);

    expect(late.body.report.shiftSessionId).toBe(second.id);
    expect(late.body.report.createdByName).toBe('Nguyễn Văn B');

    // The Ca A record is untouched: same session, same name, same instant.
    const list = await letan.get('/api/reception/reports');
    const stored = list.body.reports.find((r: { id: string }) => r.id === early.body.report.id);
    expect(stored.shiftSessionId).toBe(first.id);
    expect(stored.createdByName).toBe('Nguyễn Văn A');
    expect(stored.createdAt).toBe(hcm('2026-09-19', '08:00').toISOString());
  });
});

describe('the five categories', () => {
  beforeEach(async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
  });

  it('lists exactly five, with their Vietnamese labels', async () => {
    const res = await letan.get('/api/reception/reports/options');
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: { code: string }) => c.code)).toEqual([
      'PAYMENT',
      'GUEST_REQUEST',
      'FACILITY_ISSUE',
      'CUSTOMER_COMPLAINT',
      'ROOM_SERVICE',
    ]);
    expect(res.body.categories[0].label).toBe('Theo dõi thanh toán');
    expect(res.body.paymentMethods.map((m: { label: string }) => m.label)).toEqual([
      'Thu tiền mặt',
      'Chuyển khoản',
      'Cà thẻ',
    ]);
    expect(res.body.roomServiceTypes.map((t: { label: string }) => t.label)).toEqual([
      'Bán phòng',
      'Upgrade',
      'Hút thuốc',
      'Giặt ủi',
      'Dịch vụ khác',
    ]);
  });

  it('stores a complaint with exactly the three specified fields', async () => {
    const res = await createComplaint(letan, {
      guestName: 'Trần Thị B',
      location: 'Sảnh',
      description: 'Nhân viên trả lời chậm',
    });
    expect(res.status).toBe(201);

    const { complaint } = res.body.report;
    expect(complaint).toEqual({
      guestName: 'Trần Thị B',
      location: 'Sảnh',
      description: 'Nhân viên trả lời chậm',
    });
    // No priority, no severity, no status — the whole point of the exact shape.
    expect(Object.keys(complaint).sort()).toEqual(['description', 'guestName', 'location']);
  });

  it('refuses a complaint with an empty description', async () => {
    const res = await createComplaint(letan, { description: '   ' });
    expect(res.status).toBe(422);
  });

  it('supports all five room-service subtypes', async () => {
    const cases = [
      { serviceType: 'ROOM_SALE', guestName: 'K1', roomClass: 'Deluxe', price: 850000, phone: '0900' },
      { serviceType: 'UPGRADE', guestName: 'K2', fromRoomClass: 'Standard', toRoomClass: 'Deluxe', price: 300000 },
      { serviceType: 'SMOKING', guestName: 'K3', roomNumber: '305', price: 500000 },
      { serviceType: 'LAUNDRY', guestName: 'K4', roomNumber: '306', price: 120000 },
      { serviceType: 'OTHER', guestName: 'K5', roomNumber: '307', serviceName: 'Thuê xe máy', price: 200000 },
    ];
    for (const roomService of cases) {
      const res = await letan
        .post('/api/reception/reports')
        .send({ category: 'ROOM_SERVICE', roomService });
      expect(res.status, JSON.stringify(roomService)).toBe(201);
      expect(res.body.report.roomService.serviceType).toBe(roomService.serviceType);
      expect(res.body.report.roomService.price).toBe(roomService.price);
    }

    const list = await letan.get('/api/reception/reports?category=ROOM_SERVICE');
    expect(list.body.reports).toHaveLength(5);
  });

  it('requires the fields the subtype actually asks for', async () => {
    // Upgrade with no "từ hạng phòng".
    const missing = await letan.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'UPGRADE', guestName: 'K', toRoomClass: 'Deluxe', price: 100000 },
    });
    expect(missing.status).toBe(422);

    // "Dịch vụ khác" with no service name.
    const unnamed = await letan.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'OTHER', guestName: 'K', roomNumber: '1', price: 1000 },
    });
    expect(unnamed.status).toBe(422);
  });

  it('refuses a non-numeric or negative room-service price', async () => {
    for (const price of ['300000', -1, 1.5, null]) {
      const res = await letan.post('/api/reception/reports').send({
        category: 'ROOM_SERVICE',
        roomService: { serviceType: 'SMOKING', guestName: 'K', roomNumber: '1', price },
      });
      expect(res.status, String(price)).toBe(422);
    }
  });
});

describe('vấn đề khách yêu cầu keeps two actors', () => {
  async function newRequest(agent: Agent) {
    const res = await agent.post('/api/reception/reports').send({
      category: 'GUEST_REQUEST',
      guestRequest: { itemType: 'Balo', guestName: 'Khách ký gửi', note: 'Balo đen' },
    });
    expect(res.status).toBe(201);
    return res.body.report as { id: string };
  }

  it('records the creator, and leaves the receiver empty until somebody accepts', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    const list = await letan.get('/api/reception/reports?category=GUEST_REQUEST');
    const row = list.body.reports[0];
    expect(row.createdByName).toBe('Nguyễn A');
    expect(row.shiftName).toBe('Ca A');
    expect(row.guestRequest.accepted).toBe(false);
    expect(row.guestRequest.acceptedByName).toBeNull();
    expect(created.id).toBe(row.id);
  });

  it('records the receiver separately, on a LATER shift, without touching the creator', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    setClock({ now: () => hcm('2026-09-19', '14:02') });
    await checkIn(letanB, 'B', 'Nguyễn B');
    const accepted = await letanB.post(`/api/reception/reports/${created.id}/accept`).send({});
    expect(accepted.status).toBe(200);

    const r = accepted.body.report;
    expect(r.createdByName).toBe('Nguyễn A');
    expect(r.shiftName).toBe('Ca A');
    expect(r.createdAt).toBe(hcm('2026-09-19', '10:05').toISOString());
    expect(r.guestRequest.acceptedByName).toBe('Nguyễn B');
    expect(r.guestRequest.acceptedShiftName).toBe('Ca B');
    expect(r.guestRequest.acceptedAt).toBe(hcm('2026-09-19', '14:02').toISOString());
  });

  it('stores both events even when one person does both', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    setClock({ now: () => hcm('2026-09-19', '11:30') });
    const accepted = await letan.post(`/api/reception/reports/${created.id}/accept`).send({});
    expect(accepted.status).toBe(200);

    const r = accepted.body.report;
    expect(r.createdByName).toBe('Nguyễn A');
    expect(r.guestRequest.acceptedByName).toBe('Nguyễn A');
    // Two different instants: the two events are stored, not merged.
    expect(r.createdAt).not.toBe(r.guestRequest.acceptedAt);
  });

  it('refuses a second acceptance', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);
    expect((await letan.post(`/api/reception/reports/${created.id}/accept`).send({})).status).toBe(200);

    const again = await letan.post(`/api/reception/reports/${created.id}/accept`).send({});
    expect(again.status).toBe(409);
  });

  it('refuses to accept something that is not a guest request', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const complaint = await createComplaint(letan);
    const res = await letan.post(`/api/reception/reports/${complaint.body.report.id}/accept`).send({});
    expect(res.status).toBe(422);
  });
});

describe('sự cố cơ sở vật chất references the existing technical system', () => {
  async function reportIncident(agent: Agent) {
    const res = await agent.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '404',
      category: 'AIR_CONDITIONER',
      description: 'Máy lạnh không mát',
    });
    expect(res.status).toBe(201);
    return res.body.issue as { id: string };
  }

  it('points at the incident and creates no second one', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const issue = await reportIncident(letan);

    const before = await testPrisma.hotelIssue.count();
    const res = await letan
      .post('/api/reception/reports')
      .send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } });
    expect(res.status).toBe(201);
    // The journal entry created NOTHING in the incident table.
    expect(await testPrisma.hotelIssue.count()).toBe(before);

    expect(res.body.report.facility.issueId).toBe(issue.id);
    expect(res.body.report.facility.issue.description).toBe('Máy lạnh không mát');
    expect(res.body.report.facility.issue.status).toBe('NEW');
  });

  it('shows the LIVE technical status, not a copy taken at reporting time', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const issue = await reportIncident(letan);
    await letan
      .post('/api/reception/reports')
      .send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } });

    setClock({ now: () => hcm('2026-09-19', '09:00') });
    const accept = await tech
      .post(`/api/issues/${issue.id}/accept`)
      .send({ technicianName: 'Bảo', technicianPhone: '0909000111' });
    expect(accept.status).toBe(200);

    const list = await letan.get('/api/reception/reports?category=FACILITY_ISSUE');
    expect(list.body.reports[0].facility.issue.status).toBe('IN_PROGRESS');
    expect(list.body.reports[0].facility.issue.technicianName).toBe('Bảo');
    // The existing attempt record survived untouched.
    expect(await testPrisma.technicalRepairAttempt.count()).toBe(1);
  });

  it('refuses another branch’s incident', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letanCn2, 'A', 'Người CN2');
    const otherBranchIssue = await reportIncident(letanCn2);

    await checkIn(letan, 'A', 'Nguyễn A');
    const res = await letan
      .post('/api/reception/reports')
      .send({ category: 'FACILITY_ISSUE', facility: { issueId: otherBranchIssue.id } });
    expect(res.status).toBe(403);
  });

  it('refuses an incident that does not exist', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const res = await letan
      .post('/api/reception/reports')
      .send({ category: 'FACILITY_ISSUE', facility: { issueId: 'khong-ton-tai' } });
    expect(res.status).toBe(422);
  });

  it('has nothing to correct, and says so rather than silently succeeding', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const issue = await reportIncident(letan);
    const created = await letan
      .post('/api/reception/reports')
      .send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.id } });

    const res = await letan
      .patch(`/api/reception/reports/${created.body.report.id}`)
      .send({ complaint: { description: 'đổi' } });
    expect(res.status).toBe(422);
  });
});

describe('branch isolation and roles', () => {
  it('shows a receptionist their own branch only', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    await createComplaint(letan, { description: 'CN1' });

    await checkIn(letanCn2, 'A', 'Người CN2');
    await createComplaint(letanCn2, { description: 'CN2' });

    const mine = await letan.get('/api/reception/reports');
    expect(mine.body.reports).toHaveLength(1);
    expect(mine.body.reports[0].complaint.description).toBe('CN1');

    const theirs = await letanCn2.get('/api/reception/reports');
    expect(theirs.body.reports).toHaveLength(1);
    expect(theirs.body.reports[0].complaint.description).toBe('CN2');
  });

  it('refuses the two branchless roles outright', async () => {
    for (const agent of [tech, dept]) {
      expect((await agent.get('/api/reception/reports')).status).toBe(403);
      expect((await agent.post('/api/reception/reports').send({})).status).toBe(403);
      expect((await agent.get('/api/reception/shifts/cash')).status).toBe(403);
      expect((await agent.put('/api/reception/shifts/cash').send({ openingCash: 1 })).status).toBe(403);
    }
  });

  it('refuses an Admin a write, and gives them every branch on read', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const mine = await createComplaint(letan, { description: 'CN1' });
    await checkIn(letanCn2, 'A', 'Người CN2');
    await createComplaint(letanCn2, { description: 'CN2' });

    // The reception write routes are receptionist-only.
    expect((await admin.post('/api/reception/reports').send({})).status).toBe(403);
    expect(
      (await admin.patch(`/api/reception/reports/${mine.body.report.id}`).send({})).status,
    ).toBe(403);
    expect(
      (await admin.post(`/api/reception/reports/${mine.body.report.id}/void`).send({ reason: 'x' }))
        .status,
    ).toBe(403);

    const all = await admin.get('/api/admin/reports/operational');
    expect(all.status).toBe(200);
    expect(all.body.reports).toHaveLength(2);
  });

  /*
    BỘ PHẬN KỸ THUẬT WORKS EVERY BRANCH'S INCIDENTS, which makes it the role most
    likely to be let through a check written as "not a receptionist". It is named
    here explicitly, on the financial routes, because a technician with write
    access to a cash row is the worst version of that mistake.
  */
  it('refuses Bộ phận kỹ thuật every write on a payment record', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const payment = await letan.post('/api/reception/reports').send({
      category: 'PAYMENT',
      payment: { method: 'CASH', amount: 300000 },
    });
    expect(payment.status).toBe(201);
    const id = payment.body.report.id;

    expect((await tech.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 1 } })).status).toBe(403);
    expect((await tech.post(`/api/reception/reports/${id}/void`).send({ reason: 'x' })).status).toBe(403);
    expect((await tech.post(`/api/reception/reports/${id}/accept`).send({})).status).toBe(403);
    expect((await tech.get('/api/reception/reports')).status).toBe(403);

    // And nothing moved.
    const stored = await testPrisma.receptionPayment.findFirstOrThrow();
    expect(stored.amount).toBe(300000);
    expect(await testPrisma.receptionOperationalReport.count({ where: { NOT: { voidedAt: null } } })).toBe(0);
  });

  it('keeps Bộ phận kỹ thuật’s own all-branch incident access', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn A');
    await letan.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '101',
      category: 'AIR_CONDITIONER',
      description: 'CN1',
    });
    await checkIn(letanCn2, 'A', 'Người CN2');
    await letanCn2.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '202',
      category: 'AIR_CONDITIONER',
      description: 'CN2',
    });

    const queue = await tech.get('/api/issues?status=NEW');
    expect(queue.status).toBe(200);
    expect(queue.body.issues).toHaveLength(2);
  });

  it('refuses a receptionist another branch’s record by id', async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letanCn2, 'A', 'Người CN2');
    const theirs = await createComplaint(letanCn2, { description: 'CN2' });

    await checkIn(letan, 'A', 'Nguyễn A');
    const res = await letan
      .patch(`/api/reception/reports/${theirs.body.report.id}`)
      .send({ complaint: { description: 'sửa trộm' } });
    expect(res.status).toBe(403);
  });
});
