/**
 * Operational statistics, computed only from data the system actually holds.
 *
 * ── WHAT IS DELIBERATELY NOT COMPUTED ─────────────────────────────────────
 * Two industry metrics are returned as null with a reason rather than
 * fabricated, because the inputs genuinely do not exist:
 *
 *   OCCUPANCY and REVPAR need available room-nights — how many rooms the hotel
 *   HAS. Nothing stores that. `BranchRoomClass` is a catalogue of room TYPES,
 *   not an inventory count, and inferring a room count from it (or from
 *   mappings, or aliases) would invent a denominator and make every derived
 *   percentage wrong in a way nobody could see.
 *
 *   ADR in its industry sense is revenue per ROOM-night, which needs the number
 *   of rooms on each booking. `BookingRoom` stores one row per room LINE and no
 *   quantity: for Booking.com that happens to equal the room count, because the
 *   extractor expands "No. of Rooms" into one row each — but an OTA booking
 *   stores one row per room TYPE, so a line for three Deluxe rooms is a single
 *   row. Counting rows would therefore be right for one source and silently
 *   wrong for the other. What IS exactly computable is revenue per STAY-night,
 *   which is reported under its own honest name.
 *
 * Everything else here is derived from stored, verified values.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';

/** Why a metric could not be computed. Shown to the operator verbatim. */
export const NO_ROOM_INVENTORY = 'Room inventory not configured.';
export const NO_ROOM_QUANTITY = 'Room quantity is not stored per room line.';

/** A metric that may legitimately have no value. */
export interface Unavailable {
  value: null;
  reason: string;
}

export interface StatisticsRange {
  /** ISO "YYYY-MM-DD", inclusive. */
  from: string;
  /** ISO "YYYY-MM-DD", inclusive. */
  to: string;
}

export interface Breakdown {
  key: string;
  label: string;
  bookings: number;
  revenue: number;
  /** Share of counted bookings, 0–100 with one decimal. */
  share: number;
}

export interface BookingStatistics {
  range: StatisticsRange;

  /** Bookings that count toward revenue: dispatched, not cancelled, not no-show. */
  bookingCount: number;
  /** Sum of the branch price. What the hotels are owed, not what guests paid. */
  revenue: number;
  /** Total nights across counted bookings. */
  stayNights: number;
  /** revenue ÷ stayNights. Revenue per stay-night — NOT per room-night. */
  averageRevenuePerStayNight: number | null;
  /** stayNights ÷ bookingCount. */
  averageStayNights: number | null;

  /** Industry ADR (per room-night). Not derivable — see the module comment. */
  adr: Unavailable;
  occupancy: Unavailable;
  revPar: Unavailable;

  cancelledCount: number;
  noShowCount: number;
  /** Of every dispatched booking in range, the share cancelled / no-showed. */
  cancellationRate: number | null;
  noShowRate: number | null;

  byOta: Breakdown[];
  byBranch: Breakdown[];
}

/** Statuses whose revenue is real: the stay happened or is going to. */
const REVENUE_STATES = ['NEW', 'RECEIVED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED', 'ARCHIVED'] as const;
/** Every state a DISPATCHED booking can hold, including the failed ones. */
const DISPATCHED_STATES = [...REVENUE_STATES, 'CANCELLED', 'NO_SHOW'] as const;

const OTA_LABEL: Record<string, string> = {
  BOOKING_COM: 'Booking.com',
  AGODA: 'Agoda',
  CTRIP: 'CTrip',
};

function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function dayAfter(iso: string): Date {
  const d = dayStart(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Whole nights between two dates, or 0 when either is missing or inverted. */
function nightsOf(checkIn: Date | null, checkOut: Date | null): number {
  if (!checkIn || !checkOut) return 0;
  const diff = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
  return diff > 0 ? diff : 0;
}

/** One decimal, so a share reads as 12.5 rather than 12.499999999. */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** A percentage, or null when there is nothing to divide by. */
function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : round1((part / whole) * 100);
}

export interface StatisticsOptions {
  from: string;
  to: string;
  /** Restrict to one branch. A receptionist is always scoped by the caller. */
  branchId?: number;
}

/**
 * Computes the statistics for a date range, by DISPATCH date.
 *
 * Dispatch date rather than stay date: an operator asking "how did last month
 * go" means the bookings taken then. A stay-based figure would move as guests
 * arrive and is a different question, deliberately not answered here.
 */
export async function computeStatistics(
  options: StatisticsOptions,
  client: PrismaClient = defaultPrisma,
): Promise<BookingStatistics> {
  const sentAt = { gte: dayStart(options.from), lt: dayAfter(options.to) };
  const scope = options.branchId === undefined ? {} : { branchId: options.branchId };

  const bookings = await client.booking.findMany({
    where: { ...scope, sentAt, status: { in: [...DISPATCHED_STATES] } },
    select: {
      status: true,
      sourcePlatform: true,
      branchId: true,
      totalAmount: true,
      checkInDate: true,
      checkOutDate: true,
      branch: { select: { code: true, hotelName: true } },
    },
  });

  const counted = bookings.filter((b) => (REVENUE_STATES as readonly string[]).includes(b.status));
  const revenue = counted.reduce((sum, b) => sum + (b.totalAmount ?? 0), 0);
  const stayNights = counted.reduce((sum, b) => sum + nightsOf(b.checkInDate, b.checkOutDate), 0);

  const cancelledCount = bookings.filter((b) => b.status === 'CANCELLED').length;
  const noShowCount = bookings.filter((b) => b.status === 'NO_SHOW').length;

  /** Groups the counted bookings, keeping revenue and share together. */
  const group = (
    keyOf: (b: (typeof counted)[number]) => string | null,
    labelOf: (b: (typeof counted)[number]) => string,
  ): Breakdown[] => {
    const acc = new Map<string, { label: string; bookings: number; revenue: number }>();
    for (const b of counted) {
      const key = keyOf(b);
      if (key === null) continue;
      const row = acc.get(key) ?? { label: labelOf(b), bookings: 0, revenue: 0 };
      row.bookings += 1;
      row.revenue += b.totalAmount ?? 0;
      acc.set(key, row);
    }
    return [...acc.entries()]
      .map(([key, row]) => ({
        key,
        label: row.label,
        bookings: row.bookings,
        revenue: row.revenue,
        share: counted.length === 0 ? 0 : round1((row.bookings / counted.length) * 100),
      }))
      .sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key));
  };

  return {
    range: { from: options.from, to: options.to },

    bookingCount: counted.length,
    revenue,
    stayNights,
    averageRevenuePerStayNight: stayNights === 0 ? null : Math.round(revenue / stayNights),
    averageStayNights: counted.length === 0 ? null : round1(stayNights / counted.length),

    // Honest absences, not zeros. A zero here would read as "no occupancy".
    adr: { value: null, reason: NO_ROOM_QUANTITY },
    occupancy: { value: null, reason: NO_ROOM_INVENTORY },
    revPar: { value: null, reason: NO_ROOM_INVENTORY },

    cancelledCount,
    noShowCount,
    // Against every DISPATCHED booking, so the denominator includes the
    // cancellations themselves — otherwise the rate could exceed 100%.
    cancellationRate: rate(cancelledCount, bookings.length),
    noShowRate: rate(noShowCount, bookings.length),

    byOta: group(
      (b) => b.sourcePlatform,
      (b) => OTA_LABEL[b.sourcePlatform] ?? b.sourcePlatform,
    ),
    byBranch: group(
      (b) => (b.branchId === null ? null : String(b.branchId)),
      (b) => b.branch?.hotelName ?? b.branch?.code ?? '—',
    ),
  };
}
