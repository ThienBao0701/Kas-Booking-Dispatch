/**
 * Operational statistics.
 *
 * The point of these tests is as much what the service REFUSES to compute as
 * what it does. Occupancy and RevPAR need a room inventory the system does not
 * store, and industry ADR needs a per-line room quantity it does not store
 * either. Returning 0, or guessing a denominator from the room catalogue, would
 * produce a confident percentage that is simply wrong — so those come back null
 * with a reason, and that is asserted.
 *
 * Everything else is derived from stored values and checked against figures
 * computed by hand in the fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { NO_ROOM_INVENTORY, NO_ROOM_QUANTITY, computeStatistics } from '../src/booking/statistics';

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;
let cn1 = 0;

const SENT = new Date('2026-08-01T02:00:00.000Z');

async function makeBooking(over: Record<string, unknown>) {
  return testPrisma.booking.create({
    data: {
      bookingCode: `S-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'Guest',
      sourcePlatform: 'AGODA',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'x',
      status: 'NEW',
      branchId: cn5,
      sentAt: SENT,
      ...over,
    },
  });
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  // Counted: 1,000,000 over 2 nights (Agoda, CN5)
  await makeBooking({
    totalAmount: 1_000_000,
    checkInDate: new Date('2026-08-10T00:00:00.000Z'),
    checkOutDate: new Date('2026-08-12T00:00:00.000Z'),
  });
  // Counted: 600,000 over 3 nights (CTrip, CN5), already checked out
  await makeBooking({
    sourcePlatform: 'CTRIP',
    status: 'CHECKED_OUT',
    totalAmount: 600_000,
    checkInDate: new Date('2026-08-10T00:00:00.000Z'),
    checkOutDate: new Date('2026-08-13T00:00:00.000Z'),
  });
  // Counted: 400,000 over 1 night (Booking.com, CN1)
  await makeBooking({
    sourcePlatform: 'BOOKING_COM',
    branchId: cn1,
    status: 'COMPLETED',
    totalAmount: 400_000,
    checkInDate: new Date('2026-08-10T00:00:00.000Z'),
    checkOutDate: new Date('2026-08-11T00:00:00.000Z'),
  });
  // NOT counted toward revenue: cancelled and no-show.
  await makeBooking({ status: 'CANCELLED', totalAmount: 999_999 });
  await makeBooking({ status: 'NO_SHOW', totalAmount: 888_888 });
  // NOT counted at all: never dispatched.
  await makeBooking({ status: 'DRAFT', sentAt: null, totalAmount: 777_777 });
});

afterAll(async () => testPrisma.$disconnect());

const RANGE = { from: '2026-08-01', to: '2026-08-01' };
const stats = () => computeStatistics(RANGE, testPrisma);

/* ================================================================== */
/* What is deliberately NOT computed                                   */
/* ================================================================== */
describe('metrics that cannot be computed honestly', () => {
  it('returns occupancy as null, not zero, with the reason', async () => {
    const s = await stats();
    expect(s.occupancy).toEqual({ value: null, reason: NO_ROOM_INVENTORY });
  });

  it('returns RevPAR as null for the same reason', async () => {
    const s = await stats();
    expect(s.revPar).toEqual({ value: null, reason: NO_ROOM_INVENTORY });
  });

  it('returns industry ADR as null — room quantity is not stored per line', async () => {
    // Counting BookingRoom rows would be right for Booking.com, whose extractor
    // expands "No. of Rooms" into one row each, and wrong for an OTA booking,
    // where one row is a room TYPE. A metric that is correct for one source and
    // silently wrong for another is worse than an absent one.
    const s = await stats();
    expect(s.adr).toEqual({ value: null, reason: NO_ROOM_QUANTITY });
  });

  it('never infers a denominator from the room catalogue', async () => {
    // CN5 has a full room-class catalogue seeded; that is a list of TYPES and
    // must not become an inventory count.
    const classes = await testPrisma.branchRoomClass.count();
    expect(classes).toBeGreaterThan(0);
    const s = await stats();
    expect(s.occupancy.value).toBeNull();
    expect(s.revPar.value).toBeNull();
  });
});

/* ================================================================== */
/* Revenue and counts                                                  */
/* ================================================================== */
describe('revenue', () => {
  it('sums only bookings whose stay is real', async () => {
    const s = await stats();
    // 1,000,000 + 600,000 + 400,000 — cancelled, no-show and draft excluded.
    expect(s.revenue).toBe(2_000_000);
    expect(s.bookingCount).toBe(3);
  });

  it('excludes a cancelled booking from revenue but counts it as cancelled', async () => {
    const s = await stats();
    // The cancelled 999,999 and the no-show 888,888 are absent from revenue:
    // 2,000,000 is the exact sum of the three real stays and nothing else.
    expect(s.revenue).toBe(2_000_000);
    expect(s.revenue).toBeLessThan(2_000_000 + 999_999);
    expect(s.cancelledCount).toBe(1);
    expect(s.noShowCount).toBe(1);
  });

  it('ignores a booking that was never dispatched', async () => {
    const s = await stats();
    // The DRAFT booking's 777,777 appears nowhere.
    expect(s.revenue).toBe(2_000_000);
    expect(s.bookingCount + s.cancelledCount + s.noShowCount).toBe(5);
  });
});

/* ================================================================== */
/* Derived figures                                                     */
/* ================================================================== */
describe('derived figures', () => {
  it('totals the stay nights', async () => {
    const s = await stats();
    expect(s.stayNights).toBe(6); // 2 + 3 + 1
  });

  it('computes revenue per stay-night, honestly named', async () => {
    const s = await stats();
    expect(s.averageRevenuePerStayNight).toBe(Math.round(2_000_000 / 6));
  });

  it('computes the average stay', async () => {
    const s = await stats();
    expect(s.averageStayNights).toBe(2); // 6 nights / 3 bookings
  });

  it('computes cancellation and no-show rates against dispatched bookings', async () => {
    const s = await stats();
    // 5 dispatched (3 counted + 1 cancelled + 1 no-show); 1 of each.
    expect(s.cancellationRate).toBe(20);
    expect(s.noShowRate).toBe(20);
  });

  it('returns null rather than zero when there is nothing to divide by', async () => {
    const empty = await computeStatistics({ from: '2020-01-01', to: '2020-01-01' }, testPrisma);
    expect(empty.bookingCount).toBe(0);
    expect(empty.revenue).toBe(0);
    expect(empty.averageRevenuePerStayNight).toBeNull();
    expect(empty.averageStayNights).toBeNull();
    expect(empty.cancellationRate).toBeNull();
    expect(empty.noShowRate).toBeNull();
  });
});

/* ================================================================== */
/* Breakdowns                                                          */
/* ================================================================== */
describe('breakdowns', () => {
  it('splits revenue by OTA', async () => {
    const s = await stats();
    const byKey = new Map(s.byOta.map((r) => [r.key, r]));
    expect(byKey.get('AGODA')).toMatchObject({ bookings: 1, revenue: 1_000_000, label: 'Agoda' });
    expect(byKey.get('CTRIP')).toMatchObject({ bookings: 1, revenue: 600_000, label: 'CTrip' });
    expect(byKey.get('BOOKING_COM')).toMatchObject({ bookings: 1, revenue: 400_000 });
  });

  it('splits revenue by branch, labelled by hotel', async () => {
    const s = await stats();
    const cn5Row = s.byBranch.find((r) => r.key === String(cn5));
    expect(cn5Row).toMatchObject({ bookings: 2, revenue: 1_600_000 });
    expect(cn5Row!.label).not.toBe('—');
  });

  it('reports shares that add to 100', async () => {
    const s = await stats();
    const total = s.byOta.reduce((sum, r) => sum + r.share, 0);
    expect(Math.round(total)).toBe(100);
  });

  it('orders breakdowns by revenue, largest first', async () => {
    const s = await stats();
    const revenues = s.byOta.map((r) => r.revenue);
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
  });
});

/* ================================================================== */
/* Scoping                                                             */
/* ================================================================== */
describe('scoping', () => {
  it('restricts to one branch when asked', async () => {
    const s = await computeStatistics({ ...RANGE, branchId: cn1 }, testPrisma);
    expect(s.revenue).toBe(400_000);
    expect(s.bookingCount).toBe(1);
    expect(s.byBranch).toHaveLength(1);
  });

  it('counts by dispatch date, not stay date', async () => {
    // Every stay is in mid-August; every dispatch is on the 1st.
    const onStayDates = await computeStatistics({ from: '2026-08-10', to: '2026-08-13' }, testPrisma);
    expect(onStayDates.bookingCount).toBe(0);
  });
});

/* ================================================================== */
/* The endpoint                                                        */
/* ================================================================== */
describe('the statistics endpoint', () => {
  it('serves the figures to an admin', async () => {
    const res = await admin.get('/api/admin/dashboard/statistics?from=2026-08-01&to=2026-08-01');
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(2_000_000);
    expect(res.body.occupancy).toEqual({ value: null, reason: NO_ROOM_INVENTORY });
  });

  it('defaults to today when no range is given', async () => {
    const res = await admin.get('/api/admin/dashboard/statistics');
    expect(res.status).toBe(200);
    expect(res.body.range.from).toBe(res.body.range.to);
  });

  it('rejects a malformed date', async () => {
    expect((await admin.get('/api/admin/dashboard/statistics?from=01-08-2026')).status).toBe(422);
  });

  it('refuses a receptionist — this is admin-only, like the rest of the dashboard', async () => {
    await createReceptionist(cn5, { username: 'letan_stats', mustChangePassword: false });
    const reception = (await loginAgent(app, 'letan_stats', RECEPTIONIST_PASSWORD)).agent;
    expect((await reception.get('/api/admin/dashboard/statistics')).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/admin/dashboard/statistics')).status).toBe(401);
  });
});
