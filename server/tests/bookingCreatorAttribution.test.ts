/**
 * WHO CREATED THIS ORDER — resolved by the server from the receptionist's shift.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Submitting the proof (the receptionist's "I created this reservation")
 *      attributes the order to the person on the open shift.
 *   2. With no open shift the submission is REFUSED, and specifically with
 *      SHIFT_CHECK_IN_REQUIRED so the browser knows to show the picker.
 *   3. A creator name sent BY THE CLIENT is ignored. This is the whole point:
 *      the field used to be typed, and a typed field can name anyone.
 *   4. The attribution is a SNAPSHOT — renaming the account, or closing the
 *      shift, does not rewrite the history of work already done.
 *   5. A re-creation after a rejection adds a second attempt beside the first
 *      rather than overwriting it, so the ORIGINAL creator survives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetBookingData, resetShiftData, testPrisma, utcDate } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

const NOW = hcm('2026-09-17', '08:00');

/** A 1x1 PNG — the smallest thing `sniffImageMime` accepts. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let cn1 = 0;
let letan: Agent;
let letanId = 0;
let admin: Agent;
let adminId = 0;

/**
 * Accounts and logins are built ONCE: the login endpoint is rate limited per app
 * instance, so logging in on every test exhausts the limiter and later tests
 * receive 401 instead of the status they assert.
 */
beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  const rec = await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letanId = rec.id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  const adm = await createAdmin({ mustChangePassword: false });
  adminId = adm.id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetBookingData();
  await resetShiftData();
  setClock({ now: () => NOW });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** A dispatched order, claimed by the receptionist so they may submit a proof. */
async function dispatchedBooking(code = 'ATTR-1', at: Date = NOW): Promise<string> {
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
      sentAt: at,
      sentByUserId: adminId,
      verificationStatus: 'NOT_SUBMITTED',
      claimedByUserId: letanId,
      claimedAt: at,
      claimExpiresAt: new Date(at.getTime() + 3 * 60 * 1000),
      claimCycle: 1,
    },
  });
  return booking.id;
}

async function checkIn(shiftType: string, name: string): Promise<void> {
  const res = await letan.post('/api/reception/shifts/check-in').send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
}

describe('the order gains its creator from the open shift', () => {
  it('stamps the receptionist name and the shift on the attempt', async () => {
    await checkIn('A4', 'Nguyễn Văn A');
    const id = await dispatchedBooking();

    const res = await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'proof.png');
    expect(res.status).toBe(201);

    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });
    expect(proof.receptionistNameSnapshot).toBe('Nguyễn Văn A');
    expect(proof.shiftType).toBe('A4');
    expect(proof.shiftSessionId).not.toBeNull();
    expect(proof.submittedByUserId).toBe(letanId);
  });

  it('serves the attribution back on the booking', async () => {
    await checkIn('B', 'Trần Thị B');
    const id = await dispatchedBooking('ATTR-WIRE');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'proof.png');

    const res = await admin.get(`/api/bookings/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.booking.proofs[0]).toMatchObject({
      receptionistName: 'Trần Thị B',
      shiftType: 'B',
    });
  });

  /**
   * THE SPOOFING CASE.
   *
   * The request carries `note` — the multipart field the old typed creator-name
   * box used. The server stores it as a note and attributes the order to the
   * SHIFT regardless, so a hand-made request cannot put another receptionist's
   * name on somebody's work.
   */
  it('ignores a creator name supplied by the client', async () => {
    await checkIn('A', 'Nguyễn Văn A');
    const id = await dispatchedBooking('ATTR-SPOOF');

    const res = await letan
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'Lê Thị Kẻ Mạo Danh')
      .attach('image', PNG, 'proof.png');
    expect(res.status).toBe(201);

    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });
    expect(proof.receptionistNameSnapshot).toBe('Nguyễn Văn A');
    expect(proof.receptionistNameSnapshot).not.toBe('Lê Thị Kẻ Mạo Danh');
  });
});

describe('no shift, no order', () => {
  it('refuses the submission with SHIFT_CHECK_IN_REQUIRED', async () => {
    const id = await dispatchedBooking('ATTR-NOSHIFT');

    const res = await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'proof.png');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
    expect(res.body.error.message).toContain('ca làm việc');
  });

  it('writes nothing when it refuses', async () => {
    const id = await dispatchedBooking('ATTR-NOWRITE');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'proof.png');

    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: id } })).toBe(0);
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    // Still awaiting creation — the refusal did not half-advance the order.
    expect(booking.verificationStatus).toBe('NOT_SUBMITTED');
  });

  it('accepts the submission once the receptionist checks in', async () => {
    const id = await dispatchedBooking('ATTR-RECOVER');
    expect((await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png')).status).toBe(422);

    await checkIn('A', 'Nguyễn Văn A');

    const res = await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png');
    expect(res.status).toBe(201);
  });
});

describe('the attribution is a snapshot, not a live lookup', () => {
  it('survives a renamed account', async () => {
    await checkIn('A', 'Nguyễn Văn A');
    const id = await dispatchedBooking('ATTR-RENAME');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png');

    // The person later changes their display name — or an Admin corrects it.
    await testPrisma.user.update({ where: { id: letanId }, data: { fullName: 'Tên Hoàn Toàn Khác' } });
    try {
      const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });
      expect(proof.receptionistNameSnapshot).toBe('Nguyễn Văn A');
    } finally {
      await testPrisma.user.update({ where: { id: letanId }, data: { fullName: 'Lễ tân Một' } });
    }
  });

  it('survives the shift being closed', async () => {
    await checkIn('C', 'Người Trực Đêm');
    const id = await dispatchedBooking('ATTR-CLOSED');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png');

    await letan.post('/api/reception/shifts/close').send({});

    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });
    expect(proof.receptionistNameSnapshot).toBe('Người Trực Đêm');
    expect(proof.shiftType).toBe('C');
    // The session row itself is kept, closed — it is the audit record.
    const session = await testPrisma.receptionShiftSession.findUniqueOrThrow({
      where: { id: proof.shiftSessionId! },
    });
    expect(session.closedAt).not.toBeNull();
    expect(session.receptionistName).toBe('Người Trực Đêm');
  });

  it('survives a disabled account', async () => {
    await checkIn('A', 'Nguyễn Văn A');
    const id = await dispatchedBooking('ATTR-DISABLED');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png');

    await testPrisma.user.update({ where: { id: letanId }, data: { active: false } });
    try {
      const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });
      expect(proof.receptionistNameSnapshot).toBe('Nguyễn Văn A');
    } finally {
      // The account is shared with the rest of the file — restore it, or every
      // later test is refused with ACCOUNT_DISABLED for no visible reason.
      await testPrisma.user.update({ where: { id: letanId }, data: { active: true } });
    }
  });
});

/**
 * THE RE-CREATION CASE — the heart of "Cần tạo lại" accountability.
 *
 * Attempt 1 is the ORIGINAL creator, for ever. A rejection and a second attempt
 * by a DIFFERENT person on a DIFFERENT shift adds a row; it does not overwrite
 * the first. That is why the report can say who originally created an order that
 * later had to be redone.
 */
describe('a re-creation never overwrites the original creator', () => {
  it('keeps both attempts, each with its own receptionist and shift', async () => {
    await checkIn('A', 'Người Tạo Đầu Tiên');
    const id = await dispatchedBooking('ATTR-REDO');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p.png');

    const first = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: id } });

    // The Admin rejects it.
    const rejected = await admin
      .post(`/api/bookings/${id}/proofs/${first.id}/reject`)
      .send({ reasonCode: 'WRONG_CUSTOMER_NAME', reviewNote: 'Sai tên khách' });
    expect(rejected.status).toBe(200);

    // A different shift, a different person, re-creates it.
    setClock({ now: () => hcm('2026-09-17', '15:00') });
    await testPrisma.booking.update({
      where: { id },
      data: { claimedByUserId: letanId, claimedAt: hcm('2026-09-17', '15:00'), claimExpiresAt: hcm('2026-09-17', '15:03'), claimCycle: 2 },
    });
    await checkIn('B', 'Người Tạo Lại');
    const second = await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'p2.png');
    expect(second.status).toBe(201);

    const proofs = await testPrisma.bookingCreationProof.findMany({
      where: { bookingId: id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(proofs).toHaveLength(2);

    // The original is untouched — same name, same shift, still REJECTED.
    expect(proofs[0]).toMatchObject({
      attemptNumber: 1,
      receptionistNameSnapshot: 'Người Tạo Đầu Tiên',
      shiftType: 'A',
      status: 'REJECTED',
    });
    // The re-creation stands beside it.
    expect(proofs[1]).toMatchObject({
      attemptNumber: 2,
      receptionistNameSnapshot: 'Người Tạo Lại',
      shiftType: 'B',
      status: 'PENDING_REVIEW',
    });
  });
});

/* ================================================================== */
/* Attribution across an early handover ("Đổi ca")                     */
/* ================================================================== */

/**
 * THE BOUNDARY IS THE HANDOVER INSTANT, AND IT ONLY EVER MOVES FORWARD.
 *
 * This is the claim the whole "Đổi ca" feature rests on: an order created at
 * 13:14 belongs to the receptionist who was on the desk at 13:14, for ever, even
 * though somebody else was on it at 13:16. If a handover could re-attribute work
 * already submitted, the accountability report would credit — or blame — the
 * wrong person for every order near a shift change.
 */
describe('a shift handover moves attribution forward and never backwards', () => {
  async function handover(reason: string, name: string, shiftType: string): Promise<void> {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason, incomingName: name, incomingShiftType: shiftType });
    expect(res.status).toBe(201);
  }

  it('keeps the outgoing receptionist on work submitted before, and the incoming one after', async () => {
    await checkIn('A', 'Nguyễn Văn A');

    // Submitted BEFORE the handover.
    const before = await dispatchedBooking('ATTR-BEFORE');
    expect(
      (await letan.post(`/api/bookings/${before}/proofs`).attach('image', PNG, 'proof.png')).status,
    ).toBe(201);

    // 13:15 — A leaves, B takes over Ca B.
    const at = new Date(NOW.getTime() + 60 * 60 * 1000);
    setClock({ now: () => at });
    await handover('Có việc cá nhân', 'Nguyễn Văn B', 'B');

    // Submitted AFTER the handover.
    // Claimed at the CURRENT clock — a three-minute claim stamped an hour ago
    // has expired, and the proof would be refused for that reason instead.
    const after = await dispatchedBooking('ATTR-AFTER', at);
    expect(
      (await letan.post(`/api/bookings/${after}/proofs`).attach('image', PNG, 'proof.png')).status,
    ).toBe(201);

    const first = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: before },
    });
    const second = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: after },
    });

    expect(first).toMatchObject({ receptionistNameSnapshot: 'Nguyễn Văn A', shiftType: 'A' });
    expect(second).toMatchObject({ receptionistNameSnapshot: 'Nguyễn Văn B', shiftType: 'B' });
    // Two different sessions, so the report can group by either.
    expect(first.shiftSessionId).not.toBe(second.shiftSessionId);
  });

  it('does not rewrite an attempt already stored when the handover happens', async () => {
    await checkIn('A', 'Nguyễn Văn A');
    const id = await dispatchedBooking('ATTR-FROZEN');
    await letan.post(`/api/bookings/${id}/proofs`).attach('image', PNG, 'proof.png');

    const beforeRow = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: id },
    });

    setClock({ now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });
    await handover('Có việc cá nhân', 'Nguyễn Văn B', 'B');

    const afterRow = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: id },
    });
    // Byte for byte the same attribution — the handover touched nothing.
    expect(afterRow.receptionistNameSnapshot).toBe(beforeRow.receptionistNameSnapshot);
    expect(afterRow.shiftType).toBe(beforeRow.shiftType);
    expect(afterRow.shiftSessionId).toBe(beforeRow.shiftSessionId);
  });
});
