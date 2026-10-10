/**
 * Admin reports: "Cần tạo lại" accountability, and the hotel incident report.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The accountability report finds orders that had to be re-created, and
 *      attributes each to the branch, shift and receptionist that produced it.
 *   2. It keeps finding them AFTER the order was withdrawn and re-sent — which
 *      is the case a report driven off `Booking.verificationStatus` would lose,
 *      because a redispatch resets that field.
 *   3. Both PDFs are real PDFs with the Vietnamese font EMBEDDED, so the
 *      diacritics cannot be dropped.
 *   4. Only an Admin may run them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetBookingData, resetIssueData, resetShiftData, testPrisma, utcDate } from './helpers/db';
import { assignTo } from './helpers/issues';
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
const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const NOW = hcm('2026-09-17', '10:00');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let cn1 = 0;
let letan: Agent;
let letanId = 0;
let admin: Agent;
let adminId = 0;

let tech: Agent;

/**
 * Accounts and logins are built ONCE: the login endpoint is rate limited per app
 * instance, so logging in on every test exhausts the limiter and later tests
 * receive 401 instead of the status they assert.
 */
beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  const rec = await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letanId = rec.id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật viên trực',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  const adm = await createAdmin({ mustChangePassword: false });
  adminId = adm.id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetBookingData();
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => NOW });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/**
 * Creates an order, has the receptionist claim it on a named shift, submit a
 * proof, and the Admin reject it — i.e. one order that needs re-creating.
 */
async function rejectedOrder(code: string, shiftType: string, name: string): Promise<string> {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: code,
      hotelName: 'KAS Passion Boutique Hotel',
      branchId: cn1,
      customerName: 'Nguyễn Thị Khách',
      sourcePlatform: 'BOOKING_COM',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'fixture',
      checkInDate: utcDate('2026-09-20'),
      checkOutDate: utcDate('2026-09-22'),
      status: 'NEW',
      sentAt: NOW,
      sentByUserId: adminId,
      verificationStatus: 'NOT_SUBMITTED',
      claimedByUserId: letanId,
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 3 * 60 * 1000),
      claimCycle: 1,
    },
  });

  await letan.post('/api/reception/shifts/check-in').send({ shiftType, receptionistName: name });
  const submitted = await letan.post(`/api/bookings/${booking.id}/proofs`).attach('image', PNG, 'p.png');
  expect(submitted.status).toBe(201);

  const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: booking.id } });
  const rejected = await admin
    .post(`/api/bookings/${booking.id}/proofs/${proof.id}/reject`)
    .send({ reasonCode: 'WRONG_CUSTOMER_NAME', reviewNote: 'Sai tên khách' });
  expect(rejected.status).toBe(200);

  return booking.id;
}

const RANGE = 'from=2026-09-01&to=2026-09-30';

describe('the "Cần tạo lại" accountability report', () => {
  it('lists the rejected attempt with its branch, shift and receptionist', async () => {
    await rejectedOrder('REP-1', 'A4', 'Nguyễn Văn A');

    const res = await admin.get(`/api/admin/reports/recreations?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      bookingCode: 'REP-1',
      receptionistName: 'Nguyễn Văn A',
      shiftType: 'A4',
      shiftLabel: 'Ca A4',
      attemptNumber: 1,
      reasonCode: 'WRONG_CUSTOMER_NAME',
    });
    expect(res.body.rows[0].branch.code).toBe('TRUONG_DINH_05');
  });

  it('totals by branch, by shift and by receptionist', async () => {
    await rejectedOrder('REP-A', 'A', 'Nguyễn Văn A');
    await rejectedOrder('REP-B', 'A', 'Nguyễn Văn A');
    await rejectedOrder('REP-C', 'C4', 'Trần Thị B');

    const res = await admin.get(`/api/admin/reports/recreations?${RANGE}`);
    expect(res.body.totals.total).toBe(3);
    expect(res.body.totals.byShift).toEqual({ 'Ca A': 2, 'Ca C4': 1 });
    expect(res.body.totals.byReceptionist).toEqual({ 'Nguyễn Văn A': 2, 'Trần Thị B': 1 });
    expect(Object.values(res.body.totals.byBranch)).toEqual([3]);
  });

  it('filters by shift', async () => {
    await rejectedOrder('REP-A', 'A', 'Nguyễn Văn A');
    await rejectedOrder('REP-C', 'C4', 'Trần Thị B');

    const res = await admin.get(`/api/admin/reports/recreations?${RANGE}&shiftType=C4`);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].bookingCode).toBe('REP-C');
  });

  it('excludes a rejection outside the period', async () => {
    await rejectedOrder('REP-OLD', 'A', 'Nguyễn Văn A');

    const res = await admin.get('/api/admin/reports/recreations?from=2026-10-01&to=2026-10-31');
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.totals.total).toBe(0);
  });

  it('refuses an inverted range rather than returning nothing', async () => {
    const res = await admin.get('/api/admin/reports/recreations?from=2026-09-30&to=2026-09-01');
    expect(res.status).toBe(422);
  });

  /**
   * THE CASE THE WHOLE DESIGN TURNS ON.
   *
   * Withdrawing and re-sending an order RESETS `Booking.verificationStatus` to
   * NOT_SUBMITTED. A report driven off the booking row would therefore lose
   * exactly the orders that were re-created. Driven off the immutable proof
   * attempts, the history survives — and so does the name of whoever originally
   * created it.
   */
  it('still reports an order after it was withdrawn and re-sent', async () => {
    const bookingId = await rejectedOrder('REP-REDISPATCH', 'A', 'Người Tạo Đầu Tiên');

    // Withdraw, then re-send — the Admin recovery path.
    const deleted = await admin.delete(`/api/admin/bookings/${bookingId}`).send({});
    expect(deleted.status).toBe(200);
    const resent = await admin.post(`/api/admin/bookings/${bookingId}/redispatch`).send({});
    expect(resent.status).toBe(200);

    // The booking row has forgotten the rejection...
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.verificationStatus).toBe('NOT_SUBMITTED');

    // ...but the report has not.
    const res = await admin.get(`/api/admin/reports/recreations?${RANGE}`);
    expect(res.body.totals.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({
      bookingCode: 'REP-REDISPATCH',
      receptionistName: 'Người Tạo Đầu Tiên',
      shiftType: 'A',
    });
  });

  it('is refused to a receptionist', async () => {
    const res = await letan.get(`/api/admin/reports/recreations?${RANGE}`);
    expect(res.status).toBe(403);
  });
});

describe('the "Cần tạo lại" PDF', () => {
  it('is a PDF with the Vietnamese font embedded', async () => {
    await rejectedOrder('REP-PDF', 'A4', 'Nguyễn Văn Ạ');

    const res = await admin.get(`/api/admin/reports/recreations.pdf?${RANGE}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf');

    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // An embedded CID-keyed TrueType subset — the only way the diacritics in
    // "Nguyễn Văn Ạ" survive into the file.
    expect(body.includes('FontFile2')).toBe(true);
    expect(body.includes('CIDFontType2')).toBe(true);
  });

  it('is refused to a receptionist', async () => {
    const res = await letan.get(`/api/admin/reports/recreations.pdf?${RANGE}`);
    expect(res.status).toBe(403);
  });
});

describe('the hotel incident report', () => {
  async function completedIncident(): Promise<void> {
    const created = await letan
      .post('/api/issues')
      .send({ areaCategory: 'STAIRCASE', floorNumber: '3', description: 'Tay vịn cầu thang tầng 3 bị lỏng' });
    expect(created.status).toBe(201);

    const id = created.body.issue.id;
    // `createdAt` is the database's now(), not the test clock: pin it inside RANGE.
    await testPrisma.hotelIssue.update({ where: { id }, data: { createdAt: NOW } });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Trần Văn Bảo', technicianPhone: '0901234567' });
    await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });
  }

  it('returns the incidents in the period with the technician information', async () => {
    await completedIncident();

    const res = await admin.get(`/api/admin/reports/incidents?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      areaCategory: 'STAIRCASE',
      floorNumber: '3',
      status: 'COMPLETED',
      technicianName: 'Trần Văn Bảo',
      technicianPhone: '0901234567',
      reportedByName: 'Lễ tân CN1',
    });
    expect(res.body.issues[0].acceptedAt).not.toBeNull();
    expect(res.body.issues[0].completedAt).not.toBeNull();
  });

  it('excludes an incident outside the period', async () => {
    await completedIncident();
    const res = await admin.get('/api/admin/reports/incidents?from=2026-08-01&to=2026-08-31');
    expect(res.body.issues).toHaveLength(0);
  });

  it('is a PDF with the Vietnamese font embedded', async () => {
    await completedIncident();

    const res = await admin.get(`/api/admin/reports/incidents.pdf?${RANGE}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(body.includes('FontFile2')).toBe(true);
  });

  it('renders an empty period without failing', async () => {
    const res = await admin.get('/api/admin/reports/incidents.pdf?from=2026-01-01&to=2026-01-31').buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('is refused to a receptionist', async () => {
    expect((await letan.get(`/api/admin/reports/incidents?${RANGE}`)).status).toBe(403);
    expect((await letan.get(`/api/admin/reports/incidents.pdf?${RANGE}`)).status).toBe(403);
  });
});
