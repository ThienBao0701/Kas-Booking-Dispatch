/**
 * END-TO-END: an OTA reservation becomes one BookingRoom per PHYSICAL room.
 *
 * WHY THIS EXISTS SEPARATELY FROM `otaRoomAllocation.test.ts`. That file proves
 * the arithmetic in isolation, which is necessary but not sufficient: an
 * allocator can be perfectly correct and still not be the thing the running
 * dispatch calls. These cases go through the real HTTP endpoint and then read
 * the DATABASE, so they fail if the wiring is ever bypassed — which is exactly
 * the doubt that arose when the screen still showed one room.
 *
 * (The screen was right. The booking it showed had been dispatched before the
 * allocator existed, and its single row was written by the old code. Rows are
 * written once, at dispatch; nothing rewrites history.)
 *
 * Every case asserts the same invariant last: the per-room shares of each night
 * add back to exactly what the platform stated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';

const fixture = (platform: string, name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', platform, name), 'utf8');

/*
  These are the fixtures the dispatch endpoint actually accepts. The mail-format
  Agoda fixtures (01–04) parse as reservations but carry no room lines for this
  path, so dispatching them 422s on validation long before persistence — they
  cannot prove anything about room rows.

  `11-SYNTHETIC` carries Deluxe ×2, King ×1, Standard Double ×3: both a
  quantity > 1 line and several distinct types, so it serves Case 2 (expansion)
  and Case 5 (mixed types) with different assertions over the same reservation.
*/
const AGODA_ONE_ROOM = fixture('agoda', '10-list-page-above-reservation.txt');
const AGODA_MULTI = fixture('agoda', '11-SYNTHETIC-multi-room-types.txt');
const CTRIP_ONE_ROOM = fixture('ctrip', '06-real-page-property-above.txt');

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.notification.deleteMany({});
  await testPrisma.booking.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function dispatch(source: 'AGODA' | 'CTRIP', rawText: string) {
  const res = await admin
    .post('/api/admin/ota/dispatch')
    .send({ source, rawText, adminPmsNote: 'Nguyen Van A\nCa sáng', overrides: { paymentMode: 'CN' } });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
  return res;
}

/** The persisted rooms, in display order, with their nights. */
async function persistedRooms(bookingId: string) {
  return testPrisma.bookingRoom.findMany({
    where: { bookingId },
    include: { nights: { orderBy: { stayDate: 'asc' } } },
    orderBy: { roomIndex: 'asc' },
  });
}

/**
 * The load-bearing assertion: night by night, the physical rooms add back to
 * the platform's own figure. Applied to every case so no shape escapes it.
 */
function expectNightsPreserved(
  rooms: { nights: { amount: number | null }[] }[],
  nightly: { amount: number | null }[],
): void {
  nightly.forEach((stated, index) => {
    if (stated.amount === null) return;
    const summed = rooms.reduce((sum, room) => sum + (room.nights[index]?.amount ?? 0), 0);
    expect(summed, `night index ${index}`).toBe(stated.amount);
  });
}

/* ================================================================== */

describe('Case 1 — Agoda, a single room', () => {
  it('persists exactly one room, with the platform figures untouched', async () => {
    const res = await dispatch('AGODA', AGODA_ONE_ROOM);
    const rooms = await persistedRooms(res.body.bookingId);
    const nightly = res.body.review.nightlyRates as { amount: number | null }[];

    // quantity = 1 must behave exactly as it always did: no division at all.
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.roomIndex).toBe(1);
    expect(rooms[0]!.nights).toHaveLength(nightly.length);
    rooms[0]!.nights.forEach((night, i) => expect(night.amount).toBe(nightly[i]!.amount));
    expectNightsPreserved(rooms, nightly);
  });
});

describe('Case 2 — Agoda, several rooms', () => {
  it('persists one row per physical room, each carrying every night', async () => {
    const res = await dispatch('AGODA', AGODA_MULTI);
    const rooms = await persistedRooms(res.body.bookingId);
    const nightly = res.body.review.nightlyRates as { amount: number | null }[];
    const physical = (res.body.review.rooms as { quantity: number }[]).reduce(
      (sum, r) => sum + r.quantity,
      0,
    );

    expect(physical).toBeGreaterThan(1);
    expect(rooms).toHaveLength(physical);
    // Numbered 1..N with no gaps — this is the "PHÒNG n" the operator reads.
    expect(rooms.map((r) => r.roomIndex)).toEqual(
      Array.from({ length: physical }, (_, i) => i + 1),
    );
    // No room is left empty the way the old shape left rooms 2..N.
    for (const room of rooms) expect(room.nights).toHaveLength(nightly.length);
    expectNightsPreserved(rooms, nightly);
  });

  it('divides rather than repeats — the stay is not multiplied', async () => {
    const res = await dispatch('AGODA', AGODA_MULTI);
    const rooms = await persistedRooms(res.body.bookingId);
    const nightly = res.body.review.nightlyRates as { amount: number | null }[];

    const statedTotal = nightly.reduce((sum, n) => sum + (n.amount ?? 0), 0);
    const persistedTotal = rooms.reduce(
      (sum, room) => sum + room.nights.reduce((s, n) => s + (n.amount ?? 0), 0),
      0,
    );
    expect(persistedTotal).toBe(statedTotal);

    // Each room's stored subtotal matches the sum of its own nights.
    for (const room of rooms) {
      const own = room.nights.reduce((s, n) => s + (n.amount ?? 0), 0);
      expect(room.roomSubtotal).toBe(own);
    }
  });
});

describe('Case 3 — CTrip, a single room', () => {
  /*
    CTrip mail states a total and no per-night figures, so `review.nightlyRates`
    is empty and the nights are DERIVED against the stored total. The invariant
    is therefore reconciliation against `booking.totalAmount` rather than against
    a stated night — the same property, measured where CTrip actually states it.
  */
  it('is unchanged: one room carrying the whole stay', async () => {
    const res = await dispatch('CTRIP', CTRIP_ONE_ROOM);
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId as string },
    });
    const rooms = await persistedRooms(res.body.bookingId);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.roomIndex).toBe(1);
    const stayNights = Math.round(
      (booking.checkOutDate!.getTime() - booking.checkInDate!.getTime()) / 86_400_000,
    );
    expect(rooms[0]!.nights).toHaveLength(stayNights);

    // quantity = 1 means no division: the single room holds the entire total.
    const own = rooms[0]!.nights.reduce((sum, n) => sum + (n.amount ?? 0), 0);
    expect(own).toBe(booking.totalAmount);
    expect(rooms[0]!.roomSubtotal).toBe(booking.totalAmount);
  });

  it('keeps CTrip-derived nights flagged as estimates', async () => {
    // Nights allocated from a bare total carry isEstimated; expanding the rooms
    // must not quietly promote an estimate to a stated figure.
    const res = await dispatch('CTRIP', CTRIP_ONE_ROOM);
    const rooms = await persistedRooms(res.body.bookingId);
    const nights = rooms.flatMap((room) => room.nights);

    expect(nights.length).toBeGreaterThan(0);
    for (const night of nights) expect(night.isEstimated).toBe(true);
  });
});

describe('Case 5 — mixed room types', () => {
  it('expands every line and keeps each room its own type', async () => {
    const res = await dispatch('AGODA', AGODA_MULTI);
    const rooms = await persistedRooms(res.body.bookingId);
    const lines = res.body.review.rooms as { quantity: number; pmsCode: string | null; otaRoomName: string | null }[];
    const physical = lines.reduce((sum, r) => sum + r.quantity, 0);

    expect(rooms).toHaveLength(physical);

    // Rooms appear in line order, each repeated by its quantity — identical
    // types are NOT collapsed back into one card.
    const expectedTypes = lines.flatMap((line) =>
      Array.from({ length: line.quantity }, () => line.pmsCode ?? line.otaRoomName ?? ''),
    );
    expect(rooms.map((r) => r.roomType)).toEqual(expectedTypes);
  });

  it('allocates the aggregate evenly and preserves the total exactly', async () => {
    const res = await dispatch('AGODA', AGODA_MULTI);
    const rooms = await persistedRooms(res.body.bookingId);
    const nightly = res.body.review.nightlyRates as { amount: number | null }[];

    expectNightsPreserved(rooms, nightly);

    const statedTotal = nightly.reduce((sum, n) => sum + (n.amount ?? 0), 0);
    expect(rooms.reduce((s, r) => s + (r.roomSubtotal ?? 0), 0)).toBe(statedTotal);
  });
});

/* ================================================================== */
/* What reception actually receives                                    */
/* ================================================================== */

describe('the reception payload', () => {
  it('reports the PHYSICAL room count, which is what the screen renders', async () => {
    /*
      The detail view heads its section with `rooms.length` and maps one card per
      row, so this count IS the "(N)" an operator sees. Asserting it here means a
      regression in persistence shows up as a wrong number on screen, not just as
      a wrong row count in a table nobody looks at.
    */
    const res = await dispatch('AGODA', AGODA_MULTI);
    const physical = (res.body.review.rooms as { quantity: number }[]).reduce(
      (sum, r) => sum + r.quantity,
      0,
    );

    const detail = await admin.get(`/api/admin/bookings/${res.body.bookingId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking.rooms).toHaveLength(physical);
    expect(detail.body.booking.rooms.map((r: { roomIndex: number }) => r.roomIndex)).toEqual(
      Array.from({ length: physical }, (_, i) => i + 1),
    );
  });

  it('gives every room its own nights, so "Sao chép giá" copies a per-room figure', async () => {
    const res = await dispatch('AGODA', AGODA_MULTI);
    const detail = await admin.get(`/api/admin/bookings/${res.body.bookingId}`);
    const rooms = detail.body.booking.rooms as { nights: { amount: number | null }[] }[];
    const nightly = res.body.review.nightlyRates as { amount: number | null }[];

    for (const room of rooms) expect(room.nights).toHaveLength(nightly.length);
    // The value behind each copy button is this room's share, not the aggregate.
    if (nightly[0]!.amount !== null && rooms.length > 1) {
      expect(rooms[0]!.nights[0]!.amount).toBeLessThan(nightly[0]!.amount);
    }
    expectNightsPreserved(rooms, nightly);
  });
});
