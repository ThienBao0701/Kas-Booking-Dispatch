/**
 * WORK GROUPS — "Công việc 1", "Công việc 2", … of one branch and business day.
 *
 *   MANAGER (Quản lý buồng phòng, its branch; the Admin, any branch)
 *     creates a group of one or many rooms / areas — each with its OWN ticked
 *     "Việc cần làm", note and priority — in one transaction; renames it, adds
 *     places, takes a place out (a soft removal that keeps its history), gives
 *     the whole group to a housekeeper, and decides "Không cần dọn".
 *   HOUSEKEEPER (on shift at the group's branch)
 *     sees every group of the day and who works it, accepts a free group WHOLE
 *     ("Nhận công việc"), works its rooms through the existing lifecycle
 *     (Kiểm tra → Dọn phòng → Hoàn thành), and asks "Không cần dọn" for a room
 *     with a reason.
 *
 * EACH PLACE STAYS ITS OWN HousekeepingRoomTask: its state, inspection,
 * cleaning, review, KPI and history are exactly what they were. The group adds
 * the number, the optional name and the one person who holds it.
 *
 * NEVER TWO OWNERS. Accepting is a conditional write on "nobody holds the
 * group", in one transaction with its rooms: a second housekeeper pressing at
 * the same moment is refused, and sees who has it.
 */
import { randomUUID } from 'node:crypto';
import type { HousekeepingAreaKind, Prisma, PrismaClient } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { scopeIncludes } from '../auth/branchScope';
import { catalogFloor, catalogRoom, floorsForBranchCode, hasRooftop } from '../room/branchRooms';
import { notifyOperational } from '../push/pushService';
import type { HousekeepingActor } from './roomIssueService';
import {
  MAX_WORK_ITEMS,
  TASK_INCLUDE,
  assertAssignee,
  assertDate,
  assertManagerOf,
  assignee,
  loadTask,
  managedBranch,
  managerScope,
  notifyAssignee,
  recordEvent,
  serializeTask,
  text,
  type TaskRow,
} from './roomTaskService';
import { AREA_KIND_LABELS, floorLabel, normalizeTaskCodes, placeLabel, roomFloor } from './workAreas';
import { listShifts } from './workShiftService';

const GROUP_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  tasks: { include: TASK_INCLUDE, orderBy: [{ groupIndex: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.HousekeepingWorkGroupInclude;

type GroupRow = Prisma.HousekeepingWorkGroupGetPayload<{ include: typeof GROUP_INCLUDE }>;

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Is the item still part of the day's work (not removed, not "Không cần dọn")? */
const live = (t: TaskRow) => t.voidedAt === null;

/**
 * The group as every screen reads it. `viewerId` is the housekeeper looking:
 * the full record (findings, cleaning, history) of a room is theirs only when
 * it is given to them — a colleague sees where the work stands, never more.
 */
export function serializeGroup(row: GroupRow, opts: { money: boolean; viewerId?: number; now?: Date }) {
  const now = opts.now ?? getClock().now();
  const items = row.tasks.map((t) => {
    const full = serializeTask(t, { money: opts.money, now });
    if (opts.viewerId === undefined || t.assigneeUserId === opts.viewerId) return full;
    return { ...full, inspection: null, cleaning: null, events: [], note: full.note };
  });
  const liveItems = row.tasks.filter(live);
  const floors = [...new Set(liveItems.map((t) => (t.areaKind === 'ROOFTOP' ? AREA_KIND_LABELS.ROOFTOP : t.floor ? floorLabel(t.floor) : null)))];
  const done = liveItems.filter((t) => t.state === 'COMPLETED').length;
  const started = liveItems.some((t) => t.state !== 'NOT_STARTED' || t.inspectionStartedAt);
  const status = !row.assigneeUserId
    ? { code: 'UNASSIGNED' as const, label: 'Chưa giao' }
    : liveItems.length > 0 && done === liveItems.length
      ? { code: 'DONE' as const, label: 'Đã xong' }
      : started
        ? { code: 'IN_PROGRESS' as const, label: 'Đang thực hiện' }
        : { code: 'ACCEPTED' as const, label: row.acceptedAt ? 'Đã nhận' : 'Đã giao' };
  return {
    id: row.id,
    branchId: row.branchId,
    branch: row.branch,
    workDate: row.workDate,
    number: row.number,
    title: `Công việc ${row.number}`,
    name: row.name,
    assignee: row.assigneeUserId ? { id: row.assigneeUserId, name: row.assigneeNameSnapshot ?? '—' } : null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    status,
    /** "Tầng 1", "Tầng 2 (Khu Suite)", "Rooftop" — null for a place with no floor. */
    floors: floors.filter((f): f is string => f !== null),
    counts: {
      items: liveItems.length,
      completed: done,
      noCleanPending: liveItems.filter((t) => t.noCleanStatus === 'PENDING').length,
    },
    items,
    createdByName: row.createdByNameSnapshot,
    createdAt: row.createdAt.toISOString(),
  };
}

export type SerializedWorkGroup = ReturnType<typeof serializeGroup>;

async function loadGroup(id: string, client: PrismaClient): Promise<GroupRow> {
  const row = await client.housekeepingWorkGroup.findUnique({ where: { id }, include: GROUP_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy công việc.');
  return row;
}

/* ------------------------------------------------------------------ *
 * One place of the form, checked against the branch's own catalog
 * ------------------------------------------------------------------ */

export interface GroupItemInput {
  areaKind?: unknown;
  roomNumber?: unknown;
  floor?: unknown;
  /** OUT / OC / VC (one at most) and/or OTHER — ticked boxes. */
  taskCodes?: unknown;
  note?: unknown;
  priority?: unknown;
}

interface PlaceItem {
  areaKind: HousekeepingAreaKind;
  roomNumber: string;
  floor: string | null;
  statusCode: string;
  taskCodes: string[];
  note: string | null;
  priority: boolean;
}

/**
 *   PHÒNG       a room of the branch; its ticked codes (one of OUT / OC / VC
 *               and/or Khác — "Khác" needs its note); its floor read from the
 *               catalog, never typed;
 *   HÀNH LANG / CẦU THANG   a floor of the branch, and a required note;
 *   KHÁC        a required note saying where and what; the floor if there is one;
 *   ROOFTOP     only where the branch has one; a required note.
 */
function normalizePlace(raw: GroupItemInput, branchCode: string, index: number): PlaceItem {
  const at = `Khu vực ${index + 1}`;
  const kind = raw.areaKind ?? 'ROOM';
  if (kind !== 'ROOM' && kind !== 'HALLWAY' && kind !== 'STAIRCASE' && kind !== 'OTHER' && kind !== 'ROOFTOP') {
    throw ApiError.validation(`${at}: khu vực không hợp lệ.`);
  }
  const note = text(raw.note, 1000, `${at}: Ghi chú`);
  const priority = raw.priority === true;
  const { codes, statusCode } = normalizeTaskCodes(raw.taskCodes, kind, at);
  if (kind === 'ROOM') {
    const typed = typeof raw.roomNumber === 'string' ? raw.roomNumber.trim() : '';
    if (!typed) throw ApiError.validation(`${at}: vui lòng chọn phòng.`);
    if (typed.length > 50) throw ApiError.validation(`${at}: số phòng quá dài.`);
    const roomNumber = catalogRoom(branchCode, typed)!;
    if (codes.includes('OTHER') && !note) throw ApiError.validation(`Phòng ${roomNumber}: "Khác" cần ghi chú nêu rõ việc cần làm.`);
    const floor = roomFloor(roomNumber, floorsForBranchCode(branchCode), branchCode);
    return { areaKind: 'ROOM', roomNumber, floor, statusCode, taskCodes: codes, note, priority };
  }
  if (kind === 'ROOFTOP') {
    if (!hasRooftop(branchCode)) throw ApiError.validation(`${at}: chi nhánh này không có Rooftop.`);
    if (!note) throw ApiError.validation(`${at}: Rooftop cần ghi chú / hướng dẫn.`);
    return { areaKind: 'ROOFTOP', roomNumber: placeLabel('ROOFTOP', null, null), floor: null, statusCode, taskCodes: codes, note, priority };
  }
  const typedFloor = typeof raw.floor === 'string' ? raw.floor.trim() : '';
  if (typedFloor.length > 50) throw ApiError.validation(`${at}: tầng quá dài.`);
  const floor = typedFloor ? catalogFloor(branchCode, typedFloor) : null;
  if (kind !== 'OTHER' && !floor) throw ApiError.validation(`${at}: vui lòng chọn tầng của ${AREA_KIND_LABELS[kind].toLowerCase()}.`);
  if (!note) {
    throw ApiError.validation(
      kind === 'OTHER' ? `${at}: "Khác" cần ghi chú nêu rõ vị trí và việc cần làm.` : `${at}: ${AREA_KIND_LABELS[kind]} cần ghi chú / hướng dẫn.`,
    );
  }
  return { areaKind: kind, roomNumber: placeLabel(kind, null, floor), floor, statusCode, taskCodes: codes, note, priority };
}

function normalizePlaces(rawItems: unknown, branchCode: string): PlaceItem[] {
  const list = Array.isArray(rawItems) ? (rawItems as GroupItemInput[]) : [];
  if (list.length === 0) throw ApiError.validation('Vui lòng chọn ít nhất một phòng / khu vực.');
  if (list.length > MAX_WORK_ITEMS) throw ApiError.validation(`Tối đa ${MAX_WORK_ITEMS} phòng / khu vực mỗi công việc.`);
  const items = list.map((raw, i) => normalizePlace(raw ?? {}, branchCode, i));
  const rooms = items.filter((i) => i.areaKind === 'ROOM').map((i) => i.roomNumber);
  const twice = rooms.find((r, i) => rooms.indexOf(r) !== i);
  if (twice) throw ApiError.validation(`Phòng ${twice} được chọn hai lần trong cùng công việc.`);
  return items;
}

/** A room may be in ONE open item a day — a second group would give it two people. */
async function assertRoomsFree(
  client: PrismaClient | Prisma.TransactionClient,
  branchId: number,
  workDate: string,
  items: PlaceItem[],
): Promise<void> {
  const rooms = items.filter((i) => i.areaKind === 'ROOM').map((i) => i.roomNumber);
  if (rooms.length === 0) return;
  const open = await client.housekeepingRoomTask.findMany({
    where: { branchId, workDate, areaKind: 'ROOM', roomNumber: { in: rooms }, voidedAt: null, reviewResult: null },
    select: { roomNumber: true, workGroup: { select: { number: true } } },
  });
  if (open.length > 0) {
    const where = open.map((o) => `Phòng ${o.roomNumber}${o.workGroup ? ` (Công việc ${o.workGroup.number})` : ''}`);
    throw ApiError.conflict(`Đã có việc đang mở trong ngày: ${where.join(', ')}. Sửa công việc đó thay vì tạo lại.`);
  }
}

async function createItems(
  tx: Prisma.TransactionClient,
  group: { id: string; branchId: number; workDate: string; number: number; assigneeUserId: number | null; assigneeNameSnapshot: string | null },
  items: PlaceItem[],
  firstIndex: number,
  actor: HousekeepingActor,
  now: Date,
): Promise<{ id: string; roomNumber: string }[]> {
  const created: { id: string; roomNumber: string }[] = [];
  for (const [offset, item] of items.entries()) {
    const task = await tx.housekeepingRoomTask.create({
      data: {
        branchId: group.branchId,
        workDate: group.workDate,
        roomNumber: item.roomNumber,
        itemKey: randomUUID(),
        areaKind: item.areaKind,
        floor: item.floor,
        cycleNumber: 1,
        statusCode: item.statusCode,
        taskCodes: item.taskCodes,
        priority: item.priority,
        note: item.note,
        workGroupId: group.id,
        groupId: group.id,
        groupIndex: firstIndex + offset,
        // A place added to a group someone holds is theirs too.
        assigneeUserId: group.assigneeUserId,
        assigneeNameSnapshot: group.assigneeNameSnapshot,
        createdByUserId: actor.id,
        createdByNameSnapshot: actor.fullName,
        createdAt: now,
      },
    });
    await recordEvent(tx, task.id, 'CREATED', actor, now, {
      group: group.number,
      areaKind: item.areaKind,
      place: item.roomNumber,
      floor: item.floor,
      taskCodes: item.taskCodes,
      priority: item.priority,
      note: item.note,
    });
    if (group.assigneeUserId) {
      await recordEvent(tx, task.id, 'ASSIGNED', actor, now, { fromId: null, fromName: null, toId: group.assigneeUserId, toName: group.assigneeNameSnapshot, group: group.number });
    }
    created.push({ id: task.id, roomNumber: item.roomNumber });
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

export interface CreateWorkGroupInput {
  branchId?: unknown;
  workDate: unknown;
  /** One per form submission: a repeat of it finds the group already saved. */
  requestId?: unknown;
  name?: unknown;
  items: unknown;
}

/**
 * "TẠO CÔNG VIỆC" — one group, its places, in ONE transaction: a place that
 * fails its check saves nothing at all. The number is the next one of the
 * branch and day; two managers saving at once get two numbers (the unique key
 * decides, and the loser takes the next).
 */
export async function createWorkGroup(
  actor: HousekeepingActor,
  input: CreateWorkGroupInput,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managedBranch(actor, input.branchId, client);
  const workDate = assertDate(input.workDate);
  const requestId = typeof input.requestId === 'string' && REQUEST_ID.test(input.requestId) ? input.requestId : null;
  const name = text(input.name, 200, 'Tên công việc');
  if (requestId) {
    const saved = await client.housekeepingWorkGroup.findUnique({ where: { requestId }, include: GROUP_INCLUDE });
    if (saved) return { duplicate: true, group: serializeGroup(saved, { money: true }) };
  }
  const items = normalizePlaces(input.items, branch.code);
  await assertRoomsFree(client, branch.id, workDate, items);

  const now = clock.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const id = await client.$transaction(async (tx) => {
        await assertRoomsFree(tx, branch.id, workDate, items);
        const { _max } = await tx.housekeepingWorkGroup.aggregate({ where: { branchId: branch.id, workDate }, _max: { number: true } });
        const group = await tx.housekeepingWorkGroup.create({
          data: {
            branchId: branch.id,
            workDate,
            number: (_max.number ?? 0) + 1,
            name,
            requestId,
            createdByUserId: actor.id,
            createdByNameSnapshot: actor.fullName,
            createdAt: now,
          },
        });
        await createItems(tx, { ...group, assigneeUserId: null, assigneeNameSnapshot: null }, items, 0, actor, now);
        return group.id;
      });
      return { duplicate: false, group: serializeGroup(await loadGroup(id, client), { money: true }) };
    } catch (error) {
      if (!(error instanceof PrismaNS.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const target = JSON.stringify(error.meta?.target ?? '');
      // The same submission racing itself: the other request saved it.
      if (requestId && target.includes('requestId')) {
        const saved = await client.housekeepingWorkGroup.findUnique({ where: { requestId }, include: GROUP_INCLUDE });
        if (saved) return { duplicate: true, group: serializeGroup(saved, { money: true }) };
      }
      // Another group took this number a moment ago: take the next one.
      if (target.includes('number') && attempt < 3) continue;
      throw ApiError.conflict('Một phòng trong công việc vừa được tạo ở nơi khác. Vui lòng tải lại và thử lại.');
    }
  }
}

/** The day's groups of a manager's branch (or the one asked), in creation order — removed places marked. */
export async function listWorkGroups(
  actor: HousekeepingActor,
  filter: { workDate: unknown; branchId?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managedBranch(actor, filter.branchId === '' ? undefined : filter.branchId, client);
  const workDate = assertDate(filter.workDate);
  const rows = await client.housekeepingWorkGroup.findMany({
    where: { branchId: branch.id, workDate },
    include: GROUP_INCLUDE,
    orderBy: { number: 'asc' },
  });
  const now = getClock().now();
  return rows.map((r) => serializeGroup(r, { money: true, now }));
}

async function managedGroup(actor: HousekeepingActor, id: string, client: PrismaClient): Promise<GroupRow> {
  const row = await loadGroup(id, client);
  if (!scopeIncludes(managerScope(actor), row.branchId)) throw ApiError.branchAccessDenied();
  return row;
}

/** "Chỉnh sửa" — the group's name. Each live place keeps the change in its history. */
export async function renameWorkGroup(
  actor: HousekeepingActor,
  id: string,
  input: { name?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await managedGroup(actor, id, client);
  const name = text(input.name, 200, 'Tên công việc');
  if (name === row.name) return serializeGroup(row, { money: true });
  const now = clock.now();
  await client.$transaction(async (tx) => {
    await tx.housekeepingWorkGroup.update({ where: { id }, data: { name } });
    for (const t of row.tasks.filter(live)) {
      await recordEvent(tx, t.id, 'UPDATED', actor, now, { group: row.number, before: { groupName: row.name }, after: { groupName: name } });
    }
  });
  return serializeGroup(await loadGroup(id, client), { money: true });
}

/** "Chỉnh sửa" — more places in the same group, checked as at creation. */
export async function addWorkGroupItems(
  actor: HousekeepingActor,
  id: string,
  input: { items?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await managedGroup(actor, id, client);
  const branch = await client.branch.findUniqueOrThrow({ where: { id: row.branchId }, select: { code: true } });
  const items = normalizePlaces(input.items, branch.code);
  const now = clock.now();
  try {
    const created = await client.$transaction(async (tx) => {
      await assertRoomsFree(tx, row.branchId, row.workDate, items);
      const { _max } = await tx.housekeepingRoomTask.aggregate({ where: { workGroupId: id }, _max: { groupIndex: true } });
      return createItems(tx, row, items, (_max.groupIndex ?? -1) + 1, actor, now);
    });
    if (row.assigneeUserId && created.length > 0) await notifyAssignee(row.assigneeUserId, row.branchId, created, now, client);
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw ApiError.conflict('Một phòng vừa được thêm ở nơi khác. Vui lòng tải lại và thử lại.');
    }
    throw error;
  }
  return serializeGroup(await loadGroup(id, client), { money: true });
}

/**
 * "Giao" the WHOLE group (or "Chưa giao" with null) — the manager's way, beside
 * a housekeeper's own "Nhận". Every place that has not begun its inspection
 * moves with the group; a place already inspected keeps its housekeeper (the
 * hand-over after inspection is "Giao lại" in "Chờ dọn phòng").
 */
export async function assignWorkGroup(
  actor: HousekeepingActor,
  id: string,
  input: { assigneeUserId?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await managedGroup(actor, id, client);
  const person = await assignee(input.assigneeUserId, row.branchId, client);
  if ((person?.id ?? null) === row.assigneeUserId) return serializeGroup(row, { money: true });
  const movable = row.tasks.filter((t) => live(t) && t.state === 'NOT_STARTED' && !t.inspectionStartedAt && t.reviewResult === null);
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingWorkGroup.updateMany({
      where: { id, assigneeUserId: row.assigneeUserId },
      data: { assigneeUserId: person?.id ?? null, assigneeNameSnapshot: person?.fullName ?? null, acceptedAt: null },
    });
    if (count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    for (const t of movable) {
      const moved = await tx.housekeepingRoomTask.updateMany({
        where: { id: t.id, voidedAt: null, state: 'NOT_STARTED', inspectionStartedAt: null, assigneeUserId: t.assigneeUserId },
        data: { assigneeUserId: person?.id ?? null, assigneeNameSnapshot: person?.fullName ?? null, acceptedAt: null },
      });
      if (moved.count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
      await recordEvent(tx, t.id, 'ASSIGNED', actor, now, {
        fromId: t.assigneeUserId,
        fromName: t.assigneeNameSnapshot,
        toId: person?.id ?? null,
        toName: person?.fullName ?? null,
        group: row.number,
      });
    }
  });
  if (person && movable.length > 0) {
    await notifyAssignee(person.id, row.branchId, movable.map((t) => ({ id: t.id, roomNumber: t.roomNumber })), now, client);
  }
  return serializeGroup(await loadGroup(id, client), { money: true });
}

/**
 * "KHÔNG CẦN DỌN" — the manager's decision on a housekeeper's request.
 *
 *   Duyệt     the place leaves the day's active work: a soft removal (\`voidedAt\`,
 *             "Không cần dọn: <reason>"); its request, decision and history stay.
 *   Từ chối   the place goes back to work where it was; the housekeeper is told.
 */
export async function decideNoClean(
  actor: HousekeepingActor,
  taskId: string,
  input: { approve?: unknown; note?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadTask(taskId, client);
  assertManagerOf(row, actor);
  if (row.noCleanStatus !== 'PENDING' || row.voidedAt) throw ApiError.conflict('Không có yêu cầu "Không cần dọn" đang chờ duyệt cho phòng này.');
  if (typeof input.approve !== 'boolean') throw ApiError.validation('Chọn "Duyệt" hoặc "Từ chối".');
  const note = text(input.note, 1000, 'Ghi chú');
  const now = clock.now();
  const decided = { noCleanDecidedAt: now, noCleanDecidedByUserId: actor.id, noCleanDecidedByNameSnapshot: actor.fullName, noCleanDecisionNote: note };
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      where: { id: taskId, noCleanStatus: 'PENDING', voidedAt: null },
      data: input.approve
        ? {
            ...decided,
            noCleanStatus: 'APPROVED',
            voidedAt: now,
            voidedByUserId: actor.id,
            voidedByNameSnapshot: actor.fullName,
            voidReason: `Không cần dọn: ${row.noCleanReason ?? ''}`.trim(),
          }
        : { ...decided, noCleanStatus: 'REJECTED' },
    });
    if (count === 0) throw ApiError.conflict('Yêu cầu vừa được xử lý ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, taskId, input.approve ? 'NO_CLEAN_APPROVED' : 'NO_CLEAN_REJECTED', actor, now, {
      reason: row.noCleanReason,
      requestedById: row.noCleanRequestedByUserId,
      requestedByName: row.noCleanRequestedByNameSnapshot,
      note,
    });
  });
  if (row.noCleanRequestedByUserId) {
    const branch = await client.branch.findUnique({ where: { id: row.branchId }, select: { branchNumber: true } });
    await notifyOperational(
      [
        {
          userId: row.noCleanRequestedByUserId,
          kind: 'HOUSEKEEPING_ASSIGNED',
          title: input.approve ? `Đã duyệt không cần dọn — ${placeLabel(row.areaKind, row.roomNumber, row.floor)}` : `Từ chối không cần dọn — ${placeLabel(row.areaKind, row.roomNumber, row.floor)}`,
          body: `CN ${branch?.branchNumber ?? ''} · ${input.approve ? 'Phòng không cần dọn nữa.' : 'Vui lòng tiếp tục dọn phòng.'}${note ? `\nGhi chú: ${note}` : ''}`,
          link: '/app/inspections',
          dedupeKey: `HOUSEKEEPING_NO_CLEAN:${taskId}:${now.toISOString()}`,
        },
      ],
      client,
    );
  }
  return serializeTask(await loadTask(taskId, client), { money: true });
}

/* ------------------------------------------------------------------ *
 * The housekeeper
 * ------------------------------------------------------------------ */

/**
 * The branch a worker accepts work at — never the request's:
 *   Bộ phận buồng phòng  its open shift's (middleware/auth.ts puts it on the user);
 *   Quản lý buồng phòng  its assigned branch, and only while on a shift there.
 */
async function shiftBranch(actor: HousekeepingActor, client: PrismaClient): Promise<number> {
  if (actor.role !== 'HOUSEKEEPING' && actor.role !== 'HOUSEKEEPING_MANAGER') {
    throw ApiError.forbidden('Chỉ nhân viên buồng phòng hoặc quản lý buồng phòng mới nhận được công việc.');
  }
  if (actor.branchId === null) throw ApiError.conflict('Bạn cần "Vào ca" trước khi nhận hoặc làm công việc.');
  if (actor.role === 'HOUSEKEEPING_MANAGER') {
    const onShift = await client.housekeepingWorkSegment.findFirst({
      where: { branchId: actor.branchId, endedAt: null, session: { userId: actor.id, endedAt: null } },
      select: { id: true },
    });
    if (!onShift) throw ApiError.conflict('Bạn cần "Vào ca làm việc" tại chi nhánh trước khi nhận công việc.');
  }
  return actor.branchId;
}

/**
 * THE DAY'S WORK GROUPS at the shift's branch — every one with a place still to
 * do, and who holds it, so a colleague sees "A đang làm" and cannot take it too.
 * Not on shift: no branch, nothing to show.
 */
export async function workerGroups(actor: HousekeepingActor, workDateRaw: unknown, client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới có danh sách công việc.');
  const workDate = assertDate(workDateRaw);
  if (actor.branchId === null) return { working: false, groups: [] };
  const rows = await client.housekeepingWorkGroup.findMany({
    where: { branchId: actor.branchId, workDate, tasks: { some: { voidedAt: null } } },
    include: GROUP_INCLUDE,
    orderBy: { number: 'asc' },
  });
  const now = getClock().now();
  return { working: true, groups: rows.map((r) => serializeGroup(r, { money: false, viewerId: actor.id, now })) };
}

/**
 * "NHẬN CÔNG VIỆC" — the WHOLE group, by one housekeeper on shift at its
 * branch. The group is taken with a conditional write on "nobody holds it", and
 * its free places with it, in one transaction: a second "Nhận" — at the same
 * moment or later — is refused with who holds it. Accepting starts nothing.
 */
export async function acceptWorkGroup(actor: HousekeepingActor, id: string, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branchId = await shiftBranch(actor, client);
  const row = await loadGroup(id, client);
  // Another branch's group is not this housekeeper's to see.
  if (row.branchId !== branchId) throw ApiError.notFound('Không tìm thấy công việc.');
  const free = row.tasks.filter((t) => live(t) && t.assigneeUserId === null && t.state === 'NOT_STARTED' && t.reviewResult === null);
  if (row.tasks.filter(live).length === 0) throw ApiError.conflict('Công việc này không còn phòng nào để làm.');
  const now = clock.now();
  try {
    await client.$transaction(async (tx) => {
      const { count } = await tx.housekeepingWorkGroup.updateMany({
        where: { id, branchId, assigneeUserId: null },
        data: { assigneeUserId: actor.id, assigneeNameSnapshot: actor.fullName, acceptedAt: now },
      });
      if (count === 0) throw new GroupTaken();
      for (const t of free) {
        const taken = await tx.housekeepingRoomTask.updateMany({
          where: { id: t.id, voidedAt: null, assigneeUserId: null, state: 'NOT_STARTED', reviewResult: null },
          data: { assigneeUserId: actor.id, assigneeNameSnapshot: actor.fullName, acceptedAt: now },
        });
        if (taken.count === 0) throw ApiError.conflict('Công việc vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
        await recordEvent(tx, t.id, 'ACCEPTED', actor, now, { toId: actor.id, toName: actor.fullName, group: row.number });
      }
    });
  } catch (error) {
    if (!(error instanceof GroupTaken)) throw error;
    const holder = await client.housekeepingWorkGroup.findUnique({ where: { id }, select: { assigneeNameSnapshot: true } });
    // Kept in each place's history, as a lost "Nhận" always was.
    await client.$transaction(async (tx) => {
      for (const t of row.tasks.filter(live)) {
        await recordEvent(tx, t.id, 'CLAIM_REJECTED', actor, now, { reason: 'GROUP_TAKEN', group: row.number, holder: holder?.assigneeNameSnapshot ?? null });
      }
    });
    throw ApiError.conflict(`Công việc ${row.number} đã có người nhận${holder?.assigneeNameSnapshot ? `: ${holder.assigneeNameSnapshot}` : ''}.`);
  }
  return serializeGroup(await loadGroup(id, client), { money: false, viewerId: actor.id });
}

class GroupTaken extends Error {}

/**
 * "KHÔNG CẦN DỌN" — asked by the housekeeper the room is given to, on shift
 * there, with the reason (required): the guest no longer wants it. Until the
 * manager decides, the room waits ("Chờ duyệt không cần dọn") — it is neither
 * worked nor taken out. Once cleaning has begun it is too late to ask.
 */
export async function requestNoClean(
  actor: HousekeepingActor,
  taskId: string,
  input: { reason?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  // The manager decides "Không cần dọn" — it does not ask itself; it takes a
  // room out of a group in "Chỉnh sửa" instead, with its reason.
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới báo "Không cần dọn".');
  const row = await loadTask(taskId, client);
  assertAssignee(row, actor);
  if (row.state === 'IN_PROGRESS') throw ApiError.conflict('Phòng đang được dọn — không thể báo không cần dọn.');
  if (row.state === 'COMPLETED') throw ApiError.conflict('Phòng đã dọn xong.');
  if (row.noCleanStatus === 'PENDING') throw ApiError.conflict('Phòng này đã được báo không cần dọn, đang chờ quản lý duyệt.');
  const reason = text(input.reason, 1000, 'Lý do');
  if (!reason) throw ApiError.validation('Vui lòng nhập lý do không cần dọn.');
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.housekeepingRoomTask.updateMany({
      // "not pending" spelled out: a NULL status is not 'PENDING', and NOT (= 'PENDING') would drop it.
      where: {
        id: taskId,
        voidedAt: null,
        assigneeUserId: actor.id,
        state: { in: ['NOT_STARTED', 'INSPECTED'] },
        OR: [{ noCleanStatus: null }, { noCleanStatus: { in: ['APPROVED', 'REJECTED'] } }],
      },
      data: {
        noCleanStatus: 'PENDING',
        noCleanReason: reason,
        noCleanRequestedAt: now,
        noCleanRequestedByUserId: actor.id,
        noCleanRequestedByNameSnapshot: actor.fullName,
        noCleanDecidedAt: null,
        noCleanDecidedByUserId: null,
        noCleanDecidedByNameSnapshot: null,
        noCleanDecisionNote: null,
      },
    });
    if (count === 0) throw ApiError.conflict('Phòng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await recordEvent(tx, taskId, 'NO_CLEAN_REQUESTED', actor, now, { reason, state: row.state });
  });
  return serializeTask(await loadTask(taskId, client), { money: false });
}

/**
 * "CÔNG VIỆC TRONG NGÀY CỦA TÔI" — what this housekeeper finished, or closed by
 * an answered "Không cần dọn", on a business day (any branch they worked at),
 * with each place's history; and that day's shifts. Read-only.
 */
export async function workerHistory(actor: HousekeepingActor, workDateRaw: unknown, client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới có lịch sử công việc.');
  const workDate = assertDate(workDateRaw);
  const rows = await client.housekeepingRoomTask.findMany({
    where: {
      workDate,
      OR: [
        { cleanedByUserId: actor.id, state: 'COMPLETED' },
        { noCleanRequestedByUserId: actor.id, noCleanStatus: { in: ['APPROVED', 'REJECTED'] } },
      ],
    },
    include: TASK_INCLUDE,
    orderBy: [{ completedAt: 'asc' }, { noCleanDecidedAt: 'asc' }, { createdAt: 'asc' }],
  });
  const dayStart = new Date(`${workDate}T00:00:00+07:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const shifts = await listShifts(actor, { from: dayStart, to: dayEnd }, client);
  const now = getClock().now();
  return {
    workDate,
    items: rows.map((r) => serializeTask(r, { money: false, now })),
    totals: {
      completed: rows.filter((r) => r.state === 'COMPLETED' && r.cleanedByUserId === actor.id).length,
      noClean: rows.filter((r) => r.noCleanStatus === 'APPROVED').length,
    },
    shifts,
  };
}
