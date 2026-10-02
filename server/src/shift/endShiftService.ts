/**
 * "KẾT THÚC CA" — a shift ending normally.
 *
 * HOW THIS DIFFERS FROM "ĐỔI CA"
 *
 *   Kết thúc ca  the shift is over. One session closes and NOTHING opens. The
 *                desk is unattended until the next receptionist checks in and
 *                says who they are, which is the honest state: nobody is on it.
 *
 *   Đổi ca       the shift ends EARLY and somebody specific takes over in the
 *                same moment. Two sessions and a `ShiftHandover` linking them,
 *                with a reason — see `handoverService.ts`.
 *
 * Folding them together was possible and wrong: an ordinary end-of-shift would
 * then have to invent an incoming receptionist, and every quiet 14:00 would
 * manufacture a handover record to somebody who had not arrived yet.
 *
 * THE END INSTANT IS THE SERVER'S. There is no field on the request that can
 * carry one. A reception PC with a wrong clock would otherwise decide when a
 * shift ended, and therefore which receptionist owns the orders and the cash
 * around the boundary.
 *
 * WHAT CLOSING ACTUALLY ENFORCES
 *
 * Every write a receptionist makes goes through `requireOpenSession`. Once
 * `closedAt` is set there is no open session, so the shift that just ended
 * cannot record another payment, another guest request or another order — its
 * journal is final. The next records wait for the next check-in and attach to
 * that shift instead. Nothing rewrites what the closed shift already wrote.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { findOpenSession, isShiftRole, type ShiftActor, type ShiftSessionRow } from './shiftService';
import { pendingWork, type PendingWork } from './handoverNoteService';
import { shiftCashSummary, type CashSummary } from '../reception/cashService';

export interface EndShiftPreview {
  session: ShiftSessionRow | null;
  /** Live outstanding work at the branch — never copied into any record. */
  pending: PendingWork;
  /** How many "Bàn giao ca" notes this session has written. */
  handoverNoteCount: number;
  /** How many journal entries it recorded, voided ones included. */
  reportCount: number;
  cash: CashSummary | null;
  /**
   * TRUE when there is outstanding work AND the shift has written no handover
   * note. The client shows "Ca hiện tại còn nội dung cần bàn giao." and offers
   * "Bàn giao ca" first.
   *
   * IT DOES NOT BLOCK, AND IT NEVER FABRICATES A HANDOVER. A receptionist whose
   * replacement is standing beside them has already handed over verbally, and
   * refusing to let them go home would turn a reminder into an obstacle they
   * learn to work around. What the system must not do is record a handover that
   * did not happen — so it asks, and takes no for an answer.
   */
  handoverAdvised: boolean;
}

export async function endShiftPreview(
  actor: ShiftActor,
  client: PrismaClient = prisma,
): Promise<EndShiftPreview> {
  if (!isShiftRole(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân mới kết thúc được ca làm việc.');
  }
  if (actor.branchId == null) {
    throw ApiError.branchAccessDenied('Tài khoản chưa được gán chi nhánh.');
  }

  const session = await findOpenSession(actor.id, client);
  const pending = await pendingWork(actor.branchId, client);

  if (!session) {
    return {
      session: null,
      pending,
      handoverNoteCount: 0,
      reportCount: 0,
      cash: null,
      handoverAdvised: false,
    };
  }

  const [handoverNoteCount, reportCount, cash] = await Promise.all([
    client.shiftHandoverNote.count({ where: { shiftSessionId: session.id } }),
    client.receptionOperationalReport.count({ where: { shiftSessionId: session.id } }),
    shiftCashSummary(session.id, client),
  ]);

  const outstanding =
    pending.openIssues.length > 0 ||
    pending.bookings.awaitingCreation > 0 ||
    pending.bookings.awaitingReview > 0 ||
    pending.bookings.needsRecreation > 0;

  return {
    session,
    pending,
    handoverNoteCount,
    reportCount,
    cash,
    handoverAdvised: outstanding && handoverNoteCount === 0,
  };
}

export interface EndShiftResult {
  /** 1 when a shift was closed, 0 when there was nothing open. Idempotent. */
  closed: number;
  /** The session as it now stands, with `closedAt` set. Null if none was open. */
  session: ShiftSessionRow | null;
  /** The drawer at the moment it closed, for the confirmation screen. */
  cash: CashSummary | null;
}

/**
 * Close the actor's own open shift. Idempotent: closing nothing is not an error.
 *
 * Guarded by `closedAt: null` inside the update rather than by the read before
 * it, so two tabs pressing "Kết thúc ca" at the same instant close the shift
 * once and agree on the instant it ended.
 */
export async function endShift(
  actor: ShiftActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<EndShiftResult> {
  if (!isShiftRole(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân mới kết thúc được ca làm việc.');
  }
  const now = clock.now();

  const open = await findOpenSession(actor.id, client);
  if (!open) return { closed: 0, session: null, cash: null };

  const { count } = await client.receptionShiftSession.updateMany({
    where: { id: open.id, closedAt: null },
    data: { closedAt: now },
  });
  if (count === 0) return { closed: 0, session: null, cash: null };

  const [session, cash] = await Promise.all([
    client.receptionShiftSession.findUnique({
      where: { id: open.id },
      select: {
        id: true,
        branchId: true,
        userId: true,
        shiftType: true,
        receptionistName: true,
        startedAt: true,
        nominalEndAt: true,
        graceEndAt: true,
        closedAt: true,
      },
    }),
    shiftCashSummary(open.id, client),
  ]);

  return { closed: count, session, cash };
}
