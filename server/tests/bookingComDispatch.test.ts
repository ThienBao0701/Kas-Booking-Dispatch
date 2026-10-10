/**
 * BOOKING.COM: the reviewed reservation is created ONCE, at Send.
 *
 * These cases prove the new transactional path in isolation — they do not care
 * whether extraction still persists anything, which is what makes Phase 1
 * verifiable on its own before the extraction endpoint changes underneath it.
 *
 * The two properties worth stating plainly, because everything else follows
 * from them:
 *
 *   ATOMICITY — a dispatch that fails leaves the database exactly as it was.
 *   Not "leaves a draft", not "leaves an orphan room": as it was. The failure
 *   cases below count every table the success case writes to.
 *
 *   THE SERVER DECIDES — the browser supplies values, never rules. Warnings are
 *   re-read from the pasted text, the branch must be active, and a room class
 *   that does not belong to the branch is refused rather than stored.
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
import { loadActiveMapping } from '../src/room/roomClassResolver';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'booking', name), 'utf8');

/** One room, three nights — the ordinary case. */
const ONE_ROOM = fixture('02-vi-one-room-multi-night.txt');
/** "Deluxe Double Room x2" — two PHYSICAL rooms from one printed line. */
const TWO_ROOMS_QTY = fixture('16-qty-x2-per-room-prices.txt');
/** A night with no stated figure, so the review really does raise a warning. */
const INCOMPLETE = fixture('11-missing-one-nightly-price.txt');

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let adminUserId: number;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  const created = await createAdmin({ mustChangePassword: false });
  adminUserId = created.id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.notification.deleteMany({});
  await testPrisma.booking.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* Building a dispatch payload the way the review screen would         */
/* ================================================================== */

interface PreviewRoom {
  roomIndex: number;
  roomName: string | null;
  roomTotal: number | null;
  nights: { stayDate: string; amount: number | null }[];
}

/** The extraction preview — the same data the review screen holds locally. */
async function preview(rawText: string) {
  const res = await admin.post('/api/bookings/extract').send({ rawText, source: 'BOOKING_COM' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
  return res.body as {
    booking: {
      bookingCode: string | null;
      hotelName: string | null;
      guestName: string | null;
      phone: string | null;
      checkIn: string | null;
      checkOut: string | null;
      totalAmount: number | null;
      paymentStatus: 'PAY_BEFORE' | 'PAY_AFTER';
      specialRequest: string | null;
    };
    suggestedBranch: { id: number } | null;
    rooms: PreviewRoom[];
  };
}

/** The branch's active room classes, as the picker would list them. */
async function activeClasses(branchId: number) {
  const mapping = await loadActiveMapping(branchId, testPrisma);
  expect(mapping, `branch ${branchId} has no ACTIVE mapping`).not.toBeNull();
  return mapping!.classes.filter((c) => c.active);
}

/**
 * Assembles the request exactly as the review screen does: preview values, the
 * chosen branch, and one internal room class per room.
 */
async function payloadFrom(rawText: string, overrides: Record<string, unknown> = {}) {
  const p = await preview(rawText);
  /*
    Phase 1 is additive: the extraction endpoint still writes a DRAFT, and the
    call above just made one. Clearing it here keeps these cases measuring the
    DISPATCH path rather than the extraction path they happen to borrow to build
    a realistic payload — the "nothing was written" assertions below would
    otherwise be counting a row this helper created.

    After Phase 2 there is nothing to clear and this becomes a no-op. It is
    deliberately narrow: DRAFT only, so it can never hide a row the dispatch
    itself wrote.
  */
  await testPrisma.booking.deleteMany({ where: { status: 'DRAFT' } });

  const branchId = p.suggestedBranch?.id;
  expect(branchId, 'fixture did not resolve to a branch').toBeDefined();
  const classes = await activeClasses(branchId!);

  return {
    rawText,
    branchId: branchId!,
    hotelName: p.booking.hotelName,
    customerName: p.booking.guestName ?? '',
    phone: p.booking.phone,
    bookingCode: p.booking.bookingCode ?? '',
    checkInDate: p.booking.checkIn,
    checkOutDate: p.booking.checkOut,
    totalAmount: p.booking.totalAmount,
    paymentStatus: p.booking.paymentStatus,
    specialRequest: p.booking.specialRequest,
    rooms: p.rooms.map((room) => ({
      roomIndex: room.roomIndex,
      roomType: room.roomName,
      roomSubtotal: room.roomTotal,
      roomClassId: classes[0]!.id,
      nights: room.nights.map((n) => ({ stayDate: n.stayDate, amount: n.amount })),
    })),
    // The fixtures carry extraction warnings (no phone, missing figures); the
    // review screen surfaces them and the Admin acknowledges them before Send.
    acknowledgedWarningCodes: [
      'MISSING_PHONE',
      'MISSING_TOTAL',
      'NULL_NIGHTLY_PRICE',
      'MISSING_ROOM_TYPE',
      'NIGHTLY_SUBTOTAL_MISMATCH',
      'ROOM_TOTAL_MISMATCH',
      'LOW_CONFIDENCE_BRANCH',
      'UNRESOLVED_EXTRACT_WARNINGS',
    ],
    ...overrides,
  };
}

const dispatch = (body: object) => admin.post('/api/admin/bookings/dispatch').send(body);

/** Everything the success path writes — counted, for the rollback cases. */
async function counts() {
  const [bookings, rooms, nights, history, notifications, warnings] = await Promise.all([
    testPrisma.booking.count(),
    testPrisma.bookingRoom.count(),
    testPrisma.bookingNightPrice.count(),
    testPrisma.bookingStatusHistory.count(),
    testPrisma.notification.count(),
    testPrisma.bookingExtractWarning.count(),
  ]);
  return { bookings, rooms, nights, history, notifications, warnings };
}

/* ================================================================== */
/* Test 7 — a valid review becomes exactly one dispatched booking      */
/* ================================================================== */

describe('Test 7 — Send creates the booking', () => {
  it('creates exactly one Booking, already NEW and already sent', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const res = await dispatch(body);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);

    const bookings = await testPrisma.booking.findMany();
    expect(bookings).toHaveLength(1);
    const booking = bookings[0]!;

    expect(booking.status).toBe('NEW');
    expect(booking.sentAt).not.toBeNull();
    expect(booking.sentByUserId).toBe(adminUserId);
    expect(booking.branchId).toBe(body.branchId);
    expect(booking.sourcePlatform).toBe('BOOKING_COM');
    // Never a draft on the way: no row ever held DRAFT or READY.
    expect(booking.createdByUserId).toBe(adminUserId);
  });

  it('creates the rooms, the nights, the history row and the branch notification', async () => {
    const branchId = (await payloadFrom(ONE_ROOM)).branchId;
    // A receptionist at the branch, so a notification has somewhere to go.
    await createReceptionist(branchId, { username: 'le-tan-cn' });

    const body = await payloadFrom(ONE_ROOM);
    const res = await dispatch(body);
    expect(res.status).toBe(201);
    const id = res.body.booking.id as string;

    const rooms = await testPrisma.bookingRoom.findMany({
      where: { bookingId: id },
      include: { nights: true },
      orderBy: { roomIndex: 'asc' },
    });
    expect(rooms).toHaveLength(body.rooms.length);
    expect(rooms[0]!.nights).toHaveLength(body.rooms[0]!.nights.length);

    const history = await testPrisma.bookingStatusHistory.findMany({ where: { bookingId: id } });
    expect(history).toHaveLength(1);
    // Nothing preceded it — this booking's first state IS NEW.
    expect(history[0]!.oldStatus).toBeNull();
    expect(history[0]!.newStatus).toBe('NEW');
    expect(history[0]!.changedByUserId).toBe(adminUserId);

    const notifications = await testPrisma.notification.findMany({ where: { bookingId: id } });
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('stores each room with the internal code the Admin chose', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const chosen = body.rooms[0]!.roomClassId;
    const res = await dispatch(body);
    expect(res.status).toBe(201);

    const room = await testPrisma.bookingRoom.findFirstOrThrow({
      where: { bookingId: res.body.booking.id as string },
    });
    expect(room.roomClassId).toBe(chosen);
    expect(room.roomClassStatus).toBe('MANUAL');
    expect(room.roomClassPmsCode).not.toBeNull();
    // The snapshot names the branch it was resolved against.
    expect(room.roomClassBranchId).toBe(body.branchId);
  });

  it('refuses a second dispatch of the same reservation to the same branch', async () => {
    // The SHARED duplicate rule: same code + branch + check-in already live.
    const body = await payloadFrom(ONE_ROOM);
    expect((await dispatch(body)).status).toBe(201);

    const second = await dispatch(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_BOOKING');
    expect(await testPrisma.booking.count()).toBe(1);
  });
});

/* ================================================================== */
/* Duplicate detection ignores WITHDRAWN orders                        */
/* ================================================================== */

/**
 * A withdrawn order must not block the same reservation being sent again.
 *
 * THE BUG THIS GUARDS AGAINST. Soft delete writes `deletedAt` and nothing else —
 * the status stays `NEW`. A duplicate lookup that asked only about status
 * therefore matched an order the Admin had just taken back, and told them
 * "Đơn trùng đã tồn tại (NEW)" about a booking that was in no queue, on no
 * screen and in front of no receptionist.
 *
 * The point of the duplicate rule is to stop a branch being asked to create one
 * reservation twice. A withdrawn order asks nobody to create anything, so it
 * cannot be what "twice" means. It stays in the database as history — and
 * history must not block new work.
 *
 * These cases go through the real endpoint and read the database, because the
 * defect was in a Prisma WHERE clause: a pure-helper test would have been
 * written against the same misunderstanding.
 */
describe('a withdrawn booking is not a duplicate', () => {
  /** Sends the reservation and returns the created booking id. */
  async function send(body: object): Promise<string> {
    const res = await dispatch(body);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
    return res.body.booking.id as string;
  }

  /** Withdraws it the way an Admin does — through the endpoint. */
  async function withdraw(id: string): Promise<void> {
    const res = await admin.delete(`/api/admin/bookings/${id}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  }

  it('Case 1 — an ACTIVE match still blocks', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const first = await send(body);

    const second = await dispatch(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_BOOKING');
    expect(second.body.error.details.existingBookingId).toBe(first);

    // Nothing new was created by the refusal.
    expect(await testPrisma.booking.count()).toBe(1);
  });

  it('Case 2 — a WITHDRAWN match does not block', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const first = await send(body);
    await withdraw(first);

    const second = await dispatch(body);
    expect(second.status, JSON.stringify(second.body).slice(0, 400)).toBe(201);

    const bookings = await testPrisma.booking.findMany({ orderBy: { createdAt: 'asc' } });
    expect(bookings).toHaveLength(2);
    // One historical, one live — exactly what withdraw-then-resend should leave.
    expect(bookings.filter((b) => b.deletedAt !== null)).toHaveLength(1);
    expect(bookings.filter((b) => b.deletedAt === null)).toHaveLength(1);
  });

  it('Case 3 — an ACTIVE match blocks even when a WITHDRAWN one also exists', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const withdrawn = await send(body);
    await withdraw(withdrawn);
    const active = await send(body); // allowed: only the withdrawn one existed

    const third = await dispatch(body);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('DUPLICATE_BOOKING');
    // The LIVE booking is named as the duplicate; the withdrawn one is invisible.
    expect(third.body.error.details.existingBookingId).toBe(active);
    expect(third.body.error.details.existingBookingId).not.toBe(withdrawn);

    expect(await testPrisma.booking.count()).toBe(2);
  });

  it('Case 4 — the withdrawn booking is left exactly as it was', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const first = await send(body);
    await withdraw(first);

    const before = await testPrisma.booking.findUniqueOrThrow({ where: { id: first } });
    const second = await send(body);

    // A NEW row, not a revival: `redispatchDeletedBooking` is the only thing
    // that brings a withdrawn order back, and it was not involved here.
    expect(second).not.toBe(first);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: first } });
    expect(after.deletedAt).toEqual(before.deletedAt);
    expect(after.deletedByUserId).toBe(before.deletedByUserId);
    expect(after.status).toBe(before.status);
    expect(after.sentAt).toEqual(before.sentAt);
    expect(after.claimCycle).toBe(before.claimCycle);
    expect(after.verificationStatus).toBe(before.verificationStatus);

    const created = await testPrisma.booking.findUniqueOrThrow({ where: { id: second } });
    expect(created.deletedAt).toBeNull();
    expect(created.status).toBe('NEW');
    expect(created.sentAt).not.toBeNull();
    expect(created.sentByUserId).toBe(adminUserId);
  });

  it('gives the new booking its own rooms, history and notifications', async () => {
    // A resend after withdrawal is a full dispatch, not a pointer at the old one.
    const body = await payloadFrom(ONE_ROOM);
    const first = await send(body);
    await withdraw(first);
    const second = await send(body);

    const rooms = await testPrisma.bookingRoom.findMany({ where: { bookingId: second } });
    expect(rooms).toHaveLength(body.rooms.length);

    const history = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: second },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.oldStatus).toBeNull();
    expect(history[0]!.newStatus).toBe('NEW');

    // And the old booking's own rows are untouched.
    expect(await testPrisma.bookingRoom.count({ where: { bookingId: first } })).toBe(
      body.rooms.length,
    );
  });

  it('still closes the race it was built for: two live sends at once', async () => {
    /*
      `Booking_one_operational_per_code_branch_checkin` exists because the
      application checks with a SELECT and then inserts, so two Admins sending
      the same reservation at the same instant can both find nothing. Narrowing
      that index to live rows must not reopen that race — both racing rows would
      have `deletedAt IS NULL`, so they still collide.

      Asserted by racing the real endpoint, not by reading the index definition.
    */
    const body = await payloadFrom(ONE_ROOM);

    const results = await Promise.all([dispatch(body), dispatch(body), dispatch(body)]);
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(2);
    // Exactly one booking reached the branch, whichever request won.
    expect(await testPrisma.booking.count()).toBe(1);
  });

  it('a COMPLETED order that was withdrawn does not block either', async () => {
    // The rule is about deletion, not about which operational state the order
    // had reached when it was withdrawn.
    const body = await payloadFrom(ONE_ROOM);
    const first = await send(body);
    await testPrisma.booking.update({ where: { id: first }, data: { status: 'COMPLETED' } });
    await withdraw(first);

    const second = await dispatch(body);
    expect(second.status, JSON.stringify(second.body).slice(0, 400)).toBe(201);
    expect(await testPrisma.booking.count()).toBe(2);
  });
});

/* ================================================================== */
/* Test 8 — quantity still becomes physical rooms                      */
/* ================================================================== */

describe('Test 8 — multi-room quantity', () => {
  it('keeps one BookingRoom per physical room, as before', async () => {
    // "Deluxe Double Room x2" is TWO rooms the branch has to create. The
    // Booking.com parser has always expanded this; carrying the review in
    // memory must not quietly collapse it back to one line.
    const body = await payloadFrom(TWO_ROOMS_QTY);
    expect(body.rooms.length).toBeGreaterThan(1);

    const res = await dispatch(body);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);

    const rooms = await testPrisma.bookingRoom.findMany({
      where: { bookingId: res.body.booking.id as string },
      include: { nights: true },
      orderBy: { roomIndex: 'asc' },
    });
    expect(rooms).toHaveLength(body.rooms.length);
    expect(rooms.map((r) => r.roomIndex)).toEqual(body.rooms.map((r) => r.roomIndex));
    // Every room keeps its own nights — no room is left empty.
    for (const room of rooms) expect(room.nights.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* Test 9 — the Admin's edits are what gets stored                     */
/* ================================================================== */

describe('Test 9 — edited values reach the database', () => {
  it('persists the edited name, total, business type and room class', async () => {
    const base = await payloadFrom(ONE_ROOM);
    const classes = await activeClasses(base.branchId);
    // A different class from the one the payload builder picked by default.
    const secondClass = classes[1] ?? classes[0]!;

    const body = {
      ...base,
      customerName: 'Trần Thị Sửa',
      totalAmount: 4_321_000,
      businessType: 'PARTNER' as const,
      rooms: base.rooms.map((room) => ({ ...room, roomClassId: secondClass.id })),
    };

    const res = await dispatch(body);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id as string },
      include: { rooms: true },
    });
    expect(booking.customerName).toBe('Trần Thị Sửa');
    expect(booking.totalAmount).toBe(4_321_000);
    expect(booking.businessType).toBe('PARTNER');
    // Confirmed by a human, recorded exactly as the DRAFT-era endpoint did.
    expect(booking.businessTypeManuallyConfirmed).toBe(true);
    expect(booking.businessTypeConfidence).toBe(100);
    expect(booking.businessTypeDetectionSource).toBe(`manual:${adminUserId}`);
    expect(booking.rooms[0]!.roomClassId).toBe(secondClass.id);
  });

  it('detects the business type when the Admin did not choose one', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const res = await dispatch(body);
    expect(res.status).toBe(201);

    const booking = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id as string },
    });
    expect(booking.businessTypeManuallyConfirmed).toBe(false);
    expect(booking.businessTypeDetectionSource).not.toMatch(/^manual:/);
  });
});

/* ================================================================== */
/* Test 10 — a failed dispatch writes nothing at all                   */
/* ================================================================== */

describe('Test 10 — failure leaves the database untouched', () => {
  it('writes nothing when validation blocks the send', async () => {
    const before = await counts();
    const body = await payloadFrom(ONE_ROOM);

    // Blocking: a booking with no code can never reach a branch.
    const res = await dispatch({ ...body, bookingCode: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.errors.map((e: { code: string }) => e.code)).toContain(
      'MISSING_BOOKING_CODE',
    );

    expect(await counts()).toEqual(before);
  });

  it('writes nothing when a warning was never acknowledged', async () => {
    // A reservation that genuinely warns — this fixture states no nightly
    // figure for one of its nights, which the Admin has to see before sending.
    const before = await counts();
    const body = await payloadFrom(INCOMPLETE);

    const res = await dispatch({ ...body, acknowledgedWarningCodes: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    expect(res.body.error.details.warnings.length).toBeGreaterThan(0);

    expect(await counts()).toEqual(before);
  });

  it('writes nothing when the branch is not a real, active branch', async () => {
    const before = await counts();
    const body = await payloadFrom(ONE_ROOM);

    const res = await dispatch({ ...body, branchId: 99_999 });
    expect(res.status).toBe(422);

    expect(await counts()).toEqual(before);
  });

  it('writes nothing when a room class does not belong to the branch', async () => {
    const before = await counts();
    const body = await payloadFrom(ONE_ROOM);

    const res = await dispatch({
      ...body,
      rooms: body.rooms.map((r) => ({ ...r, roomClassId: 'not-a-real-class-id' })),
    });
    expect(res.status).toBe(422);

    // The point of the whole change: no half-created booking, no orphan room,
    // no orphan notification, and above all no DRAFT left behind as a fallback.
    expect(await counts()).toEqual(before);
  });

  it('leaves nothing behind after several failed attempts in a row', async () => {
    const before = await counts();
    const body = await payloadFrom(ONE_ROOM);

    for (const bad of [
      { ...body, bookingCode: '' },
      { ...body, customerName: '' },
      { ...body, checkInDate: null },
      { ...body, branchId: 99_999 },
    ]) {
      const res = await dispatch(bad);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    expect(await counts()).toEqual(before);
  });
});

/* ================================================================== */
/* Test 6 — an invalid room class is refused, not silently downgraded  */
/* ================================================================== */

describe('Test 6 — room-class validity is decided by the server', () => {
  it("refuses another branch's room class rather than storing UNRESOLVED", async () => {
    const body = await payloadFrom(ONE_ROOM);

    // A class that genuinely exists — at a DIFFERENT branch.
    const otherBranch = await testPrisma.branch.findFirstOrThrow({
      where: { active: true, id: { not: body.branchId } },
    });
    const foreign = (await activeClasses(otherBranch.id))[0]!;

    const res = await dispatch({
      ...body,
      rooms: body.rooms.map((r) => ({ ...r, roomClassId: foreign.id })),
    });
    expect(res.status).toBe(422);
    expect(await testPrisma.booking.count()).toBe(0);
  });

  it('refuses a class that has been deactivated', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const chosen = body.rooms[0]!.roomClassId;
    await testPrisma.branchRoomClass.update({
      where: { id: chosen },
      data: { active: false },
    });

    const res = await dispatch(body);
    expect(res.status).toBe(422);
    expect(await testPrisma.booking.count()).toBe(0);

    await testPrisma.branchRoomClass.update({ where: { id: chosen }, data: { active: true } });
  });

  it('accepts a room whose name the mapping recognises on its own', async () => {
    // No explicit choice: the server resolves from the room name, exactly as
    // the extract-time snapshot used to.
    const body = await payloadFrom(ONE_ROOM);
    const classes = await activeClasses(body.branchId);
    const named = classes[0]!;

    const res = await dispatch({
      ...body,
      rooms: body.rooms.map((r) => ({
        ...r,
        roomType: named.displayName,
        roomClassId: null,
      })),
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);

    const room = await testPrisma.bookingRoom.findFirstOrThrow({
      where: { bookingId: res.body.booking.id as string },
    });
    expect(room.roomClassId).toBe(named.id);
    expect(room.roomClassStatus).toBe('RESOLVED');
  });

  it('refuses a room the mapping cannot recognise and that names no class', async () => {
    // Reception cannot act on an order whose PMS code is unknown, so it never
    // leaves. The review screen already blocks this; the server agrees.
    const body = await payloadFrom(ONE_ROOM);
    const res = await dispatch({
      ...body,
      rooms: body.rooms.map((r) => ({
        ...r,
        roomType: 'Một hạng phòng không tồn tại',
        roomClassId: null,
      })),
    });
    expect(res.status).toBe(422);
    expect(await testPrisma.booking.count()).toBe(0);
  });
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('who may dispatch', () => {
  it('is refused to a receptionist', async () => {
    const body = await payloadFrom(ONE_ROOM);
    await createReceptionist(body.branchId, { username: 'le-tan-2' });
    const { agent } = await loginAgent(app, 'le-tan-2', RECEPTIONIST_PASSWORD);

    const res = await agent.post('/api/admin/bookings/dispatch').send(body);
    expect(res.status).toBe(403);
    expect(await testPrisma.booking.count()).toBe(0);
  });

  it('is refused without a session', async () => {
    const body = await payloadFrom(ONE_ROOM);
    const res = await (await import('supertest')).default(app)
      .post('/api/admin/bookings/dispatch')
      .send(body);
    expect(res.status).toBe(401);
    expect(await testPrisma.booking.count()).toBe(0);
  });
});
