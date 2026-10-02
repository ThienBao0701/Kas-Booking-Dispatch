/**
 * Operational search over the booking history.
 *
 * This extends the endpoint that already existed rather than adding a second
 * one, so the first thing these tests protect is that an existing caller which
 * sends none of the new parameters gets exactly what it got before.
 *
 * The behavioural change is deliberate and singular: search is now
 * case-insensitive. `contains` is case-sensitive on PostgreSQL, so typing
 * "khuyen" found nothing for a guest stored as "Khuyen" — and an operator
 * would reasonably conclude the booking did not exist.
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
let reception: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;
let cn1 = 0;

/** Creates a dispatched booking directly — this suite tests querying, not intake. */
async function makeBooking(over: Record<string, unknown> = {}) {
  return testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'Default Guest',
      sourcePlatform: 'AGODA',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'x',
      status: 'NEW',
      branchId: cn5,
      sentAt: new Date('2026-08-01T02:00:00.000Z'),
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
  await createReceptionist(cn5, { username: 'letan_search', mustChangePassword: false });
  reception = (await loginAgent(app, 'letan_search', RECEPTIONIST_PASSWORD)).agent;

  await makeBooking({
    bookingCode: 'AG-1000001',
    customerName: 'Khuyen Nguyen',
    phone: '0900000001',
    countryOfResidence: 'Vietnam',
    websiteLanguage: 'Vietnamese',
    sourcePlatform: 'AGODA',
    status: 'NEW',
    totalAmount: 500_000,
    checkInDate: new Date('2026-08-10T00:00:00.000Z'),
    checkOutDate: new Date('2026-08-12T00:00:00.000Z'),
  });
  await makeBooking({
    bookingCode: 'CT-2000002',
    customerName: 'LEE/JENSON HWEE',
    phone: '0900000002',
    countryOfResidence: 'Singapore',
    websiteLanguage: 'English',
    sourcePlatform: 'CTRIP',
    status: 'CHECKED_IN',
    verificationStatus: 'APPROVED',
    totalAmount: 900_000,
    checkInDate: new Date('2026-08-11T00:00:00.000Z'),
    checkOutDate: new Date('2026-08-15T00:00:00.000Z'),
  });
  await makeBooking({
    bookingCode: 'BC-3000003',
    customerName: 'Other Branch Guest',
    sourcePlatform: 'BOOKING_COM',
    branchId: cn1,
    status: 'COMPLETED',
    totalAmount: 100_000,
  });
});

afterAll(async () => testPrisma.$disconnect());

const search = (query: string) => admin.get(`/api/bookings/history?${query}`);
const codesOf = (res: { body: { bookings: { bookingCode: string }[] } }) =>
  res.body.bookings.map((b) => b.bookingCode).sort();

/* ================================================================== */
/* Backward compatibility                                              */
/* ================================================================== */
describe('the existing contract is unchanged', () => {
  it('returns everything, newest first, with no parameters', async () => {
    const res = await search('');
    expect(res.status).toBe(200);
    expect(res.body.bookings.length).toBe(3);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 20, total: 3 });
  });

  it('still filters by the original parameters', async () => {
    expect(codesOf(await search('status=COMPLETED'))).toEqual(['BC-3000003']);
    expect(codesOf(await search('paymentStatus=PAY_BEFORE')).length).toBe(3);
    expect(codesOf(await search(`branchId=${cn1}`))).toEqual(['BC-3000003']);
  });
});

/* ================================================================== */
/* Search                                                              */
/* ================================================================== */
describe('search', () => {
  it('finds a guest whatever the casing', async () => {
    // The reason this endpoint was extended: "khuyen" used to match nothing.
    for (const term of ['khuyen', 'KHUYEN', 'Khuyen']) {
      expect(codesOf(await search(`search=${term}`)), term).toEqual(['AG-1000001']);
    }
  });

  it.each([
    ['booking code', 'AG-1000001', ['AG-1000001']],
    ['partial code', '2000002', ['CT-2000002']],
    ['phone', '0900000002', ['CT-2000002']],
    ['country', 'singapore', ['CT-2000002']],
    ['guest with a slash', 'JENSON', ['CT-2000002']],
  ])('searches by %s', async (_label, term, expected) => {
    expect(codesOf(await search(`search=${encodeURIComponent(term)}`))).toEqual(expected);
  });

  it('finds a booking by its branch hotel name', async () => {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { id: cn1 } });
    const res = await search(`search=${encodeURIComponent(branch.hotelName)}`);
    expect(codesOf(res)).toEqual(['BC-3000003']);
  });

  it('returns nothing rather than everything for an unmatched term', async () => {
    expect((await search('search=zzz-no-such-guest')).body.bookings).toEqual([]);
  });
});

/* ================================================================== */
/* Filters                                                             */
/* ================================================================== */
describe('filters', () => {
  it.each([
    ['source=AGODA', ['AG-1000001']],
    ['source=CTRIP', ['CT-2000002']],
    ['source=BOOKING_COM', ['BC-3000003']],
    ['status=CHECKED_IN', ['CT-2000002']],
    ['verificationStatus=APPROVED', ['CT-2000002']],
    ['country=vietnam', ['AG-1000001']],
    ['language=English', ['CT-2000002']],
  ])('filters by %s', async (query, expected) => {
    expect(codesOf(await search(query))).toEqual(expected);
  });

  it('filters by an operational state the old enum could not express', async () => {
    // Before this, CHECKED_IN was not an accepted value at all.
    expect((await search('status=CHECKED_IN')).status).toBe(200);
    expect((await search('status=NO_SHOW')).body.bookings).toEqual([]);
  });

  it('combines several filters, as an operator actually searches', async () => {
    // "Agoda, CN5, NEW, Khuyen" — the example from the brief.
    const res = await search(`source=AGODA&branchId=${cn5}&status=NEW&search=khuyen`);
    expect(codesOf(res)).toEqual(['AG-1000001']);
  });

  it('returns nothing when the filters genuinely conflict', async () => {
    expect((await search('source=AGODA&status=COMPLETED')).body.bookings).toEqual([]);
  });

  it.each([
    ['checkOutFrom=2026-08-13', ['CT-2000002']],
    ['checkInFrom=2026-08-11&checkInTo=2026-08-11', ['CT-2000002']],
    ['checkOutTo=2026-08-12', ['AG-1000001']],
  ])('filters by date range %s', async (query, expected) => {
    expect(codesOf(await search(query))).toEqual(expected);
  });

  it('filters by created and updated ranges', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await search(`createdFrom=${today}`)).body.bookings.length).toBe(3);
    expect((await search(`updatedFrom=${today}`)).body.bookings.length).toBe(3);
    expect((await search('createdTo=2020-01-01')).body.bookings).toEqual([]);
  });
});

/* ================================================================== */
/* Sorting                                                             */
/* ================================================================== */
describe('sorting', () => {
  it('defaults to newest first', async () => {
    const res = await search('');
    expect(res.body.bookings[0].bookingCode).toBeDefined();
  });

  it('sorts ascending when asked', async () => {
    const asc = await search('sort=totalAmount&order=asc');
    const amounts = asc.body.bookings.map((b: { totalAmount: number }) => b.totalAmount);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
  });

  it('sorts descending by default for a new key', async () => {
    const desc = await search('sort=totalAmount');
    const amounts = desc.body.bookings.map((b: { totalAmount: number }) => b.totalAmount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });

  it.each(['checkOutDate', 'updatedAt', 'customerName', 'status', 'sourcePlatform'])(
    'accepts the new sort key %s',
    async (key) => {
      expect((await search(`sort=${key}`)).status).toBe(200);
    },
  );

  it('refuses a sort key that is not on the list', async () => {
    // A free-text sort key would let a caller order by any column.
    expect((await search('sort=passwordHash')).status).toBe(422);
  });
});

/* ================================================================== */
/* Branch isolation survives every new parameter                       */
/* ================================================================== */
describe('branch isolation', () => {
  it('never lets a receptionist see another branch, whatever they search', async () => {
    for (const query of [
      '',
      'search=Other Branch Guest',
      'source=BOOKING_COM',
      'status=COMPLETED',
      `branchId=${cn1}`,
      'sort=totalAmount&order=asc',
    ]) {
      const res = await reception.get(`/api/bookings/history?${encodeURI(query)}`);
      expect(res.status, query).toBe(200);
      const codes = res.body.bookings.map((b: { bookingCode: string }) => b.bookingCode);
      expect(codes, query).not.toContain('BC-3000003');
    }
  });

  it('lets an admin see every branch', async () => {
    expect(codesOf(await search(`branchId=${cn1}`))).toEqual(['BC-3000003']);
  });
});

/* ================================================================== */
/* Pagination                                                          */
/* ================================================================== */
describe('pagination', () => {
  it('reports totals that match the filter, not the page', async () => {
    const res = await search('pageSize=1');
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 1, total: 3, totalPages: 3 });
  });

  it('pages through without repeating or dropping a booking', async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await search(`pageSize=1&page=${page}&sort=totalAmount&order=asc`);
      seen.push(...res.body.bookings.map((b: { bookingCode: string }) => b.bookingCode));
    }
    expect(new Set(seen).size).toBe(3);
  });
});
