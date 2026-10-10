/**
 * "Cần tạo lại" accountability: which branch, which shift and which receptionist
 * produced orders that later had to be created again.
 *
 * WHY IT IS DRIVEN OFF `BookingCreationProof` AND NOT OFF `Booking`
 *
 * `Booking.verificationStatus` is the CURRENT state, and a redispatch resets it
 * to NOT_SUBMITTED. Counting rejections from it would therefore under-report
 * exactly the orders that were re-created — the ones the report exists to find.
 *
 * A proof row is the opposite: one immutable CREATION ATTEMPT, append-only,
 * unique per `(bookingId, attemptNumber)`, never deleted. Attempt 1 is the
 * original creator for all time; attempts 2..n are the re-creations. So the
 * history survives the withdrawal, the resend and the re-approval.
 *
 * WHAT THIS IS NOT
 *
 * There is no score, no ranking of people and no threshold. It counts rejected
 * attempts and groups them. Whether a number is high is a judgement for the
 * person reading it, not arithmetic performed here.
 */
import type { Prisma, ShiftType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { HCM_OFFSET_MS } from '../lib/clock';
import { shiftDefinition } from '../shift/shiftTypes';

/** Half-open [start, end) over HCM calendar days — the repo-wide convention. */
export function hcmRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - HCM_OFFSET_MS);
  const lastDayStart = Date.parse(`${to}T00:00:00.000Z`) - HCM_OFFSET_MS;
  return { start, end: new Date(lastDayStart + 24 * 60 * 60 * 1000) };
}

export interface RecreationFilter {
  from: string;
  to: string;
  branchId?: number;
  shiftType?: ShiftType;
  receptionistUserId?: number;
  source?: string;
}

const REPORT_SELECT = {
  id: true,
  bookingId: true,
  attemptNumber: true,
  submittedAt: true,
  submissionNote: true,
  receptionistNameSnapshot: true,
  shiftType: true,
  shiftSessionId: true,
  reviewedAt: true,
  reviewReasonCode: true,
  reviewNote: true,
  submittedBy: { select: { id: true, fullName: true } },
  reviewedBy: { select: { id: true, fullName: true } },
  shiftSession: { select: { id: true, shiftType: true, receptionistName: true, startedAt: true } },
  booking: {
    select: {
      id: true,
      bookingCode: true,
      customerName: true,
      sourcePlatform: true,
      checkInDate: true,
      createdAt: true,
      sentAt: true,
      branchId: true,
      status: true,
      verificationStatus: true,
      deletedAt: true,
      branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
    },
  },
} satisfies Prisma.BookingCreationProofSelect;

export type RecreationRow = Prisma.BookingCreationProofGetPayload<{ select: typeof REPORT_SELECT }>;

export interface RecreationReport {
  range: { from: string; to: string };
  rows: RecreationRow[];
  totals: {
    total: number;
    byBranch: Map<string, number>;
    byShift: Map<string, number>;
    byReceptionist: Map<string, number>;
  };
}

/** How a row names the person, preferring the snapshot over any live account. */
export function receptionistOf(row: RecreationRow): string {
  return (
    row.receptionistNameSnapshot ??
    row.shiftSession?.receptionistName ??
    // Pre-shift attempts: the typed note was the only name recorded.
    row.submissionNote ??
    row.submittedBy?.fullName ??
    'Không rõ'
  );
}

/** "Ca A4" / "Không rõ" for an attempt made before shifts existed. */
export function shiftLabelOf(row: RecreationRow): string {
  const code = row.shiftType ?? row.shiftSession?.shiftType ?? null;
  return code ? shiftDefinition(code).name : 'Không rõ';
}

export function branchLabelOf(row: RecreationRow): string {
  const b = row.booking.branch;
  return b ? `${b.code} — ${b.address}` : 'Không rõ';
}

/**
 * Rejected creation attempts in a period, newest first, with the totals the PDF
 * prints. Filtered in the DATABASE, never by loading everything and filtering in
 * JavaScript — this is the query behind an end-of-month report across eight
 * properties.
 */
export async function buildRecreationReport(filter: RecreationFilter): Promise<RecreationReport> {
  const { start, end } = hcmRange(filter.from, filter.to);

  const where: Prisma.BookingCreationProofWhereInput = {
    status: 'REJECTED',
    // The moment it was JUDGED to need recreating is the event being reported.
    reviewedAt: { gte: start, lt: end },
  };
  if (filter.shiftType) where.shiftType = filter.shiftType;
  if (filter.receptionistUserId !== undefined) where.submittedByUserId = filter.receptionistUserId;

  const bookingWhere: Prisma.BookingWhereInput = {};
  if (filter.branchId !== undefined) bookingWhere.branchId = filter.branchId;
  if (filter.source) bookingWhere.sourcePlatform = filter.source as Prisma.BookingWhereInput['sourcePlatform'];
  if (Object.keys(bookingWhere).length > 0) where.booking = bookingWhere;

  const rows = await prisma.bookingCreationProof.findMany({
    where,
    select: REPORT_SELECT,
    orderBy: { reviewedAt: 'desc' },
  });

  const byBranch = new Map<string, number>();
  const byShift = new Map<string, number>();
  const byReceptionist = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of rows) {
    bump(byBranch, branchLabelOf(row));
    bump(byShift, shiftLabelOf(row));
    bump(byReceptionist, receptionistOf(row));
  }

  return {
    range: { from: filter.from, to: filter.to },
    rows,
    totals: { total: rows.length, byBranch, byShift, byReceptionist },
  };
}

/** The wire shape. Dates are ISO; the client formats them. */
export function serializeRecreationRow(row: RecreationRow) {
  return {
    proofId: row.id,
    bookingId: row.bookingId,
    attemptNumber: row.attemptNumber,
    bookingCode: row.booking.bookingCode,
    customerName: row.booking.customerName,
    source: row.booking.sourcePlatform,
    branch: row.booking.branch
      ? {
          id: row.booking.branch.id,
          code: row.booking.branch.code,
          hotelName: row.booking.branch.hotelName,
          address: row.booking.branch.address,
        }
      : null,
    /** The order's own creation instant — never rewritten by a redispatch. */
    bookingCreatedAt: row.booking.createdAt.toISOString(),
    checkInDate: row.booking.checkInDate ? row.booking.checkInDate.toISOString() : null,
    submittedAt: row.submittedAt.toISOString(),
    receptionistName: receptionistOf(row),
    shiftType: row.shiftType ?? row.shiftSession?.shiftType ?? null,
    shiftLabel: shiftLabelOf(row),
    shiftSessionId: row.shiftSessionId,
    shiftStartedAt: row.shiftSession?.startedAt ? row.shiftSession.startedAt.toISOString() : null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedBy: row.reviewedBy ? { id: row.reviewedBy.id, fullName: row.reviewedBy.fullName } : null,
    reasonCode: row.reviewReasonCode,
    reviewNote: row.reviewNote,
    currentStatus: row.booking.status,
    currentVerificationStatus: row.booking.verificationStatus,
    withdrawn: row.booking.deletedAt !== null,
  };
}
