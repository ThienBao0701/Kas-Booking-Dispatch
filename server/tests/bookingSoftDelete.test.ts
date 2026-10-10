/**
 * Removing a booking from the queues.
 *
 * THE PROPERTY THIS FILE EXISTS FOR: deleting a booking must not destroy the
 * evidence of what happened to it. 25 relations cascade from Booking, so a row
 * deletion would take the audit events, the append-only corrections, the status
 * history and the receptionist's proof images with it — and nobody would notice
 * until the day that proof was needed.
 *
 * So the tests below check both halves: the booking is gone from every list a
 * human looks at, AND the records are still there.
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
let branchId = 0;

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

/** Dispatches one Agoda reservation and returns its id. */
async function dispatched(): Promise<string> {
  const res = await admin.post('/api/admin/ota/dispatch').send({
    source: 'AGODA',
    rawText: AGODA_RAW,
    adminPmsNote: 'Nguyen Van A\nCa sáng',
    overrides: { paymentMode: 'CN' },
  });
  expect(res.status).toBe(201);
  const id = res.body.bookingId as string;
  branchId = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).branchId!;
  return id;
}

async function asReception() {
  if (!reception) {
    await createReceptionist(branchId, { username: 'letan_del', mustChangePassword: false });
    reception = (await loginAgent(app, 'letan_del', RECEPTIONIST_PASSWORD)).agent;
  }
  return reception;
}

/* ================================================================== */
/* It disappears                                                       */
/* ================================================================== */
describe('a deleted booking leaves every operational list', () => {
  it('is gone from the reception queue', async () => {
    const id = await dispatched();
    const before = await (await asReception()).get('/api/bookings/new');
    expect(before.body.bookings.some((b: { id: string }) => b.id === id)).toBe(true);

    expect((await admin.delete(`/api/admin/bookings/${id}`)).status).toBe(200);

    const after = await (await asReception()).get('/api/bookings/new');
    expect(after.body.bookings.some((b: { id: string }) => b.id === id)).toBe(false);
  });

  it('is gone from history', async () => {
    const id = await dispatched();
    await admin.delete(`/api/admin/bookings/${id}`);
    const history = await admin.get('/api/bookings/history?pageSize=100');
    expect(history.body.bookings.some((b: { id: string }) => b.id === id)).toBe(false);
  });

  it('is gone from search', async () => {
    const id = await dispatched();
    const code = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).bookingCode;
    await admin.delete(`/api/admin/bookings/${id}`);
    const found = await admin.get(`/api/bookings/history?search=${encodeURIComponent(code)}`);
    expect(found.body.bookings).toHaveLength(0);
  });

  it('is gone from the dashboard counters', async () => {
    const id = await dispatched();
    const before = await admin.get('/api/admin/dashboard/summary');
    await admin.delete(`/api/admin/bookings/${id}`);
    const after = await admin.get('/api/admin/dashboard/summary');
    expect(after.body.totals.waiting).toBe(before.body.totals.waiting - 1);
  });

  it('leaves no ghost row anywhere a receptionist looks', async () => {
    const id = await dispatched();
    await admin.delete(`/api/admin/bookings/${id}`);
    const r = await asReception();
    for (const list of ['/api/bookings/new', '/api/bookings/pending-review', '/api/bookings/rejected']) {
      const res = await r.get(list);
      expect(res.body.bookings.some((b: { id: string }) => b.id === id), list).toBe(false);
    }
  });
});

/* ================================================================== */
/* Nothing is destroyed                                                */
/* ================================================================== */
describe('what survives a deletion', () => {
  it('keeps the booking row itself, marked with who and when', async () => {
    const id = await dispatched();
    await admin.delete(`/api/admin/bookings/${id}`);

    const booking = await testPrisma.booking.findUnique({ where: { id } });
    expect(booking).not.toBeNull();
    expect(booking!.deletedAt).toBeInstanceOf(Date);
    expect(booking!.deletedByUserId).not.toBeNull();
  });

  it('keeps the status history', async () => {
    const id = await dispatched();
    const before = await testPrisma.bookingStatusHistory.count({ where: { bookingId: id } });
    expect(before).toBeGreaterThan(0);

    await admin.delete(`/api/admin/bookings/${id}`);
    expect(await testPrisma.bookingStatusHistory.count({ where: { bookingId: id } })).toBe(before);
  });

  it('keeps the rooms and nightly prices', async () => {
    const id = await dispatched();
    const before = await testPrisma.bookingRoom.count({ where: { bookingId: id } });
    expect(before).toBeGreaterThan(0);

    await admin.delete(`/api/admin/bookings/${id}`);
    expect(await testPrisma.bookingRoom.count({ where: { bookingId: id } })).toBe(before);
  });

  it('keeps the append-only corrections', async () => {
    const id = await dispatched();
    await admin.patch(`/api/admin/bookings/${id}/ota-fields`).send({ adminPmsNote: 'Tran Thi B' });
    const before = await testPrisma.bookingCorrection.count({ where: { bookingId: id } });
    expect(before).toBeGreaterThan(0);

    await admin.delete(`/api/admin/bookings/${id}`);
    expect(await testPrisma.bookingCorrection.count({ where: { bookingId: id } })).toBe(before);
  });
});

/* ================================================================== */
/* Permissions                                                         */
/* ================================================================== */
describe('who may delete', () => {
  it('refuses a receptionist', async () => {
    const id = await dispatched();
    const r = await asReception();
    expect((await r.delete(`/api/admin/bookings/${id}`)).status).toBe(403);

    // And the booking is untouched — a refused delete writes nothing.
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(booking.deletedAt).toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const id = await dispatched();
    const { default: request } = await import('supertest');
    expect((await request(app).delete(`/api/admin/bookings/${id}`)).status).toBe(401);
  });

  it('allows an Admin', async () => {
    const id = await dispatched();
    expect((await admin.delete(`/api/admin/bookings/${id}`)).status).toBe(200);
  });
});

/* ================================================================== */
/* Edge cases                                                          */
/* ================================================================== */
describe('deleting twice, and deleting nothing', () => {
  it('is idempotent — a second delete is not an error', async () => {
    // Two Admins clicking at once should both see it gone, rather than one
    // being told their intended outcome failed.
    const id = await dispatched();
    expect((await admin.delete(`/api/admin/bookings/${id}`)).status).toBe(200);
    expect((await admin.delete(`/api/admin/bookings/${id}`)).status).toBe(200);
  });

  it('keeps the first deletion timestamp on a repeat', async () => {
    const id = await dispatched();
    const first = await admin.delete(`/api/admin/bookings/${id}`);
    const second = await admin.delete(`/api/admin/bookings/${id}`);
    expect(second.body.deletedAt).toBe(first.body.deletedAt);
  });

  it('404s for a booking that does not exist', async () => {
    expect((await admin.delete('/api/admin/bookings/does-not-exist')).status).toBe(404);
  });
});

/* ================================================================== */
/* Confirmed bookings leave the queue (Hotfix F)                       */
/* ================================================================== */
describe('an approved booking leaves the reception queue', () => {
  it('is not in /bookings/new once the Admin approves it', async () => {
    // Before 5.2 an approved booking still had to be RECEIVED through the
    // lifecycle, so it stayed visible. The lifecycle UI is gone, so there is
    // nothing left for reception to do with it.
    const id = await dispatched();
    await testPrisma.booking.update({ where: { id }, data: { verificationStatus: 'APPROVED' } });

    const res = await (await asReception()).get('/api/bookings/new');
    expect(res.body.bookings.some((b: { id: string }) => b.id === id)).toBe(false);
  });

  it('a rejected booking is back in "Đơn mới", marked for recreation (and in the recreate queue)', async () => {
    const id = await dispatched();
    await testPrisma.booking.update({ where: { id }, data: { verificationStatus: 'REJECTED' } });
    const r = await asReception();

    expect((await r.get('/api/bookings/rejected')).body.bookings.some((b: { id: string }) => b.id === id)).toBe(true);
    const fresh = (await r.get('/api/bookings/new')).body.bookings.find((b: { id: string }) => b.id === id);
    expect(fresh?.verificationStatus).toBe('REJECTED');
  });

  it('a not-yet-submitted booking is still waiting for the branch', async () => {
    const id = await dispatched();
    const res = await (await asReception()).get('/api/bookings/new');
    expect(res.body.bookings.some((b: { id: string }) => b.id === id)).toBe(true);
  });
});
