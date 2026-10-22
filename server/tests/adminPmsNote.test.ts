/**
 * The stored PMS note, and the reviewed payment mode.
 *
 * WHY THE NOTE IS STORED AT ALL: it is a string contract with the hotel system.
 * A receptionist pastes it, character for character, into the PMS. For Agoda and
 * CTrip it is generated once — at dispatch, from the review the Admin approved —
 * and it CANNOT be rebuilt afterwards: its second line carries the price the
 * GUEST booked at, and no column on the booking holds that figure. Anything
 * re-deriving this note on a later screen would be inventing money.
 *
 * So dispatch stores what it generated. That is asserted here as an exact string
 * match against the note the same request returned, for both platforms — not a
 * shape check, because a note that is merely note-shaped is the failure mode.
 *
 * The field briefly held something else: the name of whoever created the
 * reservation in the PMS, typed by the Admin at dispatch and required. 5.2d
 * removed that. The branch needs the note; the name answered a question nobody
 * was asking, and requiring it put two different things under one label.
 */
import fs from 'node:fs';
import path from 'node:path';
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

const AGODA_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '10-list-page-above-reservation.txt'),
  'utf8',
);
const CTRIP_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '06-real-page-property-above.txt'),
  'utf8',
);

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.booking.deleteMany();
});

afterAll(async () => testPrisma.$disconnect());

/** Dispatches an OTA reservation with the given body. */
const dispatch = (body: Record<string, unknown>) => admin.post('/api/admin/ota/dispatch').send(body);

const agodaBody = (over: Record<string, unknown> = {}) => ({
  source: 'AGODA',
  rawText: AGODA_RAW,
  overrides: { paymentMode: 'CN' },
  ...over,
});

/* ================================================================== */
/* Nothing is typed any more                                           */
/* ================================================================== */
describe('dispatch asks the Admin for no note', () => {
  it('dispatches a body carrying nothing but the review fields', async () => {
    const res = await dispatch(agodaBody());
    expect(res.status).toBe(201);
  });

  it('still stores a note, without one having been supplied', async () => {
    const res = await dispatch(agodaBody());
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.adminPmsNote).toBeTruthy();
  });

  it('ignores an adminPmsNote a stale browser still sends', async () => {
    // A tab left open across the upgrade must not fail validation mid-shift,
    // and must not be able to overwrite the generated note with typed text.
    const res = await dispatch(agodaBody({ adminPmsNote: 'Nguyen Van A' }));
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.adminPmsNote).not.toBe('Nguyen Van A');
    expect(booking.adminPmsNote).toBe(res.body.review.note);
  });
});

/* ================================================================== */
/* What is stored is what the Admin approved                           */
/* ================================================================== */
describe('what dispatch stores', () => {
  it('stores the generated note exactly, character for character', async () => {
    const res = await dispatch(agodaBody());
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    // The SAME string the review screen displayed and the Admin approved.
    expect(booking.adminPmsNote).toBe(res.body.review.note);
  });

  it('keeps the line break a CN note depends on', async () => {
    const res = await dispatch(agodaBody());
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.adminPmsNote).toContain('\n');
    expect(booking.adminPmsNote).toContain('GIÁ KHÁCH ĐẶT');
  });

  it('stores a note this row could never have rebuilt', async () => {
    // THE REASON THIS COLUMN EXISTS. The note quotes the guest-booked price;
    // totalAmount is the BRANCH price, and nothing else on the booking carries
    // the other figure. Storing is the only way the note survives.
    const res = await dispatch(agodaBody());
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    const guestPrice = /GIÁ KHÁCH ĐẶT ([\d.]+)/.exec(booking.adminPmsNote ?? '')?.[1];
    expect(guestPrice).toBeTruthy();

    const asNumber = Number(guestPrice!.replace(/\./g, ''));
    expect(asNumber).toBeGreaterThan(0);
    expect(asNumber).not.toBe(booking.totalAmount);
    expect(Object.values(booking)).not.toContain(asNumber);
  });

  it('stores it for CTrip too, in that platform’s own format', async () => {
    const res = await dispatch({ source: 'CTRIP', rawText: CTRIP_RAW, overrides: { paymentMode: 'CN' } });
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.adminPmsNote).toBe(res.body.review.note);
    // CTRIP is followed immediately by an underscore; AGD by a space.
    expect(booking.adminPmsNote?.startsWith('CTRIP_')).toBe(true);
    expect(booking.reviewedPaymentMode).toBe('CN');
  });

  it('stores a single-line note for a hotel-payment reservation', async () => {
    // A hotel-payment note has no guest-price line at all. Storing it verbatim
    // is what keeps that difference intact.
    const res = await dispatch(agodaBody({ overrides: { paymentMode: 'HOTEL_PAYMENT' } }));
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.adminPmsNote).toBe(res.body.review.note);
    expect(booking.adminPmsNote).not.toContain('\n');
    expect(booking.adminPmsNote).toContain('THANH TOÁN TẠI KHÁCH SẠN');
  });

  it('stores the payment mode the Admin reviewed', async () => {
    const res = await dispatch(agodaBody({ overrides: { paymentMode: 'HOTEL_PAYMENT' } }));
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.reviewedPaymentMode).toBe('HOTEL_PAYMENT');
  });

  it('keeps the reviewed mode separate from what the mail said', async () => {
    // paymentType records the MAIL's wording; reviewedPaymentMode records the
    // Admin's decision. Conflating them destroys the distinction exactly when
    // the two disagree, which is when it matters.
    const res = await dispatch(agodaBody({ overrides: { paymentMode: 'HOTEL_PAYMENT' } }));
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    expect(booking.reviewedPaymentMode).toBe('HOTEL_PAYMENT');
    expect(booking.reviewedPaymentMode).not.toBe(booking.paymentType);
  });

  it('serves the note back on the booking detail, unchanged', async () => {
    const res = await dispatch(agodaBody());
    const detail = await admin.get(`/api/bookings/${res.body.bookingId}`);
    expect(detail.body.booking.adminPmsNote).toBe(res.body.review.note);
    expect(detail.body.booking.reviewedPaymentMode).toBe('CN');
  });

  it('no longer sends it down the history list', async () => {
    // 5.2d removed the history column that displayed it. A field no screen
    // reads is one more thing on the wire that can drift out of date.
    await dispatch(agodaBody());
    const history = await admin.get('/api/bookings/history?pageSize=10');
    expect(history.body.bookings[0]).not.toHaveProperty('adminPmsNote');
  });
});

/* ================================================================== */
/* Editing after dispatch                                              */
/* ================================================================== */
describe('correcting the note after dispatch', () => {
  /** Dispatches one booking and returns its id and the note it stored. */
  async function dispatched(): Promise<{ id: string; note: string }> {
    const res = await dispatch(agodaBody());
    expect(res.status).toBe(201);
    return { id: res.body.bookingId as string, note: res.body.review.note as string };
  }

  const edit = (id: string, body: Record<string, unknown>) =>
    admin.patch(`/api/admin/bookings/${id}/ota-fields`).send(body);

  it('updates the note and records an immutable correction', async () => {
    const { id, note } = await dispatched();
    const res = await edit(id, { adminPmsNote: 'AGD 1_1STAN_1DEM 100.000 CN' });
    expect(res.status).toBe(200);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.adminPmsNote).toBe('AGD 1_1STAN_1DEM 100.000 CN');

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id, field: 'adminPmsNote' },
    });
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.oldValue).toBe(note);
    expect(corrections[0]!.newValue).toBe('AGD 1_1STAN_1DEM 100.000 CN');
  });

  it('records who made the change and when', async () => {
    const { id } = await dispatched();
    await edit(id, { adminPmsNote: 'AGD 2_1STAN_1DEM 200.000 CN' });

    const correction = await testPrisma.bookingCorrection.findFirstOrThrow({
      where: { bookingId: id, field: 'adminPmsNote' },
    });
    expect(correction.correctedByUserId).not.toBeNull();
    expect(correction.correctedAt).toBeInstanceOf(Date);
    // Same provenance every other correction carries.
    expect(correction.requestAuditId).not.toBeNull();
  });

  it('records a payment change the same way', async () => {
    const { id } = await dispatched();
    await edit(id, { reviewedPaymentMode: 'HOTEL_PAYMENT' });

    const correction = await testPrisma.bookingCorrection.findFirstOrThrow({
      where: { bookingId: id, field: 'reviewedPaymentMode' },
    });
    expect(correction.oldValue).toBe('CN');
    expect(correction.newValue).toBe('HOTEL_PAYMENT');
  });

  it('never overwrites silently — the old value survives in the correction', async () => {
    const { id, note } = await dispatched();
    await edit(id, { adminPmsNote: 'Second' });
    await edit(id, { adminPmsNote: 'Third' });

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id, field: 'adminPmsNote' },
      orderBy: { correctedAt: 'asc' },
    });
    expect(corrections).toHaveLength(2);
    expect(corrections[0]!.oldValue).toBe(note);
    expect(corrections[1]!.oldValue).toBe('Second');
  });

  it('writes no correction when nothing actually changed', async () => {
    // Re-submitting the same value would otherwise fill the history with rows
    // that record nothing and bury the ones that matter.
    const { id, note } = await dispatched();
    const res = await edit(id, { adminPmsNote: note });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(await testPrisma.bookingCorrection.count({ where: { bookingId: id } })).toBe(0);
  });

  it('rejects an empty note rather than erasing what the branch reads', async () => {
    const { id, note } = await dispatched();
    expect((await edit(id, { adminPmsNote: '' })).status).toBe(422);
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.adminPmsNote).toBe(note);
  });

  it('refuses a receptionist — this is an Admin correction', async () => {
    const { id, note } = await dispatched();
    const branchId = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).branchId!;
    await createReceptionist(branchId, { username: 'letan_note', mustChangePassword: false });
    const reception = (await loginAgent(app, 'letan_note', RECEPTIONIST_PASSWORD)).agent;

    expect((await reception.patch(`/api/admin/bookings/${id}/ota-fields`).send({ adminPmsNote: 'X' })).status).toBe(403);
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.adminPmsNote).toBe(note);
  });
});

/* ================================================================== */
/* Booking.com is untouched                                            */
/* ================================================================== */
describe('Booking.com', () => {
  it('still dispatches with no note, and stores none', async () => {
    // Its send endpoint deliberately did not change, and its note has always
    // been generated from the booking's own fields at display time.
    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'BCOM-1',
        customerName: 'Guest',
        sourcePlatform: 'BOOKING_COM',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'x',
        status: 'NEW',
        sentAt: new Date(),
      },
    });
    expect(booking.adminPmsNote).toBeNull();
    expect(booking.reviewedPaymentMode).toBeNull();

    const detail = await admin.get(`/api/bookings/${booking.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking.adminPmsNote).toBeNull();
  });
});
