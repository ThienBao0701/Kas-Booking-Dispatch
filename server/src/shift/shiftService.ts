/**
 * Reception shift sessions: check in, read the current one, close it.
 *
 * WHAT THIS IS FOR
 *
 * A branch runs one login across a rotating team, so the ACCOUNT never named the
 * person on the desk. This is where that gap is closed: a receptionist says who
 * they are and which shift they are working, once, and every order they create
 * during it is attributed to them by the server. The browser is never asked for
 * the name again, and is never believed if it sends one.
 *
 * WHY THE INVARIANTS LIVE HERE AND IN THE DATABASE, NOT IN THE UI
 *
 * "One open session per receptionist" is enforced by the partial unique index
 * `ReceptionShiftSession_one_open_per_user`. The check-in below closes the old
 * session and opens the new one inside ONE transaction, so there is never an
 * instant where a working receptionist has no session; and if two browser tabs
 * check in at the same moment, the loser hits the index rather than creating a
 * second, conflicting session. An application-level SELECT could not do this:
 * both tabs would pass it.
 */
import type { Prisma, PrismaClient, ShiftType, UserRole } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { isPromptDue, shiftBoundaries, shiftDefinition, shiftWindowLabel } from './shiftTypes';

/** The unique index that makes "one open session" a database fact. */
const ONE_OPEN_PER_USER = 'ReceptionShiftSession_one_open_per_user';

// The full role enum — see issueSummary.ts. Access is decided at runtime.
export interface ShiftActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
}

const SESSION_SELECT = {
  id: true,
  branchId: true,
  userId: true,
  shiftType: true,
  receptionistName: true,
  startedAt: true,
  nominalEndAt: true,
  graceEndAt: true,
  closedAt: true,
} satisfies Prisma.ReceptionShiftSessionSelect;

export type ShiftSessionRow = Prisma.ReceptionShiftSessionGetPayload<{
  select: typeof SESSION_SELECT;
}>;

/** The on-the-wire shape. `promptDue` is computed, never stored. */
export function serializeShiftSession(session: ShiftSessionRow, now: Date) {
  return {
    id: session.id,
    branchId: session.branchId,
    shiftType: session.shiftType,
    shiftName: shiftDefinition(session.shiftType).name,
    shiftWindow: shiftWindowLabel(session.shiftType),
    receptionistName: session.receptionistName,
    startedAt: session.startedAt.toISOString(),
    nominalEndAt: session.nominalEndAt.toISOString(),
    graceEndAt: session.graceEndAt.toISOString(),
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    /**
     * TRUE once the grace period has elapsed. The client shows the shift picker
     * on this flag alone, so the "when do we ask again?" rule exists once, on
     * the server, rather than being re-derived from clock arithmetic in React.
     */
    promptDue: isPromptDue(session.graceEndAt, now),
  };
}

export type SerializedShiftSession = ReturnType<typeof serializeShiftSession>;

/** Only a receptionist works a shift. Everyone else has no concept of one. */
export function isShiftRole(role: UserRole): boolean {
  return role === 'RECEPTIONIST';
}

/**
 * The receptionist's open session, or null. Never returns another user's.
 *
 * A session stays OPEN past its grace end on purpose — it is still the answer to
 * "who is on the desk?" until somebody checks in again. Expiry is a prompt, not
 * a logout: silently dropping it would leave a working receptionist unable to
 * submit an order they had already created.
 */
export async function findOpenSession(
  userId: number,
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ShiftSessionRow | null> {
  return client.receptionShiftSession.findFirst({
    where: { userId, closedAt: null },
    select: SESSION_SELECT,
    orderBy: { startedAt: 'desc' },
  });
}

export interface CheckInInput {
  shiftType: ShiftType;
  receptionistName: string;
}

/**
 * Open a shift, closing any previous one in the same transaction.
 *
 * The branch is taken from the ACCOUNT, never from the request: a receptionist
 * cannot check in to a branch they are not assigned to, because they are never
 * asked which branch it is.
 */
export async function checkInShift(
  input: CheckInInput,
  actor: ShiftActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ShiftSessionRow> {
  if (!isShiftRole(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân mới bắt đầu được ca làm việc.');
  }
  if (actor.branchId == null) {
    throw ApiError.branchAccessDenied('Tài khoản chưa được gán chi nhánh.');
  }

  const receptionistName = input.receptionistName.trim();
  if (!receptionistName) {
    throw ApiError.validation('Vui lòng nhập họ tên lễ tân.');
  }

  const now = clock.now();
  const { nominalEndAt, graceEndAt } = shiftBoundaries(input.shiftType, now);

  try {
    return await client.$transaction(async (tx) => {
      // Close whatever was open first. `updateMany` rather than `update` so a
      // receptionist with no previous session is not an error.
      await tx.receptionShiftSession.updateMany({
        where: { userId: actor.id, closedAt: null },
        data: { closedAt: now },
      });

      return tx.receptionShiftSession.create({
        data: {
          branchId: actor.branchId!,
          userId: actor.id,
          shiftType: input.shiftType,
          receptionistName,
          startedAt: now,
          nominalEndAt,
          graceEndAt,
        },
        select: SESSION_SELECT,
      });
    });
  } catch (error) {
    // Two tabs checked in at the same instant and the index refused the second.
    // Reported rather than papered over: the two tabs may have picked DIFFERENT
    // shifts, and silently returning the winner's would misattribute the work.
    if (
      error instanceof PrismaNS.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      String(error.meta?.target ?? '').includes(ONE_OPEN_PER_USER)
    ) {
      throw ApiError.conflict('Ca làm việc đã được bắt đầu ở nơi khác. Vui lòng tải lại trang.');
    }
    throw error;
  }
}

/**
 * THE GATE for anything a receptionist creates.
 *
 * Returns the open session or refuses with SHIFT_CHECK_IN_REQUIRED — the code
 * the client keys off to show the picker. There is deliberately no fallback to a
 * client-supplied name: without a session the server does not know who is
 * working, and guessing is precisely the failure this feature removes.
 */
export async function requireOpenSession(
  actor: ShiftActor,
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ShiftSessionRow> {
  const session = await findOpenSession(actor.id, client);
  if (!session) {
    throw ApiError.shiftCheckInRequired();
  }
  return session;
}

/**
 * The shift a receptionist action HAPPENED IN, for the things that record it but
 * do not depend on it.
 *
 * WHY THIS IS SEPARATE FROM `requireOpenSession`
 *
 * Submitting proof of a created order is an ACCOUNTING act: the whole point is
 * to say who created it, so without a shift there is nothing to record and the
 * request is refused. Reporting a broken door is not. Refusing an incident
 * report because nobody had checked in would leave a real fault unreported to
 * protect a statistic — so these callers CAPTURE the shift when there is one and
 * carry nulls when there is not.
 *
 * Null all the way through for anyone who does not work shifts, which is what
 * lets an Admin file a report without the concept leaking into their record.
 */
export interface ShiftContext {
  shiftSessionId: string | null;
  shiftType: ShiftType | null;
  receptionistName: string | null;
}

export const NO_SHIFT_CONTEXT: ShiftContext = {
  shiftSessionId: null,
  shiftType: null,
  receptionistName: null,
};

export async function captureShiftContext(
  actor: ShiftActor,
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<ShiftContext> {
  if (!isShiftRole(actor.role)) return NO_SHIFT_CONTEXT;
  const session = await findOpenSession(actor.id, client);
  if (!session) return NO_SHIFT_CONTEXT;
  return {
    shiftSessionId: session.id,
    shiftType: session.shiftType,
    receptionistName: session.receptionistName,
  };
}
