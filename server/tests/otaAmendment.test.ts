/**
 * Amending a booking that was already dispatched.
 *
 * An amended mail describes the SAME reservation with different details.
 * Dispatching it again is refused — correctly, since a second booking would
 * double the stay — which left the amendment silently ignored and the branch
 * working from superseded details.
 *
 * Two properties matter most, and both are about not acting on a parser's word:
 *
 *   the comparison WRITES NOTHING until a human accepts it;
 *   a mail that says CANCELLED never cancels a real guest's room.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';

const AGODA_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '10-list-page-above-reservation.txt'),
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

const AGODA = {
  source: 'AGODA',
  rawText: AGODA_RAW,
  // Required since 5.2b: who created the reservation in the hotel PMS.
  adminPmsNote: 'Nguyen Van A\nCa sáng',
  overrides: { paymentMode: 'CN' },
};

/** The same reservation with a later check-out and a higher price. */
const AMENDED_RAW = AGODA_RAW
  .replace('Check-out Trả phòng\t5-Aug-2026 (5-08-2026)', 'Check-out Trả phòng\t7-Aug-2026 (7-08-2026)')
  .replace('Agoda Booking Confirmation', 'Agoda Amended Booking Confirmation');

const AMENDED = { source: 'AGODA', rawText: AMENDED_RAW, overrides: { paymentMode: 'CN' } };

async function dispatchOne(): Promise<string> {
  const res = await admin.post('/api/admin/ota/dispatch').send(AGODA);
  expect(res.status).toBe(201);
  return res.body.bookingId as string;
}

const preview = (body: Record<string, unknown>) =>
  admin.post('/api/admin/ota/amendment').send(body);
const apply = (body: Record<string, unknown>) =>
  admin.post('/api/admin/ota/amendment/apply').send(body);

/* ================================================================== */
/* The comparison                                                      */
/* ================================================================== */
describe('the amendment comparison', () => {
  it('lists every field that differs, old beside new', async () => {
    const id = await dispatchOne();
    const res = await preview(AMENDED);
    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBe(id);

    const byField = new Map(
      res.body.changes.map((c: { field: string }) => [c.field, c]),
    );
    const checkOut = byField.get('checkOut') as { oldValue: string; newValue: string; label: string };
    expect(checkOut.oldValue).toBe('2026-08-05');
    expect(checkOut.newValue).toBe('2026-08-07');
    expect(checkOut.label).toBe('Ngày trả phòng');
  });

  it('reports the platform status changing to AMENDED', async () => {
    await dispatchOne();
    const res = await preview(AMENDED);
    const status = res.body.changes.find((c: { field: string }) => c.field === 'otaBookingStatus');
    expect(status.oldValue).toBe('CONFIRMED');
    expect(status.newValue).toBe('AMENDED');
  });

  it('writes absolutely nothing', async () => {
    const id = await dispatchOne();
    const before = await testPrisma.booking.findUniqueOrThrow({ where: { id } });

    await preview(AMENDED);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(after).toEqual(before);
    expect(await testPrisma.bookingCorrection.count()).toBe(0);
  });

  it('reports no changes when the mail says the same thing', async () => {
    await dispatchOne();
    const res = await preview(AGODA);
    expect(res.body.changes).toEqual([]);
  });

  it('refuses an amendment for a reservation never dispatched', async () => {
    const res = await preview(AMENDED);
    expect(res.status).toBe(404);
  });
});

/* ================================================================== */
/* Applying                                                            */
/* ================================================================== */
describe('applying an amendment', () => {
  it('updates the booking in place — no second booking', async () => {
    const id = await dispatchOne();
    const res = await apply(AMENDED);
    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBe(id);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.checkOutDate?.toISOString().slice(0, 10)).toBe('2026-08-07');
    // One booking, still. The current row is the latest state.
    expect(await testPrisma.booking.count()).toBe(1);
  });

  it('records every applied field as an immutable correction', async () => {
    const id = await dispatchOne();
    await apply(AMENDED);

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id },
    });
    const checkOut = corrections.find((c) => c.field === 'checkOut');
    expect(checkOut?.oldValue).toBe('2026-08-05');
    expect(checkOut?.newValue).toBe('2026-08-07');
    expect(checkOut?.correctedByUserId).not.toBeNull();
  });

  it('applies only the fields the reviewer accepted', async () => {
    const id = await dispatchOne();
    const res = await apply({ ...AMENDED, acceptedFields: ['otaBookingStatus'] });

    expect(res.body.applied.map((c: { field: string }) => c.field)).toEqual(['otaBookingStatus']);
    expect(res.body.rejected.map((c: { field: string }) => c.field)).toContain('checkOut');

    // The rejected field is untouched on the booking.
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.checkOutDate?.toISOString().slice(0, 10)).toBe('2026-08-05');
  });

  it('leaves the booking untouched when every change is rejected', async () => {
    const id = await dispatchOne();
    const before = await testPrisma.booking.findUniqueOrThrow({ where: { id } });

    const res = await apply({ ...AMENDED, acceptedFields: [] });
    expect(res.body.applied).toEqual([]);
    expect(res.body.rejected.length).toBeGreaterThan(0);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(after).toEqual(before);
    // A rejected amendment records nothing, because nothing happened.
    expect(await testPrisma.bookingCorrection.count({ where: { bookingId: id } })).toBe(0);
  });

  it('keeps earlier corrections when a second amendment arrives', async () => {
    const id = await dispatchOne();
    await apply(AMENDED);

    const secondRaw = AMENDED_RAW.replace(
      'Customer First Name Tên Khách Hàng\tNga',
      'Customer First Name Tên Khách Hàng\tHai',
    );
    await apply({ source: 'AGODA', rawText: secondRaw, overrides: { paymentMode: 'CN' } });

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id },
      orderBy: { correctedAt: 'asc' },
    });
    // The first amendment's row survives the second: history is never rewritten.
    expect(corrections.some((c) => c.field === 'checkOut')).toBe(true);
    expect(corrections.some((c) => c.field === 'guestName')).toBe(true);
  });

  it('links the corrections to the request that made them', async () => {
    const id = await dispatchOne();
    await admin
      .post('/api/admin/ota/amendment/apply')
      .set('x-request-id', 'corr-amend-001')
      .send(AMENDED);

    const correction = await testPrisma.bookingCorrection.findFirstOrThrow({
      where: { bookingId: id, field: 'checkOut' },
      include: { requestAudit: true },
    });
    expect(correction.requestAudit?.correlationId).toBe('corr-amend-001');
  });
});

/* ================================================================== */
/* A cancelled mail never cancels a booking                            */
/* ================================================================== */
describe('OTA cancellation is reported, never applied', () => {
  const CANCELLED_RAW = AGODA_RAW.replace(
    'Agoda Booking Confirmation',
    'Agoda Booking Cancelled',
  );
  const CANCELLED = { source: 'AGODA', rawText: CANCELLED_RAW, overrides: { paymentMode: 'CN' } };

  it('flags the cancellation on the comparison', async () => {
    await dispatchOne();
    const res = await preview(CANCELLED);
    expect(res.body.otaCancelled).toBe(true);
    expect(res.body.currentStatus).toBe('NEW');
  });

  it('does NOT move the booking status, even when applied', async () => {
    const id = await dispatchOne();
    await apply(CANCELLED);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    // The platform's word is recorded; the operational state is not touched.
    expect(booking.status).toBe('NEW');
    expect(booking.cancelledAt).toBeNull();
    expect(booking.cancelledByUserId).toBeNull();
  });

  it('records the platform status as a correction so a human can act', async () => {
    const id = await dispatchOne();
    await apply(CANCELLED);

    const correction = await testPrisma.bookingCorrection.findFirstOrThrow({
      where: { bookingId: id, field: 'otaBookingStatus' },
    });
    expect(correction.newValue).toBe('CANCELLED');
  });

  it('cancels only when a person explicitly says so', async () => {
    const id = await dispatchOne();
    await apply(CANCELLED);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe('NEW');

    // The lifecycle route is the ONLY way to a cancelled booking.
    const res = await admin
      .post(`/api/bookings/${id}/cancel`)
      .send({ reason: 'Đã xác nhận huỷ từ OTA' });
    expect(res.status).toBe(200);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.status).toBe('CANCELLED');
    expect(booking.cancellationReason).toBe('Đã xác nhận huỷ từ OTA');
  });

  it('flags no cancellation for an ordinary amendment', async () => {
    await dispatchOne();
    expect((await preview(AMENDED)).body.otaCancelled).toBe(false);
  });
});

/* ================================================================== */
/* Booking.com is untouched                                            */
/* ================================================================== */
describe('Booking.com is unreachable from this path', () => {
  it('refuses BOOKING_COM as an amendment source', async () => {
    const res = await preview({ source: 'BOOKING_COM', rawText: AGODA_RAW });
    expect(res.status).toBe(422);
  });
});

/* ================================================================== */
/* Two tabs cannot both apply the same amendment                       */
/* ================================================================== */
describe('concurrent applies', () => {
  it('lets exactly one of two simultaneous applies succeed', async () => {
    const id = await dispatchOne();
    // Both tabs opened the same comparison and hold the same version token.
    const a = await preview(AMENDED);
    const b = await preview(AMENDED);
    expect(a.body.expectedVersion).toBe(b.body.expectedVersion);

    const [first, second] = await Promise.all([
      apply({ ...AMENDED, expectedVersion: a.body.expectedVersion }),
      apply({ ...AMENDED, expectedVersion: b.body.expectedVersion }),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([200, 409]);

    // One amendment, one set of corrections — not two.
    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id, field: 'checkOut' },
    });
    expect(corrections).toHaveLength(1);
  });

  it('refuses an apply built on a stale comparison', async () => {
    const id = await dispatchOne();
    const stale = await preview(AMENDED);

    // Someone else changes the booking in between.
    await apply(AMENDED);

    const res = await apply({ ...AMENDED, expectedVersion: stale.body.expectedVersion });
    expect(res.status).toBe(409);

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: id, field: 'checkOut' },
    });
    expect(corrections).toHaveLength(1);
  });

  it('advances the version even when only a status change is applied', async () => {
    await dispatchOne();
    const before = await preview(AMENDED);

    await apply({ ...AMENDED, acceptedFields: ['otaBookingStatus'] });

    const after = await preview(AMENDED);
    // A status-only amendment writes no business column, but the token must
    // still move — otherwise the guard could be bypassed by choosing fields
    // that happen to touch nothing.
    expect(after.body.expectedVersion).not.toBe(before.body.expectedVersion);
  });
});
