/**
 * Hotel Technical Department — the incident lifecycle and who may drive it.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The structured report form's rules are enforced by the SERVER, so a
 *      request that skips the form is refused exactly as the form would refuse
 *      it.
 *   2. NEW → IN_PROGRESS → COMPLETED is a real state machine: each step is
 *      refused out of order, and accepting always names a technician.
 *   3. Bộ phận kỹ thuật sees all eight branches; Reception sees one.
 *   4. An ADMIN CANNOT perform a transition. Hiding the buttons is not the
 *      control — the API is — so the API is what is tested.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
import { assignTo } from './helpers/issues';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';
const NOW = new Date('2026-09-17T03:00:00.000Z'); // 10:00 HCM

let cn1 = 0;
let cn5 = 0;
let letan1: Agent;
let letan5: Agent;
let tech: Agent;
let techId = 0;
let admin: Agent;

/**
 * Accounts and logins are built ONCE: the login endpoint is rate limited per app
 * instance, so logging in on every test exhausts the limiter and later tests
 * receive 401 instead of the status they assert.
 */
beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;

  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  await createReceptionist(cn5, { username: 'letan5', fullName: 'Lễ tân CN5', mustChangePassword: false });
  letan5 = (await loginAgent(app, 'letan5', RECEPTIONIST_PASSWORD)).agent;

  const t = await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật viên trực',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  techId = t.id;
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await testPrisma.notification.deleteMany();
  await resetShiftData();
  setClock({ now: () => NOW });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** Reports an incident as CN1's receptionist and returns its id. */
async function report(body: Record<string, unknown>): Promise<string> {
  const res = await letan1.post('/api/issues').send(body);
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

describe('the report form is enforced on the server', () => {
  it('a room incident carries a room number', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'Máy lạnh không lạnh' });

    expect(res.status).toBe(201);
    expect(res.body.issue).toMatchObject({
      areaCategory: 'ROOM',
      roomNumber: '301',
      category: 'AIR_CONDITIONER',
      status: 'NEW',
      locationLabel: 'Phòng · Phòng 301',
    });
    // The reporter's name is snapshotted at the moment of reporting.
    expect(res.body.issue.reportedByName).toBe('Lễ tân CN1');
  });

  it('refuses a room incident with no room number', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', category: 'DOOR', description: 'Hỏng cửa' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('số phòng');
  });

  it('a hallway incident carries a floor and no room', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'HALLWAY', floorNumber: '3', description: 'Đèn hành lang tầng 3 bị cháy' });

    expect(res.status).toBe(201);
    expect(res.body.issue).toMatchObject({ areaCategory: 'HALLWAY', floorNumber: '3', roomNumber: null });
  });

  it('refuses a hallway incident with no floor', async () => {
    const res = await letan1.post('/api/issues').send({ areaCategory: 'HALLWAY', description: 'Đèn cháy' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('số tầng');
  });

  it('refuses a staircase incident with no floor', async () => {
    const res = await letan1.post('/api/issues').send({ areaCategory: 'STAIRCASE', description: 'Tay vịn lỏng' });
    expect(res.status).toBe(422);
  });

  it('a lobby incident carries one of the requested subtypes', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'LOBBY', areaSubtype: 'SOFA', description: 'Sofa rách' });

    expect(res.status).toBe(201);
    expect(res.body.issue).toMatchObject({ areaCategory: 'LOBBY', areaSubtype: 'SOFA' });
  });

  it('refuses a lobby incident with no subtype', async () => {
    const res = await letan1.post('/api/issues').send({ areaCategory: 'LOBBY', description: 'Có vấn đề' });
    expect(res.status).toBe(422);
  });

  /**
   * "Khác" and "Các Khu Vực Còn Lại" both mean "not on the list". Left alone
   * they produce a report saying only that something somewhere is broken, so
   * both require the one extra sentence that makes the report actionable.
   */
  it('refuses "Các Khu Vực Còn Lại" with no location detail', async () => {
    const res = await letan1.post('/api/issues').send({ areaCategory: 'OTHER_AREA', description: 'Hỏng' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('vị trí');
  });

  it('accepts "Các Khu Vực Còn Lại" with a location detail', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'OTHER_AREA', locationDetail: 'Kho tầng hầm', description: 'Cửa kho kẹt' });
    expect(res.status).toBe(201);
    expect(res.body.issue.locationLabel).toContain('Kho tầng hầm');
  });

  it('refuses lobby "Khác" with no location detail', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'LOBBY', areaSubtype: 'OTHER', description: 'Hỏng gì đó' });
    expect(res.status).toBe(422);
  });

  it('drops a room number that does not belong to the area', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOFTOP', roomNumber: '999', description: 'Lan can rooftop lỏng' });

    expect(res.status).toBe(201);
    // Stored as null, so a rooftop incident can never be read as a room one.
    expect(res.body.issue.roomNumber).toBeNull();
  });

  it('refuses a room that is not one of the branch’s rooms, and trims one that is', async () => {
    // CN1 (05 Trương Định) has no room 999, and 501 belongs to another branch's list only.
    for (const room of ['999', '104']) {
      const res = await letan1
        .post('/api/issues')
        .send({ areaCategory: 'ROOM', roomNumber: room, category: 'DOOR', description: 'Hỏng cửa' });
      expect(res.status).toBe(422);
    }
    const ok = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', roomNumber: ' 301 ', category: 'DOOR', description: 'Hỏng cửa' });
    expect(ok.status).toBe(201);
    expect(ok.body.issue.roomNumber).toBe('301');
  });

  it('serves the branch’s room list, ordered and without duplicates', async () => {
    const res = await letan1.get(`/api/branches/${cn1}/rooms`);
    expect(res.status).toBe(200);
    expect(res.body.rooms).toEqual(['101', '102', '103', '201', '202', '301', '302', '401', '402', '501', '502', '601', '602', '701', '702']);
  });

  it('the description is always required, and whitespace is not a description', async () => {
    const blank = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: '' });
    expect(blank.status).toBe(422);

    const spaces = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: '     ' });
    expect(spaces.status).toBe(422);
  });
});

describe('branch isolation for Reception is unchanged', () => {
  it('a receptionist files against their OWN branch, whatever they send', async () => {
    const res = await letan1
      .post('/api/issues')
      .send({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa', branchId: cn5 });

    expect(res.status).toBe(201);
    expect(res.body.issue.branchId).toBe(cn1);
  });

  it('a receptionist never sees another branch incident', async () => {
    await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Sự cố CN1' });

    const theirs = await letan5.get('/api/issues');
    expect(theirs.status).toBe(200);
    expect(theirs.body.issues).toHaveLength(0);
  });

  it('a receptionist cannot read another branch incident by id', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Sự cố CN1' });

    const res = await letan5.get(`/api/issues/${id}`);
    expect(res.status).toBe(403);
  });
});

describe('Bộ phận kỹ thuật works what it is given, in every branch', () => {
  it('sees the incidents assigned to it from all branches — and none that are not', async () => {
    const a = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Sự cố CN1' });
    const b = (
      await letan5.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '501', category: 'WIFI', description: 'Sự cố CN5' })
    ).body.issue.id as string;
    await report({ areaCategory: 'ROOM', roomNumber: '302', category: 'DOOR', description: 'Chưa giao' });
    await assignTo(admin, a, tech);
    await assignTo(admin, b, tech);

    const res = await tech.get('/api/issues');
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(2);
    const branchIds = res.body.issues.map((i: { branchId: number }) => i.branchId).sort();
    expect(branchIds).toEqual([cn1, cn5].sort());
  });

  it('cannot read an incident it was never given, by id', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Chưa giao' });
    expect((await tech.get(`/api/issues/${id}`)).status).toBe(403);
  });

  it('counts its own queues across every branch', async () => {
    const a = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'A' });
    const b = (
      await letan5.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '501', category: 'WIFI', description: 'B' })
    ).body.issue.id as string;
    await report({ areaCategory: 'ROOM', roomNumber: '302', category: 'DOOR', description: 'Chưa giao' });
    await assignTo(admin, a, tech);
    await assignTo(admin, b, tech);

    const res = await tech.get('/api/issues/counts');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      newCount: 2,
      reworkCount: 0,
      inProgressCount: 0,
      // Inspection is dormant: there is no such queue in the active workflow.
      awaitingInspectionCount: 0,
      completedCount: 0,
      inspectionEnabled: false,
    });
  });

  it('sees all eight branches in the branch list', async () => {
    const res = await tech.get('/api/branches');
    expect(res.status).toBe(200);
    expect(res.body.branches).toHaveLength(8);
  });
});

describe('NEW → IN_PROGRESS → COMPLETED', () => {
  it('accepting names the technician and stamps the moment', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);

    const res = await tech
      .post(`/api/issues/${id}/accept`)
      .send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });

    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'IN_PROGRESS',
      technicianName: 'Trần Văn B',
      technicianPhone: '0901234567',
      acceptedByName: 'Kỹ thuật viên trực',
    });
    expect(res.body.issue.acceptedAt).toBe(NOW.toISOString());

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.acceptedByUserId).toBe(techId);
  });

  it('accepting requires a technician name', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    const res = await tech.post(`/api/issues/${id}/accept`).send({ technicianName: '   ', technicianPhone: '0901234567' });
    expect(res.status).toBe(422);
  });

  it('accepting requires a phone number', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    const res = await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '' });
    expect(res.status).toBe(422);
  });

  it('completes an accepted incident and records who finished it', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });

    const res = await tech.post(`/api/issues/${id}/complete`).send({});
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({
      status: 'COMPLETED',
      completedByName: 'Kỹ thuật viên trực',
      // The technician who did the work is still named on the completed record.
      technicianName: 'Trần Văn B',
      technicianPhone: '0901234567',
    });
    expect(res.body.issue.completedAt).toBe(NOW.toISOString());
  });

  /**
   * COMPLETED IS REACHABLE ONLY FROM IN_PROGRESS. That is what guarantees a
   * completed incident always names a technician — skipping the accept step
   * would produce a finished job nobody is recorded as having done.
   */
  it('refuses to complete an incident nobody accepted', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);

    const res = await tech.post(`/api/issues/${id}/complete`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('tiếp nhận');

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('NEW');
    expect(stored.completedAt).toBeNull();
  });

  it('refuses to accept an incident twice', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });

    const second = await tech
      .post(`/api/issues/${id}/accept`)
      .send({ technicianName: 'Người Khác', technicianPhone: '0900000000' });

    expect(second.status).toBe(409);
    // The first technician's name is NOT overwritten by the loser of the race.
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.technicianName).toBe('Trần Văn B');
  });

  it('refuses to complete an incident twice', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
    await tech.post(`/api/issues/${id}/complete`).send({});

    const again = await tech.post(`/api/issues/${id}/complete`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('đã hoàn thành');
  });

  it('a completed incident is kept, never deleted', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
    await tech.post(`/api/issues/${id}/complete`).send({});

    const stored = await testPrisma.hotelIssue.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('COMPLETED');

    // And it is still listed, under its own queue.
    const list = await tech.get('/api/issues?status=COMPLETED');
    expect(list.body.issues).toHaveLength(1);
  });
});

/**
 * ADMIN IS READ-ONLY FOR THE WORKFLOW.
 *
 * These are the assertions that matter most in this file: the Admin UI has no
 * accept/complete buttons, but hiding a button is not a control. The API refuses
 * an Admin outright, so the rule holds for anyone with a terminal.
 */
describe('an Admin monitors and cannot perform technical transitions', () => {
  it('cannot accept an incident', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });

    const res = await admin
      .post(`/api/issues/${id}/accept`)
      .send({ technicianName: 'Quản trị viên', technicianPhone: '0900000000' });

    expect(res.status).toBe(403);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('NEW');
    expect(stored.technicianName).toBeNull();
  });

  it('cannot complete an incident', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });

    const res = await admin.post(`/api/issues/${id}/complete`).send({});

    expect(res.status).toBe(403);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.completedAt).toBeNull();
  });

  it('a receptionist cannot accept or complete either', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });

    expect(
      (await letan1.post(`/api/issues/${id}/accept`).send({ technicianName: 'X', technicianPhone: '1' })).status,
    ).toBe(403);
    expect((await letan1.post(`/api/issues/${id}/complete`).send({})).status).toBe(403);
  });

  it('an anonymous caller cannot transition anything', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Hỏng cửa' });
    const res = await request(app)
      .post(`/api/issues/${id}/accept`)
      .send({ technicianName: 'X', technicianPhone: '1' });
    expect(res.status).toBe(401);
  });

  it('still sees every branch and every status', async () => {
    await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'DOOR', description: 'Sự cố CN1' });
    await letan5.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '501', category: 'WIFI', description: 'Sự cố CN5' });

    const res = await admin.get('/api/issues');
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(2);
  });
});

describe('a new incident reaches the people who act on it', () => {
  it('notifies the people who assign it — and the technician only once it is theirs', async () => {
    const id = await report({ areaCategory: 'ROOM', roomNumber: '301', category: 'AIR_CONDITIONER', description: 'Máy lạnh hỏng' });

    const onReport = await testPrisma.notification.findMany({ include: { user: true } });
    expect(onReport.map((n) => n.user.role)).toEqual(['ADMIN']);
    expect(onReport[0]!.title).toBe('Có báo cáo sự cố mới');

    await assignTo(admin, id, tech);
    const toTech = await testPrisma.notification.findMany({ where: { userId: techId } });
    expect(toTech).toHaveLength(1);
    expect(toTech[0]!.title).toBe('Bạn được giao xử lý sự cố');
    expect(toTech[0]!.body).toContain('Giao bởi');
  });
});

/**
 * BỘ PHẬN KỸ THUẬT HAS NO BOOKING CAPABILITY.
 *
 * This role is branchless, and the booking module's branch and claim checks are
 * written as `actor.role === 'RECEPTIONIST' && …` — a role that is not a
 * receptionist SKIPS them rather than failing them. So "it has no menu item for
 * this" is not a control; these are the assertions that make it one.
 */
describe('a technical user cannot operate bookings', () => {
  let bookingId = '';

  beforeEach(async () => {
    // Cleared first: the outer reset only clears incidents, and
    // `Booking_one_operational_per_code_branch_checkin` refuses a second live
    // order with the same (code, branch, check-in) — correctly.
    await testPrisma.booking.deleteMany();

    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'TECH-NOPE',
        hotelName: 'KAS Passion Boutique Hotel',
        branchId: cn1,
        customerName: 'Nguyễn Thị Khách',
        sourcePlatform: 'BOOKING_COM',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'fixture',
        checkInDate: new Date('2026-09-20T00:00:00.000Z'),
        checkOutDate: new Date('2026-09-22T00:00:00.000Z'),
        status: 'NEW',
        sentAt: NOW,
        verificationStatus: 'NOT_SUBMITTED',
      },
    });
    bookingId = booking.id;
  });

  it('cannot claim an order', async () => {
    expect((await tech.post(`/api/bookings/${bookingId}/claim`).send({})).status).toBe(403);
  });

  it('cannot CẮT a field', async () => {
    const res = await tech.post(`/api/bookings/${bookingId}/cut`).send({ field: 'CUSTOMER_NAME' });
    expect(res.status).toBe(403);
  });

  it('cannot submit a creation proof', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await tech.post(`/api/bookings/${bookingId}/proofs`).attach('image', png, 'p.png');
    expect(res.status).toBe(403);
  });

  /**
   * The lifecycle endpoints had no role gate at all, so a branchless role could
   * have checked a guest in at a property it has no connection to.
   */
  it('cannot drive the operational lifecycle at any branch', async () => {
    for (const action of ['receive', 'check-in', 'check-out', 'cancel', 'no-show']) {
      const res = await tech.post(`/api/bookings/${bookingId}/${action}`).send({ reason: 'x' });
      expect(res.status).toBe(403);
    }

    const stored = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(stored.status).toBe('NEW');
    expect(stored.receivedAt).toBeNull();
  });

  it('gets no booking queue counts in the sidebar badges', async () => {
    const res = await tech.get('/api/nav-badges');
    expect(res.status).toBe(200);
    // Zeros, not "every branch" — the branchless filter used to widen to all.
    expect(res.body.counts).toEqual({
      new: 0,
      pendingReview: 0,
      rejected: 0,
      resendOrders: 0,
      chat: 0,
      reminders: 0,
    });
  });

  it('sees no orders in the receptionist queues', async () => {
    const res = await tech.get('/api/bookings/new');
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(0);
  });
});
