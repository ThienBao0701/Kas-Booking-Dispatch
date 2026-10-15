import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { setClock, resetClock } from '../src/lib/clock';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;
let otherBranchId: number;
let ownReceptionistId: number;
let otherReceptionistId: number;
let inactiveReceptionistId: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  otherBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  ownReceptionistId = (await createReceptionist(ownBranchId, { username: 'letan_own', mustChangePassword: false })).id;
  otherReceptionistId = (await createReceptionist(otherBranchId, { username: 'letan_other', mustChangePassword: false })).id;
  inactiveReceptionistId = (
    await createReceptionist(ownBranchId, { username: 'letan_off', active: false, mustChangePassword: false })
  ).id;
});

afterEach(() => {
  resetClock();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('POST /api/admin/bookings/:id/send', () => {
  it('sends a DRAFT: NEW, sentAt/sentBy set, history and notifications written', async () => {
    const draft = await createDraftBooking();
    const res = await adminAgent
      .post(`/api/admin/bookings/${draft.id}/send`)
      .send({ branchId: ownBranchId, acknowledgedWarningCodes: [] });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('NEW');
    expect(res.body.booking.sentAt).toBeTruthy();
    expect(res.body.booking.sentBy).not.toBeNull();

    const stored = await testPrisma.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stored.branchId).toBe(ownBranchId);
    expect(stored.sentByUserId).not.toBeNull();
    expect(stored.completedAt).toBeNull();

    const history = await testPrisma.bookingStatusHistory.findMany({ where: { bookingId: draft.id } });
    expect(history.some((h) => h.newStatus === 'NEW')).toBe(true);

    // Notifications go only to the active receptionist of the target branch.
    const notes = await testPrisma.notification.findMany({ where: { bookingId: draft.id } });
    const recipients = notes.map((n) => n.userId).sort();
    expect(recipients).toEqual([ownReceptionistId]);
    expect(recipients).not.toContain(otherReceptionistId);
    expect(recipients).not.toContain(inactiveReceptionistId);
  });

  it('sends a READY booking', async () => {
    const draft = await createDraftBooking({ status: 'READY' });
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('NEW');
  });

  it('requires a branchId', async () => {
    const draft = await createDraftBooking();
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an inactive branch', async () => {
    const draft = await createDraftBooking();
    await testPrisma.branch.update({ where: { id: otherBranchId }, data: { active: false } });
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: otherBranchId });
    expect(res.status).toBe(422);
  });

  it('computes isLastMinute in Asia/Ho_Chi_Minh and flags the notification', async () => {
    setClock({ now: () => new Date('2026-07-22T03:00:00.000Z') }); // 10:00 HCM on 2026-07-22
    const draft = await createDraftBooking({ checkIn: '2026-07-22', checkOut: '2026-07-24' });
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(res.status).toBe(200);
    expect(res.body.booking.isLastMinute).toBe(true);

    const note = await testPrisma.notification.findFirstOrThrow({ where: { bookingId: draft.id } });
    expect(note.title).toBe('ĐƠN LAST MINUTE');
  });

  it('is not last-minute for a future check-in', async () => {
    setClock({ now: () => new Date('2026-07-20T03:00:00.000Z') });
    const draft = await createDraftBooking({ checkIn: '2026-07-22', checkOut: '2026-07-24' });
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(res.body.booking.isLastMinute).toBe(false);
    const note = await testPrisma.notification.findFirstOrThrow({ where: { bookingId: draft.id } });
    expect(note.title).toBe('Có đơn mới');
  });

  it('requires acknowledgement of every non-blocking warning', async () => {
    const draft = await createDraftBooking({ phone: null }); // -> MISSING_PHONE warning
    const blocked = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');

    const ok = await adminAgent
      .post(`/api/admin/bookings/${draft.id}/send`)
      .send({ branchId: ownBranchId, acknowledgedWarningCodes: ['MISSING_PHONE'] });
    expect(ok.status).toBe(200);
  });

  it('blocks sending with 422 when a blocking error remains', async () => {
    const draft = await createDraftBooking({ bookingCode: '' }); // missing booking code
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BOOKING_NOT_READY');
  });

  it('returns CONFLICT when re-sending an already-sent booking (no duplicate side effects)', async () => {
    const draft = await createDraftBooking();
    await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    const again = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BOOKING_ALREADY_SENT');

    const notes = await testPrisma.notification.findMany({ where: { bookingId: draft.id } });
    expect(notes).toHaveLength(1);
    const history = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: draft.id, newStatus: 'NEW' },
    });
    expect(history).toHaveLength(1);
  });

  it('detects a duplicate operational booking (same code + branch + check-in)', async () => {
    await createDraftBooking({ status: 'NEW', branchId: ownBranchId, bookingCode: 'DUP123456', checkIn: '2026-07-19', checkOut: '2026-07-22' });
    const draft = await createDraftBooking({ bookingCode: 'DUP123456', checkIn: '2026-07-19', checkOut: '2026-07-22' });
    const res = await adminAgent.post(`/api/admin/bookings/${draft.id}/send`).send({ branchId: ownBranchId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_BOOKING');
    expect(res.body.error.details.existingStatus).toBe('NEW');
  });

  it('does NOT treat a WITHDRAWN booking as a duplicate', async () => {
    /*
      The same correction as the Booking.com dispatch path, asserted on the
      legacy send because both go through `findOperationalDuplicate`.

      Soft delete leaves `status` alone, so this fixture is a withdrawn order
      still reading 'NEW'. It is in no queue and in front of no receptionist —
      there is nothing for a branch to create twice, so it must not block.
    */
    const withdrawn = await createDraftBooking({
      status: 'NEW',
      branchId: ownBranchId,
      bookingCode: 'DUP777777',
      checkIn: '2026-07-19',
      checkOut: '2026-07-22',
    });
    await testPrisma.booking.update({
      where: { id: withdrawn.id },
      data: { deletedAt: new Date(), deletedByUserId: null },
    });

    const draft = await createDraftBooking({
      bookingCode: 'DUP777777',
      checkIn: '2026-07-19',
      checkOut: '2026-07-22',
    });
    const res = await adminAgent
      .post(`/api/admin/bookings/${draft.id}/send`)
      .send({ branchId: ownBranchId });

    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.body.booking.status).toBe('NEW');

    // The withdrawn order is untouched — still deleted, still historical.
    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: withdrawn.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.status).toBe('NEW');
  });
});
