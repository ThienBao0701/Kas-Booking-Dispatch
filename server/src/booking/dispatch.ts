import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, isLastMinute, type Clock } from '../lib/clock';
import { loadBookingDetail } from './bookingRepo';
import { validateBooking, type ValidationResult } from './validation';
import { snapshotRoomClasses } from './store';
import { NOT_DELETED } from './deleteBooking';
import type { BookingDetail } from './bookingView';

/**
 * The booking dispatch state machine: DRAFT/READY -> NEW (send) -> COMPLETED.
 * Each transition is atomic, guards its precondition with a conditional update
 * (so two concurrent callers cannot both transition), writes an immutable
 * status-history row, and creates the right persistent notifications.
 */

// The full role enum — a new role must not silently fail to compile here.
// Which roles may act is enforced at runtime, never by narrowing this type.
type Actor = { id: number; role: UserRole; branchId: number | null; fullName: string };

function isoDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : '—';
}

/** Blocking validation errors -> a 422 that carries the full {valid,errors,warnings}. */
function assertNoBlockingErrors(result: ValidationResult): void {
  if (!result.valid) {
    throw ApiError.bookingNotReady('Đơn chưa hợp lệ để xử lý.', {
      valid: false,
      errors: result.errors,
      warnings: result.warnings,
    });
  }
}

// ---------------------------------------------------------------------------
// READY
// ---------------------------------------------------------------------------
export async function markBookingReady(
  bookingId: string,
  admin: Actor,
  note: string | undefined,
): Promise<BookingDetail> {
  const booking = await loadBookingDetail(bookingId);
  if (booking.status !== 'DRAFT') {
    throw ApiError.conflict('Chỉ có thể chuyển sang “sẵn sàng” từ trạng thái nháp.', {
      status: booking.status,
    });
  }

  const result = validateBooking(booking, 'ready');
  assertNoBlockingErrors(result);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, status: 'DRAFT' },
      data: { status: 'READY' },
    });
    if (updated.count === 0) {
      throw ApiError.conflict('Trạng thái đơn đã thay đổi, vui lòng tải lại.');
    }
    await tx.bookingStatusHistory.create({
      data: {
        bookingId,
        oldStatus: 'DRAFT',
        newStatus: 'READY',
        changedByUserId: admin.id,
        note: note ?? null,
      },
    });
  });

  return loadBookingDetail(bookingId);
}

// ---------------------------------------------------------------------------
// SEND
// ---------------------------------------------------------------------------
export interface SendInput {
  branchId: number;
  acknowledgedWarningCodes: string[];
}

export async function sendBooking(
  bookingId: string,
  input: SendInput,
  admin: Actor,
  clock: Clock = getClock(),
): Promise<BookingDetail> {
  const booking = await loadBookingDetail(bookingId);

  // A booking already dispatched (or beyond) can never be re-sent.
  if (['NEW', 'COMPLETED', 'ARCHIVED'].includes(booking.status)) {
    throw ApiError.bookingAlreadySent('Đơn đã được gửi trước đó.', { status: booking.status });
  }
  if (booking.status !== 'DRAFT' && booking.status !== 'READY') {
    throw ApiError.conflict('Chỉ có thể gửi đơn ở trạng thái nháp hoặc sẵn sàng.', {
      status: booking.status,
    });
  }

  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch || !branch.active) {
    throw ApiError.validation('Chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
  }

  // Validate against the branch the admin is actually sending to.
  const result = validateBooking({ ...booking, branchId: input.branchId }, 'send');
  assertNoBlockingErrors(result);

  const acknowledged = new Set(input.acknowledgedWarningCodes);
  const unacknowledged = result.warnings.filter((w) => !acknowledged.has(w.code));
  if (unacknowledged.length > 0) {
    throw ApiError.warningsNotAcknowledged('Vui lòng xác nhận các cảnh báo trước khi gửi.', {
      valid: true,
      errors: [],
      warnings: unacknowledged,
    });
  }

  // Duplicate operational booking: same code + branch + check-in already live.
  const duplicate = await findOperationalDuplicate(
    {
      bookingCode: booking.bookingCode,
      branchId: input.branchId,
      checkInDate: booking.checkInDate,
      excludeBookingId: bookingId,
    },
    prisma,
  );
  if (duplicate) {
    throw ApiError.duplicateBooking('Đã tồn tại một đơn vận hành trùng khớp.', {
      existingBookingId: duplicate.id,
      existingStatus: duplicate.status,
    });
  }

  const lastMinute = isLastMinute(booking.checkInDate, clock.now());
  const oldStatus = booking.status;

  await prisma.$transaction(async (tx) => {
    // Conditional update: only a still-unsent booking transitions, so a racing
    // second send cannot double-dispatch.
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: ['DRAFT', 'READY'] } },
      data: {
        branchId: input.branchId,
        status: 'NEW',
        sentAt: clock.now(),
        sentByUserId: admin.id,
        isLastMinute: lastMinute,
      },
    });
    if (updated.count === 0) {
      throw ApiError.bookingAlreadySent('Đơn đã được gửi trước đó.');
    }

    await tx.bookingStatusHistory.create({
      data: {
        bookingId,
        oldStatus,
        newStatus: 'NEW',
        changedByUserId: admin.id,
        note: `Gửi tới chi nhánh ${branch.hotelName}`,
      },
    });

    await createSendNotifications(tx, bookingId, input.branchId, booking, lastMinute);
  });

  // Dispatch is the moment the branch becomes final, so it is the moment the
  // branch-specific room codes can be resolved. Rooms that already carry a
  // resolved snapshot are left untouched; this only fills in the blanks.
  // Outside the transaction: a resolver problem must never undo a dispatch.
  await snapshotRoomClasses(bookingId);

  return loadBookingDetail(bookingId);
}

/**
 * "Has this reservation already reached this branch?" — THE duplicate rule.
 *
 * Extracted verbatim from the send path above so the Booking.com dispatch that
 * creates its booking outright asks the identical question. Two implementations
 * of "is this a duplicate" is one more than the number of answers the operator
 * can live with: they would drift, and the direction they drift in is a second
 * order sent to a branch that is already working on the first.
 *
 * The identity is (code, branch, check-in) rather than the code alone: the same
 * confirmation code legitimately reappears at a different branch or for a
 * different stay, and refusing those would block real work.
 *
 * ── A WITHDRAWN BOOKING IS NOT A DUPLICATE ────────────────────────────────
 * `NOT_DELETED` is part of the rule, not housekeeping.
 *
 * Soft delete writes `deletedAt` and NOTHING ELSE — the status stays exactly as
 * it was. So an order the Admin withdrew is still `NEW` on the row, and a lookup
 * that asked only about status counted it as a live duplicate. The Admin was
 * told "Đơn trùng đã tồn tại (NEW)" about an order they had just taken back, and
 * the only way forward was to revive that same row.
 *
 * What "duplicate" is protecting against is a branch being asked to create the
 * same reservation twice. A withdrawn order is in no queue, on no screen and in
 * front of no receptionist — there is nothing to create twice. It remains in the
 * database as history, which is exactly what soft delete is for, and history
 * must not block new work.
 *
 * This is the same `deletedAt: null` filter every other operational query
 * already applies; this lookup was the one place that had been missed.
 *
 * `excludeBookingId` exists only for the legacy path, where the booking being
 * sent already has a row and must not match itself. A dispatch that creates its
 * booking has no id yet and simply omits it. Its meaning is unchanged.
 */
export async function findOperationalDuplicate(
  input: {
    bookingCode: string;
    branchId: number;
    checkInDate: Date | null;
    excludeBookingId?: string;
  },
  client: PrismaClient = prisma,
): Promise<{ id: string; status: string } | null> {
  return client.booking.findFirst({
    where: {
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
      ...NOT_DELETED,
      bookingCode: input.bookingCode,
      branchId: input.branchId,
      checkInDate: input.checkInDate,
      status: { in: ['NEW', 'COMPLETED', 'ARCHIVED'] },
    },
    select: { id: true, status: true },
  });
}

/**
 * Sends a DELETED order back to its branch ("Gửi lại" after a withdrawal).
 *
 * ── WHY THIS IS NOT THE CLAIM RESEND ──────────────────────────────────────
 * `resendBooking` in `claim.ts` answers a different question: a receptionist
 * held an order and let the three minutes lapse, so it goes back on their queue.
 * That order was never withdrawn and is still perfectly valid.
 *
 * This answers "the Admin sent the wrong thing, took it back, and wants to send
 * it again". The two share a Vietnamese label and nothing else — one releases a
 * lapsed claim, this one revives a withdrawn order — so they stay separate
 * rather than one growing a mode flag.
 *
 * ── THE ELIGIBILITY RULE, AND WHY EACH CLAUSE IS THERE ────────────────────
 * The WHERE below is the rule, enforced in the database rather than in the
 * screen, so a hand-made request cannot do what the button will not offer:
 *
 *   sentAt   IS NOT NULL  — it must have been SENT once. An order still being
 *                           typed has never reached a branch, so there is
 *                           nothing to send again (Case C).
 *   deletedAt IS NOT NULL — the Admin must have explicitly withdrawn it. An
 *                           order sitting with reception right now is theirs to
 *                           work on, and re-sending underneath them would
 *                           duplicate it (Case A).
 *   verificationStatus <> APPROVED
 *                         — see below.
 *
 * ── WHY AN APPROVED ORDER CAN NEVER BE SENT BACK ──────────────────────────
 * APPROVED is not a workflow stage; it is a statement of fact about the outside
 * world. `approveProof` records that an Admin looked at the screenshot and
 * verified THE RESERVATION EXISTS IN THE HOTEL SYSTEM.
 *
 * Sending such an order back tells a receptionist to create a reservation that
 * has already been created and verified — which produces the duplicate booking
 * this entire claim feature exists to prevent. It would also erase the
 * verification itself, throwing away the Admin's own sign-off to make room for
 * work that should not happen.
 *
 * There is already a first-class way to say "this needs creating again": REJECT
 * the proof. That sets REJECTED, puts the order back on the branch's "Cần tạo
 * lại" queue, and keeps the whole history of why. Withdraw-and-resend is for
 * pulling back an order that was WRONG, not for redoing one that was right.
 *
 * Deletion is Admin-only — the whole `/admin/bookings` router is behind
 * `requireAdmin` — so a non-null `deletedAt` already means "withdrawn by an
 * Admin"; no extra role lookup is needed to prove it.
 *
 * CASE D falls out of the same condition rather than needing a counter. Sending
 * it back clears `deletedAt`, so the order immediately stops satisfying clause
 * two: it cannot be sent again until an Admin withdraws it again, which is a new
 * decision about a new dispatch. There is no state in which the button stays
 * live and can be pressed repeatedly.
 *
 * The claim is cleared and `claimCycle` incremented so the branch must press CẮT
 * again — this is a fresh piece of work, not a continuation of the claim that
 * existed before the order was withdrawn.
 */
export async function redispatchDeletedBooking(
  bookingId: string,
  admin: { id: number; role: string },
  client: PrismaClient = prisma,
  clock: Clock = getClock(),
): Promise<BookingDetail> {
  if (admin.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ Admin mới gửi lại được đơn đã xoá.');
  }

  const before = await client.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      sentAt: true,
      deletedAt: true,
      branchId: true,
      bookingCode: true,
      checkInDate: true,
      verificationStatus: true,
    },
  });
  if (!before) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  /*
    ── THE ORDER MAY HAVE BEEN REPLACED WHILE IT WAS WITHDRAWN ──────────────
    Withdrawing an order stopped blocking a fresh dispatch of the same
    reservation, which is correct — a withdrawn order is in no queue and asks
    nobody to create anything. But it means an Admin can withdraw A, send the
    same reservation as B, and then still be looking at A's "Gửi lại" button.
    Reviving A at that point would put the same reservation in front of the
    same branch twice.

    THE DATABASE ALREADY REFUSES THIS. The revival below sets `deletedAt` to
    null, which moves the row INTO
    `Booking_one_operational_per_code_branch_checkin` — where B already sits
    under the same key — so PostgreSQL rejects the UPDATE. That is what makes
    this safe under concurrency: two simultaneous revivals, or a revival racing
    a fresh dispatch, cannot both land, because the winner's row occupies the
    key before the loser's UPDATE is applied. No transaction redesign is needed
    and none was made.

    What the index cannot do is explain itself. Without the check below the
    Admin sees "Dữ liệu đã tồn tại" and a list of column names, about a booking
    the screen never mentioned. So this asks the question in the application
    too — the SAME question, through the SAME helper `sendBooking` and the
    Booking.com dispatch use — purely so the refusal names the order that is
    actually in the way. The index remains the authority; this is the wording.

    It runs only for an order that is OTHERWISE eligible. The three refusals
    below are about THIS booking and keep their priority and their exact
    wording — an APPROVED order is still refused as APPROVED, not as a
    duplicate. The `updateMany` WHERE remains the atomic guard; this gate is a
    read that decides which message an Admin gets, never whether the write is
    permitted.

    A booking with no branch has no operational identity to collide on (the
    index does not constrain NULLs either), so there is nothing to ask.
  */
  const eligibleForRedispatch =
    before.sentAt !== null &&
    before.deletedAt !== null &&
    before.verificationStatus !== 'APPROVED';

  if (eligibleForRedispatch && before.branchId !== null) {
    const duplicate = await findOperationalDuplicate(
      {
        bookingCode: before.bookingCode,
        branchId: before.branchId,
        checkInDate: before.checkInDate,
        // A withdrawn order is already outside the lookup, but saying so keeps
        // the call honest about never matching itself.
        excludeBookingId: bookingId,
      },
      client,
    );
    if (duplicate) {
      throw ApiError.duplicateBooking(
        'Đơn này đã được gửi lại dưới một đơn khác đang hoạt động. ' +
          'Gửi lại sẽ khiến lễ tân tạo trùng.',
        { existingBookingId: duplicate.id, existingStatus: duplicate.status },
      );
    }
  }

  const now = clock.now();

  const revived = await client.booking.updateMany({
    where: {
      id: bookingId,
      sentAt: { not: null },
      deletedAt: { not: null },
      verificationStatus: { not: 'APPROVED' },
    },
    data: {
      deletedAt: null,
      deletedByUserId: null,
      status: 'NEW',
      sentAt: now,
      sentByUserId: admin.id,
      /*
        RE-STAMPED WITH `sentAt`, because it is a fact ABOUT this dispatch.

        "Last minute" means the guest arrives on the day the order reached the
        branch, so the flag belongs to the moment of sending — and this is a
        sending. Carrying the old value over made it a statement about a dispatch
        that had since been withdrawn: an order sent early, taken back, and sent
        again on its check-in day stayed `false` and vanished from the LAST
        MINUTE count on the one day it mattered most, while one that was
        last-minute first time round kept `true` long after its check-in passed.

        `isLastMinute` is the shared helper every other dispatch path already
        uses (`sendBooking`, `dispatchOtaReview`, `dispatchBookingComReview`), so
        this is the same definition applied to the path that was missing it — not
        a second one. It is what the dashboard's LAST MINUTE card reads.
      */
      isLastMinute: isLastMinute(before.checkInDate, now),
      // Back to the branch as work to be done: the previous cycle's proof state
      // does not carry over, and the earlier proof rows stay as the record of
      // what happened before the order was withdrawn.
      verificationStatus: 'NOT_SUBMITTED',
      claimedByUserId: null,
      claimedAt: null,
      claimExpiresAt: null,
      claimCycle: { increment: 1 },
    },
  });

  if (revived.count === 0) {
    // Say which clause failed — "not allowed" sends an Admin hunting.
    if (before.sentAt === null) {
      throw ApiError.conflict('Đơn này chưa từng được gửi nên không thể gửi lại.');
    }
    if (before.deletedAt === null) {
      throw ApiError.conflict(
        'Đơn này đang ở chi nhánh. Hãy xoá đơn trước nếu muốn gửi lại.',
      );
    }
    if (before.verificationStatus === 'APPROVED') {
      throw ApiError.conflict(
        'Đơn này đã được xác nhận là đã tạo đúng trên hệ thống khách sạn. ' +
          'Gửi lại sẽ khiến lễ tân tạo trùng. Nếu cần tạo lại, hãy từ chối ảnh xác nhận.',
      );
    }
    throw ApiError.conflict('Không gửi lại được đơn này.');
  }

  await client.bookingStatusHistory.create({
    data: {
      bookingId,
      oldStatus: before.status,
      newStatus: 'NEW',
      changedByUserId: admin.id,
      note: 'Gửi lại đơn đã xoá',
    },
  });

  await client.bookingAuditEvent.create({
    data: {
      bookingId,
      action: 'BOOKING_RESENT',
      reason: 'REDISPATCH_AFTER_DELETE',
      actorUserId: admin.id,
      actorRole: 'ADMIN',
    },
  });

  return loadBookingDetail(bookingId);
}

async function createSendNotifications(
  tx: Prisma.TransactionClient,
  bookingId: string,
  branchId: number,
  booking: BookingDetail,
  lastMinute: boolean,
): Promise<void> {
  await createBranchNotifications(tx, {
    bookingId,
    branchId,
    customerName: booking.customerName,
    checkInDate: booking.checkInDate,
    lastMinute,
  });
}

/**
 * Tells a branch's receptionists that a booking has arrived.
 *
 * Extracted verbatim from the Booking.com send path so the OTA dispatch raises
 * exactly the same notification — same wording, same recipients, same
 * last-minute emphasis. Taking a plain value object rather than a full
 * `BookingDetail` is what lets a freshly-created OTA booking use it inside the
 * same transaction, before any detail view exists to load.
 */
export async function createBranchNotifications(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    branchId: number;
    customerName: string;
    checkInDate: Date | null;
    lastMinute: boolean;
  },
): Promise<void> {
  const receptionists = await tx.user.findMany({
    where: { role: 'RECEPTIONIST', branchId: input.branchId, active: true },
    select: { id: true },
  });
  if (receptionists.length === 0) return;

  const branch = await tx.branch.findUnique({
    where: { id: input.branchId },
    select: { hotelName: true },
  });
  const branchName = branch?.hotelName ?? '';
  const customer = input.customerName.length > 0 ? input.customerName : 'Khách';
  const title = input.lastMinute ? 'ĐƠN LAST MINUTE' : 'Có đơn mới';
  const body = input.lastMinute
    ? `${customer} nhận phòng hôm nay\n${branchName}\nVui lòng ưu tiên xử lý`
    : `${customer} – nhận phòng ${isoDate(input.checkInDate)}\n${branchName}`;

  await tx.notification.createMany({
    data: receptionists.map((r) => ({ userId: r.id, bookingId: input.bookingId, title, body })),
  });
}

// Booking completion is no longer a direct receptionist action: a booking moves
// NEW -> COMPLETED only when an admin approves an uploaded creation proof. See
// `booking/proof.ts` (submitProof / approveProof / rejectProof).
