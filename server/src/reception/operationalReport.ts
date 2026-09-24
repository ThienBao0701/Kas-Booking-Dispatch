/**
 * THE OFFICIAL REPORT OF THE RECEPTION JOURNAL — one branch, or all of them,
 * over a range of BUSINESS DATES.
 *
 * WHICH ROWS ARE IN IT
 *
 * The rows of every CLOSED shift whose business date is in the range — decided
 * per shift by `businessDate.ts`, never by a record's own timestamp. Ca C of the
 * 23rd ends at 06:00 on the 24th; its after-midnight rows are the 23rd's, and
 * they join the 23rd's report the moment that shift presses "Kết thúc ca".
 *
 * An OPEN shift is left out: until it ends, its figures can still change, and a
 * report that printed them would be superseded by the next one without anything
 * saying so. It is not left out silently — each branch carries its open shifts,
 * and the file prints them under a warning.
 *
 * WHY IT RETURNS EVERY RECORD AND NOT COUNTS
 *
 * "Thu tiền: 15 giao dịch" answers no question anybody actually has. The ROWS
 * are the payload; the PDF and the XLSX are built from this same structure,
 * which is what stops the file and the screen disagreeing.
 */
import type { OperationalReportCategory, PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getClock } from '../lib/clock';
import {
  REPORT_INCLUDE,
  countReports,
  listReports,
  serializeReport,
  type ReportActor,
  type SerializedReport,
} from './reportService';
import { perShiftCash, sessionsCashSummary, type CashSummary } from './cashService';
import { CATEGORIES } from './reportTypes';
import {
  openShiftNotices,
  sessionsForBusinessDates,
  type BusinessDateSession,
  type OpenShiftNotice,
} from './businessDate';
import { shiftDefinition, shiftWindowLabel } from '../shift/shiftTypes';

/** One closed shift of the official report, with its own drawer. */
export interface OfficialShift {
  sessionId: string;
  businessDate: string;
  shiftName: string;
  shiftWindow: string;
  receptionistName: string;
  cash: CashSummary;
}

export interface BranchOperationalReport {
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  /** The drawer across this branch's closed shifts of the period. */
  cash: CashSummary;
  counts: Record<OperationalReportCategory, number>;
  /** Grouped by category, each group oldest first — the order a shift ran. */
  byCategory: Record<OperationalReportCategory, SerializedReport[]>;
  total: number;
  /** True when the branch has more rows in the period than were loaded. */
  truncated: boolean;
  /** The closed shifts of the period, in the order they began. */
  shifts: OfficialShift[];
  /** Shifts of the period still open — named, and left out of every figure. */
  openShifts: OpenShiftNotice[];
}

export interface OperationalReportData {
  from: string;
  to: string;
  /** Set when the export was scoped to one category; the header names it. */
  category?: OperationalReportCategory;
  branches: BranchOperationalReport[];
  generatedAt: Date;
}

/**
 * The per-branch row cap.
 *
 * High enough that a month at one branch fits comfortably, and stated in the
 * output rather than silently applied: `truncated` is carried all the way to the
 * PDF's own header, because an audit document that quietly stops at row 2000 is
 * worse than one that says it did.
 */
const MAX_ROWS_PER_BRANCH = 2000;

function emptyCounts(): Record<OperationalReportCategory, number> {
  return {
    PAYMENT: 0,
    GUEST_REQUEST: 0,
    FACILITY_ISSUE: 0,
    CUSTOMER_COMPLAINT: 0,
    ROOM_SERVICE: 0,
  };
}

function emptyGroups(): Record<OperationalReportCategory, SerializedReport[]> {
  return {
    PAYMENT: [],
    GUEST_REQUEST: [],
    FACILITY_ISSUE: [],
    CUSTOMER_COMPLAINT: [],
    ROOM_SERVICE: [],
  };
}

/**
 * Build the report for one branch, from its shifts of the period.
 *
 * `actor` is still passed through `listReports`, so the branch filter is the
 * same one every other read uses. There is no privileged second path.
 */
export async function branchOperationalReport(
  actor: ReportActor,
  branch: BranchOperationalReport['branch'],
  sessions: BusinessDateSession[],
  client: PrismaClient = prisma,
  /**
   * One category, or every category. Applied IN THE QUERY, through the same
   * `listReports` every other read uses — an export scoped to "Theo dõi thanh
   * toán" never loads a complaint and then drops it.
   */
  category?: OperationalReportCategory,
): Promise<BranchOperationalReport> {
  const now = getClock().now();
  const closed = sessions.filter((s) => s.closedAt !== null);
  const closedIds = closed.map((s) => s.id);
  const filter = { branchId: branch.id, category, shiftSessionIds: closedIds };

  const [rows, total, cash, shiftCash] = await Promise.all([
    listReports(actor, { ...filter, take: MAX_ROWS_PER_BRANCH }, client),
    countReports(actor, filter, client),
    sessionsCashSummary(closedIds, client),
    perShiftCash(closed, client),
  ]);

  const byCategory = emptyGroups();
  const counts = emptyCounts();
  // `listReports` is newest first; a report section reads forwards through a
  // shift, so it is reversed once here rather than sorted five times below.
  for (const row of [...rows].reverse()) {
    const view = serializeReport(row, now);
    byCategory[row.category].push(view);
    counts[row.category] += 1;
  }

  return {
    branch,
    cash,
    counts,
    byCategory,
    total,
    truncated: total > rows.length,
    shifts: closed.map((s) => ({
      sessionId: s.id,
      businessDate: s.businessDate,
      shiftName: shiftDefinition(s.shiftType).name,
      shiftWindow: shiftWindowLabel(s.shiftType),
      receptionistName: s.receptionistName,
      cash: shiftCash.get(s.id)!,
    })),
    openShifts: openShiftNotices(sessions),
  };
}

/**
 * Every branch the Admin asked for, in branch-number order.
 *
 * BRANCHES COME FROM THE DATABASE, never from a hardcoded list of eight names or
 * ids. The eight properties are `Branch` rows with their own numbers; a ninth
 * opening, or one being renamed, must not require a code change here.
 */
export async function operationalReport(
  actor: ReportActor,
  params: {
    /** Business dates, "YYYY-MM-DD", inclusive. */
    from: string;
    to: string;
    branchId?: number;
    category?: OperationalReportCategory;
  },
  client: PrismaClient = prisma,
): Promise<OperationalReportData> {
  const [branches, sessions] = await Promise.all([
    client.branch.findMany({
      where: params.branchId !== undefined ? { id: params.branchId } : { active: true },
      select: { id: true, code: true, hotelName: true, address: true, branchNumber: true },
      orderBy: [{ branchNumber: 'asc' }, { id: 'asc' }],
    }),
    sessionsForBusinessDates({ from: params.from, to: params.to, branchId: params.branchId }, client),
  ]);

  const sections: BranchOperationalReport[] = [];
  // Sequential on purpose: eight branches × four queries in parallel would open
  // thirty-two connections at once on a pool this application sizes for a desk.
  for (const branch of branches) {
    const mine = sessions.filter((s) => s.branchId === branch.id);
    sections.push(await branchOperationalReport(actor, branch, mine, client, params.category));
  }

  return {
    from: params.from,
    to: params.to,
    category: params.category,
    branches: sections,
    generatedAt: getClock().now(),
  };
}

/** Re-exported so the routes need only this module for a report. */
export { REPORT_INCLUDE, CATEGORIES };
