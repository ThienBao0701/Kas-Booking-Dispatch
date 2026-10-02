import type { BookingSource, Prisma } from '@prisma/client';
import type { BranchConfig } from './branchConfig';
import type { ParsedBooking } from './types';

/** A stored booking loaded with everything the preview needs. */
export type BookingWithExtractRelations = Prisma.BookingGetPayload<{
  include: {
    branch: true;
    rooms: { include: { nights: true } };
    warnings: true;
  };
}>;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Serialises a stored booking into the structured extraction preview the
 * frontend consumes. Field names follow the Phase 4A contract (guestName,
 * roomName, roomTotal, isEstimated) regardless of the underlying column names.
 */
export function serializeBookingPreview(booking: BookingWithExtractRelations) {
  const rooms = [...booking.rooms]
    .sort((a, b) => a.roomIndex - b.roomIndex)
    .map((room) => ({
      id: room.id,
      roomIndex: room.roomIndex,
      roomName: room.roomType,
      roomTotal: room.roomSubtotal,
      nights: [...room.nights]
        .sort((a, b) => a.stayDate.getTime() - b.stayDate.getTime())
        .map((night) => ({
          id: night.id,
          stayDate: isoDate(night.stayDate),
          amount: night.amount,
          currency: night.currency,
          isEstimated: night.isEstimated,
        })),
    }));

  return {
    booking: {
      id: booking.id,
      bookingCode: booking.bookingCode.length > 0 ? booking.bookingCode : null,
      hotelName: booking.hotelName,
      // The intake platform, echoed back so the review screen shows which
      // source the Admin actually extracted from — never inferred client-side.
      sourcePlatform: booking.sourcePlatform,
      businessType: booking.businessType,
      businessTypeConfidence: booking.businessTypeConfidence,
      businessTypeManuallyConfirmed: booking.businessTypeManuallyConfirmed,
      guestName: booking.customerName.length > 0 ? booking.customerName : null,
      phone: booking.phone,
      checkIn: booking.checkInDate ? isoDate(booking.checkInDate) : null,
      checkOut: booking.checkOutDate ? isoDate(booking.checkOutDate) : null,
      currency: booking.currency,
      totalAmount: booking.totalAmount,
      paymentStatus: booking.paymentStatus,
      specialRequest: booking.specialRequest,
      status: booking.status,
      parserVersion: booking.parserVersion,
      createdAt: booking.createdAt.toISOString(),
    },
    suggestedBranch: booking.branch
      ? {
          id: booking.branch.id,
          code: booking.branch.code,
          hotelName: booking.branch.hotelName,
          address: booking.branch.address,
          branchNumber: booking.branch.branchNumber,
        }
      : null,
    rooms,
    warnings: booking.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      severity: warning.severity,
    })),
  };
}

/**
 * The same preview, built straight from the PARSE — with nothing stored.
 *
 * ── WHY THIS EXISTS BESIDE `serializeBookingPreview` ──────────────────────
 * A Booking.com extraction used to be written to the database before it was
 * shown to anyone, so the preview could be read back out of the row. Nothing is
 * written now: the reservation is reviewed in the browser and created once, at
 * Send. This produces the identical shape from the parsed structure instead.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 * `id`, `status` and `createdAt` — on the booking, its rooms and their nights.
 * Not omitted for tidiness: there IS no booking, and inventing a placeholder id
 * for one would hand the review screen something that looks addressable and
 * isn't. `persisted: false` says so outright, so a caller reading this response
 * cannot mistake it for a record.
 *
 * Rooms are keyed by `roomIndex`, which the parser already assigns and which is
 * exactly what the dispatch payload sends back.
 *
 * The business type is NOT included here; the extract route adds it from
 * `detectBusinessType`, the same call the dispatch re-runs. One detector, and
 * this stays a pure projection of the parse.
 */
export function serializeParsedPreview(
  parsed: ParsedBooking,
  sourcePlatform: BookingSource,
  branches: readonly BranchConfig[],
) {
  const suggested = parsed.suggestedBranch;
  const branchNumber = suggested
    ? (branches.find((b) => b.id === suggested.id)?.branchNumber ?? 0)
    : 0;

  return {
    persisted: false as const,
    booking: {
      bookingCode: parsed.bookingCode,
      hotelName: parsed.hotelName,
      sourcePlatform,
      guestName: parsed.guestName,
      phone: parsed.phone,
      checkIn: parsed.checkIn,
      checkOut: parsed.checkOut,
      currency: parsed.currency,
      totalAmount: parsed.totalAmount,
      paymentStatus: parsed.paymentStatus,
      specialRequest: parsed.specialRequest,
      parserVersion: parsed.parserVersion,
    },
    /*
      The candidate branch, whether or not the match was confident enough to
      preselect. The old path could only surface a branch it had already written
      to the row, so a low-confidence candidate had to be re-attached afterwards;
      here it is simply reported, and `branchConfident` says how much to trust it.
    */
    suggestedBranch: suggested
      ? {
          id: suggested.id,
          code: suggested.code,
          hotelName: suggested.hotelName,
          address: suggested.address,
          branchNumber,
        }
      : null,
    rooms: [...parsed.rooms]
      .sort((a, b) => a.roomIndex - b.roomIndex)
      .map((room) => ({
        roomIndex: room.roomIndex,
        roomName: room.roomName,
        roomTotal: room.roomTotal,
        nights: [...room.nights]
          .sort((a, b) => a.stayDate.localeCompare(b.stayDate))
          .map((night) => ({
            stayDate: night.stayDate,
            amount: night.amount,
            currency: night.currency,
            isEstimated: night.isEstimated,
          })),
      })),
    warnings: parsed.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      severity: warning.severity,
    })),
  };
}
