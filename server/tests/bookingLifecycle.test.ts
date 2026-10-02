/**
 * The operational booking lifecycle after dispatch.
 *
 *   NEW -> RECEIVED -> CHECKED_IN -> CHECKED_OUT -> COMPLETED
 *
 * Three properties matter most here, and each has bitten this system before:
 *
 *   a transition cannot be applied from the wrong state, so an operational
 *   record cannot claim a guest checked out of a booking nobody received;
 *
 *   two receptionists pressing the same button cannot both succeed, so the
 *   recorded actor and timestamp are the real ones;
 *
 *   the ACTUAL timestamps never overwrite the reservation's EXPECTED dates.
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

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let reception: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherBranch: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;
let cn1 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createReceptionist(cn5, { username: 'letan_life', mustChangePassword: false });
  reception = (await loginAgent(app, 'letan_life', RECEPTIONIST_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letan_life_other', mustChangePassword: false });
  otherBranch = (await loginAgent(app, 'letan_life_other', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.booking.deleteMany();
});

afterAll(async () => testPrisma.$disconnect());

/** Dispatches the sample and returns the new booking id. */
async function dispatched(): Promise<string> {
  const res = await admin
    .post('/api/admin/ota/dispatch')
    .send({ source: 'AGODA', rawText: AGODA_RAW, adminPmsNote: 'Nguyen Van A\nCa sáng', overrides: { paymentMode: 'CN' } });
  expect(res.status).toBe(201);
  return res.body.bookingId as string;
}

const act = (id: string, action: string, body: Record<string, unknown> = {}) =>
  reception.post(`/api/bookings/${id}/${action}`).send(body);

const statusOf = async (id: string) =>
  (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).status;

/* ================================================================== */
/* The happy path                                                      */
/* ================================================================== */
describe('the operational lifecycle', () => {
  it('runs NEW -> RECEIVED -> CHECKED_IN -> CHECKED_OUT -> COMPLETED', async () => {
    const id = await dispatched();
    expect(await statusOf(id)).toBe('NEW');

    for (const [action, expected] of [
      ['receive', 'RECEIVED'],
      ['check-in', 'CHECKED_IN'],
      ['check-out', 'CHECKED_OUT'],
      ['complete', 'COMPLETED'],
    ] as const) {
      const res = await act(id, action);
      expect(res.status, action).toBe(200);
      expect(await statusOf(id), action).toBe(expected);
    }
  });

  it('records who acted and when, at each step', async () => {
    const id = await dispatched();
    await act(id, 'receive');
    await act(id, 'check-in');
    await act(id, 'check-out');

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.receivedAt).not.toBeNull();
    expect(booking.receivedByUserId).not.toBeNull();
    expect(booking.actualCheckInAt).not.toBeNull();
    expect(booking.checkedInByUserId).not.toBeNull();
    expect(booking.actualCheckOutAt).not.toBeNull();
    expect(booking.checkedOutByUserId).not.toBeNull();
  });

  it('writes an immutable history row for every transition', async () => {
    const id = await dispatched();
    await act(id, 'receive');
    await act(id, 'check-in');

    const history = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: id },
      orderBy: { changedAt: 'asc' },
    });
    // Dispatch wrote the first; each action adds one more.
    expect(history.map((h) => h.newStatus)).toEqual(['NEW', 'RECEIVED', 'CHECKED_IN']);
    expect(history[1]!.oldStatus).toBe('NEW');
    expect(history[2]!.oldStatus).toBe('RECEIVED');
  });
});

/* ================================================================== */
/* Expected dates are never overwritten                                */
/* ================================================================== */
describe('actual timestamps stay separate from the reservation', () => {
  it('leaves the OTA check-in and check-out dates untouched', async () => {
    const id = await dispatched();
    const before = await testPrisma.booking.findUniqueOrThrow({ where: { id } });

    await act(id, 'receive');
    await act(id, 'check-in');
    await act(id, 'check-out');

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    // What the reservation EXPECTS is unchanged by what actually happened.
    expect(after.checkInDate).toEqual(before.checkInDate);
    expect(after.checkOutDate).toEqual(before.checkOutDate);
    // And the actual arrival is a distinct value, not a copy of the expectation.
    expect(after.actualCheckInAt).not.toEqual(after.checkInDate);
  });
});

/* ================================================================== */
/* Illegal transitions                                                 */
/* ================================================================== */
describe('a transition is refused from the wrong state', () => {
  it('cannot check in a booking nobody received', async () => {
    const id = await dispatched();
    const res = await act(id, 'check-in');
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe('NEW');
  });

  it('cannot check out a booking nobody checked in', async () => {
    const id = await dispatched();
    await act(id, 'receive');
    const res = await act(id, 'check-out');
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe('RECEIVED');
  });

  it('cannot receive the same booking twice', async () => {
    const id = await dispatched();
    expect((await act(id, 'receive')).status).toBe(200);
    expect((await act(id, 'receive')).status).toBe(409);
  });

  it('cannot cancel after the guest has arrived', async () => {
    const id = await dispatched();
    await act(id, 'receive');
    await act(id, 'check-in');
    const res = await act(id, 'cancel', { reason: 'thử' });
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe('CHECKED_IN');
  });

  it('records a no-show only for a booking that was received', async () => {
    const id = await dispatched();
    expect((await act(id, 'no-show')).status).toBe(409);
    await act(id, 'receive');
    expect((await act(id, 'no-show')).status).toBe(200);
    expect(await statusOf(id)).toBe('NO_SHOW');
  });

  it('keeps a cancellation reason', async () => {
    const id = await dispatched();
    const res = await act(id, 'cancel', { reason: 'Khách huỷ qua OTA' });
    expect(res.status).toBe(200);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.status).toBe('CANCELLED');
    expect(booking.cancellationReason).toBe('Khách huỷ qua OTA');
    expect(booking.cancelledByUserId).not.toBeNull();
  });
});

/* ================================================================== */
/* Concurrency                                                         */
/* ================================================================== */
describe('concurrent transitions', () => {
  it('lets exactly one of two simultaneous receives win', async () => {
    const id = await dispatched();
    const [a, b] = await Promise.all([act(id, 'receive'), act(id, 'receive')]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    expect(await statusOf(id)).toBe('RECEIVED');

    // Exactly one history row, so the recorded actor is the one who won.
    const history = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: id, newStatus: 'RECEIVED' },
    });
    expect(history).toHaveLength(1);
  });
});

/* ================================================================== */
/* Branch isolation                                                    */
/* ================================================================== */
describe('branch isolation', () => {
  it('refuses a receptionist from another branch', async () => {
    const id = await dispatched();
    const res = await otherBranch.post(`/api/bookings/${id}/receive`).send({});
    expect(res.status).toBe(404);
    expect(await statusOf(id)).toBe('NEW');
  });

  it('refuses an anonymous caller', async () => {
    const id = await dispatched();
    const { default: request } = await import('supertest');
    const res = await request(app).post(`/api/bookings/${id}/receive`).send({});
    expect(res.status).toBe(401);
    expect(await statusOf(id)).toBe('NEW');
  });
});

/* ================================================================== */
/* Dispatch stays idempotent across the whole lifecycle                */
/* ================================================================== */
describe('re-dispatch never duplicates a booking in progress', () => {
  it.each(['receive', 'check-in', 'check-out'])(
    'after %s, re-sending returns the same booking',
    async (upTo) => {
      const id = await dispatched();
      for (const action of ['receive', 'check-in', 'check-out']) {
        await act(id, action);
        if (action === upTo) break;
      }

      const again = await admin
        .post('/api/admin/ota/dispatch')
        .send({ source: 'AGODA', rawText: AGODA_RAW, adminPmsNote: 'Nguyen Van A\nCa sáng', overrides: { paymentMode: 'CN' } });

      expect(again.status).toBe(200);
      expect(again.body.created).toBe(false);
      expect(again.body.bookingId).toBe(id);
      expect(await testPrisma.booking.count()).toBe(1);
    },
  );
});

/* ================================================================== */
/* Proof state and booking state are independent                       */
/* ================================================================== */
describe('the proof workflow never moves the booking lifecycle', () => {
  it('reaches COMPLETED only after CHECKED_OUT', async () => {
    const id = await dispatched();

    // Approving a proof records the proof's outcome and nothing else, so the
    // booking cannot be completed while the guest is still in the room.
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED' },
    });
    expect(await statusOf(id)).toBe('NEW');

    // The only route to COMPLETED is the operational one.
    expect((await act(id, 'complete')).status).toBe(409);
    await act(id, 'receive');
    expect((await act(id, 'complete')).status).toBe(409);
    await act(id, 'check-in');
    expect((await act(id, 'complete')).status).toBe(409);
    await act(id, 'check-out');
    expect((await act(id, 'complete')).status).toBe(200);
    expect(await statusOf(id)).toBe('COMPLETED');
  });

  it('lets a verified booking still run its whole lifecycle', async () => {
    const id = await dispatched();
    await testPrisma.booking.update({ where: { id }, data: { verificationStatus: 'APPROVED' } });

    for (const action of ['receive', 'check-in', 'check-out', 'complete']) {
      expect((await act(id, action)).status, action).toBe(200);
    }
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.status).toBe('COMPLETED');
    // Both facts are recorded, separately.
    expect(booking.verificationStatus).toBe('APPROVED');
  });
});

/* ================================================================== */
/* Booking.com is unaffected                                           */
/* ================================================================== */
describe('Booking.com semantics are unchanged', () => {
  it('keeps the original five states meaning exactly what they did', async () => {
    // The appended states are additive: the originals are still present and in
    // their original order, so no existing row's status changed meaning.
    // Scoped to THIS schema: the type name also exists in `public`, and an
    // unscoped query returns both copies interleaved.
    const values = await testPrisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'BookingStatus'
         AND pg_type.typnamespace = current_schema()::regnamespace
       ORDER BY enumsortorder`,
    );
    expect(values.map((v) => v.enumlabel).slice(0, 5)).toEqual([
      'DRAFT',
      'READY',
      'NEW',
      'COMPLETED',
      'ARCHIVED',
    ]);
  });

  it('does not offer lifecycle actions on a Booking.com draft', async () => {
    const draft = await testPrisma.booking.create({
      data: {
        bookingCode: 'BCOM-LIFECYCLE-1',
        customerName: 'Draft Guest',
        sourcePlatform: 'BOOKING_COM',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'x',
        status: 'DRAFT',
        branchId: cn5,
      },
    });
    // DRAFT belongs to the extract-and-send flow; reception cannot act on it.
    expect((await act(draft.id, 'receive')).status).toBe(409);
    expect((await act(draft.id, 'check-in')).status).toBe(409);
    expect(await statusOf(draft.id)).toBe('DRAFT');
  });
});
