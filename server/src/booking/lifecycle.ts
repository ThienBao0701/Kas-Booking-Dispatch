/**
 * The operational booking lifecycle, after dispatch.
 *
 *   NEW -> RECEIVED -> CHECKED_IN -> CHECKED_OUT -> COMPLETED
 *
 * with CANCELLED and NO_SHOW reachable from the states where they make sense.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *  - It never touches DRAFT or READY. Those belong to the Booking.com
 *    extract-and-send flow in `dispatch.ts`, which is unchanged.
 *  - It never redefines NEW. NEW has always meant "dispatched, awaiting the
 *    branch", and that is exactly what it still means here.
 *  - It is INDEPENDENT of proof approval. A booking may be completed by an
 *    approved creation proof without ever passing through these states, and
 *    passing through these states does not approve a proof. Two workflows,
 *    deliberately not coupled.
 *
 * Every transition is a CONDITIONAL update guarded on the state it expects, so
 * two receptionists pressing the same button cannot both succeed — the second
 * update matches no row and is reported as a conflict rather than silently
 * overwriting the first one's timestamp and actor.
 */
import type { BookingStatus, PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { recordRequestOrigin, type RequestOrigin } from './requestAudit';

/** Who is performing the transition. */
export interface LifecycleActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  /** Where the request came from, recorded beside the transition. */
  origin?: RequestOrigin;
}

/**
 * The states each action may be applied FROM.
 *
 * Listed explicitly rather than derived, so adding a state to the enum cannot
 * quietly widen what an existing action accepts.
 */
const ALLOWED_FROM: Record<LifecycleAction, readonly BookingStatus[]> = {
  RECEIVE: ['NEW'],
  CHECK_IN: ['RECEIVED'],
  CHECK_OUT: ['CHECKED_IN'],
  // Completion closes a stay that has ended. Proof approval completes a booking
  // by its own, separate route; this is the operational path.
  COMPLETE: ['CHECKED_OUT'],
  // A booking can fall through at any point before the guest arrives.
  CANCEL: ['NEW', 'RECEIVED'],
  // Only meaningful once the guest was expected and did not appear.
  NO_SHOW: ['RECEIVED'],
};

export type LifecycleAction =
  | 'RECEIVE'
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'COMPLETE'
  | 'CANCEL'
  | 'NO_SHOW';

const RESULTING_STATUS: Record<LifecycleAction, BookingStatus> = {
  RECEIVE: 'RECEIVED',
  CHECK_IN: 'CHECKED_IN',
  CHECK_OUT: 'CHECKED_OUT',
  COMPLETE: 'COMPLETED',
  CANCEL: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
};

const ACTION_LABEL: Record<LifecycleAction, string> = {
  RECEIVE: 'Lễ tân đã nhận đơn',
  CHECK_IN: 'Khách đã nhận phòng',
  CHECK_OUT: 'Khách đã trả phòng',
  COMPLETE: 'Hoàn tất đơn',
  CANCEL: 'Huỷ đơn',
  NO_SHOW: 'Khách không đến',
};

export interface LifecycleResult {
  bookingId: string;
  oldStatus: BookingStatus;
  newStatus: BookingStatus;
}

/**
 * Applies one lifecycle transition.
 *
 * The booking, its new timestamp, its actor and an immutable status-history row
 * are written in a single transaction: an operational event is either fully
 * recorded or not recorded at all.
 */
export async function applyLifecycleAction(
  bookingId: string,
  action: LifecycleAction,
  actor: LifecycleActor,
  options: { reason?: string } = {},
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<LifecycleResult> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, branchId: true },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  // A receptionist acts only on their OWN branch's bookings. Checked here as
  // well as at the route, because this is where the write happens.
  if (actor.role === 'RECEPTIONIST' && booking.branchId !== actor.branchId) {
    throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');
  }

  const allowed = ALLOWED_FROM[action];
  if (!allowed.includes(booking.status)) {
    throw ApiError.conflict(
      `Không thể ${ACTION_LABEL[action].toLowerCase()} khi đơn đang ở trạng thái ${booking.status}.`,
      { status: booking.status, allowedFrom: allowed },
    );
  }

  const now = clock.now();
  const newStatus = RESULTING_STATUS[action];

  return client.$transaction(async (tx) => {
    // Conditional on the state we read: a concurrent caller that already moved
    // the booking leaves this matching zero rows rather than overwriting them.
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: [...allowed] } },
      data: {
        status: newStatus,
        ...(action === 'RECEIVE' ? { receivedAt: now, receivedByUserId: actor.id } : {}),
        ...(action === 'CHECK_IN' ? { actualCheckInAt: now, checkedInByUserId: actor.id } : {}),
        ...(action === 'CHECK_OUT' ? { actualCheckOutAt: now, checkedOutByUserId: actor.id } : {}),
        ...(action === 'COMPLETE' ? { completedAt: now, completedByUserId: actor.id } : {}),
        ...(action === 'CANCEL' || action === 'NO_SHOW'
          ? { cancelledAt: now, cancelledByUserId: actor.id, cancellationReason: options.reason ?? null }
          : {}),
      },
    });
    if (updated.count === 0) {
      throw ApiError.conflict('Đơn vừa được cập nhật bởi người khác. Vui lòng tải lại.', {
        status: booking.status,
      });
    }

    const requestAuditId = actor.origin
      ? await recordRequestOrigin(tx, actor.origin, now)
      : null;

    await tx.bookingStatusHistory.create({
      data: {
        bookingId,
        requestAuditId,
        oldStatus: booking.status,
        newStatus,
        changedByUserId: actor.id,
        changedAt: now,
        note: options.reason ? `${ACTION_LABEL[action]}: ${options.reason}` : ACTION_LABEL[action],
      },
    });

    return { bookingId, oldStatus: booking.status, newStatus };
  });
}
