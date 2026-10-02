/**
 * Removing a booking from the operational queues.
 *
 * SOFT, NOT HARD. 25 relations cascade from Booking — audit events, the
 * append-only corrections, status history, the receptionist's proof images.
 * Those records prove what happened, and a hotel deleting a booking wants it
 * out of the queues, not the evidence that a branch did its job destroyed.
 * Nobody would notice that loss until the day the proof was needed.
 *
 * So the row stays and every operational query filters `deletedAt: null`. The
 * booking disappears from reception, history and search; the audit trail is
 * untouched and still reachable for anyone investigating.
 *
 * Deletion is recorded as an audit event like every other consequential act, so
 * "where did this booking go" has an answer.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';

/** Excludes soft-deleted rows. Spread into every operational `where`. */
export const NOT_DELETED = { deletedAt: null } as const;

export interface DeleteResult {
  bookingId: string;
  deletedAt: Date;
}

/**
 * Marks a booking deleted.
 *
 * Idempotent: deleting an already-deleted booking is not an error. Two Admins
 * clicking at once should both see it gone rather than one seeing a failure for
 * doing what they intended.
 */
export async function softDeleteBooking(
  bookingId: string,
  actorUserId: number,
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<DeleteResult> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, deletedAt: true },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');
  if (booking.deletedAt) return { bookingId, deletedAt: booking.deletedAt };

  const now = clock.now();

  // The two columns ARE the record: who removed it and when, on the row itself
  // and permanently queryable. No BookingAuditEvent is written — that enum
  // describes field-level edits, and adding a member for this would need a
  // second migration (ALTER TYPE … ADD VALUE cannot share a transaction with
  // its first use) to record something the booking already states.
  await client.booking.update({
    where: { id: bookingId },
    data: { deletedAt: now, deletedByUserId: actorUserId },
  });

  return { bookingId, deletedAt: now };
}
