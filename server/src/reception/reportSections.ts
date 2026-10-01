/**
 * THE TWO SECTIONS OF THE FULL REPORT THAT ARE NOT JOURNAL CATEGORIES.
 *
 * "ĐƠN MỚI" — the orders the Admin sent to a branch in the period, with where
 * each one stands now. They are Reception's first screen, so a report of
 * Reception's work that left them out would describe a different job. Read by
 * the day the order was SENT (an order belongs to no shift), never deleted ones.
 *
 * "HOÀN THÀNH VẤN ĐỀ" — the records of the report that the 12-hour rule has
 * moved to Reception's completion archive: requests, facility incidents,
 * service-quality reports and deliveries, finished and received at least 12
 * hours before the report was built. NOT a second query: it is a selection of the
 * very rows the report already printed, by the same rule the archive screen
 * uses, so the two can never disagree about what was finished.
 */
import type { BookingSource, BookingStatus, OperationalReportCategory, PrismaClient, VerificationStatus } from '@prisma/client';
import { NOT_DELETED } from '../booking/deleteBooking';
import { completedStatuses } from '../issue/issueLifecycle';
import { archiveCutoff } from './completionArchive';
import type { SerializedReport } from './reportService';

/** One order of "Đơn mới", as the report prints it. */
export interface ReportBooking {
  id: string;
  bookingCode: string;
  customerName: string;
  sourceLabel: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  sentAt: string;
  stateLabel: string;
  /** Who confirmed it was created, else who took it — the desk's own name for the work. */
  handledBy: string | null;
  handledAt: string | null;
}

const SOURCE_LABELS: Record<BookingSource, string> = {
  BOOKING_COM: 'Booking.com',
  AGODA: 'Agoda',
  CTRIP: 'CTrip',
};

/** The workflow chip Reception reads on every order — the same four words. */
const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  NOT_SUBMITTED: 'Chờ chi nhánh tạo',
  PENDING_REVIEW: 'Chờ kiểm tra',
  APPROVED: 'Đã xác nhận đúng',
  REJECTED: 'Cần tạo lại',
};

/** A cancelled or no-show stay says so before anything about its creation. */
export function bookingStateLabel(status: BookingStatus, verification: VerificationStatus): string {
  if (status === 'CANCELLED') return 'Đã hủy';
  if (status === 'NO_SHOW') return 'Không đến';
  return VERIFICATION_LABELS[verification];
}

/** Stated in the output when reached, like every other cap of the report. */
const MAX_BOOKINGS_PER_BRANCH = 2000;

/** "Đơn mới" for one branch: the orders SENT to it in the period, oldest first. */
export async function bookingsForReport(
  branchId: number,
  window: { from: Date; to: Date },
  client: PrismaClient,
): Promise<{ bookings: ReportBooking[]; total: number; truncated: boolean }> {
  const where = { ...NOT_DELETED, branchId, sentAt: { gte: window.from, lt: window.to } };
  const [rows, total] = await Promise.all([
    client.booking.findMany({
      where,
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: MAX_BOOKINGS_PER_BRANCH,
      select: {
        id: true,
        bookingCode: true,
        customerName: true,
        sourcePlatform: true,
        checkInDate: true,
        checkOutDate: true,
        sentAt: true,
        status: true,
        verificationStatus: true,
        completedAt: true,
        claimedAt: true,
        completedBy: { select: { fullName: true } },
        claimedBy: { select: { fullName: true } },
      },
    }),
    client.booking.count({ where }),
  ]);
  return {
    bookings: rows.map((b) => ({
      id: b.id,
      bookingCode: b.bookingCode,
      customerName: b.customerName,
      sourceLabel: SOURCE_LABELS[b.sourcePlatform],
      checkInDate: b.checkInDate ? b.checkInDate.toISOString().slice(0, 10) : null,
      checkOutDate: b.checkOutDate ? b.checkOutDate.toISOString().slice(0, 10) : null,
      sentAt: b.sentAt!.toISOString(),
      stateLabel: bookingStateLabel(b.status, b.verificationStatus),
      handledBy: b.completedBy?.fullName ?? b.claimedBy?.fullName ?? null,
      handledAt: (b.completedAt ?? b.claimedAt)?.toISOString() ?? null,
    })),
    total,
    truncated: total > rows.length,
  };
}

/** The categories the completion archive is made of, in the archive screen's order. */
export const ARCHIVE_SECTION_CATEGORIES: readonly OperationalReportCategory[] = [
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'HOTEL_DELIVERY',
];

/**
 * "Hoàn thành vấn đề": the report's rows the 12-hour rule has archived, as of
 * `now` — finished, and received (or, for a delivery, finished) 12 hours or more
 * ago. Voided rows never reach the archive.
 */
export function completionArchiveRows(
  byCategory: Record<OperationalReportCategory, SerializedReport[]>,
  now: Date,
): SerializedReport[] {
  const cutoff = archiveCutoff(now).getTime();
  const old = (iso: string) => new Date(iso).getTime() <= cutoff;
  const finished = new Set<string>(completedStatuses());
  const archived = (r: SerializedReport): boolean => {
    if (r.voided) return false;
    switch (r.category) {
      case 'GUEST_REQUEST':
        return !!r.guestRequest?.completed && old(r.createdAt);
      case 'CUSTOMER_COMPLAINT':
        return !!r.complaint?.completed && old(r.createdAt);
      case 'FACILITY_ISSUE':
        return !!r.facility && finished.has(r.facility.issue.status) && old(r.facility.issue.createdAt);
      case 'HOTEL_DELIVERY':
        return !!r.delivery?.archived;
      default:
        return false;
    }
  };
  return ARCHIVE_SECTION_CATEGORIES.flatMap((c) => byCategory[c].filter(archived));
}
