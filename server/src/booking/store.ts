import type { BookingSource, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { isoToUtcDate } from './dates';
import { detectBusinessType } from './businessType';
import { applyRoomClassSnapshots } from '../room/roomSnapshotService';
import type { ParsedBooking } from './types';

/** Prisma transaction client (the callback argument of `$transaction`). */
type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Persists a parsed booking as a DRAFT, together with its rooms, generated
 * night prices and extraction warnings — atomically. Everything is written
 * inside a single interactive transaction so a failure can never leave a
 * half-written booking (a booking without its rooms/nights/warnings) behind.
 * Returns the new booking id.
 *
 * Field mapping to the existing schema: guestName -> customerName,
 * roomName -> roomType, roomTotal -> roomSubtotal, night.roomId -> bookingRoomId.
 * Required columns (bookingCode, customerName) fall back to "" when absent so a
 * partial draft can still be stored; the warnings flag what is missing.
 *
 * Branch safety: the branch is auto-assigned only when the match is confident.
 * A low-confidence candidate is surfaced in the preview but never written to
 * `branchId`, so the admin must confirm it before dispatch.
 *
 * Duplicate policy: re-extracting the same confirmation code replaces the
 * previous DRAFT for that code (cascading to its rooms/nights/warnings) rather
 * than piling up unbounded duplicate drafts on retry. Bookings already advanced
 * past DRAFT are never touched.
 */
export async function persistDraftBooking(
  parsed: ParsedBooking,
  rawText: string,
  createdByUserId: number | null,
  sourcePlatform: BookingSource = 'BOOKING_COM',
  client: PrismaClient = defaultPrisma,
): Promise<string> {
  const branchId = parsed.branchConfident ? (parsed.suggestedBranch?.id ?? null) : null;
  const bookingCode = parsed.bookingCode ?? '';

  // Deterministic business-type detection (never uses phone, OTA source or AI).
  const detected = detectBusinessType({
    rawText,
    roomType: parsed.rooms[0]?.roomName ?? null,
    specialRequest: parsed.specialRequest,
  });

  return client.$transaction(async (tx: TxClient) => {
    if (bookingCode.length > 0) {
      await tx.booking.deleteMany({ where: { bookingCode, status: 'DRAFT' } });
    }

    const booking = await tx.booking.create({
      data: {
        bookingCode,
        hotelName: parsed.hotelName,
        branchId,
        sourcePlatform,
        businessType: detected.type,
        businessTypeConfidence: detected.confidence,
        businessTypeDetectionSource: detected.detectionSource,
        businessTypeManuallyConfirmed: false,
        customerName: parsed.guestName ?? '',
        phone: parsed.phone,
        checkInDate: parsed.checkIn ? isoToUtcDate(parsed.checkIn) : null,
        checkOutDate: parsed.checkOut ? isoToUtcDate(parsed.checkOut) : null,
        totalAmount: parsed.totalAmount,
        currency: parsed.currency,
        paymentStatus: parsed.paymentStatus,
        specialRequest: parsed.specialRequest,
        rawText,
        status: 'DRAFT',
        parserVersion: parsed.parserVersion,
        createdByUserId,
        rooms: {
          create: parsed.rooms.map((room) => ({
            roomIndex: room.roomIndex,
            roomType: room.roomName,
            roomSubtotal: room.roomTotal,
            nights: {
              create: room.nights.map((night) => ({
                stayDate: isoToUtcDate(night.stayDate),
                amount: night.amount,
                currency: night.currency,
                isEstimated: night.isEstimated,
              })),
            },
          })),
        },
        warnings: {
          create: parsed.warnings.map((warning) => ({
            code: warning.code,
            message: warning.message,
            severity: warning.severity,
          })),
        },
      },
    });

    return booking.id;
  });
}

/**
 * Captures each room's branch-specific room-class snapshot.
 *
 * Deliberately called AFTER the booking transaction rather than inside it: the
 * snapshot is advisory metadata, so a resolver problem must never roll back a
 * successfully extracted booking. A room left unresolved here is simply
 * resolved later — when the Admin assigns the branch, or explicitly.
 */
export async function snapshotRoomClasses(
  bookingId: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    await applyRoomClassSnapshots(bookingId, client);
  } catch {
    // Never block extraction on room-class resolution.
  }
}
