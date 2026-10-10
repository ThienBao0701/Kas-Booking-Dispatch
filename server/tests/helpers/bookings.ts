import type { BookingSource, BookingStatus, PaymentStatus, VerificationStatus } from '@prisma/client';
import { testPrisma } from './db';

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Every stay night from check-in inclusive to check-out exclusive. */
function stayDates(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  const end = utc(checkOut).getTime();
  for (let t = utc(checkIn).getTime(); t < end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

interface DraftOptions {
  branchId?: number | null;
  createdByUserId?: number | null;
  bookingCode?: string;
  customerName?: string;
  phone?: string | null;
  checkIn?: string;
  checkOut?: string;
  totalAmount?: number | null;
  status?: BookingStatus;
  paymentStatus?: PaymentStatus;
  nightlyAmount?: number | null;
  roomType?: string | null;
  rooms?: number;
  warnings?: { code: string; message: string; severity?: 'INFO' | 'WARNING' | 'ERROR' }[];
  sentByUserId?: number | null;
  sentAt?: string | null;
  completedByUserId?: number | null;
  completedAt?: string | null;
  completionNote?: string | null;
  isLastMinute?: boolean;
  sourcePlatform?: BookingSource;
  verificationStatus?: VerificationStatus;
  reviewedByUserId?: number | null;
  reviewedAt?: string | null;
  /**
   * Give the booking an ACTIVE dispatch claim held by this receptionist.
   *
   * CUT is a hard prerequisite for proof submission — a receptionist must own
   * the order before creating the reservation, which is how two of them are
   * stopped from creating it twice. A fixture that wants to exercise the proof
   * workflow therefore has to arrive already claimed, exactly as it would in
   * real use after the receptionist pressed CUT.
   *
   * The deadline is set far enough out that a slow test cannot trip it; tests
   * that care about expiry set the timestamps themselves.
   */
  claimedByUserId?: number | null;
}

/** Comfortably longer than any test run; expiry tests set their own deadline. */
const FIXTURE_CLAIM_WINDOW_MS = 60 * 60 * 1000;

const OPERATIONAL: BookingStatus[] = ['NEW', 'COMPLETED', 'ARCHIVED'];

/**
 * Inserts a structurally complete booking (rooms + one night row per expected
 * stay date) so dispatch/validation flows have realistic, anonymized data to act
 * on. Defaults produce a valid, sendable DRAFT.
 */
export async function createDraftBooking(opts: DraftOptions = {}) {
  const checkIn = opts.checkIn ?? '2026-07-19';
  const checkOut = opts.checkOut ?? '2026-07-22';
  const nightly = opts.nightlyAmount === undefined ? 850_000 : opts.nightlyAmount;
  const roomCount = opts.rooms ?? 1;
  const dates = stayDates(checkIn, checkOut);
  const status = opts.status ?? 'DRAFT';
  const operational = OPERATIONAL.includes(status);
  const sentAt =
    opts.sentAt === undefined ? (operational ? '2026-07-15T02:00:00.000Z' : null) : opts.sentAt;
  const completedAt =
    opts.completedAt === undefined ? (status === 'COMPLETED' ? '2026-07-16T02:00:00.000Z' : null) : opts.completedAt;

  const rooms = Array.from({ length: roomCount }, (_, i) => ({
    roomIndex: i + 1,
    roomType: opts.roomType === undefined ? 'Deluxe Double Room' : opts.roomType,
    roomSubtotal: nightly === null ? null : nightly * dates.length,
    nights: {
      create: dates.map((d) => ({ stayDate: utc(d), amount: nightly, currency: 'VND' })),
    },
  }));

  return testPrisma.booking.create({
    data: {
      bookingCode: opts.bookingCode ?? '1234567890',
      hotelName: 'Saigon Hotel & Ben Thanh',
      branchId: opts.branchId ?? null,
      customerName: opts.customerName ?? 'Nguyễn Văn A',
      phone: opts.phone === undefined ? '0901234567' : opts.phone,
      checkInDate: utc(checkIn),
      checkOutDate: utc(checkOut),
      totalAmount:
        opts.totalAmount === undefined
          ? (nightly === null ? null : nightly * dates.length * roomCount)
          : opts.totalAmount,
      currency: 'VND',
      paymentStatus: opts.paymentStatus ?? 'PAY_AFTER',
      rawText: 'RAW TEXT (anonymized fixture)',
      status,
      parserVersion: '4a.2.0',
      createdByUserId: opts.createdByUserId ?? null,
      sentByUserId: opts.sentByUserId ?? null,
      sentAt: sentAt ? new Date(sentAt) : null,
      completedByUserId: opts.completedByUserId ?? null,
      completedAt: completedAt ? new Date(completedAt) : null,
      completionNote: opts.completionNote ?? null,
      isLastMinute: opts.isLastMinute ?? false,
      sourcePlatform: opts.sourcePlatform ?? 'BOOKING_COM',
      verificationStatus:
        opts.verificationStatus ?? (status === 'COMPLETED' ? 'APPROVED' : 'NOT_SUBMITTED'),
      claimedByUserId: opts.claimedByUserId ?? null,
      claimedAt: opts.claimedByUserId ? new Date() : null,
      claimExpiresAt: opts.claimedByUserId
        ? new Date(Date.now() + FIXTURE_CLAIM_WINDOW_MS)
        : null,
      reviewedByUserId: opts.reviewedByUserId ?? null,
      reviewedAt: opts.reviewedAt ? new Date(opts.reviewedAt) : null,
      rooms: { create: rooms },
      warnings: opts.warnings
        ? {
            create: opts.warnings.map((w) => ({
              code: w.code,
              message: w.message,
              severity: w.severity ?? 'WARNING',
            })),
          }
        : undefined,
    },
    include: { rooms: { include: { nights: true } } },
  });
}

/** The list of expected stay dates for a range (helper for edit-payload tests). */
export function expectedStayDates(checkIn: string, checkOut: string): string[] {
  return stayDates(checkIn, checkOut);
}
