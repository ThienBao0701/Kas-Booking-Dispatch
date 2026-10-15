/**
 * Where a booking change came from.
 *
 * The history tables already answered who changed what, and when. What they
 * could not answer was from which machine, session and request — the questions
 * that matter when a change is disputed, or when a session is suspected of
 * being shared. That context is now recorded ONCE PER REQUEST and referenced by
 * everything the request wrote, rather than copied onto every history row.
 *
 * It is evidence, never identity: nothing authorises against it, and a value
 * the client did not send is stored as null rather than guessed.
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
let cn5 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn5, { username: 'letan_audit', mustChangePassword: false });
  reception = (await loginAgent(app, 'letan_audit', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.booking.deleteMany();
  await testPrisma.requestAudit.deleteMany();
});

afterAll(async () => testPrisma.$disconnect());

const AGODA = {
  source: 'AGODA',
  rawText: AGODA_RAW,
  // Required since 5.2b: who created the reservation in the hotel PMS.
  adminPmsNote: 'Nguyen Van A\nCa sáng',
  overrides: { paymentMode: 'CN' },
};

describe('a dispatch records where it came from', () => {
  it('captures actor, address, agent, session and correlation id', async () => {
    const res = await admin
      .post('/api/admin/ota/dispatch')
      .set('user-agent', 'KasTest/1.0 (certification)')
      .set('x-request-id', 'corr-dispatch-001')
      .send(AGODA);
    expect(res.status).toBe(201);

    const contexts = await testPrisma.requestAudit.findMany();
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0]!;

    expect(ctx.actorUserId).not.toBeNull();
    expect(ctx.userAgent).toBe('KasTest/1.0 (certification)');
    expect(ctx.correlationId).toBe('corr-dispatch-001');
    expect(ctx.route).toBe('POST /api/admin/ota/dispatch');
    expect(ctx.ipAddress).not.toBeNull();
    expect(ctx.sessionId).not.toBeNull();
    expect(ctx.occurredAt).toBeInstanceOf(Date);
  });

  it('echoes the correlation id back, so a change joins its request trace', async () => {
    const res = await admin
      .post('/api/admin/ota/dispatch')
      .set('x-request-id', 'corr-echo-002')
      .send(AGODA);
    expect(res.headers['x-request-id']).toBe('corr-echo-002');

    const ctx = await testPrisma.requestAudit.findFirstOrThrow();
    expect(ctx.correlationId).toBe('corr-echo-002');
  });

  it('writes ONE context for a request that produced several rows', async () => {
    // A corrected dispatch writes a status row and several correction rows.
    const res = await admin
      .post('/api/admin/ota/dispatch')
      .set('x-request-id', 'corr-shared-003')
      .send({
        source: 'AGODA',
        rawText: AGODA_RAW,
        adminPmsNote: 'Nguyen Van A\nCa sáng',
        overrides: { guestName: 'CHANGED', branchPrice: 999_999, paymentMode: 'CN' },
      });
    expect(res.status).toBe(201);

    const contexts = await testPrisma.requestAudit.findMany();
    expect(contexts).toHaveLength(1);

    const corrections = await testPrisma.bookingCorrection.findMany({
      where: { bookingId: res.body.bookingId },
    });
    const history = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: res.body.bookingId },
    });
    expect(corrections.length).toBeGreaterThan(1);

    // Everything the request wrote points at that single context.
    for (const row of [...corrections, ...history]) {
      expect(row.requestAuditId).toBe(contexts[0]!.id);
    }
  });

  it('stamps the build that produced the extraction', async () => {
    const res = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.bookingId },
    });
    // APP_RELEASE_REF is unset in tests, so this is honestly unattributed
    // rather than carrying an invented revision.
    expect(booking.parserCommit).toBeNull();
    expect(booking.reviewBuildId).toBeNull();
    // The rule versions are always present regardless.
    expect(booking.parserVersion).not.toBeNull();
    expect(booking.reviewVersion).not.toBeNull();
  });
});

describe('a lifecycle transition records its own context', () => {
  it('links the status row to the request that caused it', async () => {
    const dispatched = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    const id = dispatched.body.bookingId;

    await reception
      .post(`/api/bookings/${id}/receive`)
      .set('user-agent', 'ReceptionKiosk/2.0')
      .set('x-request-id', 'corr-receive-004')
      .send({});

    const row = await testPrisma.bookingStatusHistory.findFirstOrThrow({
      where: { bookingId: id, newStatus: 'RECEIVED' },
      include: { requestAudit: true },
    });
    expect(row.requestAudit?.userAgent).toBe('ReceptionKiosk/2.0');
    expect(row.requestAudit?.correlationId).toBe('corr-receive-004');
    expect(row.requestAudit?.route).toBe('POST /api/bookings/:id/receive');
  });

  it('gives each transition its own context, not a shared one', async () => {
    const dispatched = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    const id = dispatched.body.bookingId;

    await reception.post(`/api/bookings/${id}/receive`).set('x-request-id', 'r-1').send({});
    await reception.post(`/api/bookings/${id}/check-in`).set('x-request-id', 'r-2').send({});

    const rows = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: id, newStatus: { in: ['RECEIVED', 'CHECKED_IN'] } },
      include: { requestAudit: true },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.map((r) => r.requestAudit?.correlationId)).toEqual(['r-1', 'r-2']);
    expect(rows[0]!.requestAuditId).not.toBe(rows[1]!.requestAuditId);
  });

  it('records the receptionist, not the admin who dispatched', async () => {
    const dispatched = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    const id = dispatched.body.bookingId;
    await reception.post(`/api/bookings/${id}/receive`).send({});

    const receptionist = await testPrisma.user.findUniqueOrThrow({
      where: { username: 'letan_audit' },
    });
    const row = await testPrisma.bookingStatusHistory.findFirstOrThrow({
      where: { bookingId: id, newStatus: 'RECEIVED' },
      include: { requestAudit: true },
    });
    expect(row.requestAudit?.actorUserId).toBe(receptionist.id);
    expect(row.changedByUserId).toBe(receptionist.id);
  });
});

describe('context is provenance, not business data', () => {
  it('generates a correlation id when the client sends none', async () => {
    const res = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    expect(res.status).toBe(201);

    const ctx = await testPrisma.requestAudit.findFirstOrThrow();
    // A uuid was minted rather than the field left empty.
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('survives deletion of the context without losing the business event', async () => {
    const dispatched = await admin.post('/api/admin/ota/dispatch').send(AGODA);
    const id = dispatched.body.bookingId;

    // Provenance may be purged for retention; the history must outlive it.
    await testPrisma.bookingCorrection.deleteMany({ where: { bookingId: id } });
    await testPrisma.requestAudit.deleteMany();

    const history = await testPrisma.bookingStatusHistory.findMany({ where: { bookingId: id } });
    expect(history).toHaveLength(1);
    expect(history[0]!.requestAuditId).toBeNull();
    expect(history[0]!.newStatus).toBe('NEW');
  });

  it('adds no context rows for a Booking.com booking created outside a request', async () => {
    await testPrisma.booking.create({
      data: {
        bookingCode: 'BCOM-AUDIT-1',
        customerName: 'Booking.com Guest',
        sourcePlatform: 'BOOKING_COM',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'x',
        status: 'DRAFT',
        branchId: cn5,
      },
    });
    expect(await testPrisma.requestAudit.count()).toBe(0);
  });
});
