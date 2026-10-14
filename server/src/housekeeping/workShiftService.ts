/**
 * BỘ PHẬN BUỒNG PHÒNG'S WORKDAY — "Vào ca", "Đổi chi nhánh", "Kết thúc ca".
 *
 * A housekeeping account has no permanent branch. Its workday is a SESSION, and
 * the session is a run of SEGMENTS, one per branch: "Vào ca" opens the session
 * and its first segment (branch + "Tên người dọn buồng"), "Đổi chi nhánh" closes
 * the open segment and opens the next, "Kết thúc ca" closes both. The OPEN
 * segment is where the account works — `middleware/auth.ts` reads it on every
 * request, so every branch check downstream follows the shift.
 *
 * NOTHING IS REWRITTEN. A closed segment keeps its branch, cleaner, start and
 * end; its inspections point at it (`RoomInspection.workSegmentId`), so the
 * rooms and findings of each segment are counted from the records themselves.
 * Collection — money — is never part of any of it.
 */
import type { Prisma, PrismaClient, RoomIssueType, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { isReceptionSupervisor, scopedBranchFilter } from '../auth/branchScope';
import { ROOM_ISSUE_TYPE_LABELS } from './roomIssueTypes';
import {
  MAX_ADDRESS_CHARS,
  WORKPLACE_AMBIGUOUS,
  WORKPLACE_NOT_FOUND,
  WORKPLACE_REQUIRED,
  resolveWorkplace,
} from './workplaceAddress';

export interface ShiftActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
  managedBranchIds?: readonly number[];
}

const SESSION_INCLUDE = {
  user: { select: { id: true, fullName: true } },
  segments: {
    orderBy: { startedAt: 'asc' },
    include: {
      branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
      inspections: { select: { roomNumber: true, issues: { select: { type: true, voidedAt: true } } } },
    },
  },
} satisfies Prisma.HousekeepingWorkSessionInclude;

type SessionRow = Prisma.HousekeepingWorkSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

/** Rooms, inspections and findings (voided ones excluded), with the findings by type. */
function tally(inspections: { roomNumber: string; issues: { type: RoomIssueType; voidedAt: Date | null }[] }[]) {
  const byType = new Map<RoomIssueType, number>();
  let issues = 0;
  for (const inspection of inspections) {
    for (const issue of inspection.issues) {
      if (issue.voidedAt) continue;
      issues += 1;
      byType.set(issue.type, (byType.get(issue.type) ?? 0) + 1);
    }
  }
  return {
    rooms: new Set(inspections.map((i) => i.roomNumber)).size,
    inspections: inspections.length,
    issues,
    byType: [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, label: ROOM_ISSUE_TYPE_LABELS[type], count })),
  };
}

export function serializeShift(row: SessionRow) {
  const segments = row.segments.map((segment) => ({
    id: segment.id,
    branch: segment.branch,
    staffName: segment.staffName,
    startedAt: segment.startedAt.toISOString(),
    endedAt: segment.endedAt ? segment.endedAt.toISOString() : null,
    ...tally(segment.inspections),
  }));
  return {
    id: row.id,
    user: row.user,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    segments,
    /** The open segment — where the account works now — or null once ended. */
    current: segments.find((s) => s.endedAt === null) ?? null,
    totals: tally(row.segments.flatMap((s) => s.inspections)),
  };
}

export type SerializedShift = ReturnType<typeof serializeShift>;

/**
 * Who works a housekeeping shift: Bộ phận buồng phòng, and the Quản lý buồng
 * phòng when it does the room work itself — always at its OWN assigned branch.
 */
function assertHousekeeping(actor: ShiftActor): void {
  if (actor.role !== 'HOUSEKEEPING' && actor.role !== 'HOUSEKEEPING_MANAGER') {
    throw ApiError.forbidden('Chỉ bộ phận buồng phòng mới vào ca buồng phòng.');
  }
}

/** The address lookup is a housekeeper's: a manager's branch is already its assigned one. */
function assertHousekeeper(actor: ShiftActor): void {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới tra địa chỉ khách sạn.');
}

function cleanerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw ApiError.validation('Vui lòng nhập tên người dọn buồng.');
  if (name.length > 100) throw ApiError.validation('Tên người dọn buồng quá dài.');
  return name;
}

export const NO_BRANCH_MESSAGE = 'Bạn cần "Vào ca" tại khách sạn đang làm việc trước.';

/**
 * THE BRANCH IS THE SHIFT'S — the hotel named at "Vào ca", which
 * `middleware/auth.ts` puts on the session's user for every request. A request
 * that names another branch is refused; an account not on shift has no branch
 * and cannot do branch work at all.
 */
export function accountBranch(actor: { branchId: number | null }, requested?: unknown): number {
  if (actor.branchId === null) throw ApiError.forbidden(NO_BRANCH_MESSAGE);
  if (requested !== undefined && requested !== null && Number(requested) !== actor.branchId) {
    throw ApiError.branchAccessDenied('Bạn chỉ làm việc tại chi nhánh được Admin gán cho tài khoản.');
  }
  return actor.branchId;
}

async function activeBranch(branchId: unknown, client: PrismaClient): Promise<number> {
  const id = Number(branchId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation('Vui lòng chọn chi nhánh.');
  const branch = await client.branch.findFirst({ where: { id, active: true }, select: { id: true } });
  if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ.');
  return branch.id;
}

async function openSession(userId: number, client: PrismaClient): Promise<SessionRow | null> {
  return client.housekeepingWorkSession.findFirst({ where: { userId, endedAt: null }, include: SESSION_INCLUDE });
}

/** The account's open workday, or null — "Vào ca" has not been pressed. */
export async function currentShift(actor: ShiftActor, client: PrismaClient = defaultPrisma) {
  assertHousekeeping(actor);
  const row = await openSession(actor.id, client);
  return row ? serializeShift(row) : null;
}

/** The one active branch the typed address identifies — or the neutral refusal. */
async function resolveTyped(raw: unknown, client: PrismaClient): Promise<{ id: number; address: string }> {
  const typed = typeof raw === 'string' ? raw : '';
  if (!typed.trim()) throw ApiError.validation(WORKPLACE_REQUIRED);
  if (typed.length > MAX_ADDRESS_CHARS) throw ApiError.validation(WORKPLACE_NOT_FOUND);
  const candidates = await client.branch.findMany({ where: { active: true }, select: { id: true, address: true } });
  const resolved = resolveWorkplace(typed, candidates);
  if (resolved.status === 'AMBIGUOUS') throw ApiError.validation(WORKPLACE_AMBIGUOUS);
  if (resolved.status === 'NONE') throw ApiError.validation(WORKPLACE_NOT_FOUND);
  return candidates.find((c) => c.id === resolved.branchId)!;
}

/**
 * "Vào ca" — step one: what the typed start of an address identifies. ONLY the
 * single branch it uniquely fits is named back (its address and number), so the
 * housekeeper can confirm it; too little or several fits is one generic "nhập
 * thêm", nothing a refusal ever names. Never a list, never a count.
 */
export async function lookupWorkplace(actor: ShiftActor, input: { address?: unknown }, client: PrismaClient = defaultPrisma) {
  assertHousekeeper(actor);
  const typed = typeof input.address === 'string' ? input.address : '';
  if (!typed.trim()) return { status: 'AMBIGUOUS' as const, message: WORKPLACE_AMBIGUOUS };
  try {
    const branch = await resolveTyped(typed, client);
    const row = await client.branch.findUniqueOrThrow({ where: { id: branch.id }, select: { address: true, branchNumber: true } });
    return { status: 'RESOLVED' as const, branch: { address: row.address, branchNumber: row.branchNumber } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      return { status: error.message === WORKPLACE_NOT_FOUND ? ('NONE' as const) : ('AMBIGUOUS' as const), message: error.message };
    }
    throw error;
  }
}

/**
 * "Vào ca": the workday, at the hotel the housekeeper named. One open workday
 * per account.
 *
 * THE HOUSEKEEPER NAMES THE HOTEL BY ITS ADDRESS (`address`), typed — no list
 * is ever offered — and the shift opens at the ONE active branch that address
 * identifies (`resolveWorkplace`), resolved again here on the server: nothing
 * the browser sends picks the branch. Bộ phận buồng phòng has no permanent
 * branch; this shift's is the branch of all its work until "Kết thúc ca". The
 * address itself is not stored.
 */
export async function startShift(
  actor: ShiftActor,
  input: { branchId?: unknown; staffName?: unknown; address?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  assertHousekeeping(actor);
  // A Quản lý buồng phòng works where it manages — the Admin's assignment, never
  // an address or a branch the request names. A housekeeper names the hotel.
  const branchId =
    actor.role === 'HOUSEKEEPING_MANAGER'
      ? await activeBranch(accountBranch(actor), client)
      : await activeBranch((await resolveTyped(input.address, client)).id, client);
  // THE PERSON IS THE ACCOUNT: nobody types their own name any more.
  const staffName = cleanerName(input.staffName === undefined || input.staffName === '' ? actor.fullName : input.staffName);
  if (await openSession(actor.id, client)) throw ApiError.conflict('Bạn đang trong ca. Hãy "Kết thúc ca" trước khi vào ca ở khách sạn khác.');
  const now = clock.now();
  try {
    const row = await client.housekeepingWorkSession.create({
      data: { userId: actor.id, startedAt: now, segments: { create: { branchId, staffName, startedAt: now } } },
      include: SESSION_INCLUDE,
    });
    return serializeShift(row);
  } catch (error) {
    // The partial unique index: a second "Vào ca" racing the first.
    if ((error as { code?: string }).code === 'P2002') throw ApiError.conflict('Bạn đang trong ca.');
    throw error;
  }
}

/**
 * "Đổi chi nhánh" by a branch id is no longer offered: a branch is named only by
 * its address at "Vào ca". To work at another hotel: "Kết thúc ca", then "Vào
 * ca" there. Kept as a refusal so an older client gets an answer, not a 404.
 */
export async function switchShiftBranch(actor: ShiftActor): Promise<never> {
  assertHousekeeping(actor);
  throw ApiError.conflict('Muốn làm ở khách sạn khác: "Kết thúc ca" rồi "Vào ca" bằng địa chỉ khách sạn đó.');
}

/** "Kết thúc ca": the open segment and the workday end now. Returns the day's summary. */
export async function endShift(actor: ShiftActor, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  assertHousekeeping(actor);
  const session = await openSession(actor.id, client);
  if (!session) throw ApiError.conflict('Bạn chưa vào ca.');
  const now = clock.now();
  await client.$transaction(async (tx) => {
    await tx.housekeepingWorkSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt: now } });
    await tx.housekeepingWorkSession.update({ where: { id: session.id }, data: { endedAt: now } });
  });
  const row = await client.housekeepingWorkSession.findUniqueOrThrow({ where: { id: session.id }, include: SESSION_INCLUDE });
  return serializeShift(row);
}

/**
 * WORKDAYS ON RECORD, newest first. Bộ phận buồng phòng reads its own; the
 * Admin and the reception managers read every account's, each segment narrowed
 * to their branch scope (a workday with no segment in scope is left out).
 */
export async function listShifts(
  actor: ShiftActor,
  filter: { from?: Date; to?: Date; branchId?: number },
  client: PrismaClient = defaultPrisma,
) {
  const window: Prisma.HousekeepingWorkSessionWhereInput =
    filter.from || filter.to ? { startedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } } : {};
  let segmentScope: Prisma.HousekeepingWorkSegmentWhereInput = {};
  let where: Prisma.HousekeepingWorkSessionWhereInput;
  if (actor.role === 'HOUSEKEEPING') {
    where = { ...window, userId: actor.id };
    if (filter.branchId !== undefined) segmentScope = { branchId: filter.branchId };
  } else if (isReceptionSupervisor(actor.role) || actor.role === 'HOUSEKEEPING_MANAGER') {
    segmentScope = scopedBranchFilter(actor, filter.branchId);
    where = { ...window, segments: { some: segmentScope } };
  } else {
    throw ApiError.forbidden('Bạn không có quyền xem ca buồng phòng.');
  }
  const rows = await client.housekeepingWorkSession.findMany({
    where,
    include: { ...SESSION_INCLUDE, segments: { ...SESSION_INCLUDE.segments, where: segmentScope } },
    orderBy: { startedAt: 'desc' },
    take: 500,
  });
  return rows.map(serializeShift);
}

/** The open segment an inspection is recorded in — required: no shift, no inspection. */
export async function openSegmentFor(userId: number, client: PrismaClient = defaultPrisma) {
  const segment = await client.housekeepingWorkSegment.findFirst({
    where: { endedAt: null, session: { userId, endedAt: null } },
    include: { branch: { select: { code: true } } },
  });
  if (!segment) throw ApiError.conflict('Bạn cần "Vào ca" trước khi ghi nhận kiểm tra phòng.');
  return segment;
}
