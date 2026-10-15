import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma, utcDate } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { loadActiveMapping } from '../src/room/roomClassResolver';
import { seedBranchRoomClasses } from '../src/room/roomClassSeed';
import { applyRoomClassSnapshots } from '../src/room/roomSnapshotService';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionistAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let adminId: number;
let receptionistId: number;
let cn2: number;
let cn6: number;

const CODE = { CN2: 'LY_TU_TRONG_260', CN6: 'BUI_THI_XUAN_40' };

/** A dispatched booking on `branchId` with one room of `roomType`. */
async function makeBooking(branchId: number, roomType: string, over: Record<string, unknown> = {}) {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      branchId,
      customerName: 'NGUYEN VAN TEST',
      phone: '0900000001',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'test',
      status: 'NEW',
      checkInDate: utcDate('2026-08-01'),
      checkOutDate: utcDate('2026-08-03'),
      totalAmount: 1_000_000,
      rooms: { create: [{ roomIndex: 1, roomType, roomSubtotal: 1_000_000 }] },
      ...over,
    },
    include: { rooms: true },
  });
  await applyRoomClassSnapshots(booking.id, testPrisma);
  // One primary guest, as the real creation path produces.
  await testPrisma.bookingGuest.create({
    data: { bookingId: booking.id, fullName: 'NGUYEN VAN TEST', phone: '0900000001', isPrimary: true },
  });
  return booking.id;
}

const roomOf = (bookingId: string) =>
  testPrisma.bookingRoom.findFirstOrThrow({ where: { bookingId }, orderBy: { roomIndex: 'asc' } });

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: CODE.CN2 } })).id;
  cn6 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: CODE.CN6 } })).id;

  adminId = (await createAdmin({ mustChangePassword: false })).id;
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  receptionistId = (await createReceptionist(cn2, { username: 'letan', mustChangePassword: false })).id;
  receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.booking.deleteMany({});
  // Some cases activate a NEW mapping version; rebuild the seeded version 1 so
  // every case starts from the confirmed catalogue. `BookingRoom.roomClassId`
  // is deliberately NOT a foreign key, so dropping versions can never cascade
  // into booking data — snapshots are self-contained by design.
  await testPrisma.branchRoomMappingVersion.deleteMany({});
  await seedBranchRoomClasses(testPrisma);
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* D. Historical snapshots                                             */
/* ================================================================== */

describe('D. historical snapshot protection', () => {
  it('D1. a booking captures the branch-specific code at creation', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const room = await roomOf(bookingId);

    expect(room.roomClassPmsCode).toBe('LUXDEL');
    expect(room.roomClassDisplayName).toBe('Premium');
    expect(room.roomClassStatus).toBe('RESOLVED');
    expect(room.roomClassBranchId).toBe(cn2);
    expect(room.roomClassSourceText).toBe('Premium');
  });

  it('D2. activating a new mapping does NOT change an existing booking', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const before = await roomOf(bookingId);
    expect(before.roomClassPmsCode).toBe('LUXDEL');

    // Version 2: Premium is re-coded.
    const base = `/api/admin/branches/${cn2}/room-mapping`;
    const active = await loadActiveMapping(cn2, testPrisma);
    const draft = (await adminAgent.post(`${base}/drafts`).send({})).body.draft;
    const premium = draft.roomClasses.find((c: { pmsCode: string }) => c.pmsCode === 'LUXDEL');
    await adminAgent
      .patch(`${base}/drafts/${draft.id}/room-classes/${premium.id}`)
      .send({ pmsCode: 'PREMIUM_NEW' });
    const activated = await adminAgent
      .post(`${base}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: active!.versionId });
    expect(activated.status).toBe(200);

    // The existing booking is byte-for-byte unchanged.
    const after = await roomOf(bookingId);
    expect(after.roomClassPmsCode).toBe('LUXDEL');
    expect(after.roomClassDisplayName).toBe('Premium');
    expect(after.roomClassVersionId).toBe(before.roomClassVersionId);
    expect(after.roomClassResolvedAt?.getTime()).toBe(before.roomClassResolvedAt?.getTime());

    // …while a NEW booking picks up the new code.
    const newBookingId = await makeBooking(cn2, 'Premium');
    expect((await roomOf(newBookingId)).roomClassPmsCode).toBe('PREMIUM_NEW');
  });

  it('D3. re-running the snapshot service never overwrites a resolved snapshot', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const before = await roomOf(bookingId);

    const outcome = await applyRoomClassSnapshots(bookingId, testPrisma);
    expect(outcome.roomsSkipped).toBe(1);
    expect(outcome.roomsResolved).toBe(0);

    const after = await roomOf(bookingId);
    expect(after.roomClassPmsCode).toBe(before.roomClassPmsCode);
    expect(after.roomClassResolvedAt?.getTime()).toBe(before.roomClassResolvedAt?.getTime());
  });

  it('D4. an unresolved room keeps its source text and gets no invented code', async () => {
    const bookingId = await makeBooking(cn2, 'Phòng Deluxe Có Giường Cỡ Queen');
    const room = await roomOf(bookingId);

    expect(room.roomClassStatus).toBe('UNRESOLVED');
    expect(room.roomClassPmsCode).toBeNull();
    expect(room.roomClassSourceText).toBe('Phòng Deluxe Có Giường Cỡ Queen');
    // The original room text is untouched, so the legacy note path still works.
    expect(room.roomType).toBe('Phòng Deluxe Có Giường Cỡ Queen');
  });

  it('D5. apply-latest-mapping is explicit, audited and shows both values', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');

    // Re-code Premium in a new active version.
    const base = `/api/admin/branches/${cn2}/room-mapping`;
    const active = await loadActiveMapping(cn2, testPrisma);
    const draft = (await adminAgent.post(`${base}/drafts`).send({})).body.draft;
    const premium = draft.roomClasses.find((c: { pmsCode: string }) => c.pmsCode === 'LUXDEL');
    await adminAgent.patch(`${base}/drafts/${draft.id}/room-classes/${premium.id}`).send({ pmsCode: 'PREMIUM_NEW' });
    await adminAgent.post(`${base}/drafts/${draft.id}/activate`).send({ expectedActiveVersionId: active!.versionId });

    // The preview shows old vs new WITHOUT changing anything.
    const preview = await adminAgent.get(`/api/bookings/${bookingId}/room-mapping/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.rooms[0].current.pmsCode).toBe('LUXDEL');
    expect(preview.body.rooms[0].latest.pmsCode).toBe('PREMIUM_NEW');
    expect(preview.body.rooms[0].wouldChange).toBe(true);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');

    // A reason is required.
    expect((await adminAgent.post(`/api/bookings/${bookingId}/room-mapping/apply-latest`).send({})).status).toBe(422);

    const applied = await adminAgent
      .post(`/api/bookings/${bookingId}/room-mapping/apply-latest`)
      .send({ reason: 'Đồng bộ theo cấu hình mới' });
    expect(applied.status).toBe(200);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('PREMIUM_NEW');

    const events = await testPrisma.bookingAuditEvent.findMany({ where: { bookingId } });
    const reapply = events.find((e) => e.action === 'BOOKING_ROOM_MAPPING_REAPPLIED');
    expect(reapply).toBeDefined();
    expect(reapply!.oldValue).toContain('LUXDEL');
    expect(reapply!.newValue).toContain('PREMIUM_NEW');
    expect(reapply!.reason).toBe('Đồng bộ theo cấu hình mới');
  });

  it('D6. a completed or archived booking is never recalculated', async () => {
    for (const status of ['COMPLETED', 'ARCHIVED'] as const) {
      const bookingId = await makeBooking(cn2, 'Premium', { status });
      const res = await adminAgent
        .post(`/api/bookings/${bookingId}/room-mapping/apply-latest`)
        .send({ reason: 'thử' });
      expect(res.status, status).toBe(409);
      expect((await roomOf(bookingId)).roomClassPmsCode, status).toBe('LUXDEL');
    }
  });

  it('D7. a receptionist cannot re-apply a mapping', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const res = await receptionistAgent
      .post(`/api/bookings/${bookingId}/room-mapping/apply-latest`)
      .send({ reason: 'thử' });
    expect(res.status).toBe(403);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');
  });
});

/* ================================================================== */
/* F. Guest updates                                                    */
/* ================================================================== */

describe('F. guest add/update safety', () => {
  it('F1. adding a guest keeps the first guest and every booking field', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const before = await testPrisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { rooms: true },
    });

    const res = await receptionistAgent
      .post(`/api/bookings/${bookingId}/guests`)
      .send({ fullName: 'TRAN THI HAI', phone: '0900000002', nationality: 'VN' });
    expect(res.status).toBe(201);
    expect(res.body.guests).toHaveLength(2);
    expect(res.body.guests.map((g: { fullName: string }) => g.fullName)).toContain('NGUYEN VAN TEST');
    expect(res.body.guests.filter((g: { isPrimary: boolean }) => g.isPrimary)).toHaveLength(1);

    const after = await testPrisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { rooms: true },
    });
    // Nothing about the booking or its room snapshot moved.
    expect(after.branchId).toBe(before.branchId);
    expect(after.status).toBe(before.status);
    expect(after.totalAmount).toBe(before.totalAmount);
    expect(after.checkInDate?.getTime()).toBe(before.checkInDate?.getTime());
    expect(after.customerName).toBe(before.customerName);
    expect(after.rooms[0]!.roomClassPmsCode).toBe(before.rooms[0]!.roomClassPmsCode);
    expect(after.rooms[0]!.roomClassVersionId).toBe(before.rooms[0]!.roomClassVersionId);
  });

  it('F2. updating only the phone preserves every other guest field', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const added = await receptionistAgent.post(`/api/bookings/${bookingId}/guests`).send({
      fullName: 'TRAN THI HAI',
      phone: '0900000002',
      nationality: 'Việt Nam',
      identityNumber: 'B1234567',
      identityType: 'passport',
      email: 'hai@example.invalid',
      note: 'Đi cùng trẻ nhỏ',
    });
    const guest = added.body.guests.find((g: { fullName: string }) => g.fullName === 'TRAN THI HAI');

    const res = await receptionistAgent
      .patch(`/api/bookings/${bookingId}/guests/${guest.id}`)
      .send({ phone: '0911111111' });
    expect(res.status).toBe(200);

    const updated = res.body.guests.find((g: { id: string }) => g.id === guest.id);
    expect(updated.phone).toBe('0911111111');
    // Everything else survived untouched.
    expect(updated.fullName).toBe('TRAN THI HAI');
    expect(updated.nationality).toBe('Việt Nam');
    expect(updated.identityNumber).toBe('B1234567');
    expect(updated.identityType).toBe('passport');
    expect(updated.email).toBe('hai@example.invalid');
    expect(updated.note).toBe('Đi cùng trẻ nhỏ');
  });

  it('F3. a guest update never touches the room-class snapshot or booking data', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const before = await roomOf(bookingId);
    const bookingBefore = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const primary = (await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId, isPrimary: true } }));

    await receptionistAgent
      .patch(`/api/bookings/${bookingId}/guests/${primary.id}`)
      .send({ nationality: 'VN', identityNumber: 'C9999999' });

    const after = await roomOf(bookingId);
    const bookingAfter = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    expect(after.roomClassPmsCode).toBe(before.roomClassPmsCode);
    expect(after.roomClassVersionId).toBe(before.roomClassVersionId);
    expect(after.roomType).toBe(before.roomType);
    expect(bookingAfter.branchId).toBe(bookingBefore.branchId);
    expect(bookingAfter.totalAmount).toBe(bookingBefore.totalAmount);
    expect(bookingAfter.paymentStatus).toBe(bookingBefore.paymentStatus);
    expect(bookingAfter.status).toBe(bookingBefore.status);
  });

  it('F4. editing the primary guest keeps the booking mirror in step', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const primary = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId, isPrimary: true } });

    await receptionistAgent
      .patch(`/api/bookings/${bookingId}/guests/${primary.id}`)
      .send({ fullName: 'NGUYEN VAN MOI', phone: '0988888888' });

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.customerName).toBe('NGUYEN VAN MOI');
    expect(booking.phone).toBe('0988888888');
  });

  it('F5. changing the primary guest preserves both guests', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const added = await receptionistAgent
      .post(`/api/bookings/${bookingId}/guests`)
      .send({ fullName: 'TRAN THI HAI', phone: '0900000002' });
    const second = added.body.guests.find((g: { fullName: string }) => g.fullName === 'TRAN THI HAI');

    const res = await receptionistAgent.post(`/api/bookings/${bookingId}/guests/${second.id}/primary`);
    expect(res.status).toBe(200);
    expect(res.body.guests).toHaveLength(2);
    expect(res.body.guests.filter((g: { isPrimary: boolean }) => g.isPrimary)).toHaveLength(1);
    expect(res.body.guests.find((g: { isPrimary: boolean }) => g.isPrimary).fullName).toBe('TRAN THI HAI');

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.customerName).toBe('TRAN THI HAI');
    // The demoted guest still exists with all its data.
    expect(await testPrisma.bookingGuest.count({ where: { bookingId } })).toBe(2);
  });

  it('F6. an unknown field is rejected rather than silently ignored', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const primary = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId, isPrimary: true } });
    const res = await receptionistAgent
      .patch(`/api/bookings/${bookingId}/guests/${primary.id}`)
      .send({ phoneNumber: '0900000009' });
    expect(res.status).toBe(422);
  });

  it('F7. a stale guest update is rejected as a conflict', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const primary = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId, isPrimary: true } });
    const staleTimestamp = new Date(primary.updatedAt.getTime() - 60_000).toISOString();

    const res = await receptionistAgent
      .patch(`/api/bookings/${bookingId}/guests/${primary.id}`)
      .send({ phone: '0900000003', expectedUpdatedAt: staleTimestamp });
    expect(res.status).toBe(409);

    // Nothing was written.
    const after = await testPrisma.bookingGuest.findUniqueOrThrow({ where: { id: primary.id } });
    expect(after.phone).toBe(primary.phone);
  });

  it('F8. a receptionist cannot touch another branch\'s booking', async () => {
    const otherBookingId = await makeBooking(cn6, 'Deluxe');

    expect((await receptionistAgent.get(`/api/bookings/${otherBookingId}/guests`)).status).toBe(403);
    expect(
      (await receptionistAgent.post(`/api/bookings/${otherBookingId}/guests`).send({ fullName: 'X' })).status,
    ).toBe(403);

    // The other branch's booking is untouched.
    expect(await testPrisma.bookingGuest.count({ where: { bookingId: otherBookingId } })).toBe(1);
  });

  it('F9. a receptionist cannot reach a not-yet-dispatched booking', async () => {
    const draftBooking = await makeBooking(cn2, 'Premium', { status: 'DRAFT' });
    expect((await receptionistAgent.get(`/api/bookings/${draftBooking}/guests`)).status).toBe(404);
    // …but the Admin can.
    expect((await adminAgent.get(`/api/bookings/${draftBooking}/guests`)).status).toBe(200);
  });

  it('F10. the primary guest cannot be removed while others exist', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    await receptionistAgent.post(`/api/bookings/${bookingId}/guests`).send({ fullName: 'TRAN THI HAI' });
    const primary = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId, isPrimary: true } });

    const res = await receptionistAgent.delete(`/api/bookings/${bookingId}/guests/${primary.id}`);
    expect(res.status).toBe(422);
    expect(await testPrisma.bookingGuest.count({ where: { bookingId } })).toBe(2);
  });

  it('F11. every guest change writes an audit event with the actor', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const added = await receptionistAgent
      .post(`/api/bookings/${bookingId}/guests`)
      .send({ fullName: 'TRAN THI HAI' });
    const second = added.body.guests.find((g: { fullName: string }) => g.fullName === 'TRAN THI HAI');
    await receptionistAgent.patch(`/api/bookings/${bookingId}/guests/${second.id}`).send({ phone: '0900000009' });
    await receptionistAgent.post(`/api/bookings/${bookingId}/guests/${second.id}/primary`);

    const res = await receptionistAgent.get(`/api/bookings/${bookingId}/audit`);
    expect(res.status).toBe(200);
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain('BOOKING_GUEST_ADDED');
    expect(actions).toContain('BOOKING_GUEST_UPDATED');
    expect(actions).toContain('BOOKING_PRIMARY_GUEST_CHANGED');
    expect(res.body.events[0].actor.id).toBe(receptionistId);
    expect(res.body.events[0].actorRole).toBe('RECEPTIONIST');
    expect(adminId).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* G. Migration / data preservation                                    */
/* ================================================================== */

describe('G. migration and data preservation', () => {
  it('G1. an unresolvable LEGACY row keeps its marker and its text', async () => {
    // Exactly what the migration produced for a pre-C.3.8 booking: free-text
    // Vietnamese room name, no snapshot, marked LEGACY.
    const bookingId = await makeBooking(cn2, 'Phòng Tiêu Chuẩn Giường Đôi');
    await testPrisma.bookingRoom.updateMany({
      where: { bookingId },
      data: {
        roomClassId: null, roomClassVersionId: null, roomClassPmsCode: null,
        roomClassDisplayName: null, roomClassStatus: 'LEGACY',
        roomClassSourceText: 'Phòng Tiêu Chuẩn Giường Đôi',
      },
    });

    // It cannot be resolved deterministically, so it keeps the LEGACY marker
    // rather than being downgraded — the legacy note path stays in charge and
    // no code is invented for it.
    const outcome = await applyRoomClassSnapshots(bookingId, testPrisma);
    expect(outcome.roomsUnresolved).toBe(1);
    expect(outcome.roomsResolved).toBe(0);

    const room = await roomOf(bookingId);
    expect(room.roomClassStatus).toBe('LEGACY');
    expect(room.roomClassPmsCode).toBeNull();
    expect(room.roomType).toBe('Phòng Tiêu Chuẩn Giường Đôi');
    expect(room.roomClassSourceText).toBe('Phòng Tiêu Chuẩn Giường Đôi');
  });

  it('G2. a LEGACY row whose text DOES match is resolved when re-run', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    await testPrisma.bookingRoom.updateMany({
      where: { bookingId },
      data: { roomClassStatus: 'LEGACY', roomClassPmsCode: null, roomClassId: null },
    });

    await applyRoomClassSnapshots(bookingId, testPrisma);
    const room = await roomOf(bookingId);
    expect(room.roomClassStatus).toBe('RESOLVED');
    expect(room.roomClassPmsCode).toBe('LUXDEL');
  });
});
