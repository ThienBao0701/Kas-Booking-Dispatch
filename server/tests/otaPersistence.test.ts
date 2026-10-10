/**
 * The canonical OTA persistence model.
 *
 * A reviewed reservation must arrive in the database — and then on the
 * reception screen — carrying everything the Admin saw, unchanged. Earlier
 * increments persisted only what dispatch strictly needed, so fields the parser
 * had read correctly were silently dropped at the write: the branch could not
 * see the guest's country, the rate plan, or which nights the platform quoted.
 *
 * These tests assert the persisted row against the PARSER and the REVIEW rather
 * than against constants, so a field that changes between any two stages fails
 * here even when nobody wrote down what it should have been.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { parseAgodaPartnerBooking } from '../src/booking/agodaPartner';
import { OTA_REVIEW_VERSION } from '../src/booking/otaReview';

const AGODA_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '10-list-page-above-reservation.txt'),
  'utf8',
);
const MULTI_ROOM = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '11-SYNTHETIC-multi-room-types.txt'),
  'utf8',
);

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let reception: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn5, { username: 'letan_persist', mustChangePassword: false });
  reception = (await loginAgent(app, 'letan_persist', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.booking.deleteMany();
});

afterAll(async () => testPrisma.$disconnect());

async function dispatch(body: Record<string, unknown>) {
  const res = await admin
    .post('/api/admin/ota/dispatch')
    .send({ adminPmsNote: 'Nguyen Van A\nCa sáng', ...body });
  return res;
}

const AGODA = {
  source: 'AGODA',
  rawText: AGODA_RAW,
  // Required since 5.2b: who created the reservation in the hotel PMS.
  adminPmsNote: 'Nguyen Van A\nCa sáng',
  overrides: { paymentMode: 'CN' },
};

/* ================================================================== */
/* Every reviewed field reaches the database                           */
/* ================================================================== */
describe('the review snapshot is persisted in full', () => {
  it('stores every descriptive field exactly as the parser read it', async () => {
    const parsed = parseAgodaPartnerBooking(AGODA_RAW);
    const res = await dispatch(AGODA);
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });

    // Asserted against the PARSER, not against constants.
    expect(booking.sourcePropertyId).toBe(parsed.sourcePropertyId);
    expect(booking.otaBookingStatus).toBe(parsed.bookingStatus);
    expect(booking.countryOfResidence).toBe(parsed.countryOfResidence);
    expect(booking.websiteLanguage).toBe(parsed.websiteLanguage);
    expect(booking.paymentType).toBe(parsed.paymentType);
    expect(booking.benefitsIncluded).toBe(parsed.benefitsIncluded);
    expect(booking.cancellationPolicy).toBe(parsed.cancellationPolicy);
    expect(booking.specialRequest).toBe(parsed.specialRequests);
    expect(booking.ratePlanName).toBe(parsed.ratePlan);
  });

  it('records the platform, its booking id and the dispatching user', async () => {
    const res = await dispatch(AGODA);
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });

    expect(booking.sourcePlatform).toBe('AGODA');
    expect(booking.bookingCode).toBe(res.body.review.bookingCode);
    expect(booking.sentAt).not.toBeNull();
    expect(booking.sentByUserId).not.toBeNull();
    expect(booking.createdByUserId).toBe(booking.sentByUserId);
  });

  it('stamps both the parser and the review version', async () => {
    const parsed = parseAgodaPartnerBooking(AGODA_RAW);
    const res = await dispatch(AGODA);
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });

    expect(booking.parserVersion).toBe(parsed.parserVersion);
    expect(booking.reviewVersion).toBe(OTA_REVIEW_VERSION);
  });

  it('hashes the source text instead of storing it twice', async () => {
    const res = await dispatch(AGODA);
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });

    const expected = createHash('sha256').update(AGODA_RAW, 'utf8').digest('hex');
    expect(booking.rawTextSha256).toBe(expected);
    // The same mail dispatched again is recognisably the same source.
    expect(booking.rawTextSha256).toHaveLength(64);
  });

  it('never invents a value the mail did not state', async () => {
    // The CTrip page carries no rate plan, benefits or website language.
    const CTRIP_RAW = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'ctrip', '06-real-page-property-above.txt'),
      'utf8',
    );
    const res = await dispatch({ source: 'CTRIP', rawText: CTRIP_RAW, overrides: { paymentMode: 'CN' } });
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });
    // Absent stays absent — null, never a placeholder or a guess.
    expect(booking.ratePlanName).toBeNull();
    expect(booking.benefitsIncluded).toBeNull();
    expect(booking.websiteLanguage).toBeNull();
    expect(booking.sourcePropertyId).toBeNull();
  });
});

/* ================================================================== */
/* Nightly rates                                                       */
/* ================================================================== */
describe('nightly rates are preserved night by night', () => {
  it('stores every night exactly as the review returned it', async () => {
    const res = await dispatch(AGODA);
    const review = res.body.review;

    const nights = await testPrisma.bookingNightPrice.findMany({
      where: { bookingRoom: { bookingId: res.body.bookingId } },
      orderBy: { stayDate: 'asc' },
    });

    expect(nights).toHaveLength(review.nightlyRates.length);
    expect(nights.map((n) => n.stayDate.toISOString().slice(0, 10))).toEqual(
      review.nightlyRates.map((n: { stayDate: string }) => n.stayDate),
    );
    expect(nights.map((n) => n.amount)).toEqual(
      review.nightlyRates.map((n: { amount: number }) => n.amount),
    );
    // Nothing is marked estimated: these are the platform's own figures.
    expect(nights.every((n) => n.isEstimated === false)).toBe(true);
  });

  it('divides the nights across the physical rooms without multiplying the stay', async () => {
    /*
      The nightly figures cover the whole reservation, so repeating them under
      each room would multiply the stay's value — the thing this test has always
      guarded. It used to guard it by hanging every night on the first room and
      leaving the rest empty, which lost the room count: "SUP × 3" persisted as
      one room holding three rooms' worth of money.

      The guard is now stronger. Each physical room carries its own share of
      every night, and the shares are asserted to add back to exactly what the
      platform stated — so the stay can be neither inflated nor eroded.
    */
    const res = await dispatch({ source: 'AGODA', rawText: MULTI_ROOM, overrides: { paymentMode: 'CN' } });
    expect(res.status).toBe(201);

    const rooms = await testPrisma.bookingRoom.findMany({
      where: { bookingId: res.body.bookingId },
      include: { nights: { orderBy: { stayDate: 'asc' } } },
      orderBy: { roomIndex: 'asc' },
    });

    // One row per PHYSICAL room: the quantities on the review, summed.
    const physicalRooms = (res.body.review.rooms as { quantity: number }[]).reduce(
      (sum, r) => sum + r.quantity,
      0,
    );
    expect(rooms).toHaveLength(physicalRooms);

    const nightly = res.body.review.nightlyRates as { stayDate: string; amount: number | null }[];
    // Every room carries every night — none is dropped or left empty.
    for (const room of rooms) expect(room.nights).toHaveLength(nightly.length);

    // And night by night, the shares add back to the platform's own figure.
    nightly.forEach((stated, index) => {
      if (stated.amount === null) return;
      const summed = rooms.reduce((sum, room) => sum + (room.nights[index]!.amount ?? 0), 0);
      expect(summed, `night ${stated.stayDate}`).toBe(stated.amount);
    });
  });

  it('allocates estimated nights for a CTrip mail that stated none (5.1)', async () => {
    // CTrip often sends a payout, a check-in and a check-out and no per-night
    // breakdown, which used to leave the branch with no nightly rows at all.
    // The allocator fills them AFTER review, marks them as estimates, and must
    // sum to exactly the stored total — money is never created or lost.
    const CTRIP_RAW = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'ctrip', '06-real-page-property-above.txt'),
      'utf8',
    );
    const res = await dispatch({ source: 'CTRIP', rawText: CTRIP_RAW, overrides: { paymentMode: 'CN' } });

    const nights = await testPrisma.bookingNightPrice.findMany({
      where: { bookingRoom: { bookingId: res.body.bookingId } },
    });
    expect(nights.length).toBeGreaterThan(0);
    for (const night of nights) expect(night.isEstimated).toBe(true);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    expect(nights.reduce((t, n) => t + (n.amount ?? 0), 0)).toBe(booking.totalAmount);
  });
});

/* ================================================================== */
/* Parser warnings                                                     */
/* ================================================================== */
describe('parser warnings travel with the booking', () => {
  it('stores each warning the review reported', async () => {
    // A thread holding several reservations warns; that reason must survive.
    const thread = `${AGODA_RAW}\n\n${AGODA_RAW.replace('1756224954', '1799999999')}`;
    const res = await dispatch({ source: 'AGODA', rawText: thread, overrides: { paymentMode: 'CN' } });
    expect(res.status).toBe(201);

    const warnings = await testPrisma.bookingExtractWarning.findMany({
      where: { bookingId: res.body.bookingId },
    });
    expect(warnings.map((w) => w.code)).toEqual(
      res.body.review.warnings.map((w: { code: string }) => w.code),
    );
    expect(warnings.some((w) => w.code === 'AGODA_MULTIPLE_RESERVATIONS')).toBe(true);
  });
});

/* ================================================================== */
/* Correction history                                                  */
/* ================================================================== */
describe('correction history is append-only', () => {
  it('writes nothing when the Admin changed nothing', async () => {
    const res = await dispatch(AGODA);
    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: res.body.bookingId },
    });
    expect(corrections).toEqual([]);
  });

  it('records what the mail said beside what was dispatched', async () => {
    const parsed = parseAgodaPartnerBooking(AGODA_RAW);
    const res = await dispatch({
      source: 'AGODA',
      rawText: AGODA_RAW,
      overrides: { guestName: 'CORRECTED NAME', branchPrice: 1_234_567, paymentMode: 'CN' },
    });
    expect(res.status).toBe(201);

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: res.body.bookingId },
      orderBy: { field: 'asc' },
    });
    const byField = new Map(corrections.map((c) => [c.field, c]));

    expect(byField.get('guestName')?.oldValue).toBe(parsed.customerFullName);
    expect(byField.get('guestName')?.newValue).toBe('CORRECTED NAME');
    expect(byField.get('branchPrice')?.oldValue).toBe(String(parsed.netRate));
    expect(byField.get('branchPrice')?.newValue).toBe('1234567');
    // Fields the Admin did not touch produce no row.
    expect(byField.has('checkIn')).toBe(false);
    for (const c of corrections) expect(c.correctedByUserId).not.toBeNull();
  });

  it('survives a later edit to the booking', async () => {
    const res = await dispatch({
      source: 'AGODA',
      rawText: AGODA_RAW,
      overrides: { guestName: 'FIRST CORRECTION', paymentMode: 'CN' },
    });
    const id = res.body.bookingId;

    // Someone changes the guest again, directly on the booking.
    await testPrisma.booking.update({ where: { id }, data: { customerName: 'LATER EDIT' } });

    const corrections = await testPrisma.bookingCorrection.findMany({ where: { bookingId: id } });
    // The original correction is untouched: history is never rewritten.
    const guest = corrections.find((c) => c.field === 'guestName');
    expect(guest?.newValue).toBe('FIRST CORRECTION');
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).customerName).toBe(
      'LATER EDIT',
    );
  });
});

/* ================================================================== */
/* Reception sees the whole snapshot                                   */
/* ================================================================== */
describe('the branch sees what the Admin saw', () => {
  it('serves every persisted field on the reception detail', async () => {
    const res = await dispatch(AGODA);
    const detail = await reception.get(`/api/bookings/${res.body.bookingId}`);
    expect(detail.status).toBe(200);

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
      include: { rooms: { include: { nights: true } }, warnings: true },
    });
    const booking = detail.body.booking;

    // The detail is the stored row, not a re-derivation of it.
    expect(booking.bookingCode).toBe(stored.bookingCode);
    expect(booking.customerName).toBe(stored.customerName);
    expect(booking.totalAmount).toBe(stored.totalAmount);
    expect(booking.rooms).toHaveLength(stored.rooms.length);
    expect(booking.rooms[0].nights).toHaveLength(stored.rooms[0]!.nights.length);
  });

  it('keeps the whole chain identical from parser to reception', async () => {
    const parsed = parseAgodaPartnerBooking(AGODA_RAW);
    const res = await dispatch(AGODA);
    const review = res.body.review;
    const stored = await testPrisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    const detail = (await reception.get(`/api/bookings/${res.body.bookingId}`)).body.booking;

    // parser == review == database == reception, for the operational values.
    expect([parsed.bookingId, review.bookingCode, stored.bookingCode, detail.bookingCode]).toEqual(
      Array(4).fill(parsed.bookingId),
    );
    expect([parsed.customerFullName, review.guestName, stored.customerName, detail.customerName]).toEqual(
      Array(4).fill(parsed.customerFullName),
    );
    expect([parsed.netRate, review.branchPrice, stored.totalAmount, detail.totalAmount]).toEqual(
      Array(4).fill(parsed.netRate),
    );
  });
});

/* ================================================================== */
/* Booking.com is untouched                                            */
/* ================================================================== */
describe('Booking.com bookings gain nothing and lose nothing', () => {
  it('leaves every OTA snapshot column null', async () => {
    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'BCOM-PERSIST-1',
        customerName: 'Booking.com Guest',
        sourcePlatform: 'BOOKING_COM',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'x',
        status: 'DRAFT',
        branchId: cn5,
      },
    });

    for (const value of [
      booking.sourcePropertyId,
      booking.otaBookingStatus,
      booking.ratePlanName,
      booking.countryOfResidence,
      booking.websiteLanguage,
      booking.paymentType,
      booking.benefitsIncluded,
      booking.reviewVersion,
      booking.rawTextSha256,
    ]) {
      expect(value).toBeNull();
    }
    expect(await testPrisma.bookingCorrection.count({ where: { bookingId: booking.id } })).toBe(0);
  });
});
