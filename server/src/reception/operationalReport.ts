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
import type { OperationalReportCategory, PrismaClient, ShiftType } from '@prisma/client';
import { scopedBranchFilter } from '../auth/branchScope';
import { listRoomIssues, type SerializedRoomIssue } from '../housekeeping/roomIssueService';
import { hcmRange } from '../booking/recreationReport';
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
  /**
   * "Buồng phòng": the room findings recorded in the period (by their own HCM
   * day — an inspection has no shift), with their collection state. Present on
   * the FULL report only; empty when the export is one category or one shift.
   */
  housekeeping: SerializedRoomIssue[];
  housekeepingTruncated: boolean;
}

export interface OperationalReportData {
  from: string;
  to: string;
  /** Set when the export was scoped to one category; the header names it. */
  category?: OperationalReportCategory;
  /** Set when the export was scoped to one shift type; the header names it. */
  shiftType?: ShiftType;
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
    HOTEL_DELIVERY: 0,
  };
}

function emptyGroups(): Record<OperationalReportCategory, SerializedReport[]> {
  return {
    PAYMENT: [],
    GUEST_REQUEST: [],
    FACILITY_ISSUE: [],
    CUSTOMER_COMPLAINT: [],
    ROOM_SERVICE: [],
    HOTEL_DELIVERY: [],
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
  /**
   * The period's own instants, for the records a SUPERVISOR entered while no
   * shift was open: they belong to no shift, so their HCM day decides. Omitted
   * when the report is for one shift — a shift-less row is in no shift.
   */
  unshiftedWindow?: { from: Date; to: Date },
): Promise<BranchOperationalReport> {
  const now = getClock().now();
  const closed = sessions.filter((s) => s.closedAt !== null);
  const closedIds = closed.map((s) => s.id);
  const filter = { branchId: branch.id, category, shiftSessionIds: closedIds, unshiftedWindow };

  const [rows, total, cash, shiftCash, rooms] = await Promise.all([
    listReports(actor, { ...filter, take: MAX_ROWS_PER_BRANCH }, client),
    countReports(actor, filter, client),
    sessionsCashSummary(closedIds, client),
    perShiftCash(closed, client),
    // Housekeeping belongs to the full report: no category, no single shift.
    category === undefined && unshiftedWindow
      ? listRoomIssues(actor, { branchId: branch.id, from: unshiftedWindow.from, to: unshiftedWindow.to }, client)
      : Promise.resolve({ issues: [] as SerializedRoomIssue[], total: 0, truncated: false }),
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
    // Oldest first, like every other section of the report.
    housekeeping: [...rooms.issues].reverse(),
    housekeepingTruncated: rooms.truncated,
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
    /** Several branches at once — "Chi nhánh 1 + 2 + 3". */
    branchIds?: number[];
    category?: OperationalReportCategory;
    /** One shift type only ("Ca A"); every shift when absent. */
    shiftType?: ShiftType;
  },
  client: PrismaClient = prisma,
): Promise<OperationalReportData> {
  /*
    THE BRANCHES ARE THE ACTOR'S SCOPE, narrowed to what was asked — the same
    `scopedBranchFilter` every journal read goes through. A Quản lý lễ tân asking
    for "all" gets its own branches; asking for another one is refused.
  */
  const requested = params.branchIds ?? (params.branchId !== undefined ? [params.branchId] : undefined);
  const branchWhere = scopedBranchFilter(actor, requested);
  const [branches, allSessions] = await Promise.all([
    client.branch.findMany({
      // Named branches as asked (active or not, as before); otherwise the
      // scope's active branches — every branch for the Admin.
      where: requested
        ? { id: branchWhere.branchId! }
        : { active: true, ...(branchWhere.branchId !== undefined ? { id: branchWhere.branchId } : {}) },
      select: { id: true, code: true, hotelName: true, address: true, branchNumber: true },
      orderBy: [{ branchNumber: 'asc' }, { id: 'asc' }],
    }),
    sessionsForBusinessDates(
      { from: params.from, to: params.to, branchId: requested?.length === 1 ? requested[0] : undefined },
      client,
    ),
  ]);
  const sessions = params.shiftType ? allSessions.filter((s) => s.shiftType === params.shiftType) : allSessions;
  // Shift-less supervisor rows join by their own HCM day — unless one shift was asked for.
  const window = hcmRange(params.from, params.to);
  const unshiftedWindow = params.shiftType ? undefined : { from: window.start, to: window.end };

  const sections: BranchOperationalReport[] = [];
  // Sequential on purpose: eight branches × four queries in parallel would open
  // thirty-two connections at once on a pool this application sizes for a desk.
  for (const branch of branches) {
    const mine = sessions.filter((s) => s.branchId === branch.id);
    sections.push(await branchOperationalReport(actor, branch, mine, client, params.category, unshiftedWindow));
  }

  return {
    from: params.from,
    to: params.to,
    category: params.category,
    shiftType: params.shiftType,
    branches: sections,
    generatedAt: getClock().now(),
  };
}

/** Re-exported so the routes need only this module for a report. */
export { REPORT_INCLUDE, CATEGORIES };
