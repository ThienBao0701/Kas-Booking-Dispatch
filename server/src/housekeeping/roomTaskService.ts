/**
 * "TÌNH TRẠNG PHÒNG" — the daily room work, from the Quản lý buồng phòng's board
 * to the worker's finished room.
 *
 *   MANAGER (Quản lý buồng phòng, its ONE branch; the Admin, every branch)
 *     sets each room's operational code for the day, priority and instruction,
 *     assigns and reassigns the worker, edits, voids — every act an event.
 *   WORKER (Bộ phận buồng phòng, the authenticated account — never a typed name)
 *     sees its own rooms, opens one, saves "Kiểm phòng" (which STARTS the cleaning
 *     timer, at the inspection's own time), fills "Dọn phòng", completes.
 *
 * THE ROOM CODE AND THE CLEANING STATE ARE TWO FIELDS: \`statusCode\` (OUT / OC /
 * VC) is the manager's; \`state\` (chưa bắt đầu / đang dọn / hoàn thành) is the
 * work's. Neither is derived from the other.
 *
 * NOTHING IS DELETED. "Xóa" voids an item; its inspection, findings, collections
 * and event history stay, so a KPI or a collection can always be explained.
 */
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { branchScopeOf, scopeIncludes, type BranchScope } from '../auth/branchScope';
import { catalogRoom } from '../room/branchRooms';
import { createInspection, type HousekeepingActor } from './roomIssueService';
import { ROOM_COLLECTION_STATUS_LABELS, ROOM_ISSUE_TYPE_LABELS } from './roomIssueTypes';
import { ROOM_REVIEW_LABELS, ROOM_WORK_STATE_LABELS, assertStatusCode, parseCleaningForm, readCleaning } from './roomTaskCatalog';
import { accountBranch, openSegmentFor } from './workShiftService';
import { can } from '../auth/capabilities';
import {
  AREA_KIND_LABELS,
  WORK_PHASE_LABELS,
  normalizeTaskCodes,
  placeLabel,
  taskCodesOf,
  taskLabel,
  workAreasFor,
  workPhase,
} from './workAreas';
import { notifyOperational } from '../push/pushService';

export const TASK_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  inspection: {
    include: { issues: { include: { collection: true }, orderBy: { createdAt: 'asc' } } },
  },
  events: { orderBy: { createdAt: 'asc' } },
  // A re-clean names the failed cycle it repeats — and why it failed.
  previousTask: { select: { id: true, cycleNumber: true, failureReason: true, reviewedAt: true, reviewedByNameSnapshot: true } },
  recleanTask: { select: { id: true, cycleNumber: true } },
  // "Công việc N" — the work group the item belongs to (null on older items).
  workGroup: { select: { id: true, number: true, name: true, assigneeUserId: true, assigneeNameSnapshot: true } },
} satisfies Prisma.HousekeepingRoomTaskInclude;

export type TaskRow = Prisma.HousekeepingRoomTaskGetPayload<{ include: typeof TASK_INCLUDE }>;

const EVENT_LABELS: Record<TaskRow['events'][number]['type'], string> = {
  CREATED: 'Tạo công việc',
  UPDATED: 'Sửa chỉ dẫn',
  ASSIGNED: 'Giao việc',
  OPENED: 'Mở phòng',
  INSPECTED: 'Kiểm phòng',
  CLEANING_SAVED: 'Lưu dọn phòng',
  COMPLETED: 'Hoàn thành dọn phòng',
  VOIDED: 'Xóa',
  REVIEWED: 'Đánh giá chất lượng',
  STARTED: 'Bắt đầu dọn',
  ACCEPTED: 'Nhận việc',
  INSPECTION_STARTED: 'Bắt đầu kiểm tra',
  CLAIM_REJECTED: 'Nhận việc không thành công',
  NO_CLEAN_REQUESTED: 'Báo không cần dọn',
  NO_CLEAN_APPROVED: 'Duyệt không cần dọn',
  NO_CLEAN_REJECTED: 'Từ chối không cần dọn',
};

const REVIEWED_LOCKED = 'Phòng này đã được đánh giá — lần dọn đã đánh giá không thể thay đổi.';

/**
 * The manager's review of one cycle: null before "Hoàn thành", PENDING ("Chờ
 * đánh giá") after it, then PASSED or FAILED — once, never changed.
 */
function reviewOf(row: TaskRow) {
  if (row.reviewResult) {
    return {
      status: row.reviewResult,
      label: ROOM_REVIEW_LABELS[row.reviewResult],
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedByName: row.reviewedByNameSnapshot,
      failureReason: row.failureReason,
      recleanRequested: row.recleanRequested,
    };
  }
  if (row.state === 'COMPLETED' && !row.voidedAt) {
    return { status: 'PENDING' as const, label: ROOM_REVIEW_LABELS.PENDING, reviewedAt: null, reviewedByName: null, failureReason: null, recleanRequested: false };
  }
  return null;
}

/**
 * The next cycle's number for one item (a room and day, and the item's key —
 * "" for the one-per-room items of the board) — every cycle counts, voided too.
 */
export async function nextCycle(
  tx: Prisma.TransactionClient,
  branchId: number,
  workDate: string,
  roomNumber: string,
  itemKey = '',
): Promise<number> {
  const { _max } = await tx.housekeepingRoomTask.aggregate({ where: { branchId, workDate, roomNumber, itemKey }, _max: { cycleNumber: true } });
  return (_max.cycleNumber ?? 0) + 1;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * Who may do what
 * ------------------------------------------------------------------ */

/** The Admin (every branch) and the Quản lý buồng phòng (its one branch). */
export function isRoomWorkManager(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'HOUSEKEEPING_MANAGER';
}

export function managerScope(actor: HousekeepingActor): BranchScope {
  if (!isRoomWorkManager(actor.role)) throw ApiError.forbidden('Chỉ quản lý buồng phòng hoặc Admin mới làm được việc này.');
  return branchScopeOf(actor);
}

/** A manager's branch for a write: its own, or — for the Admin — the one named. */
export async function managedBranch(actor: HousekeepingActor, requested: unknown, client: PrismaClient): Promise<{ id: number; code: string }> {
  const scope = managerScope(actor);
  const id = requested === undefined || requested === null ? (actor.role === 'HOUSEKEEPING_MANAGER' ? actor.branchId : null) : Number(requested);
  if (id === null || !Number.isInteger(id) || id <= 0) throw ApiError.validation('Vui lòng chọn chi nhánh.');
  if (!scopeIncludes(scope, id)) throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
  const branch = await client.branch.findFirst({ where: { id, active: true }, select: { id: true, code: true } });
  if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ.');
  return branch;
}

/** The branches a manager reads: one (asked for, in scope) or its whole scope. */
export function managerBranchWhere(actor: HousekeepingActor, branchId?: number): { branchId?: number | { in: number[] } } {
  const scope = managerScope(actor);
  if (branchId !== undefined) {
    if (!scopeIncludes(scope, branchId)) throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
    return { branchId };
  }
  return scope === 'ALL' ? {} : { branchId: { in: [...scope] } };
}

export function assertDate(raw: unknown): string {
  if (typeof raw !== 'string' || !DATE.test(raw)) throw ApiError.validation('Ngày không hợp lệ.');
  return raw;
}

export function text(raw: unknown, max: number, label: string): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > max) throw ApiError.validation(`${label} quá dài.`);
  return value || null;
}

export async function loadTask(id: string, client: PrismaClient): Promise<TaskRow> {
  const row = await client.housekeepingRoomTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy công việc phòng.');
  return row;
}

/** A manager may touch only its branch's items. */
export function assertManagerOf(row: TaskRow, actor: HousekeepingActor): void {
  if (!scopeIncludes(managerScope(actor), row.branchId)) throw ApiError.branchAccessDenied();
}

/**
 * A worker may touch only the rooms given to it — never another's, never by
 * branch. The worker is a housekeeper, or a Quản lý buồng phòng working a room
 * it accepted at its own branch.
 */
export function assertAssignee(row: TaskRow, actor: HousekeepingActor): void {
  if (actor.role !== 'HOUSEKEEPING' && actor.role !== 'HOUSEKEEPING_MANAGER') {
    throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới làm được việc này.');
  }
  if (row.branchId !== accountBranch(actor)) throw ApiError.branchAccessDenied();
  if (row.assigneeUserId !== actor.id) throw ApiError.forbidden('Phòng này không được giao cho bạn.');
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
}

/** How far back a shift at a branch still makes a housekeeper one of its staff. */
const BRANCH_STAFF_DAYS = 30;

/**
 * "NHÂN VIÊN CỦA CHI NHÁNH" — a Bộ phận buồng phòng account has no permanent
 * branch (it names the hotel at "Vào ca"), so a branch's staff is read from the
 * work itself: on shift there now, or a shift there in the last
 * BRANCH_STAFF_DAYS days. A `branchId` an older account still carries is not
 * used.
 */
export function branchStaffWhere(branchId: number, now: Date = getClock().now()): Prisma.UserWhereInput {
  const since = new Date(now.getTime() - BRANCH_STAFF_DAYS * 24 * 60 * 60 * 1000);
  return {
    role: 'HOUSEKEEPING',
    active: true,
    housekeepingSessions: { some: { segments: { some: { branchId, OR: [{ endedAt: null }, { startedAt: { gte: since } }] } } } },
  };
}

/** The active HOUSEKEEPING account the manager names — one of the branch's staff. */
export async function assignee(raw: unknown, branchId: number, client: PrismaClient): Promise<{ id: number; fullName: string } | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation('Nhân viên buồng phòng không hợp lệ.');
  const user = await client.user.findFirst({ where: { id, ...branchStaffWhere(branchId) }, select: { id: true, fullName: true } });
  if (!user) {
    throw ApiError.validation('Chỉ giao được cho nhân viên buồng phòng đang hoạt động và đã vào ca tại chi nhánh này (trong 30 ngày gần đây).');
  }
  return user;
}

export async function recordEvent(
  tx: Prisma.TransactionClient,
  taskId: string,
  type: TaskRow['events'][number]['type'],
  actor: HousekeepingActor,
  now: Date,
  detail?: Prisma.InputJsonValue,
): Promise<void> {
  await tx.housekeepingRoomTaskEvent.create({
    data: { taskId, type, actorUserId: actor.id, actorNameSnapshot: actor.fullName, actorRole: actor.role, detail, createdAt: now },
  });
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/**
 * One room work item as every screen reads it. \`money\` is the manager's and the
 * Admin's view of the findings' collections; the worker sees its findings, and
 * the money of its own KPI on its own KPI screen.
 */
export function serializeTask(row: TaskRow, opts: { money: boolean; now?: Date }) {
  const now = opts.now ?? getClock().now();
  return {
    id: row.id,
    branchId: row.branchId,
    branch: row.branch,
    workDate: row.workDate,
    roomNumber: row.roomNumber,
    statusCode: row.statusCode,
    priority: row.priority,
    note: row.note,
    /** The work item: where, what, and which submission it came in. */
    itemKey: row.itemKey,
    areaKind: row.areaKind,
    areaKindLabel: AREA_KIND_LABELS[row.areaKind],
    floor: row.floor,
    /** "Khu vực": "Phòng - 502", "Hành lang - Tầng 5". */
    areaLabel: placeLabel(row.areaKind, row.areaKind === 'ROOM' ? row.roomNumber : null, row.floor),
    taskName: row.taskName,
    /** "Việc cần làm": "OC", "OUT + Khác", "Khác". */
    taskLabel: taskLabel(row),
    /** The ticked codes — OUT / OC / VC (one at most) and/or OTHER. */
    taskCodes: taskCodesOf(row),
    groupId: row.groupId,
    /** "Công việc N" — null for an item created before work groups existed. */
    workGroup: row.workGroup ? { id: row.workGroup.id, number: row.workGroup.number, name: row.workGroup.name } : null,
    /** "Không cần dọn": the housekeeper's request and the manager's decision. */
    noClean: row.noCleanStatus
      ? {
          status: row.noCleanStatus,
          reason: row.noCleanReason,
          requestedAt: row.noCleanRequestedAt?.toISOString() ?? null,
          requestedByName: row.noCleanRequestedByNameSnapshot,
          decidedAt: row.noCleanDecidedAt?.toISOString() ?? null,
          decidedByName: row.noCleanDecidedByNameSnapshot,
          decisionNote: row.noCleanDecisionNote,
        }
      : null,
    /** Where the item stands, in the work's own order (see workAreas.workPhase). */
    phase: workPhase(row),
    phaseLabel: WORK_PHASE_LABELS[workPhase(row)],
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    inspectionStartedAt: row.inspectionStartedAt?.toISOString() ?? null,
    /** When the inspection was saved — the room inspection's own time on older rows. */
    inspectedAt: (row.inspectedAt ?? row.inspection?.createdAt)?.toISOString() ?? null,
    inspectionNote: row.inspectionNote,
    assignee: row.assigneeUserId ? { id: row.assigneeUserId, name: row.assigneeNameSnapshot ?? '—' } : null,
    state: row.state,
    stateLabel: ROOM_WORK_STATE_LABELS[row.state],
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    /** Running while the room is being cleaned; null otherwise. */
    elapsedSeconds:
      row.state === 'IN_PROGRESS' && row.startedAt ? Math.max(0, Math.round((now.getTime() - row.startedAt.getTime()) / 1000)) : null,
    inspection: row.inspection
      ? {
          id: row.inspection.id,
          createdAt: row.inspection.createdAt.toISOString(),
          inspectorId: row.inspection.createdByUserId,
          inspectorName: row.inspection.createdByNameSnapshot,
          findings: row.inspection.issues.map((i) => ({
            id: i.id,
            type: i.type,
            typeLabel: ROOM_ISSUE_TYPE_LABELS[i.type],
            note: i.note,
            voided: i.voidedAt !== null,
            collectionStatus: opts.money ? (i.collection?.status ?? 'PENDING') : null,
            collectionStatusLabel: opts.money ? ROOM_COLLECTION_STATUS_LABELS[i.collection?.status ?? 'PENDING'] : null,
            amount: opts.money ? (i.collection?.amount ?? null) : null,
            collectedByName: opts.money ? (i.collection?.recordedByNameSnapshot ?? null) : null,
            collectedAt: opts.money && i.collection?.status === 'COLLECTED' ? i.collection.updatedAt.toISOString() : null,
          })),
        }
      : null,
    cleaning: readCleaning(row.cleaning),
    cleanedBy: row.cleanedByUserId ? { id: row.cleanedByUserId, name: row.cleanedByNameSnapshot ?? '—' } : null,
    createdByName: row.createdByNameSnapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidedByName: row.voidedByNameSnapshot,
    voidReason: row.voidReason,
    /** 1, 2, … — this room's cleaning cycle that business day. */
    cycleNumber: row.cycleNumber,
    /** "Cần dọn lại": the failed cycle this one repeats, and the manager's reason. */
    reclean: row.previousTask
      ? {
          taskId: row.previousTask.id,
          cycleNumber: row.previousTask.cycleNumber,
          reason: row.previousTask.failureReason,
          reviewedByName: row.previousTask.reviewedByNameSnapshot,
          reviewedAt: row.previousTask.reviewedAt?.toISOString() ?? null,
        }
      : null,
    review: reviewOf(row),
    /** The re-clean this cycle's "Không đạt" opened, if any. */
    nextCycleId: row.recleanTask?.id ?? null,
    events: row.events.map((e) => ({
      id: e.id,
      type: e.type,
      label: EVENT_LABELS[e.type],
      actorName: e.actorNameSnapshot,
      actorRole: e.actorRole,
      detail: e.detail,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export type SerializedRoomTask = ReturnType<typeof serializeTask>;

/* ------------------------------------------------------------------ *
 * The manager's board
 * ------------------------------------------------------------------ */

export async function listTasks(
  actor: HousekeepingActor,
  filter: { workDate: string; branchId?: number; includeVoided?: boolean },
  client: PrismaClient = defaultPrisma,
) {
  const workDate = assertDate(filter.workDate);
  const rows = await client.housekeepingRoomTask.findMany({
    where: { ...managerBranchWhere(actor, filter.branchId), workDate, ...(filter.includeVoided ? {} : { voidedAt: null }) },
    include: TASK_INCLUDE,
    // A room's cycles in order, then its items as they were created.
    orderBy: [{ branchId: 'asc' }, { roomNumber: 'asc' }, { cycleNumber: 'asc' }, { createdAt: 'asc' }, { groupIndex: 'asc' }],
  });
  const now = getClock().now();
  return rows.map((r) => serializeTask(r, { money: true, now }));
}

export interface CreateTasksInput {
  branchId?: unknown;
  workDate: unknown;
  roomNumbers: unknown;
  statusCode: unknown;
  priority?: unknown;
  note?: unknown;
  assigneeUserId?: unknown;
}

/**
 * Sets up rooms on the board — one or several rooms, one code. A room that
 * already has a live item for the day is left as it is and named (edit it
 * instead); nothing is overwritten.
 */
export async function createTasks(
  actor: HousekeepingActor,
  input: CreateTasksInput,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managedBranch(actor, input.branchId, client);
  const workDate = assertDate(input.workDate);
  const statusCode = assertStatusCode(input.statusCode);
  const note = text(input.note, 1000, 'Ghi chú');
  const priority = input.priority === true;
  const rawRooms = Array.isArray(input.roomNumbers) ? input.roomNumbers : [];
  if (rawRooms.length === 0) throw ApiError.validation('Vui lòng chọn ít nhất một phòng.');
  if (rawRooms.length > 200) throw ApiError.validation('Tối đa 200 phòng mỗi lần.');
  const rooms = [...new Set(rawRooms.map((r) => {
    const typed = typeof r === 'string' ? r.trim() : '';
    if (!typed) throw ApiError.validation('Số phòng không hợp lệ.');
    return catalogRoom(branch.code, typed)!;
  }))];
  const person = await assignee(input.assigneeUserId, branch.id, client);
  // A room is taken while a cycle is OPEN (not voided, not yet reviewed); a
  // reviewed room — "Đạt", or "Không đạt" without a re-clean — can be added again.
  const existing = await client.housekeepingRoomTask.findMany({
    where: { branchId: branch.id, workDate, roomNumber: { in: rooms }, voidedAt: null, reviewResult: null },
    select: { roomNumber: true },
  });
  const taken = new Set(existing.map((e) => e.roomNumber));
  const now = clock.now();
  const created: { id: string; roomNumber: string }[] = [];
  await client.$transaction(async (tx) => {
    for (const roomNumber of rooms.filter((r) => !taken.has(r))) {
      const task = await tx.housekeepingRoomTask.create({
        data: {
          branchId: branch.id,
          workDate,
          roomNumber,
          cycleNumber: await nextCycle(tx, branch.id, workDate, roomNumber),
          statusCode,
          priority,
          note,
          assigneeUserId: person?.id ?? null,
          assigneeNameSnapshot: person?.fullName ?? null,
          createdByUserId: actor.id,
          createdByNameSnapshot: actor.fullName,
          createdAt: now,
        },
      });
      await recordEvent(tx, task.id, 'CREATED', actor, now, { statusCode, priority, note });
      if (person) await recordEvent(tx, task.id, 'ASSIGNED', actor, now, { fromId: null, fromName: null, toId: person.id, toName: person.fullName });
      created.push({ id: task.id, roomNumber });
    }
  });
  if (person && created.length > 0) await notifyAssignee(person.id, branch.id, created, now, client);
  return { created: created.length, skipped: [...taken] };
}

/**
 * "Công việc buồng phòng mới" — ONE notice per assignment, however many rooms:
 * "CN 1 · Phòng 101 · Dọn phòng", or "CN 1 · 3 phòng mới được giao". To the
 * worker the rooms were given to (always of this branch), in the bell and on
 * their devices; keyed by the assignment, so a retry cannot repeat it.
 */
export async function notifyAssignee(
  userId: number,
  branchId: number,
  tasks: { id: string; roomNumber: string }[],
  at: Date,
  client: PrismaClient,
): Promise<void> {
  const branch = await client.branch.findUnique({ where: { id: branchId }, select: { branchNumber: true } });
  const one = tasks.length === 1 ? tasks[0]! : null;
  const ids = tasks.map((t) => t.id).sort();
  await notifyOperational(
    [
      {
        userId,
        kind: 'HOUSEKEEPING_ASSIGNED',
        title: 'Công việc buồng phòng mới',
        body: one
          ? `CN ${branch?.branchNumber ?? ''} · Phòng ${one.roomNumber} · Dọn phòng`
          : `CN ${branch?.branchNumber ?? ''} · ${tasks.length} phòng mới được giao`,
        link: one ? `/app/inspections/room/${one.id}` : '/app/inspections',
        dedupeKey: `HOUSEKEEPING_ASSIGNED:${userId}:${ids[0]}+${ids.length}:${at.toISOString()}`,
      },
    ],
    client,
  );
}

/** "Dọn lại phòng 101" — "CN 1 · Phòng 101 · Không đạt", then the reason, short. */
async function notifyReclean(
  userId: number,
  branchId: number,
  task: { id: string; roomNumber: string },
  reason: string | null,
  client: PrismaClient,
): Promise<void> {
  const branch = await client.branch.findUnique({ where: { id: branchId }, select: { branchNumber: true } });
  const why = reason ? (reason.length > 100 ? `${reason.slice(0, 100)}…` : reason) : null;
  await notifyOperational(
    [
      {
        userId,
        kind: 'HOUSEKEEPING_RECLEAN',
        title: `Dọn lại phòng ${task.roomNumber}`,
        body: `CN ${branch?.branchNumber ?? ''} · Phòng ${task.roomNumber} · Không đạt${why ? `\nLý do: ${why}` : ''}`,
        link: `/app/inspections/room/${task.id}`,
        dedupeKey: `HOUSEKEEPING_RECLEAN:${task.id}`,
      },
    ],
    client,
  );
}

/** "Sửa": the code, priority and instruction — before and after kept in the history. */
export async function updateTask(
  actor: HousekeepingActor,
  id: string,
  input: { statusCode?: unknown; taskCodes?: unknown; priority?: unknown; note?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
  if (row.reviewResult) throw ApiError.conflict(REVIEWED_LOCKED);
  // A work group's item edits its ticked codes; an older item, its one code.
  const codes =
    input.taskCodes !== undefined
      ? normalizeTaskCodes(input.taskCodes, row.areaKind, AREA_KIND_LABELS[row.areaKind])
      : input.statusCode !== undefined
        ? { codes: row.taskCodes.length > 0 ? [assertStatusCode(input.statusCode)] : [], statusCode: assertStatusCode(input.statusCode) }
        : { codes: row.taskCodes, statusCode: row.statusCode };
  if (row.state === 'COMPLETED' && (codes.statusCode !== row.statusCode || codes.codes.join() !== row.taskCodes.join())) {
    throw ApiError.conflict('Phòng đã dọn xong — không đổi việc cần làm được nữa.');
  }
  const note = input.note === undefined ? row.note : text(input.note, 1000, 'Ghi chú');
  // "Khác" says what in its note — required whenever it is ticked, as at creation.
  if (row.workGroupId && (codes.codes.includes('OTHER') || row.areaKind !== 'ROOM') && !note) {
    throw ApiError.validation(row.areaKind === 'ROOM' ? '"Khác" cần ghi chú nêu rõ việc cần làm.' : 'Khu vực này cần ghi chú / hướng dẫn.');
  }
  const next = {
    statusCode: codes.statusCode,
    taskCodes: codes.codes,
    priority: input.priority === undefined ? row.priority : input.priority === true,
    note,
  };
  const before = { statusCode: row.statusCode, taskCodes: row.taskCodes, priority: row.priority, note: row.note };
  if (JSON.stringify(before) === JSON.stringify(next)) return serializeTask(row, { money: true });
  const now = clock.now();
  try {
    await client.$transaction(async (tx) => {
      await tx.housekeepingRoomTask.update({ where: { id }, data: next });
      await recordEvent(tx, id, 'UPDATED', actor, now, { before, after: next });
    });
  } catch (error) {
    // The room's OUT / OC / VC is single while open (a database index).
    if ((error as { code?: string }).code === 'P2002') {
      throw ApiError.conflict(`Phòng ${row.roomNumber} đã có việc ${codes.statusCode} đang mở trong ngày.`);
    }
    throw error;
  }
  return serializeTask(await loadTask(id, client), { money: true });
}

/** "Giao việc" / "Giao lại" — the current assignee changes; the history keeps every one. */
export async function assignTask(
  actor: HousekeepingActor,
  id: string,
  input: { assigneeUserId: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
  if (row.reviewResult) throw ApiError.conflict(REVIEWED_LOCKED);
  if (row.state === 'COMPLETED') throw ApiError.conflict('Phòng đã dọn xong, không thể giao lại.');
  // A work group is given out — and accepted — whole; never split room by room.
  if (row.workGroup) {
    throw ApiError.conflict(`Phòng này thuộc Công việc ${row.workGroup.number} — giao cả công việc trong "Chỉnh sửa".`);
  }
  const person = await assignee(input.assigneeUserId, row.branchId, client);
  if ((person?.id ?? null) === row.assigneeUserId) return serializeTask(row, { money: true });
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: { not: 'COMPLETED' }, assigneeUserId: row.assigneeUserId },
      data: { assigneeUserId: person?.id ?? null, assigneeNameSnapshot: person?.fullName ?? null },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'ASSIGNED', actor, now, {
      fromId: row.assigneeUserId,
      fromName: row.assigneeNameSnapshot,
      toId: person?.id ?? null,
      toName: person?.fullName ?? null,
    });
  });
  if (person) await notifyAssignee(person.id, row.branchId, [{ id, roomNumber: row.roomNumber }], now, client);
  return serializeTask(await loadTask(id, client), { money: true });
}

/** "Xóa": a void — the inspection, findings, collections and history all stay. */
export async function voidTask(
  actor: HousekeepingActor,
  id: string,
  input: { reason?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
  if (row.reviewResult) throw ApiError.conflict(REVIEWED_LOCKED);
  const reason = text(input.reason, 1000, 'Lý do');
  if (row.workGroupId) {
    // "Bỏ khỏi công việc": the room stays in the catalog and the item in the
    // history; only work that has not begun cleaning can be taken out.
    if (row.state === 'IN_PROGRESS') throw ApiError.conflict('Phòng đang được dọn — không thể bỏ khỏi công việc giữa chừng.');
    if (row.state === 'COMPLETED') throw ApiError.conflict('Phòng đã dọn xong — không thể bỏ khỏi công việc.');
    if (row.noCleanStatus === 'PENDING') throw ApiError.conflict('Phòng đang chờ duyệt "Không cần dọn" — hãy duyệt hoặc từ chối trước.');
    // Once somebody holds it, the removal says why.
    if ((row.assigneeUserId !== null || row.state !== 'NOT_STARTED') && !reason) {
      throw ApiError.validation('Phòng đã có người nhận — vui lòng nhập lý do bỏ khỏi công việc.');
    }
  }
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, ...(row.workGroupId ? { state: { in: ['NOT_STARTED', 'INSPECTED'] } } : {}) },
      data: { voidedAt: now, voidedByUserId: actor.id, voidedByNameSnapshot: actor.fullName, voidReason: reason },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'VOIDED', actor, now, { reason, state: row.state, ...(row.workGroup ? { group: row.workGroup.number } : {}) });
  });
}

export interface ReviewInput {
  result?: unknown;
  reason?: unknown;
  reclean?: unknown;
  assigneeUserId?: unknown;
}

/**
 * "ĐẠT" / "KHÔNG ĐẠT" — the manager's review of one finished cycle, given once.
 *
 *   Đạt        the room is released: back in "Thêm phòng vào bảng".
 *   Không đạt  needs "Lý do không đạt"; with "Yêu cầu dọn lại" it opens the NEXT
 *              cycle — the same room and day, a new row linked to this one —
 *              for the chosen worker of the branch (this cycle's, by default).
 *
 * This cycle — its worker, times, form and review — is never written again.
 */
export async function reviewTask(
  actor: HousekeepingActor,
  id: string,
  input: ReviewInput,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
  if (row.reviewResult) throw ApiError.conflict('Phòng này đã được đánh giá.');
  if (row.state !== 'COMPLETED') throw ApiError.conflict('Phòng chưa "Hoàn thành" — chưa thể đánh giá.');
  if (input.result !== 'PASSED' && input.result !== 'FAILED') throw ApiError.validation('Chọn "Đạt" hoặc "Không đạt".');
  const passed = input.result === 'PASSED';
  if (passed && input.reclean === true) throw ApiError.validation('"Yêu cầu dọn lại" chỉ đi cùng "Không đạt".');
  const reason = passed ? null : text(input.reason, 1000, 'Lý do không đạt');
  if (!passed && !reason) throw ApiError.validation('Vui lòng nhập lý do không đạt.');
  const reclean = !passed && input.reclean === true;
  // The re-clean's worker: the one named, or this cycle's own — always of the branch.
  const person = reclean
    ? await assignee(input.assigneeUserId === undefined ? row.assigneeUserId : input.assigneeUserId, row.branchId, client)
    : null;
  const now = clock.now();
  const nextId = await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: 'COMPLETED', reviewResult: null },
      data: {
        reviewResult: passed ? 'PASSED' : 'FAILED',
        reviewedAt: now,
        reviewedByUserId: actor.id,
        reviewedByNameSnapshot: actor.fullName,
        failureReason: reason,
        recleanRequested: reclean,
      },
    });
    if (count === 0) throw ApiError.conflict('Phòng vừa được đánh giá hoặc thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'REVIEWED', actor, now, { result: passed ? 'PASSED' : 'FAILED', reason, recleanRequested: reclean });
    if (!reclean) return null;
    const next = await tx.housekeepingRoomTask.create({
      data: {
        branchId: row.branchId,
        workDate: row.workDate,
        roomNumber: row.roomNumber,
        // The same ITEM again: its key, place and name.
        itemKey: row.itemKey,
        areaKind: row.areaKind,
        floor: row.floor,
        taskName: row.taskName,
        cycleNumber: await nextCycle(tx, row.branchId, row.workDate, row.roomNumber, row.itemKey),
        previousTaskId: id,
        statusCode: row.statusCode,
        priority: row.priority,
        note: row.note,
        assigneeUserId: person?.id ?? null,
        assigneeNameSnapshot: person?.fullName ?? null,
        createdByUserId: actor.id,
        createdByNameSnapshot: actor.fullName,
        createdAt: now,
      },
    });
    await recordEvent(tx, next.id, 'CREATED', actor, now, { recleanOf: row.cycleNumber, reason, statusCode: row.statusCode, priority: row.priority, note: row.note });
    if (person) await recordEvent(tx, next.id, 'ASSIGNED', actor, now, { fromId: null, fromName: null, toId: person.id, toName: person.fullName });
    return next.id;
  });
  if (nextId && person) await notifyReclean(person.id, row.branchId, { id: nextId, roomNumber: row.roomNumber }, reason, client);
  return {
    task: serializeTask(await loadTask(id, client), { money: true }),
    reclean: nextId ? serializeTask(await loadTask(nextId, client), { money: true }) : null,
  };
}

/** Every cycle of the room that business day, in order — voided ones marked — for the manager and the Admin. */
export async function roomHistory(actor: HousekeepingActor, id: string, client: PrismaClient = defaultPrisma) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  const rows = await client.housekeepingRoomTask.findMany({
    where: { branchId: row.branchId, workDate: row.workDate, roomNumber: row.roomNumber },
    include: TASK_INCLUDE,
    orderBy: { cycleNumber: 'asc' },
  });
  const now = getClock().now();
  return rows.map((r) => serializeTask(r, { money: true, now }));
}

/**
 * The people a manager can give a room to: the branch's own accounts (see
 * branchStaffWhere). The Admin without a branch reads every active one.
 */
export async function listStaff(actor: HousekeepingActor, query: { branchId?: unknown } = {}, client: PrismaClient = defaultPrisma) {
  const scope = managerScope(actor);
  const requested = query.branchId === '' ? undefined : query.branchId;
  const where: Prisma.UserWhereInput =
    scope === 'ALL' && requested === undefined
      ? { role: 'HOUSEKEEPING', active: true }
      : branchStaffWhere((await managedBranch(actor, requested, client)).id);
  return client.user.findMany({ where, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
}

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

/** "Không cần dọn" asked and not yet decided: the room waits for the manager. */
export function assertNotWaitingNoClean(row: TaskRow): void {
  if (row.noCleanStatus === 'PENDING') throw ApiError.conflict('Phòng đang chờ quản lý duyệt "Không cần dọn".');
}

/**
 * The rooms given to this account for the day, at its own branch, priority
 * first — the ones still to clean. "Hoàn thành" takes a room off the list (it
 * waits for the manager's review); a re-clean brings it back as a new cycle.
 */
export async function myTasks(actor: HousekeepingActor, workDateRaw: unknown, client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới có phòng được giao.');
  const branchId = accountBranch(actor);
  const workDate = assertDate(workDateRaw);
  const rows = await client.housekeepingRoomTask.findMany({
    where: { assigneeUserId: actor.id, branchId, workDate, voidedAt: null, state: { not: 'COMPLETED' } },
    include: TASK_INCLUDE,
    orderBy: [{ branchId: 'asc' }, { priority: 'desc' }, { roomNumber: 'asc' }, { cycleNumber: 'asc' }, { createdAt: 'asc' }],
  });
  const now = getClock().now();
  return rows.map((r) => serializeTask(r, { money: false, now }));
}

/** One item: its assignee, or a manager in scope. */
export async function getTask(actor: HousekeepingActor, id: string, client: PrismaClient = defaultPrisma) {
  const row = await loadTask(id, client);
  if (actor.role === 'HOUSEKEEPING') {
    if (row.branchId !== accountBranch(actor)) throw ApiError.branchAccessDenied();
    if (row.assigneeUserId !== actor.id) throw ApiError.forbidden('Phòng này không được giao cho bạn.');
    return serializeTask(row, { money: false });
  }
  assertManagerOf(row, actor);
  return serializeTask(row, { money: true });
}

/** "Mở phòng" — recorded once per worker; it starts nothing. */
export async function openTask(actor: HousekeepingActor, id: string, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  if (!row.events.some((e) => e.type === 'OPENED' && e.actorUserId === actor.id)) {
    await client.$transaction((tx) => recordEvent(tx, id, 'OPENED', actor, clock.now()));
  }
  return serializeTask(await loadTask(id, client), { money: false });
}

/**
 * "LƯU KIỂM TRA" — the shared inspection (findings optional: a clean room is a
 * result too), recorded at the room's branch on the open shift. The room becomes
 * "Đã kiểm tra" and NOTHING starts: no \`startedAt\`, no cleaning time. The
 * manager may still give it to another housekeeper; the inspection keeps its
 * own inspector. Cleaning starts only with "Bắt đầu dọn" (\`startTask\`).
 */
export async function inspectTask(
  actor: HousekeepingActor,
  id: string,
  input: { issues: { type: unknown; note?: unknown }[]; note?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  assertNotWaitingNoClean(row);
  if (row.state !== 'NOT_STARTED' || row.inspectionId) throw ApiError.conflict('Phòng này đã được kiểm.');
  if (row.areaKind !== 'ROOM') return inspectArea(actor, row, input, clock, client);
  await createInspection({ roomNumber: row.roomNumber, issues: input.issues }, actor, clock, client, {
    allowNoFindings: true,
    branchId: row.branchId,
    onCreated: async (tx, inspection) => {
      const { count } = await tx.housekeepingRoomTask.updateMany({
        where: { id, voidedAt: null, state: 'NOT_STARTED', inspectionId: null, assigneeUserId: actor.id },
        data: {
          state: 'INSPECTED',
          inspectionId: inspection.id,
          inspectedAt: inspection.createdAt,
          // Saved without "Kiểm tra" first (an older client): it began when it was saved.
          ...(row.inspectionStartedAt ? {} : { inspectionStartedAt: inspection.createdAt }),
        },
      });
      if (count === 0) throw ApiError.conflict('Phòng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
      await recordEvent(tx, id, 'INSPECTED', actor, inspection.createdAt, {
        inspectionId: inspection.id,
        findings: input.issues.length,
      });
    },
  });
  return serializeTask(await loadTask(id, client), { money: false });
}

/**
 * "BẮT ĐẦU DỌN" — the one action that starts the cleaning: "Đã kiểm tra" →
 * "Đang dọn", \`startedAt\` = now. Only the housekeeper the room is given to, and
 * only once: the update is guarded on the state, so a double tap or a retried
 * request finds it already started and changes nothing twice.
 */
export async function startTask(actor: HousekeepingActor, id: string, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  assertNotWaitingNoClean(row);
  if (row.state === 'NOT_STARTED') throw ApiError.conflict('Cần "Kiểm phòng" trước khi bắt đầu dọn.');
  if (row.state === 'IN_PROGRESS') throw ApiError.conflict('Phòng đang được dọn.');
  if (row.state === 'COMPLETED') throw ApiError.conflict('Phòng đã dọn xong.');
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: 'INSPECTED', startedAt: null, assigneeUserId: actor.id },
      data: { state: 'IN_PROGRESS', startedAt: now },
    });
    if (count === 0) throw ApiError.conflict('Phòng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'STARTED', actor, now);
  });
  return serializeTask(await loadTask(id, client), { money: false });
}

/** The cleaning form as it stands — "Lưu tạm", or before "Hoàn thành". */
async function writeCleaning(
  actor: HousekeepingActor,
  id: string,
  raw: unknown,
  complete: boolean,
  clock: Clock,
  client: PrismaClient,
) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  if (row.state === 'NOT_STARTED') throw ApiError.conflict('Cần "Kiểm phòng" trước khi dọn phòng.');
  if (row.state === 'INSPECTED' || !row.startedAt) throw ApiError.conflict('Cần "Bắt đầu dọn" trước khi dọn phòng.');
  if (row.state === 'COMPLETED') throw ApiError.conflict('Phòng đã dọn xong.');
  const form = parseCleaningForm(raw);
  const now = clock.now();
  const stored = { ...form, savedAt: now.toISOString(), savedByUserId: actor.id, savedByName: actor.fullName };
  await client.$transaction(async (tx) => {
    const durationSeconds = Math.max(0, Math.round((now.getTime() - row.startedAt!.getTime()) / 1000));
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: 'IN_PROGRESS', assigneeUserId: actor.id },
      data: complete
        ? {
            cleaning: stored,
            state: 'COMPLETED',
            completedAt: now,
            durationSeconds,
            cleanedByUserId: actor.id,
            cleanedByNameSnapshot: actor.fullName,
          }
        : { cleaning: stored },
    });
    if (count === 0) throw ApiError.conflict('Phòng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, complete ? 'COMPLETED' : 'CLEANING_SAVED', actor, now, {
      linen: Object.keys(form.linen).length,
      quantities: Object.keys(form.quantities).length,
      replaced: form.replaced.length,
      special: form.special.length,
      ...(complete ? { durationSeconds } : {}),
    });
  });
  return serializeTask(await loadTask(id, client), { money: false });
}

export function saveCleaning(actor: HousekeepingActor, id: string, raw: unknown, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  return writeCleaning(actor, id, raw, false, clock, client);
}

/** "HOÀN THÀNH DỌN PHÒNG": the form, the end time and the duration from the inspection. */
export function completeTask(actor: HousekeepingActor, id: string, raw: unknown, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  return writeCleaning(actor, id, raw, true, clock, client);
}

/* ------------------------------------------------------------------ *
 * WORK ITEMS — "Tạo công việc", "Nhận", "Kiểm tra", "Giao lại"
 * ------------------------------------------------------------------ */

/** "Chọn khu vực": the branch's floors and rooms, from its own catalog (see workAreas). */
export async function listWorkAreas(actor: HousekeepingActor, query: { branchId?: unknown }, client: PrismaClient = defaultPrisma) {
  const branch = await managedBranch(actor, query.branchId === '' ? undefined : query.branchId, client);
  return { branchId: branch.id, ...workAreasFor(branch.code) };
}

/** Most items one request may name ("Nhận" several at once). */
export const MAX_WORK_ITEMS = 50;

/** The open shift's segment — it must be at the item's branch to work it. */
async function workingSegment(actor: HousekeepingActor, branchId: number, client: PrismaClient) {
  const segment = await openSegmentFor(actor.id, client).catch(() => {
    throw ApiError.conflict('Bạn cần "Vào ca" trước khi nhận hoặc làm công việc.');
  });
  if (segment.branchId !== branchId || segment.branchId !== accountBranch(actor)) {
    throw ApiError.branchAccessDenied('Công việc này không thuộc nơi làm việc của ca hiện tại.');
  }
  return segment;
}

/**
 * THE HOUSEKEEPER'S LIST — only once "Vào ca" has established where they work:
 * the day's open items of THAT branch that are either theirs, or nobody's yet
 * ("Chưa tiếp nhận", for "Nhận"). Each item is one row; two items of one room
 * are two rows. Without an open shift there is nothing to show — no branch, no
 * items.
 */
export async function workList(actor: HousekeepingActor, workDateRaw: unknown, client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới có danh sách công việc.');
  const workDate = assertDate(workDateRaw);
  // Not on shift: no branch, and nothing to show.
  if (actor.branchId === null) return { working: false, tasks: [] };
  const home = actor.branchId;
  const segment = await client.housekeepingWorkSegment.findFirst({
    where: { endedAt: null, session: { userId: actor.id, endedAt: null } },
    select: { branchId: true },
  });
  if (!segment || segment.branchId !== home) return { working: false, tasks: [] };
  const rows = await client.housekeepingRoomTask.findMany({
    where: {
      branchId: segment.branchId,
      workDate,
      voidedAt: null,
      state: { not: 'COMPLETED' },
      // Items of a work group are listed — and accepted — with their group.
      workGroupId: null,
      OR: [{ assigneeUserId: actor.id }, { assigneeUserId: null, state: 'NOT_STARTED', reviewResult: null }],
    },
    include: TASK_INCLUDE,
    orderBy: [{ priority: 'desc' }, { floor: 'asc' }, { roomNumber: 'asc' }, { createdAt: 'asc' }],
  });
  const now = getClock().now();
  return { working: true, tasks: rows.map((r) => serializeTask(r, { money: false, now })) };
}

/**
 * "NHẬN" — the housekeeper takes exactly the items they selected (one, or
 * several at once), on their open shift at the items' branch.
 *
 * ALL OR NOTHING, AND NEVER TWO OWNERS. Each item is taken with a conditional
 * write on "nobody has it, nothing has started", inside one transaction: if any
 * one of them was taken a moment ago by somebody else, none is taken, the
 * caller is told which, and the refusal is kept in that item's history.
 * Accepting starts nothing — the item waits for "Kiểm tra".
 */
export async function claimTasks(
  actor: HousekeepingActor,
  input: { taskIds?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới nhận được công việc.');
  const ids = Array.isArray(input.taskIds) ? [...new Set(input.taskIds.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
  if (ids.length === 0) throw ApiError.validation('Vui lòng chọn công việc cần nhận.');
  if (ids.length > MAX_WORK_ITEMS) throw ApiError.validation(`Tối đa ${MAX_WORK_ITEMS} công việc mỗi lần.`);
  const home = accountBranch(actor);
  const segment = await workingSegment(actor, home, client);
  const rows = await client.housekeepingRoomTask.findMany({
    where: { id: { in: ids } },
    select: { id: true, branchId: true, areaKind: true, roomNumber: true, floor: true, taskName: true, statusCode: true, workGroupId: true },
  });
  // Another branch's item (or none at all) is not this housekeeper's to see.
  if (rows.length !== ids.length || rows.some((r) => r.branchId !== segment.branchId)) {
    throw ApiError.notFound('Không tìm thấy công việc.');
  }
  // A work group is accepted whole ("Nhận công việc"), never room by room.
  if (rows.some((r) => r.workGroupId !== null)) throw ApiError.conflict('Phòng này thuộc một công việc — hãy nhận cả công việc.');
  const now = clock.now();
  const lost: string[] = [];
  try {
    await client.$transaction(async (tx) => {
      for (const id of ids) {
        const { count } = await tx.housekeepingRoomTask.updateMany({
          where: { id, branchId: segment.branchId, assigneeUserId: null, voidedAt: null, state: 'NOT_STARTED', reviewResult: null },
          data: { assigneeUserId: actor.id, assigneeNameSnapshot: actor.fullName, acceptedAt: now },
        });
        if (count === 0) lost.push(id);
        else await recordEvent(tx, id, 'ACCEPTED', actor, now, { toId: actor.id, toName: actor.fullName, selected: ids.length });
      }
      if (lost.length > 0) throw ApiError.conflict('claim-lost');
    });
  } catch (error) {
    if (lost.length === 0) throw error;
    await client.$transaction(async (tx) => {
      for (const id of lost) await recordEvent(tx, id, 'CLAIM_REJECTED', actor, now, { reason: 'TAKEN_OR_CHANGED' });
    });
    const names = rows
      .filter((r) => lost.includes(r.id))
      .map((r) => `${placeLabel(r.areaKind, r.areaKind === 'ROOM' ? r.roomNumber : null, r.floor)} · ${taskLabel(r)}`);
    throw ApiError.conflict(
      `Không nhận được: ${names.join('; ')} — công việc vừa được người khác nhận hoặc đã thay đổi. Vui lòng tải lại danh sách và thử lại.`,
      { taskIds: lost },
    );
  }
  const fresh = await client.housekeepingRoomTask.findMany({ where: { id: { in: ids } }, include: TASK_INCLUDE });
  return fresh.map((r) => serializeTask(r, { money: false, now }));
}

/**
 * "KIỂM TRA" — the inspection begins: "Đã tiếp nhận" → "Đang kiểm tra". Only
 * the item's own housekeeper, on its shift there; once (a repeat changes
 * nothing). Saving it ("Lưu kiểm tra") is what moves the item to "Chờ dọn phòng".
 */
export async function beginInspection(actor: HousekeepingActor, id: string, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  await workingSegment(actor, row.branchId, client);
  if (row.state !== 'NOT_STARTED') throw ApiError.conflict('Công việc này đã được kiểm tra.');
  if (row.inspectionStartedAt) return serializeTask(row, { money: false });
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: 'NOT_STARTED', inspectionStartedAt: null, assigneeUserId: actor.id },
      data: { inspectionStartedAt: now },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'INSPECTION_STARTED', actor, now);
  });
  return serializeTask(await loadTask(id, client), { money: false });
}

/**
 * "LƯU KIỂM TRA" of a SHARED AREA. A hallway is not a room: it has no room
 * inspection record and no guest damages to charge, so what the housekeeper
 * saw is kept on the item itself (`inspectionNote`), at the server's time, on
 * the open shift there. Then, as for a room: "Chờ dọn phòng", nothing started.
 */
async function inspectArea(
  actor: HousekeepingActor,
  row: TaskRow,
  input: { issues: { type: unknown; note?: unknown }[]; note?: unknown },
  clock: Clock,
  client: PrismaClient,
) {
  await workingSegment(actor, row.branchId, client);
  if (input.issues.length > 0) throw ApiError.validation('Khu vực chung không ghi nhận hư hỏng phòng — ghi vào phần ghi chú.');
  const note = text(input.note, 2000, 'Ghi chú kiểm tra');
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id: row.id, voidedAt: null, state: 'NOT_STARTED', assigneeUserId: actor.id },
      data: {
        state: 'INSPECTED',
        inspectedAt: now,
        inspectionNote: note,
        ...(row.inspectionStartedAt ? {} : { inspectionStartedAt: now }),
      },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, row.id, 'INSPECTED', actor, now, { area: true, note });
  });
  return serializeTask(await loadTask(row.id, client), { money: false });
}

/* ------------------------------------------------------------------ *
 * "Các công việc trong ngày" for the reception managers, and "Giao lại"
 * ------------------------------------------------------------------ */

/**
 * WHO READS THE DAY'S WORK ITEMS: the Admin and Quản lý buồng phòng (as on the
 * board), and Quản lý lễ tân / Tổng quản lý lễ tân over their own branches.
 */
function workReaderScope(actor: HousekeepingActor): BranchScope {
  if (
    actor.role !== 'ADMIN' &&
    actor.role !== 'HOUSEKEEPING_MANAGER' &&
    actor.role !== 'RECEPTION_MANAGER' &&
    actor.role !== 'RECEPTION_GENERAL_MANAGER'
  ) {
    throw ApiError.forbidden('Bạn không có quyền xem công việc buồng phòng.');
  }
  return branchScopeOf(actor);
}

/** The day's work items of the reader's branches (one, when asked), one row each. */
export async function listWorkOrders(
  actor: HousekeepingActor,
  filter: { workDate: unknown; branchId?: number },
  client: PrismaClient = defaultPrisma,
) {
  const scope = workReaderScope(actor);
  const workDate = assertDate(filter.workDate);
  if (filter.branchId !== undefined && !scopeIncludes(scope, filter.branchId)) {
    throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
  }
  const where: Prisma.HousekeepingRoomTaskWhereInput = {
    workDate,
    voidedAt: null,
    ...(filter.branchId !== undefined ? { branchId: filter.branchId } : scope === 'ALL' ? {} : { branchId: { in: [...scope] } }),
  };
  const rows = await client.housekeepingRoomTask.findMany({
    where,
    include: TASK_INCLUDE,
    orderBy: [{ branchId: 'asc' }, { floor: 'asc' }, { roomNumber: 'asc' }, { createdAt: 'asc' }],
  });
  const now = getClock().now();
  return rows.map((r) => serializeTask(r, { money: false, now }));
}

/** The housekeepers a reassignment may name at one branch of the reader's scope. */
export async function reassignableStaff(actor: HousekeepingActor, query: { branchId?: unknown }, client: PrismaClient = defaultPrisma) {
  const scope = workReaderScope(actor);
  const id = Number(query.branchId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation('Vui lòng chọn chi nhánh.');
  if (!scopeIncludes(scope, id)) throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
  return client.user.findMany({ where: branchStaffWhere(id), select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
}

/**
 * "GIAO LẠI" AFTER THE INSPECTION — the handoff between two housekeepers: the
 * item has been inspected ("Chờ dọn phòng") and nobody has begun cleaning it.
 * The Admin, Quản lý buồng phòng and Quản lý lễ tân (`housekeeping.reassignAwaitingCleaning`),
 * each within its branches, may give it to another active housekeeper of the
 * item's branch. The previous and new housekeeper, the actor, the time and the
 * reason are kept in the item's history; the inspection keeps its inspector.
 *
 * ONCE CLEANING HAS BEGUN the cleaner stays the cleaner: refused, with the
 * reason — the board's own "Giao lại" (the manager's) is unchanged.
 */
export async function reassignAwaitingCleaning(
  actor: HousekeepingActor,
  id: string,
  input: { assigneeUserId?: unknown; reason?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  if (!can(actor.role, 'housekeeping.reassignAwaitingCleaning')) {
    throw ApiError.forbidden('Bạn không có quyền giao lại công việc buồng phòng.');
  }
  const row = await loadTask(id, client);
  if (!scopeIncludes(branchScopeOf(actor), row.branchId)) throw ApiError.branchAccessDenied();
  if (row.voidedAt) throw ApiError.conflict('Công việc này đã bị xóa.');
  if (row.state === 'IN_PROGRESS') throw ApiError.conflict('Công việc đang được dọn — không thể đổi người thực hiện giữa chừng.');
  if (row.state === 'COMPLETED') throw ApiError.conflict('Công việc đã hoàn thành, không thể giao lại.');
  if (row.state !== 'INSPECTED') throw ApiError.conflict('Chỉ giao lại được công việc đã kiểm tra và đang chờ dọn phòng.');
  if (input.assigneeUserId === null || input.assigneeUserId === undefined || input.assigneeUserId === '') {
    throw ApiError.validation('Vui lòng chọn nhân viên nhận công việc.');
  }
  const person = (await assignee(input.assigneeUserId, row.branchId, client))!;
  if (person.id === row.assigneeUserId) throw ApiError.validation('Công việc đang do nhân viên này thực hiện.');
  const reason = text(input.reason, 1000, 'Lý do');
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id, voidedAt: null, state: 'INSPECTED', startedAt: null, assigneeUserId: row.assigneeUserId },
      data: { assigneeUserId: person.id, assigneeNameSnapshot: person.fullName },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, id, 'ASSIGNED', actor, now, {
      fromId: row.assigneeUserId,
      fromName: row.assigneeNameSnapshot,
      toId: person.id,
      toName: person.fullName,
      reason,
      stage: 'AWAITING_CLEANING',
    });
  });
  await notifyAssignee(person.id, row.branchId, [{ id, roomNumber: row.roomNumber }], now, client);
  return serializeTask(await loadTask(id, client), { money: actor.role === 'ADMIN' || actor.role === 'HOUSEKEEPING_MANAGER' });
}
