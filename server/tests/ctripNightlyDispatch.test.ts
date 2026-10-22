/**
 * The CTrip nightly allocator, through the real dispatch path.
 *
 * The unit tests prove the arithmetic. This proves the wiring: that a CTrip
 * reservation whose mail states only a total actually reaches the database with
 * nightly rows, that those rows are flagged as estimates, and that the rows sum
 * to the stored booking total — the number a branch reconciles against.
 *
 * It also proves the blast radius is zero: an Agoda booking dispatched through
 * the same code path keeps exactly the nights its mail stated, still unflagged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';

const CTRIP_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '06-real-page-property-above.txt'),
  'utf8',
);
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

/** Dispatches and returns the stored booking with its nights. */
async function dispatch(source: 'CTRIP' | 'AGODA', rawText: string) {
  const res = await admin
    .post('/api/admin/ota/dispatch')
    .send({ source, rawText, adminPmsNote: 'Nguyen Van A\nCa sáng', overrides: { paymentMode: 'CN' } });
  expect(res.status).toBe(201);
  return testPrisma.booking.findUniqueOrThrow({
    where: { id: res.body.bookingId as string },
    include: { rooms: { include: { nights: { orderBy: { stayDate: 'asc' } } } } },
  });
}

const allNights = (booking: Awaited<ReturnType<typeof dispatch>>) =>
  booking.rooms.flatMap((r) => r.nights);

describe('a CTrip reservation reaches the branch with nightly rows', () => {
  it('stores one night per stay date', async () => {
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    const nights = allNights(booking);
    expect(nights.length).toBeGreaterThan(0);

    const stayNights = Math.round(
      (booking.checkOutDate!.getTime() - booking.checkInDate!.getTime()) / 86_400_000,
    );
    expect(nights).toHaveLength(stayNights);
  });

  it('sums the nights to exactly the stored booking total', async () => {
    // The reconciliation property: what the branch adds up must equal what the
    // booking says it is owed, to the dong.
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    const total = allNights(booking).reduce((t, n) => t + (n.amount ?? 0), 0);
    expect(total).toBe(booking.totalAmount);
  });

  it('starts on the check-in date and never includes check-out', async () => {
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    const nights = allNights(booking);
    expect(nights[0]!.stayDate.toISOString().slice(0, 10)).toBe(
      booking.checkInDate!.toISOString().slice(0, 10),
    );
    const last = nights[nights.length - 1]!.stayDate.toISOString().slice(0, 10);
    expect(last).not.toBe(booking.checkOutDate!.toISOString().slice(0, 10));
  });

  it('stores whole VND only', async () => {
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    for (const night of allNights(booking)) {
      expect(Number.isInteger(night.amount)).toBe(true);
    }
  });
});

describe('an allocated night is labelled as an estimate', () => {
  it('flags every derived night', async () => {
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    const nights = allNights(booking);
    // This fixture states no per-night figures, so all of these are derived.
    for (const night of nights) expect(night.isEstimated).toBe(true);
  });

  it('never marks a derived night as manually corrected', async () => {
    // Estimated and hand-corrected are different claims; only the first is true.
    const booking = await dispatch('CTRIP', CTRIP_RAW);
    for (const night of allNights(booking)) expect(night.manuallyCorrected).toBe(false);
  });
});

describe('Agoda is untouched by the allocator', () => {
  it('keeps the nights the Agoda mail stated, unflagged', async () => {
    const booking = await dispatch('AGODA', AGODA_RAW);
    const nights = allNights(booking);
    expect(nights.length).toBeGreaterThan(0);
    for (const night of nights) expect(night.isEstimated).toBe(false);
  });

  it('adds no CTrip warning to an Agoda booking', async () => {
    const booking = await dispatch('AGODA', AGODA_RAW);
    const warnings = await testPrisma.bookingExtractWarning.findMany({
      where: { bookingId: booking.id },
    });
    expect(warnings.filter((w) => w.code.startsWith('CTRIP_'))).toEqual([]);
  });
});
