/**
 * Amending a booking that was already dispatched.
 *
 * An amended reservation mail describes the SAME booking with different
 * details. Dispatching it again is refused by the idempotency check — correctly,
 * since a second booking would double the stay — but that left the amendment
 * silently ignored: the branch kept working from the superseded details.
 *
 * ── THE CURRENT ROW IS THE LATEST STATE ───────────────────────────────────
 * There is no version or revision table. The booking is updated in place, and
 * every field that changed becomes an immutable `BookingCorrection` row. The
 * history is therefore the corrections, not a chain of snapshots: "what did it
 * say before, and who changed it" stays answerable without a second source of
 * truth that could disagree with the booking.
 *
 * ── NOTHING IS APPLIED WITHOUT A HUMAN ────────────────────────────────────
 * `buildAmendment` computes the comparison and writes NOTHING. A reviewer sees
 * every changed field and accepts or rejects. Only `applyAmendment` writes, and
 * only the fields that were accepted.
 *
 * ── A CANCELLED MAIL NEVER CANCELS A BOOKING ──────────────────────────────
 * The parser can read CANCELLED from the platform's own heading. That is
 * reported and nothing else: cancelling a real guest's room because a parser
 * matched a word is not a decision this code may make. The operational status
 * moves only through `lifecycle.ts`, by an explicit human action.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { buildOtaReviewFromText, type OtaReviewRequest } from './otaReviewService';
import { recordRequestOrigin, type RequestOrigin } from './requestAudit';
import { parseAgodaBooking } from './agoda';
import type { OtaReview } from './otaReview';

/** One field the amended mail states differently from the stored booking. */
export interface AmendmentChange {
  field: string;
  /** Human-readable label for the review screen. */
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface AmendmentPreview {
  bookingId: string;
  /** The review built from the amended mail. */
  review: OtaReview;
  /** Every field that differs. Empty when the mail changes nothing. */
  changes: AmendmentChange[];
  /**
   * True when the PLATFORM says the reservation is cancelled. Reported only —
   * it never moves `Booking.status`, which requires an explicit human action.
   */
  otaCancelled: boolean;
  /** The booking's current operational status, for context on the screen. */
  currentStatus: string;
  /**
   * Optimistic-concurrency token: the booking row as this comparison saw it.
   *
   * Sent back with the apply so a SECOND tab, comparing the same mail against
   * the same booking, loses. Without it both tabs would compute an identical
   * diff and both write it, doubling the corrections for one amendment.
   */
  expectedVersion: string;
}

/** The fields an amendment may change, with the labels the screen shows. */
const COMPARABLE: ReadonlyArray<{
  field: string;
  label: string;
  fromBooking: (b: StoredBooking) => string | null;
  fromReview: (r: OtaReview) => string | null;
}> = [
  { field: 'guestName', label: 'Tên khách', fromBooking: (b) => b.customerName || null, fromReview: (r) => r.guestName },
  { field: 'checkIn', label: 'Ngày nhận phòng', fromBooking: (b) => iso(b.checkInDate), fromReview: (r) => r.checkIn },
  { field: 'checkOut', label: 'Ngày trả phòng', fromBooking: (b) => iso(b.checkOutDate), fromReview: (r) => r.checkOut },
  { field: 'branchPrice', label: 'Giá chi nhánh', fromBooking: (b) => str(b.totalAmount), fromReview: (r) => str(r.branchPrice) },
  { field: 'branchId', label: 'Chi nhánh', fromBooking: (b) => str(b.branchId), fromReview: (r) => str(r.branchId) },
  { field: 'otaBookingStatus', label: 'Trạng thái OTA', fromBooking: (b) => b.otaBookingStatus, fromReview: () => null },
];

interface StoredBooking {
  id: string;
  status: string;
  customerName: string;
  checkInDate: Date | null;
  checkOutDate: Date | null;
  totalAmount: number | null;
  branchId: number | null;
  otaBookingStatus: string | null;
  updatedAt: Date;
  rooms: { roomIndex: number; roomType: string | null }[];
}

const str = (value: number | null): string | null => (value === null ? null : String(value));
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));

/**
 * Finds the dispatched booking an amended mail refers to.
 *
 * By (booking code, platform) — the same key dispatch is idempotent on, so an
 * amendment can never attach itself to a different reservation.
 */
async function findDispatched(
  client: PrismaClient,
  bookingCode: string,
  platform: 'AGODA' | 'CTRIP',
): Promise<StoredBooking | null> {
  return client.booking.findFirst({
    where: { bookingCode, sourcePlatform: platform },
    select: {
      id: true,
      status: true,
      customerName: true,
      checkInDate: true,
      checkOutDate: true,
      totalAmount: true,
      branchId: true,
      otaBookingStatus: true,
      updatedAt: true,
      rooms: { select: { roomIndex: true, roomType: true }, orderBy: { roomIndex: 'asc' } },
    },
  });
}

/**
 * Computes the comparison. WRITES NOTHING.
 *
 * The reviewer sees exactly what would change before anything does.
 */
export async function buildAmendment(
  request: OtaReviewRequest,
  client: PrismaClient = defaultPrisma,
): Promise<AmendmentPreview> {
  const { review } = await buildOtaReviewFromText(request, client);
  if (!review.bookingCode) {
    throw ApiError.validation('Không đọc được mã đặt phòng từ nội dung sửa đổi.');
  }

  const platform = request.source === 'AGODA' ? 'AGODA' : 'CTRIP';
  const booking = await findDispatched(client, review.bookingCode, platform);
  if (!booking) {
    throw ApiError.notFound('Chưa có đơn nào được gửi với mã đặt phòng này.');
  }

  // The platform's OWN status, read from the amended mail's heading.
  const amendedStatus =
    request.source === 'AGODA'
      ? (parseAgodaBooking(request.rawText, []).agoda?.bookingStatus ?? null)
      : null;

  const changes: AmendmentChange[] = [];
  for (const spec of COMPARABLE) {
    const oldValue = spec.fromBooking(booking);
    const newValue =
      spec.field === 'otaBookingStatus' ? amendedStatus : spec.fromReview(review);
    if (oldValue !== newValue) {
      changes.push({ field: spec.field, label: spec.label, oldValue, newValue });
    }
  }

  // Room lines, compared position by position so an added or removed line shows.
  const lineCount = Math.max(booking.rooms.length, review.rooms.length);
  for (let i = 0; i < lineCount; i += 1) {
    const oldValue = booking.rooms[i]?.roomType ?? null;
    const newValue = review.rooms[i]?.pmsCode ?? review.rooms[i]?.otaRoomName ?? null;
    if (oldValue !== newValue) {
      changes.push({
        field: `rooms[${i}].roomType`,
        label: `Hạng phòng dòng ${i + 1}`,
        oldValue,
        newValue,
      });
    }
  }

  return {
    bookingId: booking.id,
    review,
    changes,
    // Reported, never acted on. Cancelling a real guest's room because a
    // parser matched a word is not a decision this code may make.
    otaCancelled: amendedStatus === 'CANCELLED',
    currentStatus: booking.status,
    expectedVersion: booking.updatedAt.toISOString(),
  };
}

export interface ApplyAmendmentInput extends OtaReviewRequest {
  /**
   * Which changed fields to apply. Omitted means "all of them"; an empty array
   * means the reviewer rejected every change, and nothing is written.
   */
  acceptedFields?: string[];
  /**
   * The version the reviewer was looking at. Omitted falls back to the version
   * read during this call, which still protects two SIMULTANEOUS applies but
   * not a stale tab; the screen always sends it.
   */
  expectedVersion?: string;
}

export interface AmendmentResult {
  bookingId: string;
  applied: AmendmentChange[];
  rejected: AmendmentChange[];
  /**
   * The correction rows this apply created, so the reviewer is shown the
   * actual audit records rather than being told to trust that some were made.
   */
  correctionIds: string[];
}

/**
 * Applies the accepted changes to the existing booking.
 *
 * The update and its correction rows are one transaction: a booking is never
 * left changed with no record of what changed it.
 */
export async function applyAmendment(
  input: ApplyAmendmentInput,
  actor: { id: number; origin?: RequestOrigin },
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<AmendmentResult> {
  const preview = await buildAmendment(input, client);

  const accepted =
    input.acceptedFields === undefined
      ? preview.changes
      : preview.changes.filter((c) => input.acceptedFields!.includes(c.field));
  const rejected = preview.changes.filter((c) => !accepted.includes(c));

  if (accepted.length === 0) {
    // A rejected amendment leaves the booking exactly as it was — and records
    // nothing, because nothing happened to it.
    return { bookingId: preview.bookingId, applied: [], rejected, correctionIds: [] };
  }

  const now = clock.now();
  const data: Prisma.BookingUpdateInput = {};
  for (const change of accepted) {
    if (change.field === 'guestName') data.customerName = change.newValue ?? '';
    if (change.field === 'checkIn') {
      data.checkInDate = change.newValue ? new Date(`${change.newValue}T00:00:00.000Z`) : null;
    }
    if (change.field === 'checkOut') {
      data.checkOutDate = change.newValue ? new Date(`${change.newValue}T00:00:00.000Z`) : null;
    }
    if (change.field === 'branchPrice') {
      data.totalAmount = change.newValue === null ? null : Number(change.newValue);
    }
    // The platform's own status is recorded as a correction only — it never
    // becomes an operational transition.
    if (change.field === 'branchId' && change.newValue !== null) {
      data.branch = { connect: { id: Number(change.newValue) } };
    }
  }

  const correctionIds = await client.$transaction(async (tx) => {
    const requestAuditId = actor.origin
      ? await recordRequestOrigin(tx as Prisma.TransactionClient, actor.origin, now)
      : null;

    // Conditional on the row this comparison was computed FROM.
    //
    // Two tabs holding the same amendment produce an identical diff, and both
    // would happily write it — doubling the corrections and applying the change
    // twice. Guarding on the version the preview saw means the second one
    // matches no row and is reported as a conflict.
    //
    // `updatedAt` is always advanced, even when no business field changed
    // (a status-only amendment writes corrections but no column), so the token
    // moves for every apply and the guard cannot be bypassed by choosing fields
    // that happen to touch nothing.
    const expected = input.expectedVersion
      ? new Date(input.expectedVersion)
      : new Date(preview.expectedVersion);
    const touched = await tx.booking.updateMany({
      where: { id: preview.bookingId, updatedAt: expected },
      data: { ...data, updatedAt: now },
    });
    if (touched.count === 0) {
      throw ApiError.conflict(
        'Đơn vừa được cập nhật bởi người khác. Vui lòng tải lại nội dung sửa đổi.',
        { bookingId: preview.bookingId },
      );
    }

    // Room changes are recorded but NOT written back onto the room rows: a
    // dispatched room line is what the branch was told, and rewriting it in
    // place would erase that without a trace. The correction row carries the
    // amendment so a human can act on it.
    const created = await tx.bookingCorrection.createManyAndReturn({
      select: { id: true },
      data: accepted.map((c) => ({
        bookingId: preview.bookingId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        correctedByUserId: actor.id,
        correctedAt: now,
        requestAuditId,
      })),
    });

    return created.map((row) => row.id);
  });

  return { bookingId: preview.bookingId, applied: accepted, rejected, correctionIds };
}
