/**
 * Dispatching a reviewed BOOKING.COM reservation to its branch.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Booking.com used to persist a DRAFT the instant an Admin pressed "Trích xuất",
 * long before anyone decided the order was worth sending. Every abandoned paste,
 * every re-extraction, every closed tab left a row behind, and the review screen
 * was really an editor for a database record that reception could not see but
 * that dashboards, duplicate checks and cleanup scripts all had to reason about.
 *
 * The reservation is now reviewed in the browser and written ONCE, here, at the
 * moment the Admin sends it. Nothing exists until then.
 *
 * ── THIS IS THE SAME SHAPE THE OTA PATH ALREADY USES ──────────────────────
 * `otaDispatch.ts` does exactly this for Agoda and CTrip: review in memory,
 * then one transaction that creates a booking already in NEW. This is that
 * design applied to the third platform, deliberately NOT a new architecture —
 * same table, same status machine, same status history, same notifications, so
 * everything downstream (reception, CẮT, claim, proof, dashboards) keeps working
 * without knowing which platform a booking came from.
 *
 * ── NOTHING THE BROWSER SENDS IS TRUSTED ──────────────────────────────────
 * The Admin's edits are accepted as VALUES — they are the point of the review —
 * but every RULE is re-derived here from the pasted text and the database:
 *
 *   · extraction warnings come from re-parsing `rawText`, not from the client,
 *     so a browser cannot make a flagged booking look clean by omitting them;
 *   · the branch must be active;
 *   · room classes are resolved against the branch's ACTIVE mapping, and an id
 *     that does not belong to it is refused rather than stored;
 *   · `validateBooking(..., 'send')` — the SAME function the legacy send path
 *     uses — decides whether it may go at all;
 *   · the duplicate rule is the one shared with `sendBooking`, not a second
 *     implementation that could drift from it.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, isLastMinute, type Clock } from '../lib/clock';
import { isoToUtcDate } from './dates';
import { parseBooking } from './parser';
import { loadBranchConfigs } from './branchConfig';
import { detectBusinessType } from './businessType';
import { validateBooking, type ValidationResult } from './validation';
import { createBranchNotifications, findOperationalDuplicate } from './dispatch';
import { loadActiveMapping, resolveRoomClass, toSnapshot } from '../room/roomClassResolver';
import type { BranchRoomMapping } from '../room/roomClassResolver';

/** The Admin performing the dispatch. */
export interface BookingComDispatchActor {
  id: number;
  fullName: string;
}

/** One night of one room, as the review screen holds it. */
export interface BookingComDispatchNight {
  /** ISO "YYYY-MM-DD". */
  stayDate: string;
  /** Whole VND, or null when the Admin left it blank. */
  amount: number | null;
}

/** One room line of the reviewed reservation. */
export interface BookingComDispatchRoom {
  roomIndex: number;
  /** The name Booking.com printed, as the Admin left it. */
  roomType: string | null;
  roomSubtotal: number | null;
  /**
   * The internal class the Admin picked, when they picked one.
   *
   * Null means "let the server resolve it from the room name" — the same
   * automatic match the old extract-time snapshot performed, just deferred to
   * the moment the branch is finally known.
   */
  roomClassId: string | null;
  nights: BookingComDispatchNight[];
}

/**
 * Everything needed to create the final booking, in one request.
 *
 * `rawText` is not decoration: it is stored as the provenance of the booking and
 * re-parsed here so the server's own warnings — not the browser's copy of them —
 * are what validation sees.
 */
export interface BookingComDispatchRequest {
  rawText: string;
  branchId: number;
  hotelName: string | null;
  customerName: string;
  phone: string | null;
  bookingCode: string;
  /** ISO "YYYY-MM-DD" or null. */
  checkInDate: string | null;
  checkOutDate: string | null;
  totalAmount: number | null;
  paymentStatus: 'PAY_BEFORE' | 'PAY_AFTER';
  specialRequest: string | null;
  rooms: BookingComDispatchRoom[];
  /** Present only when the Admin explicitly chose the type on the review screen. */
  businessType?: 'DIRECT' | 'PARTNER';
  acknowledgedWarningCodes: string[];
}

export interface BookingComDispatchResult {
  bookingId: string;
}

/** Blocking validation errors -> a 422 carrying the full {valid,errors,warnings}. */
function assertNoBlockingErrors(result: ValidationResult): void {
  if (!result.valid) {
    throw ApiError.bookingNotReady('Đơn chưa hợp lệ để gửi.', {
      valid: false,
      errors: result.errors,
      warnings: result.warnings,
    });
  }
}

/**
 * Resolves one room against the branch's active mapping, refusing an explicit
 * choice the mapping does not recognise.
 *
 * The refusal is the point. `resolveRoomClass` answers a cross-branch or
 * inactive id with UNRESOLVED, which is the right answer for TEXT matching — it
 * simply could not read the name. But when an Admin (or a hand-made request)
 * NAMES a class, silently storing "unresolved" would dispatch a booking whose
 * PMS note falls back to the legacy keyword abbreviation while the screen
 * reported a successful selection. Say no instead.
 */
function resolveRoomOrThrow(
  room: BookingComDispatchRoom,
  branchId: number,
  mapping: BranchRoomMapping | null,
) {
  const resolution = resolveRoomClass(
    {
      branchId,
      sourceRoomName: room.roomType,
      explicitRoomClassId: room.roomClassId ?? null,
    },
    mapping,
  );

  if (room.roomClassId && resolution.status !== 'MANUAL') {
    throw ApiError.validation(
      `Phòng ${room.roomIndex}: hạng phòng đã chọn không thuộc cấu hình đang áp dụng của chi nhánh này.`,
    );
  }

  /*
    Every room must carry an internal code before the order reaches a branch.

    The note a receptionist pastes into the hotel system is generated from this
    snapshot; without it the note silently falls back to a keyword abbreviation
    that is not the branch's real PMS code. The review screen already refuses to
    send in this state, so this blocks nothing an operator can legitimately do —
    it closes the gap where a request that skipped the screen could.
  */
  if (resolution.roomClassId === null) {
    throw ApiError.validation(
      `Phòng ${room.roomIndex}: chưa gán mã hạng phòng nội bộ cho chi nhánh này.`,
    );
  }

  return resolution;
}

/**
 * Creates the reviewed Booking.com reservation as a dispatched booking.
 *
 * The whole write is one transaction: booking, rooms, nightly prices, warnings,
 * room-class snapshots, status history and notifications either all land or none
 * do. There is deliberately no "create a draft, try to send, delete on failure"
 * fallback — a failed dispatch must leave the database exactly as it was.
 */
export async function dispatchBookingComReview(
  request: BookingComDispatchRequest,
  actor: BookingComDispatchActor,
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<BookingComDispatchResult> {
  const branch = await client.branch.findUnique({ where: { id: request.branchId } });
  if (!branch || !branch.active) {
    throw ApiError.validation('Chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
  }

  // Re-derived, never accepted: the warnings validation reasons about are the
  // ones THIS server reads out of the pasted text.
  const branches = await loadBranchConfigs(client);
  const parsed = parseBooking(request.rawText, branches, 'BOOKING_COM');

  const checkInDate = request.checkInDate ? isoToUtcDate(request.checkInDate) : null;
  const checkOutDate = request.checkOutDate ? isoToUtcDate(request.checkOutDate) : null;

  /*
    The reviewed reservation as a plain object, shaped for the SHARED validator.

    `status: 'DRAFT'` is what this booking would have been a moment ago under the
    old lifecycle — it is the "not yet sent" input the 'send' intent expects, and
    saying NEW here would trip the validator's own ALREADY_SENT guard. No row
    holds this status: it exists for the length of this call.
  */
  const candidate = {
    status: 'DRAFT',
    branchId: request.branchId,
    bookingCode: request.bookingCode,
    customerName: request.customerName,
    phone: request.phone,
    checkInDate,
    checkOutDate,
    totalAmount: request.totalAmount,
    rooms: request.rooms.map((room) => ({
      roomIndex: room.roomIndex,
      roomType: room.roomType,
      roomSubtotal: room.roomSubtotal,
      nights: room.nights.map((night) => ({
        stayDate: isoToUtcDate(night.stayDate),
        amount: night.amount,
      })),
    })),
    warnings: parsed.warnings.map((w) => ({ code: w.code })),
  };

  const result = validateBooking(candidate, 'send');
  assertNoBlockingErrors(result);

  // Same rule as the legacy send: a warning must be seen before it is passed.
  const acknowledged = new Set(request.acknowledgedWarningCodes);
  const unacknowledged = result.warnings.filter((w) => !acknowledged.has(w.code));
  if (unacknowledged.length > 0) {
    throw ApiError.warningsNotAcknowledged('Vui lòng xác nhận các cảnh báo trước khi gửi.', {
      valid: true,
      errors: [],
      warnings: unacknowledged,
    });
  }

  // The SHARED duplicate rule — see `findOperationalDuplicate`.
  const duplicate = await findOperationalDuplicate(
    {
      bookingCode: request.bookingCode,
      branchId: request.branchId,
      checkInDate,
    },
    client,
  );
  if (duplicate) {
    throw ApiError.duplicateBooking('Đã tồn tại một đơn vận hành trùng khớp.', {
      existingBookingId: duplicate.id,
      existingStatus: duplicate.status,
    });
  }

  /*
    Room classes are resolved BEFORE the transaction opens.

    Loading the branch's mapping is a read, and an id the mapping rejects should
    fail the request outright rather than roll back a write that had already
    begun. What goes inside the transaction is the resulting snapshot columns —
    values, not lookups.
  */
  const mapping = await loadActiveMapping(request.branchId, client);
  const now = clock.now();
  const resolvedRooms = request.rooms.map((room) => ({
    room,
    snapshot: toSnapshot(resolveRoomOrThrow(room, request.branchId, mapping), now),
  }));

  /*
    Business type: detected deterministically from the pasted text, overridden by
    the Admin's explicit choice exactly as `confirmBusinessType` does — same
    fields, same `manual:<id>` source, same 100% confidence. One rule, expressed
    once, whether it is decided before or after the booking exists.
  */
  const detected = detectBusinessType({
    rawText: request.rawText,
    roomType: request.rooms[0]?.roomType ?? null,
    specialRequest: request.specialRequest,
  });
  const business = request.businessType
    ? {
        businessType: request.businessType,
        businessTypeConfidence: 100,
        businessTypeDetectionSource: `manual:${actor.id}`,
        businessTypeManuallyConfirmed: true,
      }
    : {
        businessType: detected.type,
        businessTypeConfidence: detected.confidence,
        businessTypeDetectionSource: detected.detectionSource,
        businessTypeManuallyConfirmed: false,
      };

  const lastMinute = isLastMinute(checkInDate, now);

  const bookingId = await client.$transaction(async (tx) => {
    const booking = await tx.booking.create({
      data: {
        bookingCode: request.bookingCode,
        hotelName: request.hotelName,
        branchId: request.branchId,
        sourcePlatform: 'BOOKING_COM',
        ...business,
        customerName: request.customerName,
        phone: request.phone,
        checkInDate,
        checkOutDate,
        totalAmount: request.totalAmount,
        currency: parsed.currency,
        paymentStatus: request.paymentStatus,
        specialRequest: request.specialRequest,
        rawText: request.rawText,
        // Dispatched in one step: the review happened in the browser, so there
        // is no draft for an Admin to come back to.
        status: 'NEW',
        isLastMinute: lastMinute,
        sentAt: now,
        sentByUserId: actor.id,
        createdByUserId: actor.id,
        parserVersion: parsed.parserVersion,
        rooms: {
          create: resolvedRooms.map(({ room, snapshot }) => ({
            roomIndex: room.roomIndex,
            roomType: room.roomType,
            roomSubtotal: room.roomSubtotal,
            // Written WITH the room, in the same transaction. Under the old
            // lifecycle the snapshot was a second write that was allowed to fail
            // silently; a booking that reaches a branch without its codes is not
            // a booking reception can act on, so here it is part of the create.
            ...snapshot,
            nights: {
              create: room.nights.map((night) => ({
                stayDate: isoToUtcDate(night.stayDate),
                amount: night.amount,
                currency: parsed.currency,
                // The Booking.com engine never estimates money.
                isEstimated: false,
              })),
            },
          })),
        },
        // The server's own reading of the pasted text, stored with the booking
        // so the reasons an Admin acknowledged remain visible after dispatch.
        warnings: {
          create: parsed.warnings.map((warning) => ({
            code: warning.code,
            message: warning.message,
            severity: warning.severity,
          })),
        },
      },
    });

    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        // Nothing preceded it: this booking's first state is NEW.
        oldStatus: null,
        newStatus: 'NEW',
        changedByUserId: actor.id,
        changedAt: now,
        note: `Gửi tới chi nhánh ${branch.hotelName}`,
      },
    });

    await createBranchNotifications(tx, {
      bookingId: booking.id,
      branchId: request.branchId,
      customerName: request.customerName,
      checkInDate,
      lastMinute,
    });

    return booking.id;
  });

  return { bookingId };
}
