/**
 * Comma-separated filters on the operational search.
 *
 * The operation centre needs two things the single-valued query could not
 * express: an "OTA" tab, which is Agoda OR CTrip, and multi-select status and
 * verification filters. The alternative — merging two paginated responses in
 * the browser — reports a wrong total and a meaningless second page, so the
 * filter was widened here instead.
 *
 * The extension is purely additive, and that is what most of this file checks:
 * a single value must still behave exactly as it did before, and a malformed
 * list must still be refused rather than silently ignored. A filter that
 * quietly drops an unrecognised value would show an operator MORE bookings
 * than they asked for and look like it worked.
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

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn1 = 0;
let cn5 = 0;

const SENT = new Date('2026-08-01T02:00:00.000Z');

async function make(over: Record<string, unknown>) {
  return testPrisma.booking.create({
    data: {
      bookingCode: `H-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'Guest',
      sourcePlatform: 'BOOKING_COM',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'x',
      status: 'NEW',
      branchId: cn5,
      sentAt: SENT,
      ...over,
    },
  });
}

const codes = (body: { bookings: { bookingCode: string | null }[] }) =>
  body.bookings.map((b) => b.bookingCode).sort();

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await make({ bookingCode: 'BCOM-NEW', sourcePlatform: 'BOOKING_COM', status: 'NEW' });
  await make({ bookingCode: 'AGODA-RECEIVED', sourcePlatform: 'AGODA', status: 'RECEIVED' });
  await make({ bookingCode: 'CTRIP-IN', sourcePlatform: 'CTRIP', status: 'CHECKED_IN' });
  await make({ bookingCode: 'AGODA-CANCELLED', sourcePlatform: 'AGODA', status: 'CANCELLED' });
  await make({
    bookingCode: 'BCOM-REJECTED',
    sourcePlatform: 'BOOKING_COM',
    status: 'NEW',
    verificationStatus: 'REJECTED',
  });
  await make({
    bookingCode: 'BCOM-PENDING',
    sourcePlatform: 'BOOKING_COM',
    status: 'NEW',
    verificationStatus: 'PENDING_REVIEW',
    branchId: cn1,
  });
});

afterAll(async () => testPrisma.$disconnect());

const get = (qs: string) => admin.get(`/api/bookings/history?${qs}`);

/* ================================================================== */
/* The single-value form is untouched                                  */
/* ================================================================== */
describe('existing single-value callers', () => {
  it('filters by one status exactly as before', async () => {
    const res = await get('status=CHECKED_IN');
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['CTRIP-IN']);
  });

  it('filters by one source exactly as before', async () => {
    const res = await get('source=CTRIP');
    expect(codes(res.body)).toEqual(['CTRIP-IN']);
  });

  it('filters by one verification status exactly as before', async () => {
    const res = await get('verificationStatus=REJECTED');
    expect(codes(res.body)).toEqual(['BCOM-REJECTED']);
  });

  it('returns everything when no filter is given', async () => {
    const res = await get('pageSize=100');
    expect(res.body.pagination.total).toBe(6);
  });
});

/* ================================================================== */
/* The multi-value form                                                */
/* ================================================================== */
describe('comma-separated values', () => {
  it('accepts two sources — this is the OTA tab', async () => {
    const res = await get('source=AGODA,CTRIP');
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['AGODA-CANCELLED', 'AGODA-RECEIVED', 'CTRIP-IN']);
  });

  it('accepts several statuses at once', async () => {
    const res = await get('status=RECEIVED,CHECKED_IN');
    expect(codes(res.body)).toEqual(['AGODA-RECEIVED', 'CTRIP-IN']);
  });

  it('accepts several verification statuses at once', async () => {
    const res = await get('verificationStatus=REJECTED,PENDING_REVIEW');
    expect(codes(res.body)).toEqual(['BCOM-PENDING', 'BCOM-REJECTED']);
  });

  it('reports a total that matches the rows, not a merged guess', async () => {
    // The client alternative was two requests stitched together, whose total
    // would have been the sum of two overlapping counts.
    const res = await get('source=AGODA,CTRIP');
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.bookings).toHaveLength(3);
  });

  it('combines a multi-value filter with the other filters', async () => {
    const res = await get(`source=AGODA,CTRIP&status=RECEIVED,CHECKED_IN&branchId=${cn5}`);
    expect(codes(res.body)).toEqual(['AGODA-RECEIVED', 'CTRIP-IN']);
  });

  it('tolerates spaces around the separator', async () => {
    const res = await get(`source=${encodeURIComponent('AGODA, CTRIP')}`);
    expect(codes(res.body)).toEqual(['AGODA-CANCELLED', 'AGODA-RECEIVED', 'CTRIP-IN']);
  });

  it('treats a one-item list as the single value it is', async () => {
    const [single, listed] = await Promise.all([get('source=AGODA'), get('source=AGODA,AGODA')]);
    expect(codes(listed.body)).toEqual(codes(single.body));
  });
});

/* ================================================================== */
/* Bad input is still refused                                          */
/* ================================================================== */
describe('validation', () => {
  it('rejects an unknown value inside a list rather than ignoring it', async () => {
    // Dropping the bad entry would widen the result set silently: the operator
    // asked for two statuses, got one, and has no way to tell.
    expect((await get('status=RECEIVED,NOT_A_STATUS')).status).toBe(422);
  });

  it('rejects an unknown single value, as before', async () => {
    expect((await get('status=NOT_A_STATUS')).status).toBe(422);
  });

  it('rejects an empty filter', async () => {
    expect((await get('status=')).status).toBe(422);
    expect((await get('status=,')).status).toBe(422);
  });
});

/* ================================================================== */
/* Branch isolation is unaffected                                      */
/* ================================================================== */
describe('branch isolation', () => {
  it('still confines a receptionist to their own branch', async () => {
    // The widened filter must not become a way around branch scoping: this
    // receptionist belongs to CN1 and asks for everything.
    await createReceptionist(cn1, { username: 'letan_multi', mustChangePassword: false });
    const reception = (await loginAgent(app, 'letan_multi', RECEPTIONIST_PASSWORD)).agent;

    const res = await reception.get(
      '/api/bookings/history?source=BOOKING_COM,AGODA,CTRIP&status=NEW,RECEIVED,CHECKED_IN,CANCELLED&pageSize=100',
    );
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['BCOM-PENDING']);
  });
});
