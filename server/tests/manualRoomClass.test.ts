/**
 * PUT /api/bookings/:id/rooms/:roomIndex/room-class — the Admin chooses the
 * internal room class for one room of a booking.
 *
 * This is the write path behind the Booking.com Admin selector. What it has to
 * guarantee, and what every test below is really about:
 *
 *   The selection PERSISTS, because the PMS note a receptionist pastes is
 *   generated from this snapshot and nothing else. A choice that lived only in
 *   the Admin's browser would mean the branch received a different note than
 *   the one that was approved.
 *
 *   The selection cannot reach outside the booking's own branch or its ACTIVE
 *   mapping version — a stale dropdown must be refused, not written.
 *
 *   It is recorded as MANUAL, which the automatic snapshot pass then refuses to
 *   overwrite. An Admin's decision outlives every later routine operation.
 */
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
import { applyRoomClassSnapshots } from '../src/room/roomSnapshotService';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionistAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
/** CN2 has eight classes including DEL and LUXDEL; CN1 has three and no DEL. */
let cn1: number;
let cn2: number;

const CODE = { CN1: 'TRUONG_DINH_05', CN2: 'LY_TU_TRONG_260' };

async function makeBooking(
  branchId: number | null,
  roomType: string,
  over: Record<string, unknown> = {},
) {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      branchId,
      customerName: 'NGUYEN VAN TEST',
      phone: '0900000001',
      paymentStatus: 'PAY_BEFORE',
      rawText: 'test',
      status: 'NEW',
      sourcePlatform: 'BOOKING_COM',
      checkInDate: utcDate('2026-08-01'),
      checkOutDate: utcDate('2026-08-03'),
      totalAmount: 1_000_000,
      rooms: { create: [{ roomIndex: 1, roomType, roomSubtotal: 1_000_000 }] },
      ...over,
    },
  });
  await applyRoomClassSnapshots(booking.id, testPrisma);
  return booking.id;
}

const roomOf = (bookingId: string, roomIndex = 1) =>
  testPrisma.bookingRoom.findFirstOrThrow({ where: { bookingId, roomIndex } });

/** An active class of a branch, by its PMS code. */
async function classIdOf(branchId: number, pmsCode: string): Promise<string> {
  const mapping = await loadActiveMapping(branchId, testPrisma);
  const found = mapping!.classes.find((c) => c.active && c.pmsCode === pmsCode);
  if (!found) throw new Error(`no active class ${pmsCode} on branch ${branchId}`);
  return found.id;
}

const url = (bookingId: string, roomIndex = 1) =>
  `/api/bookings/${bookingId}/rooms/${roomIndex}/room-class`;

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: CODE.CN1 } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: CODE.CN2 } })).id;
  await createReceptionist(cn2, { username: 'letan', mustChangePassword: false });
  receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

afterEachCleanup();
function afterEachCleanup() {
  beforeEach(async () => {
    await testPrisma.bookingAuditEvent.deleteMany({});
    await testPrisma.bookingRoom.deleteMany({});
    await testPrisma.booking.deleteMany({});
  });
}

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* It persists, and it is what the note is built from                  */
/* ================================================================== */

describe('choosing an internal room class', () => {
  it('stores the chosen class on the booking room as MANUAL', async () => {
    // "Phòng Khác" matches nothing, so nothing was auto-detected.
    const bookingId = await makeBooking(cn2, 'Phòng Khác');
    expect((await roomOf(bookingId)).roomClassPmsCode).toBeNull();

    const res = await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    expect(res.status).toBe(200);
    expect(res.body.room).toMatchObject({ roomIndex: 1, pmsCode: 'DEL', status: 'MANUAL' });

    const room = await roomOf(bookingId);
    expect(room.roomClassPmsCode).toBe('DEL');
    expect(room.roomClassStatus).toBe('MANUAL');
    expect(room.roomClassBranchId).toBe(cn2);
  });

  it('overrides a code the system detected automatically', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');

    await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    const room = await roomOf(bookingId);
    expect(room.roomClassPmsCode).toBe('DEL');
    expect(room.roomClassStatus).toBe('MANUAL');
  });

  it('keeps the OTA room name exactly as it was', async () => {
    // The name the platform printed is evidence, not a working value.
    const bookingId = await makeBooking(cn2, 'Standard Double Room No Window (0)');
    await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    const room = await roomOf(bookingId);
    expect(room.roomType).toBe('Standard Double Room No Window (0)');
    expect(room.roomClassSourceText).toBe('Standard Double Room No Window (0)');
  });

  it('survives the automatic snapshot pass that runs on every save', async () => {
    // The point of MANUAL: routine operations must not undo the decision.
    const bookingId = await makeBooking(cn2, 'Premium');
    await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    await applyRoomClassSnapshots(bookingId, testPrisma);

    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('DEL');
  });

  it('records an audit event naming the old and the new code', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    const events = await testPrisma.bookingAuditEvent.findMany({ where: { bookingId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.field).toBe('room 1');
    expect(events[0]!.oldValue).toContain('LUXDEL');
    expect(events[0]!.newValue).toContain('DEL');
    expect(events[0]!.reason).toContain('chọn thủ công');
    expect(events[0]!.actorRole).toBe('ADMIN');
  });
});

/* ================================================================== */
/* What it refuses                                                     */
/* ================================================================== */

describe('refusals', () => {
  it('refuses a class belonging to a DIFFERENT branch', async () => {
    // CN2 has DEL; CN1 does not. A CN2 class must never land on a CN1 booking.
    const bookingId = await makeBooking(cn1, 'Phòng Khác');
    const res = await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('không thuộc cấu hình');
    expect((await roomOf(bookingId)).roomClassPmsCode).toBeNull();
  });

  it('refuses a class from a superseded mapping version', async () => {
    const bookingId = await makeBooking(cn2, 'Phòng Khác');
    const staleClassId = await classIdOf(cn2, 'DEL');

    // Activate a new version; every class in it gets a new id.
    const base = `/api/admin/branches/${cn2}/room-mapping`;
    const active = await loadActiveMapping(cn2, testPrisma);
    const draft = (await adminAgent.post(`${base}/drafts`).send({})).body.draft;
    await adminAgent
      .post(`${base}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: active!.versionId });

    const res = await adminAgent.put(url(bookingId)).send({ roomClassId: staleClassId });
    expect(res.status).toBe(422);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBeNull();
  });

  it('refuses a booking that has no branch yet', async () => {
    const bookingId = await makeBooking(null, 'Phòng Khác', { status: 'DRAFT' });
    const res = await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('chọn chi nhánh');
  });

  it('refuses a completed booking, whose note is a historical record', async () => {
    const bookingId = await makeBooking(cn2, 'Premium', { status: 'COMPLETED' });
    const res = await adminAgent.put(url(bookingId)).send({ roomClassId: await classIdOf(cn2, 'DEL') });

    expect(res.status).toBe(409);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');
  });

  it('refuses a receptionist', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const res = await receptionistAgent
      .put(url(bookingId))
      .send({ roomClassId: await classIdOf(cn2, 'DEL') });

    expect(res.status).toBe(403);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');
  });

  it('refuses an empty or unknown room class id', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    expect((await adminAgent.put(url(bookingId)).send({ roomClassId: '' })).status).toBe(422);
    expect((await adminAgent.put(url(bookingId)).send({ roomClassId: 'nope' })).status).toBe(422);
    expect((await roomOf(bookingId)).roomClassPmsCode).toBe('LUXDEL');
  });

  it('refuses a room index the booking does not have', async () => {
    const bookingId = await makeBooking(cn2, 'Premium');
    const res = await adminAgent
      .put(url(bookingId, 7))
      .send({ roomClassId: await classIdOf(cn2, 'DEL') });
    expect(res.status).toBe(404);
  });

  it('refuses an unknown booking', async () => {
    const res = await adminAgent
      .put(url('00000000-0000-0000-0000-000000000000'))
      .send({ roomClassId: await classIdOf(cn2, 'DEL') });
    expect(res.status).toBe(404);
  });
});
