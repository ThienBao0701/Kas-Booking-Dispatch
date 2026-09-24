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
import type { PrismaClient, ShiftType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { hcmWallClockToUtc, nextHcmDay } from '../lib/clock';
import { shiftBusinessDate, shiftDefinition, shiftWindowLabel } from '../shift/shiftTypes';

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
