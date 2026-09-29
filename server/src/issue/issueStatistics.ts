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
 * Scope: Bộ phận kỹ thuật and Admin see every branch (optionally one); it is not
 * available to anyone else, so there is no per-branch narrowing rule to get wrong.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getClock, hcmDateOnly } from '../lib/clock';
import { durationSeconds, formatDuration } from '../lib/duration';
import { hcmRange } from '../booking/recreationReport';
import { ISSUE_AREA_LABELS } from './issueArea';
import { ISSUE_CATEGORY_LABELS } from './issueService';

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
  filter: { days: StatisticsPeriodDays; branchId?: number },
  now: Date = getClock().now(),
): Promise<IncidentStatistics> {
  const to = hcmDateOnly(now);
  const from = shiftDay(to, -(filter.days - 1));
  const { start, end } = hcmRange(from, to);

  const branch: Prisma.HotelIssueWhereInput =
    filter.branchId !== undefined ? { branchId: filter.branchId } : {};
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
    needsRework: await tx.hotelIssue.count({
      where: { ...reported, status: 'NEW', attempts: { some: { outcome: 'CANNOT_REPAIR' } } },
    }),
    outstanding: await tx.hotelIssue.groupBy({
      by: ['status'],
      where: { ...branch, status: { in: ['NEW', 'IN_PROGRESS'] } },
      _count: { _all: true },
    }),
    // Timestamps only: the trend is bucketed by HCM day below, and a day is not
    // something PostgreSQL can be asked for without a timezone decision made here.
    reportedTimes: await tx.hotelIssue.findMany({ where: reported, select: { createdAt: true } }),
    completedTimes: await tx.hotelIssue.findMany({
      where: { ...branch, completedAt: { gte: start, lt: end } },
      select: { completedAt: true },
    }),
    attempts: await tx.technicalRepairAttempt.findMany({
      where: {
        acceptedAt: { gte: start, lt: end },
        ...(filter.branchId !== undefined ? { issue: { branchId: filter.branchId } } : {}),
      },
      select: { technicianNameSnapshot: true, outcome: true, acceptedAt: true, outcomeAt: true },
    }),
  }));

  const count = (status: string) =>
    result.byStatus.find((g) => g.status === status)?._count._all ?? 0;
  const newCount = count('NEW');
  const inProgressCount = count('IN_PROGRESS');
  const completedCount = count('COMPLETED');

  const outstandingOf = (status: string) =>
    result.outstanding.find((g) => g.status === status)?._count._all ?? 0;

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

  const byBranch = result.branches.map((b) => {
    const rows = result.byBranchStatus.filter((g) => g.branchId === b.id);
    const of = (status: string) => rows.find((g) => g.status === status)?._count._all ?? 0;
    const completed = of('COMPLETED');
    const total = of('NEW') + of('IN_PROGRESS') + completed;
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
      total: outstandingOf('NEW') + outstandingOf('IN_PROGRESS'),
      newCount: outstandingOf('NEW'),
      inProgressCount: outstandingOf('IN_PROGRESS'),
    },
    byStatus: (['NEW', 'IN_PROGRESS', 'COMPLETED'] as const).map((status) => ({
      status,
      label: STATUS_LABELS[status],
      count: count(status),
    })),
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
  };
}
