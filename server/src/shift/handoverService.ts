/**
 * "ĐỔI CA" — one receptionist hands the desk to the next, before their shift
 * would otherwise have ended.
 *
 * THE CASE THIS EXISTS FOR
 *
 * A is on Ca A, 06:00–14:00. At 13:15 they have to leave. Somebody else takes
 * over. Until now the only way to record that was for A to walk away and for the
 * next person to check in — which left a gap where the application still
 * believed A was on the desk, and attributed to A every order created after they
 * had gone. This closes the gap at a single server instant.
 *
 * WHAT A HANDOVER IS, MECHANICALLY
 *
 *   outgoing session  closedAt  = T   (T is the SERVER's clock, once)
 *   incoming session  startedAt = T
 *   ShiftHandover                     links the two and records the reason
 *
 * All three happen in ONE transaction, so there is no instant at which the desk
 * has two receptionists or none.
 *
 * THE PLANNED SHIFT IS NOT SHORTENED — THE POINT OF A6
 *
 * The incoming session's `nominalEndAt` comes from `shiftBoundaries()`, which
 * derives it from the SHIFT'S OWN CLOCK TIME and not from how long the session
 * has been running. Ca B started early at 13:15 therefore still ends at 22:00
 * and still prompts at 22:10 — not at 21:25, which is what "actual start plus
 * eight hours" would have produced. Nothing in this file overrides that, and
 * nothing in this file knows what time Ca B ends; that knowledge exists once, in
 * `shiftTypes.ts`.
 *
 * ATTRIBUTION MOVES AT T, AND ONLY FORWARD
 *
 * Proof submission resolves the creator from whichever session is OPEN at the
 * moment of submission (`booking/proof.ts`), and a proof row is immutable once
 * written. So everything A submitted before T stays A's for ever, everything
 * after T belongs to the incoming shift, and no record is rewritten by the
 * handover. There is no code here that touches an existing proof, and there must
 * never be.
 */
import type { HandoverPriority, Prisma, PrismaClient, ShiftType } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { shiftBoundaries, shiftDefinition, shiftWindowLabel } from './shiftTypes';
import {
  findOpenSession,
  isShiftRole,
  requireOpenSession,
  serializeShiftSession,
  type ShiftActor,
  type ShiftSessionRow,
} from './shiftService';

/** The unique index that makes "one open session per user" a database fact. */
const ONE_OPEN_PER_USER = 'ReceptionShiftSession_one_open_per_user';

export interface HandoverInput {
  reason: string;
  incomingName: string;
  incomingShiftType: ShiftType;
  /**
   * The account the incoming shift should run under, when the incoming person
   * has one of their own. Omitted is the NORMAL case — a branch runs one login
   * across a rotating team — and means the desk changes hands without the
   * account changing.
   */
  incomingUserId?: number;
  /** An optional "Bàn giao ca" note written at the same moment. */
  note?: { content: string; priority?: HandoverPriority };
}

const HANDOVER_SELECT = {
  id: true,
  branchId: true,
  outgoingShiftSessionId: true,
  incomingShiftSessionId: true,
  outgoingUserId: true,
  outgoingNameSnapshot: true,
  outgoingShiftType: true,
  incomingUserId: true,
  incomingNameSnapshot: true,
  incomingShiftType: true,
  actualHandoverAt: true,
  reason: true,
  createdAt: true,
  branch: { select: { id: true, code: true, hotelName: true, address: true } },
} satisfies Prisma.ShiftHandoverSelect;

export type HandoverRow = Prisma.ShiftHandoverGetPayload<{ select: typeof HANDOVER_SELECT }>;

/** The on-the-wire shape. Shift WINDOWS are built here so they exist once. */
export function serializeHandover(row: HandoverRow) {
  return {
    id: row.id,
    branchId: row.branchId,
    branch: row.branch,
    outgoing: {
      shiftSessionId: row.outgoingShiftSessionId,
      userId: row.outgoingUserId,
      name: row.outgoingNameSnapshot,
      shiftType: row.outgoingShiftType,
      shiftName: shiftDefinition(row.outgoingShiftType).name,
      shiftWindow: shiftWindowLabel(row.outgoingShiftType),
    },
    incoming: {
      shiftSessionId: row.incomingShiftSessionId,
      // Null when the desk changed hands without the account changing — that is
      // the common case, not a missing value.
      userId: row.incomingUserId,
      name: row.incomingNameSnapshot,
      shiftType: row.incomingShiftType,
      shiftName: shiftDefinition(row.incomingShiftType).name,
      shiftWindow: shiftWindowLabel(row.incomingShiftType),
    },
    actualHandoverAt: row.actualHandoverAt.toISOString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export type SerializedHandover = ReturnType<typeof serializeHandover>;

/**
 * Resolves, and authorises, the account the incoming shift will run under.
 *
 * THE THREE REFUSALS, AND WHY EACH ONE IS HERE
 *
 *   NOT A RECEPTIONIST — a shift is a reception concept. Binding one to an Admin
 *   or a technician would put a name in the creator column of orders that role
 *   cannot create.
 *
 *   ANOTHER BRANCH — "unauthorized cross-branch takeover". A receptionist at CN2
 *   must not end up holding the open session for CN1, because every subsequent
 *   branch check would then pass for the wrong property.
 *
 *   ALREADY ON SHIFT — accepting this would mean either two open sessions for
 *   one person (which the database refuses anyway) or silently closing the shift
 *   they are currently working somewhere else. Both are worse than a clear
 *   refusal, so it is refused here with a message that says which.
 */
async function resolveIncomingUser(
  input: HandoverInput,
  outgoing: ShiftSessionRow,
  actor: ShiftActor,
  client: PrismaClient | Prisma.TransactionClient,
): Promise<number> {
  // No account named, or the same one: the desk changes hands, the login does
  // not. The outgoing session is closed in the same transaction, so this user's
  // "already on shift" is precisely the session being handed over.
  if (input.incomingUserId === undefined || input.incomingUserId === actor.id) {
    return actor.id;
  }

  const incoming = await client.user.findUnique({
    where: { id: input.incomingUserId },
    select: { id: true, role: true, branchId: true, active: true },
  });
  if (!incoming || !incoming.active) {
    throw ApiError.validation('Tài khoản người nhận ca không hợp lệ.');
  }
  if (!isShiftRole(incoming.role)) {
    throw ApiError.validation('Người nhận ca phải là tài khoản lễ tân.');
  }
  if (incoming.branchId !== outgoing.branchId) {
    throw ApiError.branchAccessDenied('Người nhận ca không thuộc chi nhánh này.');
  }

  const theirs = await findOpenSession(incoming.id, client);
  if (theirs) {
    throw ApiError.conflict('Người nhận ca đang có một ca làm việc khác chưa kết thúc.', {
      shiftType: theirs.shiftType,
    });
  }

  return incoming.id;
}

export interface HandoverResult {
  handover: HandoverRow;
  /** The session that is now open. */
  session: ShiftSessionRow;
}

/**
 * Performs the handover.
 *
 * THE TIMESTAMP IS TAKEN ONCE, HERE, FROM THE SERVER.
 *
 * Not from the request, and not twice. A client-supplied instant would let a
 * reception PC with a wrong clock decide which receptionist owns the orders
 * around the boundary; reading the clock twice would leave a sliver between the
 * old session's end and the new one's start in which an order belongs to nobody.
 */
export async function handoverShift(
  input: HandoverInput,
  actor: ShiftActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<HandoverResult> {
  if (!isShiftRole(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân mới đổi được ca làm việc.');
  }

  // Trimmed BEFORE the emptiness check, so "   " is refused like "".
  const reason = input.reason.trim();
  if (!reason) throw ApiError.validation('Vui lòng nhập lý do đổi ca.');
  const incomingName = input.incomingName.trim();
  if (!incomingName) throw ApiError.validation('Vui lòng nhập họ tên người nhận ca.');
  const noteContent = input.note ? input.note.content.trim() : '';
  if (input.note && !noteContent) {
    throw ApiError.validation('Vui lòng nhập nội dung bàn giao.');
  }

  // There must be a shift TO hand over. Refused with the code the client already
  // knows how to act on, rather than a new one meaning the same thing.
  const outgoing = await requireOpenSession(actor, client);

  const now = clock.now();
  const { nominalEndAt, graceEndAt } = shiftBoundaries(input.incomingShiftType, now);

  try {
    return await client.$transaction(async (tx) => {
      const incomingUserId = await resolveIncomingUser(input, outgoing, actor, tx);

      /*
        Guarded on `closedAt: null`, so two confirmations of the same handover
        produce one winner. Reading the session and then closing it — which is
        what an unguarded `update` would be — lets both pass and creates two
        incoming sessions for one departure.
      */
      const { count } = await tx.receptionShiftSession.updateMany({
        where: { id: outgoing.id, closedAt: null },
        data: { closedAt: now },
      });
      if (count === 0) {
        throw ApiError.conflict('Ca làm việc này đã kết thúc ở nơi khác. Vui lòng tải lại trang.');
      }

      const session = await tx.receptionShiftSession.create({
        data: {
          branchId: outgoing.branchId,
          userId: incomingUserId,
          shiftType: input.incomingShiftType,
          receptionistName: incomingName,
          startedAt: now,
          nominalEndAt,
          graceEndAt,
        },
        select: SESSION_FIELDS,
      });

      const handover = await tx.shiftHandover.create({
        data: {
          branchId: outgoing.branchId,
          outgoingShiftSessionId: outgoing.id,
          incomingShiftSessionId: session.id,
          outgoingUserId: outgoing.userId,
          outgoingNameSnapshot: outgoing.receptionistName,
          outgoingShiftType: outgoing.shiftType,
          // Recorded only when a DIFFERENT account takes over; null otherwise
          // says "same login, different person", which is the truth.
          incomingUserId: incomingUserId === actor.id ? null : incomingUserId,
          incomingNameSnapshot: incomingName,
          incomingShiftType: input.incomingShiftType,
          actualHandoverAt: now,
          reason,
          // The same instant the sessions changed hands on. `createdAt` has a
          // database default, and letting PostgreSQL's clock set it would give
          // one event two timestamps from two different clocks.
          createdAt: now,
        },
        select: HANDOVER_SELECT,
      });

      if (input.note) {
        await tx.shiftHandoverNote.create({
          data: {
            branchId: outgoing.branchId,
            // Attributed to the session that WROTE it — the outgoing one.
            shiftSessionId: outgoing.id,
            handoverId: handover.id,
            outgoingUserId: outgoing.userId,
            outgoingNameSnapshot: outgoing.receptionistName,
            outgoingShiftType: outgoing.shiftType,
            incomingNameSnapshot: incomingName,
            incomingShiftType: input.incomingShiftType,
            content: noteContent,
            priority: input.note.priority ?? 'NORMAL',
            // Stamped with the handover's own instant, so the note and the
            // shift change it belongs to appear in the same reporting period —
            // which the database's own clock cannot guarantee.
            createdAt: now,
          },
        });
      }

      return { handover, session };
    });
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = String(error.meta?.target ?? '');
      if (target.includes(ONE_OPEN_PER_USER)) {
        throw ApiError.conflict('Người nhận ca đã bắt đầu một ca khác. Vui lòng tải lại trang.');
      }
      if (target.includes('ShiftHandover_outgoingShiftSessionId_key')) {
        throw ApiError.conflict('Ca làm việc này đã được bàn giao. Vui lòng tải lại trang.');
      }
    }
    throw error;
  }
}

/**
 * The session columns this module needs, kept identical to `shiftService`'s own
 * selection so the two cannot return differently-shaped sessions.
 */
const SESSION_FIELDS = {
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

export interface HandoverFilter {
  /** Half-open [start, end) over the handover instant. */
  start?: Date;
  end?: Date;
  branchId?: number;
  take?: number;
}

/**
 * Handover history, newest first.
 *
 * READ ONLY, AND THERE IS NO WRITE PATH BESIDE IT. A handover is an event that
 * happened; the only honest correction to a wrong one is another handover, so
 * this module deliberately exposes no update and no delete.
 */
function handoverWhere(filter: HandoverFilter): Prisma.ShiftHandoverWhereInput {
  const where: Prisma.ShiftHandoverWhereInput = {};
  if (filter.branchId !== undefined) where.branchId = filter.branchId;
  if (filter.start || filter.end) {
    where.actualHandoverAt = {
      ...(filter.start ? { gte: filter.start } : {}),
      ...(filter.end ? { lt: filter.end } : {}),
    };
  }
  return where;
}

export async function listHandovers(
  filter: HandoverFilter,
  client: PrismaClient = prisma,
): Promise<HandoverRow[]> {
  return client.shiftHandover.findMany({
    where: handoverWhere(filter),
    select: HANDOVER_SELECT,
    orderBy: { actualHandoverAt: 'desc' },
    take: filter.take ?? 200,
  });
}

/**
 * How many handovers the period ACTUALLY holds.
 *
 * Counted separately from the list because the list is capped. Printing
 * `rows.length` as the period's total meant a quarterly audit reported exactly
 * the cap — "Tổng số lượt đổi ca: 1000" — while silently omitting everything
 * older, so the operator got a wrong figure and a period that quietly started
 * later than the one they asked for.
 */
export async function countHandovers(
  filter: HandoverFilter,
  client: PrismaClient = prisma,
): Promise<number> {
  return client.shiftHandover.count({ where: handoverWhere(filter) });
}

/** Convenience for the routes: the new session in the shape the client expects. */
export function serializeHandoverResult(result: HandoverResult, now: Date) {
  return {
    handover: serializeHandover(result.handover),
    session: serializeShiftSession(result.session, now),
  };
}
