/**
 * BUỒNG PHÒNG — KPI, staff progress, the overview and the operations report.
 *
 * ONE ATTRIBUTION, DERIVED, NEVER COPIED: a finding belongs to the inspection it
 * was recorded on, and the inspection to the account that saved it
 * (\`RoomInspection.createdByUserId\` — the authenticated worker). Reception's
 * collection is the finding's one \`RoomIssueCollection\` row. So a collection is
 * credited to the worker whose inspection found it, automatically, exactly once
 * (one row per finding), and a void (the finding's) takes it out everywhere.
 *
 * The worker reads its own KPI; the Quản lý buồng phòng its branch; the Admin
 * every branch — the same functions, a different scope.
 */
import type { Prisma, PrismaClient, RoomCollectionStatus, RoomWorkState } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { hcmDateOnly } from '../lib/clock';
import { hcmRange } from '../booking/recreationReport';
import { listShifts } from './workShiftService';
import type { HousekeepingActor } from './roomIssueService';
import { ROOM_COLLECTION_STATUS_LABELS, ROOM_ISSUE_TYPE_LABELS } from './roomIssueTypes';
import { TASK_INCLUDE, managerBranchWhere, serializeTask } from './roomTaskService';
import { EMPTY_CLEANING, describeCleaning, readCleaning } from './roomTaskCatalog';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PeriodFilter {
  from: string;
  to: string;
  branchId?: number;
}

function assertPeriod(f: { from: string; to: string }): { start: Date; end: Date } {
  if (!DATE.test(f.from) || !DATE.test(f.to) || f.from > f.to) throw ApiError.validation('Khoảng ngày không hợp lệ.');
  return hcmRange(f.from, f.to);
}

const INSPECTION_SELECT = {
  id: true,
  branchId: true,
  roomNumber: true,
  createdAt: true,
  createdByUserId: true,
  createdByNameSnapshot: true,
  branch: { select: { id: true, code: true, address: true, branchNumber: true } },
  issues: {
    where: { voidedAt: null },
    select: {
      id: true,
      type: true,
      note: true,
      createdAt: true,
      collection: { select: { status: true, amount: true, recordedByNameSnapshot: true, updatedAt: true } },
    },
  },
} satisfies Prisma.RoomInspectionSelect;

type InspectionRow = Prisma.RoomInspectionGetPayload<{ select: typeof INSPECTION_SELECT }>;

export interface KpiRow {
  userId: number;
  fullName: string;
  /** "Lượt kiểm phòng". */
  inspections: number;
  /** "Phát sinh" — findings recorded (live). */
  findings: number;
  collectedCount: number;
  pendingCount: number;
  uncollectibleCount: number;
  /** "Tổng tiền đã thu" — money Reception confirmed against this worker's findings. */
  collectedAmount: number;
  pendingAmount: number;
}

function emptyRow(userId: number, fullName: string): KpiRow {
  return { userId, fullName, inspections: 0, findings: 0, collectedCount: 0, pendingCount: 0, uncollectibleCount: 0, collectedAmount: 0, pendingAmount: 0 };
}

const statusOf = (c: { status: RoomCollectionStatus } | null): RoomCollectionStatus => c?.status ?? 'PENDING';

/** Adds one inspection's findings to its worker's row. */
function tally(row: KpiRow, inspection: InspectionRow, status?: RoomCollectionStatus): void {
  row.inspections += 1;
  for (const f of inspection.issues) {
    const s = statusOf(f.collection);
    if (status && s !== status) continue;
    row.findings += 1;
    if (s === 'COLLECTED') {
      row.collectedCount += 1;
      row.collectedAmount += f.collection?.amount ?? 0;
    } else if (s === 'UNCOLLECTIBLE') {
      row.uncollectibleCount += 1;
    } else {
      row.pendingCount += 1;
      row.pendingAmount += f.collection?.amount ?? 0;
    }
  }
}

async function inspectionsFor(where: Prisma.RoomInspectionWhereInput, client: PrismaClient): Promise<InspectionRow[]> {
  // ponytail: reads the period's inspections whole; aggregate in SQL if a period outgrows memory.
  return client.roomInspection.findMany({ where, select: INSPECTION_SELECT, orderBy: { createdAt: 'desc' } });
}

function rowsOf(inspections: InspectionRow[], status?: RoomCollectionStatus): KpiRow[] {
  const byUser = new Map<number, KpiRow>();
  for (const i of inspections) {
    const row = byUser.get(i.createdByUserId) ?? emptyRow(i.createdByUserId, i.createdByNameSnapshot);
    tally(row, i, status);
    byUser.set(i.createdByUserId, row);
  }
  return [...byUser.values()].sort((a, b) => b.collectedAmount - a.collectedAmount || a.fullName.localeCompare(b.fullName, 'vi'));
}

function totalsOf(rows: KpiRow[]): Omit<KpiRow, 'userId' | 'fullName'> {
  const t = emptyRow(0, '');
  for (const r of rows) {
    t.inspections += r.inspections;
    t.findings += r.findings;
    t.collectedCount += r.collectedCount;
    t.pendingCount += r.pendingCount;
    t.uncollectibleCount += r.uncollectibleCount;
    t.collectedAmount += r.collectedAmount;
    t.pendingAmount += r.pendingAmount;
  }
  const { userId: _u, fullName: _n, ...rest } = t;
  return rest;
}

function findingLines(inspections: InspectionRow[], status?: RoomCollectionStatus) {
  return inspections.flatMap((i) =>
    i.issues
      .filter((f) => !status || statusOf(f.collection) === status)
      .map((f) => ({
        id: f.id,
        inspectionId: i.id,
        branch: i.branch,
        roomNumber: i.roomNumber,
        inspectorName: i.createdByNameSnapshot,
        type: f.type,
        typeLabel: ROOM_ISSUE_TYPE_LABELS[f.type],
        note: f.note,
        createdAt: f.createdAt.toISOString(),
        collectionStatus: statusOf(f.collection),
        collectionStatusLabel: ROOM_COLLECTION_STATUS_LABELS[statusOf(f.collection)],
        amount: f.collection?.amount ?? null,
        collectedByName: f.collection?.recordedByNameSnapshot ?? null,
        collectedAt: f.collection?.status === 'COLLECTED' ? f.collection.updatedAt.toISOString() : null,
      })),
  );
}

/** "KPI & Thu tiền" for a manager or the Admin: every worker in scope. */
export async function housekeepingKpi(
  actor: HousekeepingActor,
  filter: PeriodFilter & { userId?: number; status?: RoomCollectionStatus },
  client: PrismaClient = defaultPrisma,
) {
  const { start, end } = assertPeriod(filter);
  const inspections = await inspectionsFor(
    {
      ...managerBranchWhere(actor, filter.branchId),
      createdAt: { gte: start, lt: end },
      ...(filter.userId !== undefined ? { createdByUserId: filter.userId } : {}),
    },
    client,
  );
  const rows = rowsOf(inspections, filter.status);
  return {
    rows,
    totals: totalsOf(rows),
    findings: filter.userId !== undefined ? findingLines(inspections, filter.status) : [],
  };
}

/** "KPI & Thu tiền" for the worker: its own inspections only, whichever branch. */
export async function myKpi(actor: HousekeepingActor, filter: { from: string; to: string }, client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'HOUSEKEEPING') throw ApiError.forbidden('Chỉ nhân viên buồng phòng mới có KPI cá nhân.');
  const { start, end } = assertPeriod(filter);
  const inspections = await inspectionsFor({ createdByUserId: actor.id, createdAt: { gte: start, lt: end } }, client);
  const row = rowsOf(inspections)[0] ?? emptyRow(actor.id, actor.fullName);
  return { summary: row, findings: findingLines(inspections) };
}

/* ------------------------------------------------------------------ *
 * "Theo dõi nhân viên"
 * ------------------------------------------------------------------ */

export interface StaffProgressRow extends KpiRow {
  assigned: number;
  notStarted: number;
  inProgress: number;
  completed: number;
  /** 0–100, of the rooms assigned in the period. */
  completionRate: number;
}

export async function staffProgress(actor: HousekeepingActor, filter: PeriodFilter, client: PrismaClient = defaultPrisma) {
  const { start, end } = assertPeriod(filter);
  const branchWhere = managerBranchWhere(actor, filter.branchId);
  const [tasks, inspections] = await Promise.all([
    client.housekeepingRoomTask.findMany({
      where: { ...branchWhere, voidedAt: null, workDate: { gte: filter.from, lte: filter.to }, assigneeUserId: { not: null } },
      select: { assigneeUserId: true, assigneeNameSnapshot: true, state: true },
    }),
    inspectionsFor({ ...branchWhere, createdAt: { gte: start, lt: end } }, client),
  ]);
  const byUser = new Map<number, StaffProgressRow>();
  const get = (id: number, name: string) => {
    const row = byUser.get(id) ?? { ...emptyRow(id, name), assigned: 0, notStarted: 0, inProgress: 0, completed: 0, completionRate: 0 };
    byUser.set(id, row);
    return row;
  };
  for (const t of tasks) {
    const row = get(t.assigneeUserId!, t.assigneeNameSnapshot ?? '—');
    row.assigned += 1;
    if (t.state === 'COMPLETED') row.completed += 1;
    else if (t.state === 'IN_PROGRESS') row.inProgress += 1;
    else row.notStarted += 1;
  }
  for (const i of inspections) tally(get(i.createdByUserId, i.createdByNameSnapshot), i);
  const rows = [...byUser.values()].map((r) => ({ ...r, completionRate: r.assigned ? Math.round((r.completed / r.assigned) * 100) : 0 }));
  return rows.sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
}

/** One worker, everything it did in the manager's scope: rooms, inspections, findings and money, shifts. */
export async function staffDetail(
  actor: HousekeepingActor,
  userId: number,
  filter: PeriodFilter,
  client: PrismaClient = defaultPrisma,
) {
  const { start, end } = assertPeriod(filter);
  const branchWhere = managerBranchWhere(actor, filter.branchId);
  const user = await client.user.findFirst({ where: { id: userId, role: 'HOUSEKEEPING' }, select: { id: true, fullName: true } });
  if (!user) throw ApiError.notFound('Không tìm thấy nhân viên buồng phòng.');
  const [tasks, inspections, shifts] = await Promise.all([
    client.housekeepingRoomTask.findMany({
      where: {
        ...branchWhere,
        workDate: { gte: filter.from, lte: filter.to },
        OR: [{ assigneeUserId: userId }, { cleanedByUserId: userId }, { inspection: { is: { createdByUserId: userId } } }],
      },
      include: TASK_INCLUDE,
      orderBy: [{ workDate: 'desc' }, { roomNumber: 'asc' }],
    }),
    inspectionsFor({ ...branchWhere, createdByUserId: userId, createdAt: { gte: start, lt: end } }, client),
    listShifts(actor, { from: start, to: end, branchId: filter.branchId }, client),
  ]);
  const now = new Date();
  return {
    employee: user,
    kpi: rowsOf(inspections)[0] ?? emptyRow(user.id, user.fullName),
    tasks: tasks.map((t) => serializeTask(t, { money: true, now })),
    findings: findingLines(inspections),
    shifts: shifts.filter((s) => s.user.id === userId),
  };
}

/* ------------------------------------------------------------------ *
 * "Tổng quan"
 * ------------------------------------------------------------------ */

export async function overview(actor: HousekeepingActor, filter: { workDate: string; branchId?: number }, client: PrismaClient = defaultPrisma) {
  if (!DATE.test(filter.workDate)) throw ApiError.validation('Ngày không hợp lệ.');
  const branchWhere = managerBranchWhere(actor, filter.branchId);
  const { start, end } = hcmRange(filter.workDate, filter.workDate);
  const [tasks, working, inspections, pending] = await Promise.all([
    client.housekeepingRoomTask.findMany({
      where: { ...branchWhere, workDate: filter.workDate, voidedAt: null },
      select: { state: true, priority: true, assigneeUserId: true, assigneeNameSnapshot: true },
    }),
    client.housekeepingWorkSegment.findMany({
      where: { ...branchWhere, endedAt: null, session: { endedAt: null } },
      select: { startedAt: true, branch: { select: { address: true, branchNumber: true } }, session: { select: { user: { select: { id: true, fullName: true } } } } },
    }),
    inspectionsFor({ ...branchWhere, createdAt: { gte: start, lt: end } }, client),
    client.roomInspectionIssue.aggregate({
      where: {
        ...branchWhere,
        voidedAt: null,
        OR: [{ collection: { is: null } }, { collection: { is: { status: 'PENDING' } } }],
      },
      _count: { _all: true },
    }),
  ]);
  const employees = new Map<number, { userId: number; name: string; assigned: number; inProgress: number; completed: number }>();
  for (const t of tasks) {
    if (t.assigneeUserId === null) continue;
    const e = employees.get(t.assigneeUserId) ?? { userId: t.assigneeUserId, name: t.assigneeNameSnapshot ?? '—', assigned: 0, inProgress: 0, completed: 0 };
    e.assigned += 1;
    if (t.state === 'IN_PROGRESS') e.inProgress += 1;
    if (t.state === 'COMPLETED') e.completed += 1;
    employees.set(t.assigneeUserId, e);
  }
  const kpi = totalsOf(rowsOf(inspections));
  return {
    workDate: filter.workDate,
    rooms: {
      total: tasks.length,
      notStarted: tasks.filter((t) => t.state === 'NOT_STARTED').length,
      inProgress: tasks.filter((t) => t.state === 'IN_PROGRESS').length,
      completed: tasks.filter((t) => t.state === 'COMPLETED').length,
      priority: tasks.filter((t) => t.priority).length,
      unassigned: tasks.filter((t) => t.assigneeUserId === null).length,
    },
    working: working.map((w) => ({
      userId: w.session.user.id,
      name: w.session.user.fullName,
      branch: w.branch,
      since: w.startedAt.toISOString(),
    })),
    employees: [...employees.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    inspections: kpi.inspections,
    findings: kpi.findings,
    collectedAmount: kpi.collectedAmount,
    /** Every live finding still "Chưa thu" in scope, whatever day it was found. */
    pendingCollections: typeof pending._count === 'object' && pending._count ? (pending._count._all ?? 0) : 0,
  };
}

/* ------------------------------------------------------------------ *
 * "Báo cáo vận hành buồng phòng"
 * ------------------------------------------------------------------ */

export interface OperationsRow {
  branchLabel: string;
  workDate: string;
  employee: string;
  assigned: number;
  completed: number;
  completionRate: number;
  inspections: number;
  findings: number;
  /** Seconds, over the rooms completed; null when none were. */
  avgCleaningSeconds: number | null;
  collectedAmount: number;
  pendingAmount: number;
  pendingCount: number;
  /** Rooms voided that day, and rooms with a worker's note. */
  voided: number;
  notes: number;
}

/** One room's "Dọn phòng" form in the report: who, where, and every field, labelled. */
export type CleaningDetailRow = {
  branchLabel: string;
  workDate: string;
  roomNumber: string;
  /** OUT / OC / VC. */
  statusCode: string;
  employee: string;
  state: RoomWorkState;
  /** "Time In": the inspection that started the cleaning. */
  startedAt: Date | null;
  /** "Time Out": "Hoàn thành". */
  completedAt: Date | null;
  durationSeconds: number | null;
} & ReturnType<typeof describeCleaning>;

/**
 * Objective figures only — per branch, business date and worker: rooms given and
 * done, inspections, findings, cleaning time, money collected and still pending.
 * No scores, no "tốt / kém". `rooms` carries every live room of the period
 * with its saved form as data — King / Queen / Twin and counts, replacements,
 * "Ghi nhận đặc biệt", notes — and its times: the source of the PDF and of the
 * Excel "Chi tiết dọn phòng" alike. A room not yet cleaned has an empty form.
 */
export async function operationsReport(actor: HousekeepingActor, filter: PeriodFilter, client: PrismaClient = defaultPrisma) {
  const { start, end } = assertPeriod(filter);
  const branchWhere = managerBranchWhere(actor, filter.branchId);
  const [tasks, inspections] = await Promise.all([
    client.housekeepingRoomTask.findMany({
      where: { ...branchWhere, workDate: { gte: filter.from, lte: filter.to }, assigneeUserId: { not: null } },
      select: {
        branchId: true,
        workDate: true,
        assigneeUserId: true,
        assigneeNameSnapshot: true,
        state: true,
        durationSeconds: true,
        voidedAt: true,
        cleaning: true,
        roomNumber: true,
        statusCode: true,
        startedAt: true,
        completedAt: true,
        cleanedByNameSnapshot: true,
        branch: { select: { address: true, branchNumber: true } },
      },
    }),
    inspectionsFor({ ...branchWhere, createdAt: { gte: start, lt: end } }, client),
  ]);
  type Acc = OperationsRow & { durations: number[]; sortKey: string };
  const rows = new Map<string, Acc>();
  const label = (b: { address: string; branchNumber: number }) => `Chi nhánh ${b.branchNumber} — ${b.address}`;
  const get = (branchId: number, branch: { address: string; branchNumber: number }, workDate: string, userId: number, name: string) => {
    const key = `${branchId}|${workDate}|${userId}`;
    const row =
      rows.get(key) ??
      ({
        branchLabel: label(branch),
        workDate,
        employee: name,
        assigned: 0,
        completed: 0,
        completionRate: 0,
        inspections: 0,
        findings: 0,
        avgCleaningSeconds: null,
        collectedAmount: 0,
        pendingAmount: 0,
        pendingCount: 0,
        voided: 0,
        notes: 0,
        durations: [],
        sortKey: `${String(branch.branchNumber).padStart(3, '0')}|${workDate}|${name}`,
      } satisfies Acc);
    rows.set(key, row);
    return row;
  };
  for (const t of tasks) {
    const row = get(t.branchId, t.branch, t.workDate, t.assigneeUserId!, t.assigneeNameSnapshot ?? '—');
    if (t.voidedAt) {
      row.voided += 1;
      continue;
    }
    row.assigned += 1;
    if (t.state === 'COMPLETED') {
      row.completed += 1;
      if (t.durationSeconds !== null) row.durations.push(t.durationSeconds);
    }
    if ((t.cleaning as { note?: string | null } | null)?.note) row.notes += 1;
  }
  for (const i of inspections) {
    const k = emptyRow(i.createdByUserId, i.createdByNameSnapshot);
    tally(k, i);
    const row = get(i.branchId, i.branch, hcmDateOnly(i.createdAt), i.createdByUserId, i.createdByNameSnapshot);
    row.inspections += k.inspections;
    row.findings += k.findings;
    row.collectedAmount += k.collectedAmount;
    row.pendingAmount += k.pendingAmount;
    row.pendingCount += k.pendingCount;
  }
  const rooms: (CleaningDetailRow & { sortKey: string })[] = [];
  for (const t of tasks) {
    if (t.voidedAt) continue;
    rooms.push({
      branchLabel: label(t.branch),
      workDate: t.workDate,
      roomNumber: t.roomNumber,
      statusCode: t.statusCode,
      employee: t.cleanedByNameSnapshot ?? t.assigneeNameSnapshot ?? '—',
      state: t.state,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      durationSeconds: t.durationSeconds,
      ...describeCleaning(readCleaning(t.cleaning) ?? EMPTY_CLEANING),
      sortKey: `${String(t.branch.branchNumber).padStart(3, '0')}|${t.workDate}|${t.roomNumber.padStart(6, '0')}`,
    });
  }
  const out = [...rows.values()]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'vi'))
    .map(({ durations, sortKey: _k, ...r }) => ({
      ...r,
      completionRate: r.assigned ? Math.round((r.completed / r.assigned) * 100) : 0,
      avgCleaningSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    }));
  return {
    from: filter.from,
    to: filter.to,
    rows: out,
    rooms: rooms.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey: _k, ...r }) => r),
  };
}
