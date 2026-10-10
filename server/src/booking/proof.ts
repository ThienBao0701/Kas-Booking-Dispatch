import type { BookingAuditAction, Prisma, ProofReviewReason, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { loadBookingDetail } from './bookingRepo';
import { generateStoredFileName, saveProofFile, sniffImageMime } from './proofStorage';
import { assertClaimAllowsSubmission } from './claim';
import { isShiftRole, requireOpenSession } from '../shift/shiftService';
import type { BookingDetail } from './bookingView';

type Actor = {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
  /** Request correlation id, when the caller supplied one. Audit metadata only. */
  correlationId?: string | null;
};

/**
 * Writes one immutable proof-lifecycle audit event.
 *
 * WHAT IS DELIBERATELY NOT STORED: the proof image or its bytes, the stored file
 * name, the free-text review note, guest details, raw booking text, or any
 * credential. `reason` is always a stable machine code — either the attempt
 * number or a ProofReviewReason enum member — so the trail is queryable without
 * ever holding operational or personal data.
 *
 * The branch is intentionally NOT duplicated onto this row: it is reachable
 * through the booking relation, and denormalising it would let the audit trail
 * drift from the booking it describes.
 *
 * Every caller runs this INSIDE the transaction that also performs the
 * conditional status update, so a retried or racing request that loses the
 * update writes no event either — the trail cannot double-count.
 */
async function recordProofAudit(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    action: BookingAuditAction;
    oldValue: string | null;
    newValue: string;
    reason: string | null;
    actor: Actor;
  },
): Promise<void> {
  await tx.bookingAuditEvent.create({
    data: {
      bookingId: input.bookingId,
      action: input.action,
      field: 'verificationStatus',
      oldValue: input.oldValue,
      newValue: input.newValue,
      reason: input.reason,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      correlationId: input.actor.correlationId ?? null,
    },
  });
}

export interface UploadedProof {
  buffer: Buffer;
  originalName: string;
  size: number;
}

/** Vietnamese labels for the rejection reasons, used in notifications. */
export const REVIEW_REASON_LABELS: Record<ProofReviewReason, string> = {
  WRONG_CUSTOMER_NAME: 'Sai tên khách',
  WRONG_BOOKING_CODE: 'Sai mã Booking',
  WRONG_DATES: 'Sai ngày check-in/check-out',
  WRONG_ROOM_COUNT: 'Sai số lượng phòng',
  WRONG_ROOM_TYPE: 'Sai hạng phòng',
  WRONG_PRICE: 'Sai giá',
  MISSING_ROOM: 'Thiếu phòng',
  UNCLEAR_IMAGE: 'Ảnh không rõ',
  OTHER: 'Khác',
};

function assertReceptionistBranch(booking: BookingDetail, actor: Actor): void {
  if (actor.role === 'RECEPTIONIST' && booking.branchId !== actor.branchId) {
    throw ApiError.branchAccessDenied();
  }
}

// ---------------------------------------------------------------------------
// SUBMIT / RESUBMIT
// ---------------------------------------------------------------------------
export async function submitProof(
  bookingId: string,
  file: UploadedProof | undefined,
  note: string | undefined,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<BookingDetail> {
  if (!file) throw ApiError.proofRequired();

  const booking = await loadBookingDetail(bookingId);
  assertReceptionistBranch(booking, actor);

  if (booking.status !== 'NEW') {
    throw ApiError.conflict('Chỉ có thể nộp ảnh cho đơn đang chờ tạo.', { status: booking.status });
  }
  if (booking.verificationStatus === 'APPROVED') {
    throw ApiError.proofAlreadyReviewed('Đơn đã được xác nhận đúng, không cần nộp lại.');
  }
  if (booking.verificationStatus === 'PENDING_REVIEW') {
    throw ApiError.conflict('Đơn đang chờ Admin kiểm tra; vui lòng đợi kết quả.', {
      verificationStatus: booking.verificationStatus,
    });
  }

  // The declared MIME is never trusted — sniff the real image type from bytes.
  const mime = sniffImageMime(file.buffer);
  if (!mime) throw ApiError.unsupportedMedia();

  const previousStatus = booking.verificationStatus;

  /**
   * WHO CREATED THIS ORDER — decided here, by the server, from the open shift.
   *
   * Submitting the proof IS the receptionist asserting "I created this
   * reservation in the hotel system", so this is the moment the order gains a
   * creator. Before shifts existed they typed a name into the form and it was
   * stored verbatim: unverifiable, easy to mistype, and trivially spoofable by
   * anyone willing to edit a request. Now the name comes from the session they
   * checked in with, and `note` from the client is ignored for this purpose.
   *
   * With no open shift the submission is REFUSED (SHIFT_CHECK_IN_REQUIRED)
   * rather than falling back to whatever the browser sent — a fallback would
   * quietly reintroduce the very field this replaces.
   *
   * Only a receptionist works a shift. An Admin submitting on their behalf is
   * not on one, and their submission carries no shift attribution.
   */
  const shiftSession = isShiftRole(actor.role)
    ? await requireOpenSession({
        id: actor.id,
        role: actor.role,
        branchId: actor.branchId,
        fullName: actor.fullName,
      })
    : null;

  // THE CLAIM DEADLINE IS ENFORCED HERE, not in the browser. A receptionist
  // whose tab slept, whose network dropped, or whose polled list is stale will
  // still be refused, because this reads the stored deadline at the moment of
  // the write. Checked before the transaction so nothing is written, and
  // re-asserted inside the conditional update below so it cannot be raced.
  const claimRow = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { claimedByUserId: true, claimedAt: true, claimExpiresAt: true, claimCycle: true },
  });
  assertClaimAllowsSubmission(claimRow, { id: actor.id, role: actor.role, branchId: actor.branchId }, clock.now());

  // ONE transaction, opening with a CONDITIONAL CLAIM of the booking.
  //
  // THE RACE THIS CLOSES: the attempt number used to be counted before the
  // transaction opened. Two receptionists submitting the first proof at the
  // same instant both read zero, both computed attemptNumber = 1, and the
  // loser hit the (bookingId, attemptNumber) unique index — surfacing as a
  // generic "Dữ liệu đã tồn tại" that means nothing to a receptionist.
  //
  // The claim below serialises them on the booking row instead: the second
  // transaction blocks on the first, re-evaluates its WHERE once the first
  // commits, matches nothing (verificationStatus is no longer NOT_SUBMITTED /
  // REJECTED) and returns a clear operational conflict. Counting inside the
  // claim is therefore safe — no other submitter can be in flight.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: 'NEW',
        verificationStatus: { in: ['NOT_SUBMITTED', 'REJECTED'] },
        // The claim conditions ride along in the SAME statement that takes the
        // booking, so a deadline that lapses between the pre-check above and
        // this update cannot slip through — and a resend that lands in that
        // window clears `claimedByUserId`, which this WHERE then fails to match.
        //
        // A receptionist may submit ONLY under their own unexpired claim.
        ...(actor.role === 'RECEPTIONIST'
          ? { claimedByUserId: actor.id, claimExpiresAt: { gt: clock.now() } }
          : {}),
      },
      // The receptionist's claim that they created the reservation externally.
      data: {
        verificationStatus: 'PENDING_REVIEW',
        completedByUserId: actor.id,
        completedAt: clock.now(),
        // A resubmission clears the previous review verdict.
        reviewedByUserId: null,
        reviewedAt: null,
      },
    });
    if (claimed.count === 0) {
      throw ApiError.conflict(
        'Đơn vừa được cập nhật ở nơi khác (đang chờ Admin kiểm tra hoặc đã đổi trạng thái). Vui lòng tải lại.',
        { verificationStatus: previousStatus },
      );
    }

    const attemptNumber = (await tx.bookingCreationProof.count({ where: { bookingId } })) + 1;
    const storedFileName = generateStoredFileName(bookingId, attemptNumber, mime);

    // Written before the row exists, so a later failure leaves at most an
    // orphan file (proofs are never deleted anyway) and never a database row
    // pointing at an image that was never saved.
    await saveProofFile(file.buffer, storedFileName);

    await tx.bookingCreationProof.create({
      data: {
        bookingId,
        attemptNumber,
        storedFileName,
        originalFileName: file.originalName.slice(0, 255),
        mimeType: mime,
        fileSize: file.size,
        submissionNote: note ?? null,
        submittedByUserId: actor.id,
        // Copied, not referenced: this is who was working AT THIS ATTEMPT, and
        // it must not move when the shift closes or the account is renamed.
        shiftSessionId: shiftSession?.id ?? null,
        receptionistNameSnapshot: shiftSession?.receptionistName ?? null,
        shiftType: shiftSession?.shiftType ?? null,
        status: 'PENDING_REVIEW',
      },
    });

    // Submitting the proof IS submitting for review — one action, one event.
    await recordProofAudit(tx, {
      bookingId,
      action: 'BOOKING_PROOF_SUBMITTED',
      oldValue: previousStatus,
      newValue: 'PENDING_REVIEW',
      reason: `PROOF_ATTEMPT_${attemptNumber}`,
      actor,
    });

    await notifyAdminsProofSubmitted(tx, bookingId, booking);
  });

  return loadBookingDetail(bookingId);
}

async function notifyAdminsProofSubmitted(
  tx: Prisma.TransactionClient,
  bookingId: string,
  booking: BookingDetail,
): Promise<void> {
  const admins = await tx.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
  if (admins.length === 0) return;
  const code = booking.bookingCode.length > 0 ? booking.bookingCode : '(không mã)';
  const branchName = booking.branch?.address ?? 'chi nhánh';
  await tx.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      bookingId,
      title: 'Có đơn chờ kiểm tra',
      body: `${code} — ${branchName}`,
    })),
  });
}

// ---------------------------------------------------------------------------
// APPROVE
// ---------------------------------------------------------------------------
export async function approveProof(
  bookingId: string,
  proofId: string,
  admin: Actor,
  clock: Clock = getClock(),
): Promise<BookingDetail> {
  const proof = await prisma.bookingCreationProof.findUnique({ where: { id: proofId } });
  if (!proof || proof.bookingId !== bookingId) throw ApiError.notFound('Không tìm thấy ảnh.');
  if (proof.status !== 'PENDING_REVIEW') {
    throw ApiError.proofAlreadyReviewed('Ảnh này đã được duyệt trước đó.', { status: proof.status });
  }

  await prisma.$transaction(async (tx) => {
    // Conditional update: exactly one approval wins even under a double click.
    const updated = await tx.bookingCreationProof.updateMany({
      where: { id: proofId, status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', reviewedByUserId: admin.id, reviewedAt: clock.now() },
    });
    if (updated.count === 0) throw ApiError.proofAlreadyReviewed('Ảnh này đã được duyệt trước đó.');

    // PROOF STATE ONLY — the booking's LIFECYCLE is deliberately untouched.
    //
    // Approving a proof used to move the booking straight to COMPLETED. That
    // conflated two independent things: whether the reservation was correctly
    // entered into the hotel system, and whether the guest's stay has actually
    // finished. A booking could be marked complete while the guest was still in
    // the room, and the operational states below it were skipped entirely.
    //
    // `verificationStatus` is the proof's own outcome and is still recorded
    // here. `status` now moves only through the operational lifecycle, reaching
    // COMPLETED after CHECKED_OUT. See `booking/lifecycle.ts`.
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        verificationStatus: 'APPROVED',
        reviewedByUserId: admin.id,
        reviewedAt: clock.now(),
      },
    });

    await recordProofAudit(tx, {
      bookingId,
      action: 'BOOKING_PROOF_APPROVED',
      oldValue: 'PENDING_REVIEW',
      newValue: 'APPROVED',
      reason: `PROOF_ATTEMPT_${proof.attemptNumber}`,
      actor: admin,
    });

    await notifyReceptionist(tx, proof.submittedByUserId, bookingId, 'Đơn đã được xác nhận đúng', await bookingCodeOf(tx, bookingId));
  });

  return loadBookingDetail(bookingId);
}

// ---------------------------------------------------------------------------
// REJECT
// ---------------------------------------------------------------------------
export async function rejectProof(
  bookingId: string,
  proofId: string,
  reasonCode: ProofReviewReason | undefined,
  reviewNote: string | undefined,
  admin: Actor,
  clock: Clock = getClock(),
): Promise<BookingDetail> {
  if (!reasonCode) throw ApiError.reviewReasonRequired();

  const proof = await prisma.bookingCreationProof.findUnique({ where: { id: proofId } });
  if (!proof || proof.bookingId !== bookingId) throw ApiError.notFound('Không tìm thấy ảnh.');
  if (proof.status !== 'PENDING_REVIEW') {
    throw ApiError.proofAlreadyReviewed('Ảnh này đã được xử lý trước đó.', { status: proof.status });
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.bookingCreationProof.updateMany({
      where: { id: proofId, status: 'PENDING_REVIEW' },
      data: {
        status: 'REJECTED',
        reviewReasonCode: reasonCode,
        reviewNote: reviewNote ?? null,
        reviewedByUserId: admin.id,
        reviewedAt: clock.now(),
      },
    });
    if (updated.count === 0) throw ApiError.proofAlreadyReviewed('Ảnh này đã được xử lý trước đó.');

    // The booking status stays NEW (still operationally open); only the
    // verification verdict changes. The immutable proof attempt is the audit.
    //
    // THE ORDER GOES BACK TO "ĐƠN MỚI", TAKEABLE. The receptionist's claim from
    // the attempt just judged is released and a new claim cycle starts — the
    // same release the resend performs — so the order is not left holding a
    // lapsed claim (hidden from the queue, and takeable by nobody) and the
    // values taken with CẮT last time are visible again for the correction.
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        verificationStatus: 'REJECTED',
        reviewedByUserId: admin.id,
        reviewedAt: clock.now(),
        claimedByUserId: null,
        claimedAt: null,
        claimExpiresAt: null,
        claimCycle: { increment: 1 },
      },
    });

    // This IS the "correction requested" event: rejecting with a reason is how
    // an Admin asks for the reservation to be recreated and resubmitted. Only
    // the stable reason CODE is stored — never the free-text review note, which
    // can contain operational or guest detail.
    await recordProofAudit(tx, {
      bookingId,
      action: 'BOOKING_PROOF_REJECTED',
      oldValue: 'PENDING_REVIEW',
      newValue: 'REJECTED',
      reason: reasonCode,
      actor: admin,
    });

    await notifyReceptionist(
      tx,
      proof.submittedByUserId,
      bookingId,
      'Đơn cần tạo lại',
      REVIEW_REASON_LABELS[reasonCode],
    );
  });

  return loadBookingDetail(bookingId);
}

async function bookingCodeOf(tx: Prisma.TransactionClient, bookingId: string): Promise<string> {
  const b = await tx.booking.findUnique({ where: { id: bookingId }, select: { bookingCode: true } });
  return b && b.bookingCode.length > 0 ? b.bookingCode : '(không mã)';
}

async function notifyReceptionist(
  tx: Prisma.TransactionClient,
  receptionistId: number | null,
  bookingId: string,
  title: string,
  body: string,
): Promise<void> {
  if (receptionistId == null) return;
  // Only notify an active receptionist who still exists.
  const user = await tx.user.findFirst({
    where: { id: receptionistId, role: 'RECEPTIONIST', active: true },
    select: { id: true },
  });
  if (!user) return;
  await tx.notification.create({ data: { userId: receptionistId, bookingId, title, body } });
}

// ---------------------------------------------------------------------------
// IMAGE ACCESS AUTHORIZATION
// ---------------------------------------------------------------------------
/** Authorises a proof-image request and returns what the file endpoint needs. */
export async function authorizeProofImage(
  bookingId: string,
  proofId: string,
  actor: Actor,
): Promise<{ storedFileName: string; mimeType: string }> {
  const proof = await prisma.bookingCreationProof.findUnique({
    where: { id: proofId },
    select: { storedFileName: true, mimeType: true, bookingId: true, booking: { select: { branchId: true } } },
  });
  if (!proof || proof.bookingId !== bookingId) throw ApiError.notFound('Không tìm thấy ảnh.');
  if (actor.role === 'RECEPTIONIST' && proof.booking.branchId !== actor.branchId) {
    throw ApiError.branchAccessDenied();
  }
  return { storedFileName: proof.storedFileName, mimeType: proof.mimeType };
}
