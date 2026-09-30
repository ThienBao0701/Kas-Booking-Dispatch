/**
 * THE TECHNICAL DEPARTMENT'S "THỐNG KÊ" — one read over the incidents that
 * already exist.
 *
 * NOTHING HERE IS STORED OR INVENTED. Every figure is a count or an average over
 * `HotelIssue` and `TechnicalRepairAttempt`, the tables the incident screens
 * themselves read, and a period with no incidents returns zeros and empty lists
 * — the screen decides how to say "no data", this function never pads.
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART (as `computeIncidentRangeSummary` does):
 *   - the PERIOD: incidents REPORTED in the last N HCM days, split by status,
 *     area, fault type and branch, with a daily reported/completed trend;
 *   - RIGHT NOW: everything not finished, at any age — an old open incident is
 *     the one a period-scoped report structurally hides.
 *
 * Scope: a TECHNICIAN sees only their own work (`technicianUserId`, set by the
 * route from the session — never from the request); the Admin sees every branch
 * and every technician, optionally narrowed to one of either. Nobody else.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getClock, hcmDateOnly } from '../lib/clock';
import { durationSeconds, formatDuration } from '../lib/duration';
import { hcmRange } from '../booking/recreationReport';
import { ISSUE_AREA_LABELS } from './issueArea';
import { ISSUE_CATEGORY_LABELS, technicianHistoryWhere } from './issueService';
import { completedStatuses, outstandingStatuses, stageWhere } from './issueLifecycle';

/** The periods the screen offers. A closed list, so the query cannot be made huge. */
export const STATISTICS_PERIOD_DAYS = [7, 30, 90] as const;
export type StatisticsPeriodDays = (typeof STATISTICS_PERIOD_DAYS)[number];

export interface IncidentStatistics {
  period: { days: number; from: string; to: string };
  /** Incidents REPORTED inside the period, whatever state they are in now. */
  totals: {
    total: number;
    newCount: number;
    inProgressCount: number;
    completedCount: number;
    /** Back in the queue after a "Không sửa được". */
    needsReworkCount: number;
  };
  /** Not finished, at any age, ignoring the period. */
  outstanding: { total: number; newCount: number; inProgressCount: number };
  byStatus: { status: 'NEW' | 'IN_PROGRESS' | 'COMPLETED'; label: string; count: number }[];
  byArea: { key: string; label: string; count: number }[];
  byCategory: { key: string; label: string; count: number }[];
  byBranch: {
    branchId: number;
    branchNumber: number;
    address: string;
    hotelName: string;
    total: number;
    open: number;
    completed: number;
  }[];
  /** Repair effort in the period, from the attempts that actually happened. */
  workload: {
    attempts: number;
    completedAttempts: number;
    cannotRepairAttempts: number;
    openAttempts: number;
    averageSeconds: number | null;
    averageLabel: string | null;
    byTechnician: { name: string; attempts: number; completed: number; cannotRepair: number }[];
  };
  /** One entry per HCM day in the period, oldest first — zeros included. */
  trend: { date: string; reported: number; completed: number }[];
  /**
   * Set when the statistics are ONE technician's: their own work, counted from
   * their assignments and attempts. Facts only — no score, no ranking.
   */
  technician: {
    id: number;
    name: string;
    /** Given to them now and not yet accepted. */
    assignedNow: number;
    /** Accepted by them and still being repaired. */
    inProgressNow: number;
    /** Their attempts in the period that ended "Hoàn thành". */
    completed: number;
    /** Their attempts in the period that ended "Không sửa được". */
    cannotRepair: number;
    /** Jobs moved from them to someone else in the period. */
    reassignedAway: number;
    /** Jobs given to them in the period that repeat an earlier completed repair. */
    reopened: number;
  } | null;
}

const STATUS_LABELS = {
  NEW: 'Sự cố khách sạn',
  IN_PROGRESS: 'Đang sửa',
  COMPLETED: 'Đã hoàn thành',
} as const;

/** "YYYY-MM-DD" shifted by whole days, on the calendar and not on an instant. */
function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export async function computeIncidentStatistics(
  filter: {
    days: StatisticsPeriodDays;
    branchId?: number;
    /**
     * ONE TECHNICIAN'S statistics: the incidents they were assigned, accepted,
     * attempted or finished, and their own attempts — never the eight-branch
     * totals. Always set for a technician (by the route, from the session);
     * optional for the Admin, whose default is the global view.
     */
    technicianUserId?: number;
  },
  now: Date = getClock().now(),
): Promise<IncidentStatistics> {
  const to = hcmDateOnly(now);
  const from = shiftDay(to, -(filter.days - 1));
  const { start, end } = hcmRange(from, to);

  const tech = filter.technicianUserId;
  const branch: Prisma.HotelIssueWhereInput = {
    ...(filter.branchId !== undefined ? { branchId: filter.branchId } : {}),
    ...(tech !== undefined ? { OR: technicianHistoryWhere(tech) } : {}),
  };
  const reported: Prisma.HotelIssueWhereInput = { ...branch, createdAt: { gte: start, lt: end } };

  const result = await prisma.$transaction(async (tx) => ({
    branches: await tx.branch.findMany({
      where: filter.branchId !== undefined ? { id: filter.branchId } : { active: true },
      orderBy: { id: 'asc' },
    }),
    byStatus: await tx.hotelIssue.groupBy({ by: ['status'], where: reported, _count: { _all: true } }),
    byArea: await tx.hotelIssue.groupBy({ by: ['areaCategory'], where: reported, _count: { _all: true } }),
    byCategory: await tx.hotelIssue.groupBy({ by: ['category'], where: reported, _count: { _all: true } }),
    byBranchStatus: await tx.hotelIssue.groupBy({
      by: ['branchId', 'status'],
      where: reported,
      _count: { _all: true },
    }),
    // "Cần sửa lại": back in the queue after an attempt — the one definition the
    // queue, the counters and the exports share (`issueLifecycle.stageWhere`).
    needsRework: await tx.hotelIssue.count({ where: { ...reported, ...stageWhere('REWORK') } }),
    outstanding: await tx.hotelIssue.groupBy({
      by: ['status'],
      where: { ...branch, status: { in: outstandingStatuses() } },
      _count: { _all: true },
    }),
    // Timestamps only: the trend is bucketed by HCM day below, and a day is not
    // something PostgreSQL can be asked for without a timezone decision made here.
    reportedTimes: await tx.hotelIssue.findMany({ where: reported, select: { createdAt: true } }),
    completedTimes: await tx.hotelIssue.findMany({
      where: {
        ...branch,
        ...(tech !== undefined ? { completedByUserId: tech } : {}),
        completedAt: { gte: start, lt: end },
      },
      select: { completedAt: true },
    }),
    attempts: await tx.technicalRepairAttempt.findMany({
      where: {
        acceptedAt: { gte: start, lt: end },
        ...(filter.branchId !== undefined ? { issue: { branchId: filter.branchId } } : {}),
        ...(tech !== undefined ? { technicianUserId: tech } : {}),
      },
      select: { technicianNameSnapshot: true, outcome: true, acceptedAt: true, outcomeAt: true },
    }),
    technician:
      tech === undefined
        ? null
        : {
            user: await tx.user.findUnique({ where: { id: tech }, select: { id: true, fullName: true } }),
            assignedNow: await tx.hotelIssue.count({ where: { assignedTechnicianUserId: tech, status: 'NEW' } }),
            inProgressNow: await tx.hotelIssue.count({ where: { acceptedByUserId: tech, status: 'IN_PROGRESS' } }),
            completed: await tx.technicalRepairAttempt.count({
              where: { technicianUserId: tech, outcome: 'COMPLETED', outcomeAt: { gte: start, lt: end } },
            }),
            cannotRepair: await tx.technicalRepairAttempt.count({
              where: { technicianUserId: tech, outcome: 'CANNOT_REPAIR', outcomeAt: { gte: start, lt: end } },
            }),
            reassignedAway: await tx.hotelIssueAssignment.count({
              where: { previousTechnicianUserId: tech, createdAt: { gte: start, lt: end } },
            }),
            reopened: await tx.hotelIssueAssignment.count({
              where: {
                technicianUserId: tech,
                createdAt: { gte: start, lt: end },
                issue: { repeatOfIssueId: { not: null } },
              },
            }),
          },
  }));

  /*
    WHAT "FINISHED" MEANS IS THE LIFECYCLE'S, NOT THIS FILE'S. With inspection
    dormant a technician's "Hoàn thành" (AWAITING_INSPECTION in the database)
    closes the incident; with it on, only a pass does. Anything neither new nor
    finished is being worked, "Chờ nghiệm thu" included.
  */
  const finishedStatuses = new Set<string>(completedStatuses());
  const sumOf = (groups: { status: string; _count: { _all: number } }[], keep: (status: string) => boolean) =>
    groups.reduce((n, g) => (keep(g.status) ? n + g._count._all : n), 0);
  const newCount = sumOf(result.byStatus, (st) => st === 'NEW');
  const completedCount = sumOf(result.byStatus, (st) => finishedStatuses.has(st));
  const inProgressCount = sumOf(result.byStatus, (st) => st !== 'NEW' && !finishedStatuses.has(st));

  const outstandingNew = sumOf(result.outstanding, (st) => st === 'NEW');
  const outstandingInProgress = sumOf(result.outstanding, (st) => st !== 'NEW');

  const byArea = result.byArea
    .map((g) => ({
      key: g.areaCategory ?? 'LEGACY',
      // Reports filed before the structured form were never asked for an area.
      label: g.areaCategory ? ISSUE_AREA_LABELS[g.areaCategory] : 'Chưa phân khu vực (báo cáo cũ)',
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const byCategory = result.byCategory
    .map((g) => ({
      key: g.category ?? 'NONE',
      label: g.category ? ISSUE_CATEGORY_LABELS[g.category] : 'Không phân loại',
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const byBranch = result.branches
    .map((b) => {
      const rows = result.byBranchStatus.filter((g) => g.branchId === b.id);
      const completed = sumOf(rows, (st) => finishedStatuses.has(st));
      const total = sumOf(rows, () => true);
      return {
        branchId: b.id,
        branchNumber: b.branchNumber,
        address: b.address,
        hotelName: b.hotelName,
        total,
        open: total - completed,
        completed,
      };
    });

  // The trend: every day of the period, so a quiet day is a zero and not a gap.
  const days: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);
  const reportedByDay = new Map<string, number>();
  for (const r of result.reportedTimes) {
    const day = hcmDateOnly(r.createdAt);
    reportedByDay.set(day, (reportedByDay.get(day) ?? 0) + 1);
  }
  const completedByDay = new Map<string, number>();
  for (const r of result.completedTimes) {
    if (!r.completedAt) continue;
    const day = hcmDateOnly(r.completedAt);
    completedByDay.set(day, (completedByDay.get(day) ?? 0) + 1);
  }

  // Effort: only attempts that have an outcome have a duration.
  const finished = result.attempts.filter((a) => a.outcomeAt !== null);
  const seconds = finished
    .map((a) => durationSeconds(a.acceptedAt, a.outcomeAt!))
    .filter((n): n is number => n !== null);
  const averageSeconds =
    seconds.length > 0 ? Math.round(seconds.reduce((sum, s) => sum + s, 0) / seconds.length) : null;
  const technicians = new Map<string, { attempts: number; completed: number; cannotRepair: number }>();
  for (const a of result.attempts) {
    const row = technicians.get(a.technicianNameSnapshot) ?? { attempts: 0, completed: 0, cannotRepair: 0 };
    row.attempts += 1;
    if (a.outcome === 'COMPLETED') row.completed += 1;
    if (a.outcome === 'CANNOT_REPAIR') row.cannotRepair += 1;
    technicians.set(a.technicianNameSnapshot, row);
  }

  return {
    period: { days: filter.days, from, to },
    totals: {
      total: newCount + inProgressCount + completedCount,
      newCount,
      inProgressCount,
      completedCount,
      needsReworkCount: result.needsRework,
    },
    outstanding: {
      total: outstandingNew + outstandingInProgress,
      newCount: outstandingNew,
      inProgressCount: outstandingInProgress,
    },
    byStatus: (
      [
        ['NEW', newCount],
        ['IN_PROGRESS', inProgressCount],
        ['COMPLETED', completedCount],
      ] as const
    ).map(([status, count]) => ({ status, label: STATUS_LABELS[status], count })),
    byArea,
    byCategory,
    byBranch,
    workload: {
      attempts: result.attempts.length,
      completedAttempts: result.attempts.filter((a) => a.outcome === 'COMPLETED').length,
      cannotRepairAttempts: result.attempts.filter((a) => a.outcome === 'CANNOT_REPAIR').length,
      openAttempts: result.attempts.filter((a) => a.outcomeAt === null).length,
      averageSeconds,
      averageLabel: formatDuration(averageSeconds),
      byTechnician: [...technicians.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.attempts - a.attempts),
    },
    trend: days.map((date) => ({
      date,
      reported: reportedByDay.get(date) ?? 0,
      completed: completedByDay.get(date) ?? 0,
    })),
    technician: result.technician
      ? {
          id: tech!,
          name: result.technician.user?.fullName ?? '—',
          assignedNow: result.technician.assignedNow,
          inProgressNow: result.technician.inProgressNow,
          completed: result.technician.completed,
          cannotRepair: result.technician.cannotRepair,
          reassignedAway: result.technician.reassignedAway,
          reopened: result.technician.reopened,
        }
      : null,
  };
}
