/**
 * THE ARCHIVE RULE FOR "GIAO NHẬN HÀNG HÓA" — one constant and one predicate.
 *
 * A delivery is recorded as "Đã hoàn thành" and stays in the ACTIVE list for
 * twelve hours; after that it is shown under "Hoàn thành vấn đề".
 *
 * THIS IS DERIVED FROM THE CLOCK ON EVERY READ, NEVER STORED. There is no
 * `archived` column and no job that flips one: a status kept beside a timestamp
 * is a second answer to "how old is this?", and the two would disagree the first
 * time the job was late or the clock moved. Every screen and every API that asks
 * "is it archived?" goes through `isArchived`, so the rule is stated exactly once.
 */
import type { Prisma } from '@prisma/client';

/** How long a completed delivery stays in the active list. */
export const HOTEL_DELIVERY_ARCHIVE_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

/** The instant at or before which a completion counts as archived. */
export function archiveCutoff(now: Date): Date {
  return new Date(now.getTime() - HOTEL_DELIVERY_ARCHIVE_HOURS * HOUR_MS);
}

/** True once `HOTEL_DELIVERY_ARCHIVE_HOURS` have passed since `completedAt`. */
export function isArchived(completedAt: Date, now: Date): boolean {
  return completedAt.getTime() <= archiveCutoff(now).getTime();
}

/** The `where` fragment for one side of the split — the same boundary as `isArchived`. */
export function lifecycleWhere(
  scope: 'active' | 'archived',
  now: Date,
): Prisma.HotelDeliveryReportWhereInput {
  const cutoff = archiveCutoff(now);
  return scope === 'archived' ? { completedAt: { lte: cutoff } } : { completedAt: { gt: cutoff } };
}
