/**
 * "BÁO CÁO VẤN ĐỀ" — the reception operational journal.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Every record inherits its branch, shift, shift type and employee name
 *      from the OPEN SESSION, and a request that tries to name its own is
 *      ignored rather than believed. This is the whole accountability model.
 *   2. A CLOSED shift cannot write. Once "Kết thúc ca" runs, the journal of the
 *      shift that just ended is final.
 *   3. Exactly five categories exist, and each one stores the fields its current
 *      form asks for — and nothing a client sends beyond them. "Nguồn" is a
 *      closed list for new payments; Room Service fields follow the subtype.
 *   4. A guest request and a service-quality report keep their creator and
 *      their completer SEPARATELY, even when they are the same person, and even
 *      across a shift change. The handling text is optional; the time is the
 *      server's.
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
    complaint: { guestName: 'Khách A', description: 'Máy lạnh ồn', ...body },
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
      complaint: { guestName: 'Khách B', description: 'Wifi yếu' },
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
    expect(res.body.categories[3].label).toBe('Vấn đề về chất lượng và dịch vụ');
    // "Nguồn" is a closed list for new entries, served once like the labels.
    expect(res.body.paymentSources).toEqual(['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia']);
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

  it('stores a service-quality report from Tên khách, Mã EZ and Mô tả, as "Đã tiếp nhận"', async () => {
    const res = await createComplaint(letan, {
      guestName: 'Trần Thị B',
      ezCode: 'EZ555',
      description: 'Nhân viên trả lời chậm',
      // A legacy field an old client might still send: not accepted any more.
      location: 'Sảnh',
    });
    expect(res.status).toBe(201);

    const { complaint } = res.body.report;
    expect(complaint).toMatchObject({
      guestName: 'Trần Thị B',
      ezCode: 'EZ555',
      description: 'Nhân viên trả lời chậm',
      location: null,
      completed: false,
      completedAt: null,
      completedByName: null,
      resolution: null,
    });
    // No priority, no severity, no assignee — only the two-state lifecycle.
    expect(Object.keys(complaint)).not.toEqual(expect.arrayContaining(['priority']));
    expect(Object.keys(complaint)).not.toEqual(expect.arrayContaining(['severity']));
  });

  it('refuses a complaint with an empty description', async () => {
    const res = await createComplaint(letan, { description: '   ' });
    expect(res.status).toBe(422);
  });

  const service = (roomService: Record<string, unknown>) =>
    letan.post('/api/reception/reports').send({ category: 'ROOM_SERVICE', roomService });

  it('supports all five room-service subtypes, each with the common fields and Mã EZ', async () => {
    const cases = [
      { serviceType: 'ROOM_SALE', guestName: 'K1', ezCode: 'EZ1', roomClass: 'Deluxe', nights: 2, price: 850000 },
      { serviceType: 'UPGRADE', guestName: 'K2', ezCode: 'EZ2', fromRoomClass: 'Standard', toRoomClass: 'Deluxe', nights: 1, price: 300000 },
      { serviceType: 'SMOKING', guestName: 'K3', ezCode: 'EZ3', price: 500000, note: 'Phòng 305' },
      { serviceType: 'LAUNDRY', guestName: 'K4', ezCode: 'EZ4', price: 120000 },
      { serviceType: 'OTHER', guestName: 'K5', ezCode: 'EZ5', price: 200000, note: 'Thuê xe máy' },
    ];
    for (const roomService of cases) {
      const res = await service(roomService);
      expect(res.status, JSON.stringify(roomService)).toBe(201);
      expect(res.body.report.roomService).toMatchObject({
        serviceType: roomService.serviceType,
        guestName: roomService.guestName,
        ezCode: roomService.ezCode,
        price: roomService.price,
      });
    }

    const list = await letan.get('/api/reception/reports?category=ROOM_SERVICE');
    expect(list.body.reports).toHaveLength(5);
  });

  it('stores Hạng phòng and Số đêm on a sale, and the from/to pair and Số đêm on an upgrade', async () => {
    const sale = await service({ serviceType: 'ROOM_SALE', guestName: 'K', roomClass: 'Deluxe', nights: 3, price: 1 });
    expect(sale.body.report.roomService).toMatchObject({
      roomClass: 'Deluxe',
      nights: 3,
      fromRoomClass: null,
      toRoomClass: null,
    });

    const upgrade = await service({
      serviceType: 'UPGRADE',
      guestName: 'K',
      fromRoomClass: 'Standard',
      toRoomClass: 'Suite',
      nights: 2,
      price: 1,
    });
    expect(upgrade.body.report.roomService).toMatchObject({
      roomClass: null,
      fromRoomClass: 'Standard',
      toRoomClass: 'Suite',
      nights: 2,
    });
  });

  it('never stores a field the subtype does not ask for, whatever the request carried', async () => {
    const res = await service({
      serviceType: 'LAUNDRY',
      guestName: 'K',
      price: 120000,
      // None of these belong to "Giặt ủi"; the last three are legacy fields.
      roomClass: 'Deluxe',
      fromRoomClass: 'A',
      toRoomClass: 'B',
      nights: 4,
      phone: '0900',
      roomNumber: '305',
      serviceName: 'x',
    });
    expect(res.status).toBe(201);
    const stored = await testPrisma.roomServiceReport.findUniqueOrThrow({
      where: { reportId: res.body.report.id },
    });
    expect(stored).toMatchObject({
      serviceType: 'LAUNDRY',
      roomClass: null,
      fromRoomClass: null,
      toRoomClass: null,
      nights: null,
      phone: null,
      roomNumber: null,
      serviceName: null,
    });
  });

  it('requires the fields the subtype actually asks for, and nothing else', async () => {
    const refused = [
      // Bán phòng without a room class, or without nights.
      { serviceType: 'ROOM_SALE', guestName: 'K', nights: 1, price: 1 },
      { serviceType: 'ROOM_SALE', guestName: 'K', roomClass: 'Deluxe', price: 1 },
      // Upgrade without "từ" / "tới" hạng phòng, or without nights.
      { serviceType: 'UPGRADE', guestName: 'K', toRoomClass: 'Deluxe', nights: 1, price: 1 },
      { serviceType: 'UPGRADE', guestName: 'K', fromRoomClass: 'Std', nights: 1, price: 1 },
      { serviceType: 'UPGRADE', guestName: 'K', fromRoomClass: 'Std', toRoomClass: 'Dlx', price: 1 },
      // No guest name, on any subtype.
      { serviceType: 'SMOKING', guestName: ' ', price: 1 },
    ];
    for (const body of refused) {
      expect((await service(body)).status, JSON.stringify(body)).toBe(422);
    }
    // The three simple subtypes need no room number or service name any more.
    for (const serviceType of ['SMOKING', 'LAUNDRY', 'OTHER']) {
      expect((await service({ serviceType, guestName: 'K', price: 1 })).status, serviceType).toBe(201);
    }
  });

  it('refuses a number of nights that is not a whole number of at least one', async () => {
    for (const nights of [0, -1, 1.5, '2', 366]) {
      const res = await service({ serviceType: 'ROOM_SALE', guestName: 'K', roomClass: 'D', nights, price: 1 });
      expect(res.status, String(nights)).toBe(422);
    }
  });

  it('stamps the server time on a room service, never the browser’s', async () => {
    setClock({ now: () => hcm('2026-09-19', '09:41') });
    const res = await letan.post('/api/reception/reports').send({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'SMOKING', guestName: 'K', price: 1 },
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.report.createdAt).toBe(hcm('2026-09-19', '09:41').toISOString());
  });

  it('refuses a non-numeric or negative room-service price', async () => {
    for (const price of ['300000', -1, 1.5, null]) {
      const res = await service({ serviceType: 'SMOKING', guestName: 'K', price });
      expect(res.status, String(price)).toBe(422);
    }
  });

  it('corrects Số đêm on a sale, and refuses it on a subtype that has none', async () => {
    const sale = await service({ serviceType: 'ROOM_SALE', guestName: 'K', roomClass: 'D', nights: 1, price: 1 });
    const fixed = await letan
      .patch(`/api/reception/reports/${sale.body.report.id}`)
      .send({ roomService: { nights: 3 } });
    expect(fixed.status).toBe(200);
    expect(fixed.body.report.roomService.nights).toBe(3);
    expect(fixed.body.report.audits[0]).toMatchObject({ field: 'nights', oldValue: '1', newValue: '3' });

    const laundry = await service({ serviceType: 'LAUNDRY', guestName: 'K', price: 1 });
    const refused = await letan
      .patch(`/api/reception/reports/${laundry.body.report.id}`)
      .send({ roomService: { nights: 2 } });
    expect(refused.status).toBe(422);
  });
});

describe('"Nguồn" on a payment is a closed list for new entries', () => {
  beforeEach(async () => {
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
  });

  const pay = (payment: Record<string, unknown>) =>
    letan.post('/api/reception/reports').send({ category: 'PAYMENT', payment });

  it('accepts exactly Booking, Agoda, Ctrip, Traveloka and Expedia', async () => {
    for (const source of ['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia']) {
      const res = await pay({ source, method: 'CASH', amount: 1000 });
      expect(res.status, source).toBe(201);
      expect(res.body.report.payment.source).toBe(source);
    }
  });

  it('refuses any other source on the server, whatever the form allowed', async () => {
    for (const source of ['Booking.com', 'agoda', 'Walk-in', 'Airbnb']) {
      const res = await pay({ source, method: 'CASH', amount: 1000 });
      expect(res.status, source).toBe(422);
    }
    expect(await testPrisma.receptionPayment.count()).toBe(0);
  });

  it('allows no source at all — a walk-in came through no channel', async () => {
    const res = await pay({ method: 'CASH', amount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.report.payment.source).toBeNull();
  });

  it('no longer stores a room or a note sent by an old client', async () => {
    const res = await pay({ method: 'CASH', amount: 1000, roomNumber: '101', note: 'ghi chú' });
    expect(res.status).toBe(201);
    expect(res.body.report.payment).toMatchObject({ roomNumber: null, note: null });
  });

  it('leaves an older free-text source alone when another field is corrected', async () => {
    const res = await pay({ method: 'CASH', amount: 1000 });
    const id = res.body.report.id as string;
    // A row typed before the list was closed.
    await testPrisma.receptionPayment.update({ where: { reportId: id }, data: { source: 'agoda.com' } });

    const corrected = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ payment: { source: 'agoda.com', amount: 2000 } });
    expect(corrected.status).toBe(200);
    expect(corrected.body.report.payment).toMatchObject({ source: 'agoda.com', amount: 2000 });

    // …but a correction that CHANGES it must pick from the list.
    const invalid = await letan.patch(`/api/reception/reports/${id}`).send({ payment: { source: 'Airbnb' } });
    expect(invalid.status).toBe(422);
    const valid = await letan.patch(`/api/reception/reports/${id}`).send({ payment: { source: 'Agoda' } });
    expect(valid.status).toBe(200);
    expect(valid.body.report.payment.source).toBe('Agoda');
  });
});

describe('vấn đề khách yêu cầu thực hiện: đã tiếp nhận → đã hoàn thành', () => {
  async function newRequest(agent: Agent) {
    const res = await agent.post('/api/reception/reports').send({
      category: 'GUEST_REQUEST',
      guestRequest: { guestName: 'Khách ký gửi', ezCode: 'EZ305', note: 'Gửi balo đen, 14h lấy' },
    });
    expect(res.status).toBe(201);
    return res.body.report as { id: string };
  }

  const complete = (agent: Agent, id: string, body: Record<string, unknown>) =>
    agent.post(`/api/reception/reports/${id}/complete`).send(body);

  it('is "đã tiếp nhận" from creation: Mã EZ and content recorded, no completion time and no handling yet', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    const list = await letan.get('/api/reception/reports?category=GUEST_REQUEST');
    const row = list.body.reports[0];
    expect(created.id).toBe(row.id);
    expect(row.createdByName).toBe('Nguyễn A');
    expect(row.shiftName).toBe('Ca A');
    expect(row.createdAt).toBe(hcm('2026-09-19', '10:05').toISOString());
    expect(row.guestRequest).toMatchObject({
      guestName: 'Khách ký gửi',
      ezCode: 'EZ305',
      content: 'Gửi balo đen, 14h lấy',
      // "Ký gửi" and "Số phòng" are no longer asked for.
      itemType: null,
      roomNumber: null,
    });
    expect(row.guestRequest.completed).toBe(false);
    expect(row.guestRequest.completedAt).toBeNull();
    expect(row.guestRequest.completedByName).toBeNull();
    expect(row.guestRequest.resolution).toBeNull();
  });

  it('records the completion separately, on a LATER shift, without touching the creator', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    setClock({ now: () => hcm('2026-09-19', '14:02') });
    await checkIn(letanB, 'B', 'Nguyễn B');
    const done = await complete(letanB, created.id, { resolution: '  Đã trả balo cho khách  ' });
    expect(done.status).toBe(200);

    const r = done.body.report;
    expect(r.createdByName).toBe('Nguyễn A');
    expect(r.shiftName).toBe('Ca A');
    expect(r.createdAt).toBe(hcm('2026-09-19', '10:05').toISOString());
    expect(r.guestRequest.completed).toBe(true);
    expect(r.guestRequest.completedByName).toBe('Nguyễn B');
    expect(r.guestRequest.completedShiftName).toBe('Ca B');
    expect(r.guestRequest.completedAt).toBe(hcm('2026-09-19', '14:02').toISOString());
    expect(r.guestRequest.resolution).toBe('Đã trả balo cho khách');
  });

  it('stores both events even when one person does both', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    setClock({ now: () => hcm('2026-09-19', '11:30') });
    const done = await complete(letan, created.id, { resolution: 'Đã xử lý' });
    expect(done.status).toBe(200);

    const r = done.body.report;
    expect(r.createdByName).toBe('Nguyễn A');
    expect(r.guestRequest.completedByName).toBe('Nguyễn A');
    // Two different instants: the two events are stored, not merged.
    expect(r.createdAt).not.toBe(r.guestRequest.completedAt);
  });

  it('completes without "cách xử lý" — it is optional — and stores no placeholder', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');

    // An absent, empty or blank handling all complete, and all store nothing.
    for (const body of [{}, { resolution: '' }, { resolution: '   ' }]) {
      const created = await newRequest(letan);
      const res = await complete(letan, created.id, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.report.guestRequest.completed).toBe(true);
      expect(res.body.report.guestRequest.completedAt).toBe(hcm('2026-09-19', '10:05').toISOString());
      const stored = await testPrisma.guestRequestReport.findUniqueOrThrow({ where: { reportId: created.id } });
      expect(stored.resolution).toBeNull();
    }
  });

  it('requires a name and "Nội dung" to record a request, and ignores legacy fields', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const post = (guestRequest: Record<string, unknown>) =>
      letan.post('/api/reception/reports').send({ category: 'GUEST_REQUEST', guestRequest });

    expect((await post({ guestName: 'K', note: '  ' })).status).toBe(422);
    expect((await post({ guestName: ' ', note: 'Gửi hành lý' })).status).toBe(422);

    const res = await post({ guestName: 'K', note: 'Gửi hành lý', itemType: 'Balo', roomNumber: '305' });
    expect(res.status).toBe(201);
    expect(res.body.report.guestRequest).toMatchObject({ itemType: null, roomNumber: null, ezCode: null });
  });

  it('reads an older request’s "Ký gửi" as its content, without rewriting it', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);
    // How a V4 row looks: "Ký gửi" and a note beside it.
    await testPrisma.guestRequestReport.update({
      where: { reportId: created.id },
      data: { itemType: 'Balo', note: 'Balo đen', roomNumber: '305' },
    });

    const list = await letan.get('/api/reception/reports?category=GUEST_REQUEST');
    expect(list.body.reports[0].guestRequest).toMatchObject({
      content: 'Balo — Balo đen',
      itemType: 'Balo',
      roomNumber: '305',
    });
    expect(list.body.reports[0].summary).toBe('Balo · Khách ký gửi · đã tiếp nhận');
  });

  it('stamps the server time, whatever time the request claims', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    setClock({ now: () => hcm('2026-09-19', '11:00') });
    const done = await complete(letan, created.id, {
      resolution: 'Đã xử lý',
      completedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(done.status).toBe(200);
    expect(done.body.report.guestRequest.completedAt).toBe(hcm('2026-09-19', '11:00').toISOString());
  });

  it('refuses a second completion', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);
    expect((await complete(letan, created.id, { resolution: 'Lần một' })).status).toBe(200);

    const again = await complete(letan, created.id, { resolution: 'Lần hai' });
    expect(again.status).toBe(409);
    const stored = await testPrisma.guestRequestReport.findUniqueOrThrow({ where: { reportId: created.id } });
    expect(stored.resolution).toBe('Lần một');
  });

  it('refuses to complete a voided request', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);
    expect((await letan.post(`/api/reception/reports/${created.id}/void`).send({ reason: 'nhập trùng' })).status).toBe(200);

    const res = await complete(letan, created.id, { resolution: 'Đã xử lý' });
    expect(res.status).toBe(409);
  });

  it('refuses to complete something that has no lifecycle, such as a payment', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const payment = await letan
      .post('/api/reception/reports')
      .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 1000 } });
    const res = await complete(letan, payment.body.report.id, { resolution: 'Đã xử lý' });
    expect(res.status).toBe(422);
  });

  it('lets a correction change Mã EZ and Nội dung, but never the handling or a legacy field', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);

    const res = await letan
      .patch(`/api/reception/reports/${created.id}`)
      .send({ guestRequest: { ezCode: 'EZ306', note: 'Gửi vali', roomNumber: '306', itemType: 'Vali', resolution: 'Tự điền' } });
    expect(res.status).toBe(200);
    expect(res.body.report.guestRequest).toMatchObject({
      ezCode: 'EZ306',
      note: 'Gửi vali',
      roomNumber: null,
      itemType: null,
      resolution: null,
      completed: false,
    });

    // "Nội dung" cannot be emptied by a correction.
    const emptied = await letan
      .patch(`/api/reception/reports/${created.id}`)
      .send({ guestRequest: { note: '  ' } });
    expect(emptied.status).toBe(422);
  });

  it('no longer offers the V3 acceptance, which completed a request without saying how', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await newRequest(letan);
    const res = await letan.post(`/api/reception/reports/${created.id}/accept`).send({});
    expect(res.status).toBe(404);
  });
});

describe('vấn đề về chất lượng và dịch vụ: đã tiếp nhận → đã hoàn thành', () => {
  const complete = (agent: Agent, id: string, body: Record<string, unknown>) =>
    agent.post(`/api/reception/reports/${id}/complete`).send(body);

  it('completes on a later shift with "Hướng xử lý", keeping the creator untouched', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await createComplaint(letan, { ezCode: 'EZ9' });
    expect(created.status).toBe(201);

    setClock({ now: () => hcm('2026-09-19', '14:20') });
    await checkIn(letanB, 'B', 'Nguyễn B');
    const done = await complete(letanB, created.body.report.id, {
      resolution: '  Đổi phòng cho khách  ',
      completedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(done.status).toBe(200);

    const r = done.body.report;
    expect(r.createdByName).toBe('Nguyễn A');
    expect(r.createdAt).toBe(hcm('2026-09-19', '10:05').toISOString());
    expect(r.complaint).toMatchObject({
      completed: true,
      completedByName: 'Nguyễn B',
      completedShiftName: 'Ca B',
      // The server's clock, never the one the request claims.
      completedAt: hcm('2026-09-19', '14:20').toISOString(),
      resolution: 'Đổi phòng cho khách',
    });
  });

  it('completes with no handling text at all', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    for (const body of [{}, { resolution: '' }, { resolution: '   ' }]) {
      const created = await createComplaint(letan);
      const done = await complete(letan, created.body.report.id, body);
      expect(done.status, JSON.stringify(body)).toBe(200);
      expect(done.body.report.complaint).toMatchObject({ completed: true, resolution: null });
    }
  });

  it('refuses a second completion and a completion of a voided report', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const first = await createComplaint(letan);
    expect((await complete(letan, first.body.report.id, { resolution: 'Lần một' })).status).toBe(200);
    expect((await complete(letan, first.body.report.id, { resolution: 'Lần hai' })).status).toBe(409);
    const stored = await testPrisma.customerComplaintReport.findUniqueOrThrow({
      where: { reportId: first.body.report.id },
    });
    expect(stored.resolution).toBe('Lần một');

    const voided = await createComplaint(letan);
    await letan.post(`/api/reception/reports/${voided.body.report.id}/void`).send({ reason: 'nhập trùng' });
    expect((await complete(letan, voided.body.report.id, {})).status).toBe(409);
    const untouched = await testPrisma.customerComplaintReport.findUniqueOrThrow({
      where: { reportId: voided.body.report.id },
    });
    expect(untouched.completedAt).toBeNull();
  });

  it('cannot be completed through a correction', async () => {
    setClock({ now: () => hcm('2026-09-19', '10:05') });
    await checkIn(letan, 'A', 'Nguyễn A');
    const created = await createComplaint(letan);
    const res = await letan
      .patch(`/api/reception/reports/${created.body.report.id}`)
      .send({ complaint: { ezCode: 'EZ1', resolution: 'x', completedAt: '2026-09-19T00:00:00.000Z' } });
    expect(res.status).toBe(200);
    expect(res.body.report.complaint).toMatchObject({ ezCode: 'EZ1', completed: false, resolution: null });
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
    expect(
      (await tech.post(`/api/reception/reports/${id}/complete`).send({ resolution: 'x' })).status,
    ).toBe(403);
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
