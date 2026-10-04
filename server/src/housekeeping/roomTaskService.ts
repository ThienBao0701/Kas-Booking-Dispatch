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
import { accountBranch } from './workShiftService';

export const TASK_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  inspection: {
    include: { issues: { include: { collection: true }, orderBy: { createdAt: 'asc' } } },
  },
  events: { orderBy: { createdAt: 'asc' } },
  // A re-clean names the failed cycle it repeats — and why it failed.
  previousTask: { select: { id: true, cycleNumber: true, failureReason: true, reviewedAt: true, reviewedByNameSnapshot: true } },
  recleanTask: { select: { id: true, cycleNumber: true } },
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

/** The next cycle's number for a room and day — every cycle counts, voided ones too. */
async function nextCycle(tx: Prisma.TransactionClient, branchId: number, workDate: string, roomNumber: string): Promise<number> {
  const { _max } = await tx.housekeepingRoomTask.aggregate({ where: { branchId, workDate, roomNumber }, _max: { cycleNumber: true } });
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
async function managedBranch(actor: HousekeepingActor, requested: unknown, client: PrismaClient): Promise<{ id: number; code: string }> {
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

function assertDate(raw: unknown): string {
  if (typeof raw !== 'string' || !DATE.test(raw)) throw ApiError.validation('Ngày không hợp lệ.');
  return raw;
}

function text(raw: unknown, max: number, label: string): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > max) throw ApiError.validation(`${label} quá dài.`);
  return value || null;
}

async function loadTask(id: string, client: PrismaClient): Promise<TaskRow> {
  const row = await client.housekeepingRoomTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy công việc phòng.');
  return row;
}

/** A manager may touch only its branch's items. */
function assertManagerOf(row: TaskRow, actor: HousekeepingActor): void {
  if (!scopeIncludes(managerScope(actor), row.branchId)) throw ApiError.branchAccessDenied();
}

/** A worker may touch only the rooms given to it — never another's, never by branch. */
function assertAssignee(row: TaskRow, actor: HousekeepingActor): void {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới làm được việc này.');
  if (row.branchId !== accountBranch(actor)) throw ApiError.branchAccessDenied();
  if (row.assigneeUserId !== actor.id) throw ApiError.forbidden('Phòng này không được giao cho bạn.');
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
}

/**
 * "NHÂN VIÊN CỦA CHI NHÁNH" — the active Bộ phận buồng phòng accounts the Admin
 * assigned to the branch. The account's branch is the only source: no shift
 * history, no earlier assignment stands in for it.
 */
function branchStaffWhere(branchId: number): Prisma.UserWhereInput {
  return { role: 'HOUSEKEEPING', active: true, branchId };
}

/** The active HOUSEKEEPING account the manager names — one of the branch's own. */
async function assignee(raw: unknown, branchId: number, client: PrismaClient): Promise<{ id: number; fullName: string } | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation('Nhân viên buồng phòng không hợp lệ.');
  const user = await client.user.findFirst({
    where: { id, role: 'HOUSEKEEPING', active: true },
    select: { id: true, fullName: true, branchId: true },
  });
  if (!user) throw ApiError.validation('Nhân viên buồng phòng không hợp lệ hoặc đã ngừng hoạt động.');
  if (user.branchId !== branchId) throw ApiError.validation('Chỉ giao được cho nhân viên buồng phòng thuộc chi nhánh này.');
  return { id: user.id, fullName: user.fullName };
}

async function recordEvent(
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
    orderBy: [{ branchId: 'asc' }, { roomNumber: 'asc' }],
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
  const created: string[] = [];
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
      created.push(task.id);
    }
  });
  if (person && created.length > 0) await notifyAssignee(person.id, rooms.filter((r) => !taken.has(r)), workDate, client);
  return { created: created.length, skipped: [...taken] };
}

async function notifyAssignee(userId: number, rooms: string[], workDate: string, client: PrismaClient, title = 'Bạn được giao phòng'): Promise<void> {
  const [y, m, d] = workDate.split('-');
  await client.notification.create({
    data: {
      userId,
      title,
      body: `Ngày ${d}/${m}/${y}: phòng ${rooms.join(', ')}.`,
    },
  });
}

/** "Sửa": the code, priority and instruction — before and after kept in the history. */
export async function updateTask(
  actor: HousekeepingActor,
  id: string,
  input: { statusCode?: unknown; priority?: unknown; note?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertManagerOf(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Công việc phòng này đã bị xóa.');
  if (row.reviewResult) throw ApiError.conflict(REVIEWED_LOCKED);
  const next = {
    statusCode: input.statusCode === undefined ? row.statusCode : assertStatusCode(input.statusCode),
    priority: input.priority === undefined ? row.priority : input.priority === true,
    note: input.note === undefined ? row.note : text(input.note, 1000, 'Ghi chú'),
  };
  const before = { statusCode: row.statusCode, priority: row.priority, note: row.note };
  if (JSON.stringify(before) === JSON.stringify(next)) return serializeTask(row, { money: true });
  const now = clock.now();
  await client.$transaction(async (tx) => {
    await tx.housekeepingRoomTask.update({ where: { id }, data: next });
    await recordEvent(tx, id, 'UPDATED', actor, now, { before, after: next });
  });
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
  if (person) await notifyAssignee(person.id, [row.roomNumber], row.workDate, client);
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
  const now = clock.now();
  await client.$transaction(async (tx) => {
    await tx.housekeepingRoomTask.update({
      where: { id },
      data: { voidedAt: now, voidedByUserId: actor.id, voidedByNameSnapshot: actor.fullName, voidReason: reason },
    });
    await recordEvent(tx, id, 'VOIDED', actor, now, { reason, state: row.state });
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
        cycleNumber: await nextCycle(tx, row.branchId, row.workDate, row.roomNumber),
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
  if (nextId && person) await notifyAssignee(person.id, [row.roomNumber], row.workDate, client, 'Phòng cần dọn lại');
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
    orderBy: [{ branchId: 'asc' }, { priority: 'desc' }, { roomNumber: 'asc' }],
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
 * result too), recorded at the room's branch on the open shift, and in the SAME
 * transaction the cleaning starts: "đang dọn", \`startedAt\` = the inspection's own
 * time. Only this starts the timer — opening the room or the form never does.
 */
export async function inspectTask(
  actor: HousekeepingActor,
  id: string,
  input: { issues: { type: unknown; note?: unknown }[] },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(id, client);
  assertAssignee(row, actor);
  if (row.state !== 'NOT_STARTED' || row.inspectionId) throw ApiError.conflict('Phòng này đã được kiểm.');
  await createInspection({ roomNumber: row.roomNumber, issues: input.issues }, actor, clock, client, {
    allowNoFindings: true,
    branchId: row.branchId,
    onCreated: async (tx, inspection) => {
      const { count } = await tx.housekeepingRoomTask.updateMany({
        where: { id, voidedAt: null, state: 'NOT_STARTED', inspectionId: null, assigneeUserId: actor.id },
        data: { state: 'IN_PROGRESS', inspectionId: inspection.id, startedAt: inspection.createdAt },
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
  if (row.state === 'NOT_STARTED' || !row.startedAt) {
    throw ApiError.conflict('Cần "Kiểm phòng" trước khi dọn phòng.');
  }
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
