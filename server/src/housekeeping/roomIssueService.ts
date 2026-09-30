/**
 * BUỒNG PHÒNG — room inspections, and the collection Reception makes against them.
 *
 * THREE ROLES, THREE DIFFERENT ACTS ON ONE PIECE OF DATA
 *
 *   HOUSEKEEPING  records what a room looked like — `createInspection`. One
 *                 inspection yields one or more independent issue rows.
 *   RECEPTIONIST  settles each issue on its own — `saveCollection`: how much, and
 *                 whether it was collected, by which method, or why it could not
 *                 be. Their own branch only.
 *   ADMIN         reads and reports on all of it, may settle any issue, and is
 *                 the only role that can void one (with a reason).
 *
 * COLLECTION IS NOT A PAYMENT. It never enters the shift drawer and never
 * appears in "Theo dõi thanh toán": `RoomIssueCollection` references the issue it
 * settles and nothing in the payment tables, so neither side's totals can be
 * corrupted by the other. That is the specified separation, and the reason there
 * is no shared code path with `cashService`.
 *
 * THE BRANCH IS THE ACTOR'S. Housekeeping's branch comes from the account and the
 * request body has no field for it; Reception can only reach its own branch's
 * issues; nothing accepts a branch from the browser.
 */
import type {
  Prisma,
  PrismaClient,
  RoomCollectionMethod,
  RoomCollectionStatus,
  RoomIssueType,
  UserRole,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { captureShiftContext, type ShiftActor } from '../shift/shiftService';
import { assertMoney } from '../reception/reportService';
import { isReceptionSupervisor, scopedBranchFilter } from '../auth/branchScope';
import { catalogRoom } from '../room/branchRooms';
import {
  ROOM_COLLECTION_METHODS,
  ROOM_COLLECTION_METHOD_LABELS,
  ROOM_COLLECTION_STATUSES,
  ROOM_COLLECTION_STATUS_LABELS,
  ROOM_ISSUE_TYPES,
  ROOM_ISSUE_TYPE_LABELS,
} from './roomIssueTypes';

export type HousekeepingActor = {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
  managedBranchIds?: readonly number[];
};

const MAX_ISSUES_PER_INSPECTION = 20;
const LIST_CAP = 500;

const ISSUE_INCLUDE = {
  inspection: { select: { id: true, roomNumber: true, staffName: true, createdByNameSnapshot: true, createdAt: true } },
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  collection: true,
  /// Oldest first: a history reads forwards.
  events: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RoomInspectionIssueInclude;

type IssueRow = Prisma.RoomInspectionIssueGetPayload<{ include: typeof ISSUE_INCLUDE }>;

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/**
 * One issue as the screens read it.
 *
 * `money: false` is HOUSEKEEPING'S view: they see THAT an issue was settled or
 * waived, not what the guest was charged or why it was waived — that is the
 * front desk's business and the Admin's.
 */
export function serializeRoomIssue(row: IssueRow, opts: { money: boolean }) {
  const collection = row.collection;
  const status: RoomCollectionStatus = collection?.status ?? 'PENDING';
  return {
    id: row.id,
    inspectionId: row.inspectionId,
    branchId: row.branchId,
    branch: row.branch,
    roomNumber: row.inspection.roomNumber,
    staffName: row.inspection.staffName,
    recordedByName: row.inspection.createdByNameSnapshot,
    type: row.type,
    typeLabel: ROOM_ISSUE_TYPE_LABELS[row.type],
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedByName: row.voidedByNameSnapshot,
    voidReason: row.voidReason,
    /*
      THE COLLECTION STATE IS NOT HOUSEKEEPING'S. "Đã thu / Chưa thu / Không thu
      được" is the front desk's business; Bộ phận buồng phòng reports the room's
      condition and is sent nothing about the money — not even the state.
    */
    collectionStatus: opts.money ? status : null,
    collectionStatusLabel: opts.money ? ROOM_COLLECTION_STATUS_LABELS[status] : null,
    collection:
      opts.money && collection
        ? {
            amount: collection.amount,
            status: collection.status,
            method: collection.method,
            methodLabel: collection.method ? ROOM_COLLECTION_METHOD_LABELS[collection.method] : null,
            reason: collection.reason,
            note: collection.note,
            recordedByName: collection.recordedByNameSnapshot,
            updatedAt: collection.updatedAt.toISOString(),
          }
        : null,
    history: opts.money
      ? row.events.map((e) => ({
          id: e.id,
          amount: e.amount,
          status: e.status,
          statusLabel: ROOM_COLLECTION_STATUS_LABELS[e.status],
          methodLabel: e.method ? ROOM_COLLECTION_METHOD_LABELS[e.method] : null,
          reason: e.reason,
          note: e.note,
          actorName: e.actorNameSnapshot,
          createdAt: e.createdAt.toISOString(),
        }))
      : [],
  };
}

export type SerializedRoomIssue = ReturnType<typeof serializeRoomIssue>;

/* ------------------------------------------------------------------ *
 * Housekeeping: record an inspection
 * ------------------------------------------------------------------ */

export interface InspectionInput {
  roomNumber: unknown;
  staffName: unknown;
  issues: { type: unknown; note?: unknown }[];
}

/**
 * Saves one inspection and every finding on it, atomically: either the room and
 * all its issues are on file or none of them are.
 */
export async function createInspection(
  input: InspectionInput,
  actor: HousekeepingActor,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  if (actor.role !== 'HOUSEKEEPING') {
    throw ApiError.forbidden('Chỉ bộ phận buồng phòng mới ghi nhận được kiểm tra phòng.');
  }
  if (actor.branchId === null) {
    throw ApiError.validation('Tài khoản buồng phòng chưa được gán chi nhánh.');
  }
  const typedRoom = trimmed(input.roomNumber);
  if (!typedRoom) throw ApiError.validation('Vui lòng nhập số phòng.');
  if (typedRoom.length > 50) throw ApiError.validation('Số phòng quá dài.');
  // One of THIS branch's rooms (the shared room catalog), when it has one.
  const ownBranch = await client.branch.findUnique({ where: { id: actor.branchId }, select: { code: true } });
  if (!ownBranch) throw ApiError.validation('Chi nhánh không hợp lệ.');
  const roomNumber = catalogRoom(ownBranch.code, typedRoom)!;
  const staffName = trimmed(input.staffName);
  if (!staffName) throw ApiError.validation('Vui lòng nhập tên người dọn phòng.');
  if (staffName.length > 100) throw ApiError.validation('Tên người dọn phòng quá dài.');

  if (input.issues.length === 0) {
    throw ApiError.validation('Vui lòng chọn ít nhất một tình trạng của phòng.');
  }
  if (input.issues.length > MAX_ISSUES_PER_INSPECTION) {
    throw ApiError.validation(`Tối đa ${MAX_ISSUES_PER_INSPECTION} tình trạng cho mỗi lần kiểm tra.`);
  }
  const issues = input.issues.map((raw) => {
    if (typeof raw.type !== 'string' || !(ROOM_ISSUE_TYPES as readonly string[]).includes(raw.type)) {
      throw ApiError.validation('Tình trạng phòng không hợp lệ.');
    }
    const type = raw.type as RoomIssueType;
    const note = trimmed(raw.note);
    if (note.length > 2000) throw ApiError.validation('Mô tả quá dài.');
    // "Vấn đề khác" says nothing on its own; the others are self-explanatory.
    if (type === 'OTHER' && !note) throw ApiError.validation('Vui lòng mô tả vấn đề khác.');
    return { type, note: note || null };
  });

  const now = clock.now();
  const branchId = actor.branchId;
  const created = await client.roomInspection.create({
    data: {
      branchId,
      roomNumber,
      staffName,
      createdByUserId: actor.id,
      createdByNameSnapshot: actor.fullName,
      createdAt: now,
      issues: { create: issues.map((i) => ({ ...i, branchId, createdAt: now })) },
    },
    include: { issues: { include: ISSUE_INCLUDE } },
  });

  /*
    RECEPTION IS TOLD, because Reception is who acts next. One notification per
    receptionist of the branch, per inspection — not per issue: a room with three
    findings is one thing to go and look at.
  */
  const receptionists = await client.user.findMany({
    where: { role: 'RECEPTIONIST', active: true, branchId },
    select: { id: true },
  });
  if (receptionists.length > 0) {
    const what = issues.map((i) => ROOM_ISSUE_TYPE_LABELS[i.type]).join(', ');
    await client.notification.createMany({
      data: receptionists.map((r) => ({
        userId: r.id,
        title: 'Buồng phòng ghi nhận vấn đề phòng',
        body: `Phòng ${roomNumber} — ${what}`,
      })),
    });
  }

  return {
    id: created.id,
    roomNumber: created.roomNumber,
    issues: created.issues.map((row) => serializeRoomIssue(row, { money: false })),
  };
}

/* ------------------------------------------------------------------ *
 * Reading — scoped by role
 * ------------------------------------------------------------------ */

export type CollectionFilterStatus = RoomCollectionStatus;

export interface ListRoomIssuesFilter {
  branchId?: number;
  type?: RoomIssueType;
  /** One room of the branch. */
  roomNumber?: string;
  /** Collection state — never applied for Housekeeping, which does not see it. */
  status?: RoomCollectionStatus;
  /** Half-open [from, to) over when the inspection was recorded. */
  from?: Date;
  to?: Date;
}

/** THE VISIBILITY RULE, in one function — every read below goes through it. */
export function roomIssueWhere(
  actor: HousekeepingActor,
  filter: ListRoomIssuesFilter = {},
): Prisma.RoomInspectionIssueWhereInput {
  const where: Prisma.RoomInspectionIssueWhereInput = {};
  /** The inspection-side filter, built once: its recorder and/or its room. */
  const inspection: Prisma.RoomInspectionWhereInput = {};
  if (actor.role === 'RECEPTIONIST') {
    // `?? -1` matches no branch; the key is never left out, which would widen it.
    where.branchId = actor.branchId ?? -1;
    where.voidedAt = null;
  } else if (actor.role === 'HOUSEKEEPING') {
    where.branchId = actor.branchId ?? -1;
    where.voidedAt = null;
    inspection.createdByUserId = actor.id;
  } else if (isReceptionSupervisor(actor.role)) {
    // Admin: every branch; a Quản lý lễ tân: its branches; the general manager: all.
    Object.assign(where, scopedBranchFilter(actor, filter.branchId));
  } else {
    throw ApiError.forbidden('Bạn không có quyền xem kiểm tra phòng.');
  }
  if (filter.type) where.type = filter.type;
  if (filter.roomNumber) inspection.roomNumber = filter.roomNumber;
  if (Object.keys(inspection).length > 0) where.inspection = { is: inspection };
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  // Housekeeping never filters by the money state it is not shown.
  if (actor.role === 'HOUSEKEEPING') return where;
  if (filter.status === 'PENDING') {
    // No collection row at all reads as "Chưa thu" too.
    where.OR = [{ collection: { is: null } }, { collection: { is: { status: 'PENDING' } } }];
  } else if (filter.status) {
    where.collection = { is: { status: filter.status } };
  }
  return where;
}

/**
 * WHAT BỘ PHẬN BUỒNG PHÒNG HAS RECORDED — the facts of its own inspections, and
 * NOTHING about money. Counted over every matching row (not the capped page),
 * voided findings excluded like every other figure.
 */
export interface InspectionSummary {
  /** Inspections with at least one finding in the period. */
  inspections: number;
  /** Findings recorded. */
  issues: number;
  /** Distinct rooms with at least one finding. */
  rooms: number;
  byType: { type: RoomIssueType; label: string; count: number }[];
}

export async function summariseInspections(
  actor: HousekeepingActor,
  filter: ListRoomIssuesFilter = {},
  client: PrismaClient = defaultPrisma,
): Promise<InspectionSummary> {
  const live: Prisma.RoomInspectionIssueWhereInput = {
    ...roomIssueWhere(actor, { ...filter, status: undefined }),
    voidedAt: null,
  };
  const [byType, rows] = await client.$transaction([
    client.roomInspectionIssue.groupBy({ by: ['type'], where: live, _count: { _all: true }, orderBy: { type: 'asc' } }),
    client.roomInspectionIssue.findMany({
      where: live,
      select: { inspectionId: true, inspection: { select: { roomNumber: true } } },
    }),
  ]);
  return {
    inspections: new Set(rows.map((r) => r.inspectionId)).size,
    issues: rows.length,
    rooms: new Set(rows.map((r) => r.inspection.roomNumber)).size,
    byType: byType
      .map((g) => ({
        type: g.type,
        label: ROOM_ISSUE_TYPE_LABELS[g.type],
        count: typeof g._count === 'object' && g._count ? (g._count._all ?? 0) : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

export interface RoomIssueSummary {
  total: number;
  byStatus: Record<RoomCollectionStatus, number>;
  byType: { type: RoomIssueType; label: string; count: number }[];
  /** Whole đồng, by method — money that WAS collected. */
  collectedByMethod: Record<RoomCollectionMethod, number>;
  collectedTotal: number;
  /** Amounts recorded against issues still "Chưa thu". */
  pendingAmount: number;
  /** Amounts recorded against issues that could not be collected. */
  uncollectibleAmount: number;
}

export async function listRoomIssues(
  actor: HousekeepingActor,
  filter: ListRoomIssuesFilter = {},
  client: PrismaClient = defaultPrisma,
) {
  const where = roomIssueWhere(actor, filter);
  const money = actor.role !== 'HOUSEKEEPING';
  const [rows, total] = await client.$transaction([
    client.roomInspectionIssue.findMany({
      where,
      include: ISSUE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: LIST_CAP,
    }),
    client.roomInspectionIssue.count({ where }),
  ]);
  return {
    issues: rows.map((r) => serializeRoomIssue(r, { money })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * The Admin's totals, over EVERY matching issue and not the capped page — the
 * same rule the incident summary follows: a figure computed from a page reports
 * the size of the page.
 *
 * Voided issues are left out of every figure; they stay listed, struck through.
 */
export async function summariseRoomIssues(
  actor: HousekeepingActor,
  filter: ListRoomIssuesFilter = {},
  client: PrismaClient = defaultPrisma,
): Promise<RoomIssueSummary> {
  if (actor.role !== 'RECEPTIONIST' && !isReceptionSupervisor(actor.role)) {
    throw ApiError.forbidden('Bạn không có quyền xem tổng hợp thu tiền phòng.');
  }
  const base = roomIssueWhere(actor, { ...filter, status: undefined });
  const live: Prisma.RoomInspectionIssueWhereInput = { ...base, voidedAt: null };
  const [byType, collections, pendingNoRow] = await client.$transaction([
    client.roomInspectionIssue.groupBy({ by: ['type'], where: live, _count: { _all: true }, orderBy: { type: 'asc' } }),
    client.roomIssueCollection.groupBy({
      by: ['status', 'method'],
      where: { issue: live },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ status: 'asc' }, { method: 'asc' }],
    }),
    client.roomInspectionIssue.count({ where: { ...live, collection: { is: null } } }),
  ]);

  const byStatus: Record<RoomCollectionStatus, number> = { PENDING: pendingNoRow, COLLECTED: 0, UNCOLLECTIBLE: 0 };
  const collectedByMethod: Record<RoomCollectionMethod, number> = { CASH: 0, TRANSFER: 0, CARD: 0 };
  let pendingAmount = 0;
  let uncollectibleAmount = 0;
  for (const g of collections) {
    const amount = g._sum?.amount ?? 0;
    const count = typeof g._count === 'object' && g._count ? (g._count._all ?? 0) : 0;
    byStatus[g.status] += count;
    if (g.status === 'COLLECTED' && g.method) collectedByMethod[g.method] += amount;
    if (g.status === 'PENDING') pendingAmount += amount;
    if (g.status === 'UNCOLLECTIBLE') uncollectibleAmount += amount;
  }
  return {
    total: byStatus.PENDING + byStatus.COLLECTED + byStatus.UNCOLLECTIBLE,
    byStatus,
    byType: byType.map((g) => ({
      type: g.type,
      label: ROOM_ISSUE_TYPE_LABELS[g.type],
      count: typeof g._count === 'object' && g._count ? (g._count._all ?? 0) : 0,
    })),
    collectedByMethod,
    collectedTotal: collectedByMethod.CASH + collectedByMethod.TRANSFER + collectedByMethod.CARD,
    pendingAmount,
    uncollectibleAmount,
  };
}

/* ------------------------------------------------------------------ *
 * Reception / Admin: settle one issue
 * ------------------------------------------------------------------ */

export interface CollectionInput {
  status: unknown;
  amount?: unknown;
  method?: unknown;
  reason?: unknown;
  note?: unknown;
}

async function loadIssue(id: string, client: PrismaClient): Promise<IssueRow> {
  const row = await client.roomInspectionIssue.findUnique({ where: { id }, include: ISSUE_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy vấn đề phòng.');
  return row;
}

/** Reception reaches its own branch only; Admin reaches every branch. */
function assertMayHandle(row: IssueRow, actor: HousekeepingActor): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'RECEPTIONIST') {
    if (row.branchId !== actor.branchId) throw ApiError.branchAccessDenied();
    return;
  }
  throw ApiError.forbidden('Chỉ lễ tân hoặc Admin mới cập nhật được thu tiền phòng.');
}

/**
 * Records the collection state of ONE issue — independent of its siblings from
 * the same inspection.
 *
 * THE RULES, restated by CHECK constraints in the database:
 *   Đã thu          needs a method (Tiền mặt / Chuyển khoản / Cà thẻ) and an amount
 *   Không thu được  needs a reason, and carries no method
 *   Chưa thu        carries neither
 *
 * Every save appends a `RoomIssueCollectionEvent`, so the state on the row is
 * always explainable by what was saved, by whom, and when.
 */
export async function saveCollection(
  issueId: string,
  input: CollectionInput,
  actor: HousekeepingActor,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  const row = await loadIssue(issueId, client);
  assertMayHandle(row, actor);
  if (row.voidedAt) throw ApiError.conflict('Vấn đề phòng đã bị hủy, không thể cập nhật.');

  if (typeof input.status !== 'string' || !(ROOM_COLLECTION_STATUSES as readonly string[]).includes(input.status)) {
    throw ApiError.validation('Trạng thái thu tiền không hợp lệ.');
  }
  const status = input.status as RoomCollectionStatus;
  const amount = assertMoney(input.amount ?? 0, 'Số tiền');
  const note = trimmed(input.note) || null;
  if (note && note.length > 2000) throw ApiError.validation('Ghi chú quá dài.');

  let method: RoomCollectionMethod | null = null;
  let reason: string | null = null;
  if (status === 'COLLECTED') {
    if (typeof input.method !== 'string' || !(ROOM_COLLECTION_METHODS as readonly string[]).includes(input.method)) {
      throw ApiError.validation('Vui lòng chọn hình thức thu tiền.');
    }
    method = input.method as RoomCollectionMethod;
    if (amount < 1) throw ApiError.validation('Số tiền đã thu phải lớn hơn 0.');
  } else if (status === 'UNCOLLECTIBLE') {
    reason = trimmed(input.reason);
    if (!reason) throw ApiError.validation('Vui lòng nhập lý do không thu được.');
    if (reason.length > 1000) throw ApiError.validation('Lý do quá dài.');
  }

  const now = clock.now();
  const shift = await captureShiftContext(actor as ShiftActor, client);
  const recordedByNameSnapshot = shift.receptionistName ?? actor.fullName;

  await client.$transaction([
    client.roomIssueCollection.upsert({
      where: { issueId },
      create: {
        issueId,
        amount,
        status,
        method,
        reason,
        note,
        recordedByUserId: actor.id,
        recordedByNameSnapshot,
        shiftSessionId: shift.shiftSessionId,
        shiftType: shift.shiftType,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        amount,
        status,
        method,
        reason,
        note,
        recordedByUserId: actor.id,
        recordedByNameSnapshot,
        shiftSessionId: shift.shiftSessionId,
        shiftType: shift.shiftType,
        updatedAt: now,
      },
    }),
    client.roomIssueCollectionEvent.create({
      data: {
        issueId,
        amount,
        status,
        method,
        reason,
        note,
        actorUserId: actor.id,
        actorNameSnapshot: recordedByNameSnapshot,
        actorRole: actor.role,
        createdAt: now,
      },
    }),
  ]);
  return serializeRoomIssue(await loadIssue(issueId, client), { money: true });
}

/**
 * Admin only: withdraw a mistaken issue. Kept on file with the reason; it stops
 * counting in every total and cannot be settled afterwards.
 */
export async function voidRoomIssue(
  issueId: string,
  reason: unknown,
  actor: HousekeepingActor,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('Chỉ Admin mới hủy được vấn đề phòng.');
  const why = trimmed(reason);
  if (!why) throw ApiError.validation('Vui lòng nhập lý do hủy.');
  const row = await loadIssue(issueId, client);
  if (row.voidedAt) throw ApiError.conflict('Vấn đề phòng đã bị hủy trước đó.');
  const { count } = await client.roomInspectionIssue.updateMany({
    where: { id: issueId, voidedAt: null },
    data: {
      voidedAt: clock.now(),
      voidedByUserId: actor.id,
      voidedByNameSnapshot: actor.fullName,
      voidReason: why,
    },
  });
  if (count === 0) throw ApiError.conflict('Vấn đề phòng đã bị hủy trước đó.');
  return serializeRoomIssue(await loadIssue(issueId, client), { money: true });
}
