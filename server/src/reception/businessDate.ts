/**
 * WHICH SHIFTS BELONG TO A BUSINESS DATE.
 *
 * The date an Admin picks for "Báo cáo vấn đề" is the SHIFT's business date,
 * not the calendar date of any record. Ca C of the 23rd runs 22:00 on the 23rd
 * to 06:00 on the 24th, and everything recorded on it — at 23:40 or at 02:15 —
 * belongs to the 23rd. A `createdAt` filter would split that shift across two
 * days: its after-midnight entries would vanish from the 23rd and turn up in
 * the 24th's report under a shift that never ran on the 24th.
 *
 * So membership is decided per SESSION, by `shiftBusinessDate`, which is built
 * on the same `shiftBoundaries` arithmetic that gives every check-in its end —
 * a late check-in to Ca C at 01:30 lands on the same day as an on-time one.
 *
 * THE STARTED-AT WINDOW BELOW IS ONLY A PREFILTER. A session belonging to day D
 * started somewhere in [14:00 on D-1, 06:00 on D+1) — the earliest is an early
 * check-in to Ca A, the latest a late check-in to an overnight shift. Loading
 * [D-1, D+2) and then keeping exactly those whose computed business date is in
 * range is a cheap indexed read; it never DECIDES membership.
 */
import type { Prisma, PrismaClient, ShiftType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { hcmWallClockToUtc, nextHcmDay } from '../lib/clock';
import { SHIFT_DEFINITIONS, shiftBusinessDate, shiftDefinition, shiftWindowLabel } from '../shift/shiftTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BusinessDateSession {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  shiftType: ShiftType;
  receptionistName: string;
  startedAt: Date;
  closedAt: Date | null;
  /** Tiền đầu ca, as counted — null when it never was. */
  openingCash: number | null;
  /** "YYYY-MM-DD" — the day this shift belongs to. */
  businessDate: string;
}

/** Every session whose business date falls in [from, to], oldest first. */
export async function sessionsForBusinessDates(
  params: { from: string; to: string; branchId?: number },
  client: PrismaClient = prisma,
): Promise<BusinessDateSession[]> {
  const windowStart = new Date(hcmWallClockToUtc(params.from, '00:00').getTime() - DAY_MS);
  const windowEnd = hcmWallClockToUtc(nextHcmDay(nextHcmDay(params.to)), '00:00');

  const rows = await client.receptionShiftSession.findMany({
    where: {
      ...(params.branchId !== undefined ? { branchId: params.branchId } : {}),
      startedAt: { gte: windowStart, lt: windowEnd },
    },
    select: {
      id: true,
      branchId: true,
      branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
      shiftType: true,
      receptionistName: true,
      startedAt: true,
      closedAt: true,
      openingCash: true,
    },
    orderBy: { startedAt: 'asc' },
  });

  return rows
    .map((row) => ({ ...row, businessDate: shiftBusinessDate(row.shiftType, row.startedAt) }))
    .filter((row) => row.businessDate >= params.from && row.businessDate <= params.to);
}

/**
 * A shift that has not been ended yet, as the warning names it.
 *
 * OPEN SHIFTS ARE NOT IN THE OFFICIAL REPORT. The report for a business date is
 * complete only once every shift of that date has pressed "Kết thúc ca" — until
 * then its figures can still change. They are left out AND listed, so the file
 * never silently passes for a finished day.
 */
export interface OpenShiftNotice {
  sessionId: string;
  branchId: number;
  branchAddress: string;
  businessDate: string;
  shiftName: string;
  shiftWindow: string;
  receptionistName: string;
}

export function openShiftNotices(sessions: BusinessDateSession[]): OpenShiftNotice[] {
  return sessions
    .filter((s) => s.closedAt === null)
    .map((s) => ({
      sessionId: s.id,
      branchId: s.branchId,
      branchAddress: s.branch.address,
      businessDate: s.businessDate,
      shiftName: shiftDefinition(s.shiftType).name,
      shiftWindow: shiftWindowLabel(s.shiftType),
      receptionistName: s.receptionistName,
    }));
}

/** The one sentence every surface uses to say the day is not finished. */
export const OPEN_SHIFT_WARNING = 'Ca chưa kết thúc chưa được đưa vào báo cáo chính thức.';

/* ------------------------------------------------------------------------ *
 * THE SHARED REPORT PERIOD — one resolution for every report screen.
 * ------------------------------------------------------------------------ */

/**
 * What every report filter sends: a period of BUSINESS dates ("Hôm nay",
 * "Ngày cụ thể" = one day, "Khoảng ngày" = a range), an optional shift, and the
 * branch narrowing the reader's scope allows.
 */
export interface ReportPeriodQuery {
  from: string;
  to: string;
  shiftType?: ShiftType;
  branchId?: number;
  branchIds?: readonly number[];
}

/**
 * The period, resolved once: the SHIFTS of those business dates (inside the
 * reader's scope, the branch and the shift asked for) and — unless one shift
 * was asked for — the window for records written with NO shift (supervisors,
 * a technician, a report filed off shift), matched by their own HCM day.
 *
 * Every report reads its rows through `journalPeriodWhere` / `issuePeriodWhere`
 * on this, so a Ca C entry at 02:15 is the 23rd's on the journal, on the
 * incident list and in the archive alike — never the 24th's on one of them.
 */
export interface ReportPeriod {
  sessions: BusinessDateSession[];
  sessionIds: string[];
  unshiftedWindow: { start: Date; end: Date } | null;
}

export async function resolveReportPeriod(
  scope: 'ALL' | readonly number[],
  q: ReportPeriodQuery,
  client: PrismaClient = prisma,
): Promise<ReportPeriod> {
  const sessions = (await sessionsForBusinessDates({ from: q.from, to: q.to, branchId: q.branchId }, client)).filter(
    (s) =>
      (scope === 'ALL' || scope.includes(s.branchId)) &&
      (!q.branchIds || q.branchIds.includes(s.branchId)) &&
      (!q.shiftType || s.shiftType === q.shiftType),
  );
  return {
    sessions,
    sessionIds: sessions.map((s) => s.id),
    unshiftedWindow: q.shiftType
      ? null
      : {
          start: hcmWallClockToUtc(q.from, '00:00'),
          end: hcmWallClockToUtc(nextHcmDay(q.to), '00:00'),
        },
  };
}

/** A row written on one of the period's shifts, or shiftless within its days. */
function periodWhere(p: ReportPeriod) {
  return {
    OR: [
      { shiftSessionId: { in: p.sessionIds } },
      ...(p.unshiftedWindow
        ? [{ shiftSessionId: null, createdAt: { gte: p.unshiftedWindow.start, lt: p.unshiftedWindow.end } }]
        : []),
    ],
  };
}

export function journalPeriodWhere(p: ReportPeriod): Prisma.ReceptionOperationalReportWhereInput {
  return periodWhere(p);
}

export function issuePeriodWhere(p: ReportPeriod): Prisma.HotelIssueWhereInput {
  return periodWhere(p);
}

/**
 * "CA" — the shifts that actually RAN in the period, never a fixed list: a day
 * worked A/B/C offers A, B, C; a day worked A4/C4 offers A4, C4. In the
 * declared order, with the names and windows every screen already uses.
 */
export async function availableShifts(
  scope: 'ALL' | readonly number[],
  q: Omit<ReportPeriodQuery, 'shiftType'>,
): Promise<{ code: ShiftType; name: string; window: string }[]> {
  const { sessions } = await resolveReportPeriod(scope, q);
  const present = new Set(sessions.map((s) => s.shiftType));
  return SHIFT_DEFINITIONS.filter((d) => present.has(d.code)).map((d) => ({
    code: d.code,
    name: d.name,
    window: shiftWindowLabel(d.code),
  }));
}
