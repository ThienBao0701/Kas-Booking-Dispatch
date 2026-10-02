/**
 * "BÀN GIAO CA" — what the shift going off duty tells the shift coming on.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 *
 * It is the short list of things a person needs to SAY: room 101 is waiting on a
 * technician, the guest in 302 asked to be called back, the card machine is
 * behaving oddly. It is not a status report — every number the next shift needs
 * is already on their own screens, and asking a receptionist to retype it at the
 * end of a twelve-hour shift produces a list that is both a chore to write and
 * out of date by the time it is read.
 *
 * SO THE CONTEXT IS SHOWN, NOT COPIED. `pendingWork()` below is rendered BESIDE
 * the form as the note is written, straight from live data. It is never folded
 * into `content`: an incident resolved an hour after the handover was written
 * would otherwise sit in the note for ever, telling the next shift to chase
 * something that is already done.
 *
 * IMMUTABLE. There is no update and no delete here, deliberately. A handover is
 * a thing somebody said at a moment; correcting it means saying something else,
 * which is another note, with its own time on it.
 */
import type { HandoverPriority, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { NOT_DELETED } from '../booking/deleteBooking';
import { describeLocation } from '../issue/issueArea';
import { outstandingStatuses } from '../issue/issueLifecycle';
import { shiftDefinition, shiftWindowLabel } from './shiftTypes';
import { isShiftRole, requireOpenSession, type ShiftActor } from './shiftService';

const NOTE_SELECT = {
  id: true,
  branchId: true,
  shiftSessionId: true,
  handoverId: true,
  outgoingUserId: true,
  outgoingNameSnapshot: true,
  outgoingShiftType: true,
  incomingNameSnapshot: true,
  incomingShiftType: true,
  content: true,
  priority: true,
  createdAt: true,
  branch: { select: { id: true, code: true, hotelName: true, address: true } },
} satisfies Prisma.ShiftHandoverNoteSelect;

export type HandoverNoteRow = Prisma.ShiftHandoverNoteGetPayload<{ select: typeof NOTE_SELECT }>;

export function serializeHandoverNote(row: HandoverNoteRow) {
  return {
    id: row.id,
    branchId: row.branchId,
    branch: row.branch,
    shiftSessionId: row.shiftSessionId,
    /** Set when the note was written as part of an "Đổi ca". */
    handoverId: row.handoverId,
    outgoingName: row.outgoingNameSnapshot,
    outgoingShiftType: row.outgoingShiftType,
    outgoingShiftName: shiftDefinition(row.outgoingShiftType).name,
    outgoingShiftWindow: shiftWindowLabel(row.outgoingShiftType),
    /** Often null: a note written mid-shift is for whoever turns up. */
    incomingName: row.incomingNameSnapshot,
    incomingShiftType: row.incomingShiftType,
    incomingShiftName: row.incomingShiftType ? shiftDefinition(row.incomingShiftType).name : null,
    content: row.content,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
  };
}

export type SerializedHandoverNote = ReturnType<typeof serializeHandoverNote>;

export interface CreateHandoverNoteInput {
  content: string;
  priority?: HandoverPriority;
  incomingName?: string;
  incomingShiftType?: Prisma.ShiftHandoverNoteCreateInput['incomingShiftType'];
}

/**
 * Writes a handover note from the CURRENT shift.
 *
 * The author, their shift and the branch are all taken from the open session —
 * never from the request. A note that could name its own author would let one
 * shift leave a message signed by another, in the one record whose whole value
 * is knowing who said it.
 *
 * A shift is REQUIRED here, unlike incident reporting: "Bàn giao ca" means
 * handing over from a shift, so without one there is nothing to hand over from.
 * The refusal is the same `SHIFT_CHECK_IN_REQUIRED` the client already acts on.
 */
export async function createHandoverNote(
  input: CreateHandoverNoteInput,
  actor: ShiftActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<HandoverNoteRow> {
  if (!isShiftRole(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân mới tạo được bàn giao ca.');
  }

  const content = input.content.trim();
  if (!content) throw ApiError.validation('Vui lòng nhập nội dung bàn giao.');
  const incomingName = input.incomingName?.trim() || null;

  const session = await requireOpenSession(actor, client);

  return client.shiftHandoverNote.create({
    data: {
      branchId: session.branchId,
      shiftSessionId: session.id,
      outgoingUserId: session.userId,
      outgoingNameSnapshot: session.receptionistName,
      outgoingShiftType: session.shiftType,
      incomingNameSnapshot: incomingName,
      incomingShiftType: input.incomingShiftType ?? null,
      content,
      priority: input.priority ?? 'NORMAL',
      /*
        THE BUSINESS CLOCK, NOT THE DATABASE'S.

        `createdAt` has a `@default(now())`, which is PostgreSQL's clock — and
        this column is what the Admin's period report filters on. Two problems
        follow from leaving it to the default: the note's instant comes from a
        different clock than the handover it can belong to, so a note written in
        the same transaction as an "Đổi ca" could carry a different timestamp
        from the handover itself; and the report becomes untestable, because no
        test can place a note inside a period it controls.

        Every other timestamp this application reports on — `actualHandoverAt`,
        `acceptedAt`, `outcomeAt`, a proof's `submittedAt` — is set explicitly
        from the injected clock. This now is too.
      */
      createdAt: clock.now(),
    },
    select: NOTE_SELECT,
  });
}

export interface HandoverNoteFilter {
  branchId?: number;
  start?: Date;
  end?: Date;
  take?: number;
}

/**
 * Notes, newest first.
 *
 * BRANCH SCOPE IS THE CALLER'S, NOT THE REQUEST'S, for a receptionist: a
 * client-supplied branch is IGNORED rather than refused, exactly as the incident
 * list does it, because the scope is not theirs to choose. An Admin monitors
 * every branch and may narrow to one.
 */
export async function listHandoverNotes(
  actor: ShiftActor,
  filter: HandoverNoteFilter,
  client: PrismaClient = prisma,
): Promise<HandoverNoteRow[]> {
  const where: Prisma.ShiftHandoverNoteWhereInput = {};
  if (isShiftRole(actor.role)) {
    // -1 never matches → an unassigned receptionist sees nothing, rather than
    // everything.
    where.branchId = actor.branchId ?? -1;
  } else if (actor.role === 'ADMIN') {
    // The ONLY role that reads across branches, and it must be named rather than
    // arrived at by elimination. Written as `else if (branchId !== undefined)`,
    // this branch let every non-receptionist role through with an empty filter:
    // TECHNICAL and BOOKING_DEPARTMENT are neither a shift role nor an Admin, so
    // they matched no arm and inherited "no filter at all".
    if (filter.branchId !== undefined) where.branchId = filter.branchId;
  } else {
    throw ApiError.forbidden('Bạn không có quyền xem bàn giao ca.');
  }
  if (filter.start || filter.end) {
    where.createdAt = {
      ...(filter.start ? { gte: filter.start } : {}),
      ...(filter.end ? { lt: filter.end } : {}),
    };
  }
  return client.shiftHandoverNote.findMany({
    where,
    select: NOTE_SELECT,
    orderBy: { createdAt: 'desc' },
    take: filter.take ?? 50,
  });
}

/**
 * How many notes the period ACTUALLY holds — see `countHandovers` for why this
 * is counted rather than taken from the capped list's length.
 *
 * Applies the SAME authorization as the list by delegating the scope decision to
 * it: a count that could be taken across branches when the list could not would
 * leak the shape of other branches' activity.
 */
export async function countHandoverNotes(
  actor: ShiftActor,
  filter: HandoverNoteFilter,
  client: PrismaClient = prisma,
): Promise<number> {
  const where: Prisma.ShiftHandoverNoteWhereInput = {};
  if (isShiftRole(actor.role)) {
    where.branchId = actor.branchId ?? -1;
  } else if (actor.role === 'ADMIN') {
    if (filter.branchId !== undefined) where.branchId = filter.branchId;
  } else {
    throw ApiError.forbidden('Bạn không có quyền xem bàn giao ca.');
  }
  if (filter.start || filter.end) {
    where.createdAt = {
      ...(filter.start ? { gte: filter.start } : {}),
      ...(filter.end ? { lt: filter.end } : {}),
    };
  }
  return client.shiftHandoverNote.count({ where });
}

export interface PendingWork {
  /** Incidents at this branch nobody has finished. */
  openIssues: { id: string; location: string; status: string; needsRework: boolean }[];
  /** Orders reception still has to act on, by the queue they are sitting in. */
  bookings: { awaitingCreation: number; awaitingReview: number; needsRecreation: number };
}

/**
 * "VIỆC ĐANG TỒN" — what is still outstanding at this branch, right now.
 *
 * Read-only context for the form. It exists so the receptionist does not have to
 * retype what the application already knows, and so the note they DO write is
 * about the things only a person could know.
 *
 * Counted per queue rather than as one number, because "three orders" and "three
 * orders waiting on the Admin" ask different things of the next shift.
 */
export async function pendingWork(
  branchId: number,
  client: PrismaClient = prisma,
): Promise<PendingWork> {
  const [issues, awaitingCreation, awaitingReview, needsRecreation] = await Promise.all([
    client.hotelIssue.findMany({
      where: { branchId, status: { in: outstandingStatuses() } },
      select: {
        id: true,
        status: true,
        roomNumber: true,
        floorNumber: true,
        areaSubtype: true,
        locationDetail: true,
        areaCategory: true,
        // `take: 1` — this asks whether the incident has EVER been worked, not
        // how often, so one row is the whole answer and loading the rest is
        // waste. A NEW incident with any attempt came back — "Không sửa được"
        // or a failed inspection — and both are "Cần sửa lại".
        attempts: { select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    client.booking.count({
      where: { ...NOT_DELETED, branchId, status: 'NEW', verificationStatus: 'NOT_SUBMITTED' },
    }),
    client.booking.count({
      where: { ...NOT_DELETED, branchId, status: 'NEW', verificationStatus: 'PENDING_REVIEW' },
    }),
    client.booking.count({
      where: { ...NOT_DELETED, branchId, status: 'NEW', verificationStatus: 'REJECTED' },
    }),
  ]);

  return {
    openIssues: issues.map((i) => ({
      id: i.id,
      // The same one-line place description every incident screen uses, so the
      // handover names a room exactly as the incident queue does.
      location: describeLocation(i),
      status: i.status,
      needsRework: i.status === 'NEW' && i.attempts.length > 0,
    })),
    bookings: { awaitingCreation, awaitingReview, needsRecreation },
  };
}
