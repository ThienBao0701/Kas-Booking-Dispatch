/**
 * "KAS – BÁO CÁO SỰ CỐ KHÁCH SẠN" as a PDF.
 *
 * WHAT IS DELIBERATELY NOT IN IT
 *
 * Nothing about an account beyond a display name: no username, no role, no id,
 * no password state. The technician's phone IS included — it is operational
 * contact information the report exists to carry, and the Admin who can run this
 * report can already see it on screen.
 */
import type { IssueStatus } from '@prisma/client';
import { durationSeconds, formatDuration } from '../lib/duration';
import type { IncidentRangeSummary } from '../issue/issueSummary';
import { shiftDefinition } from '../shift/shiftTypes';
import { describeLocation, ISSUE_AREA_LABELS } from '../issue/issueArea';
import { ISSUE_CATEGORY_LABELS, type IssueDetail } from '../issue/issueService';
import { INSPECTION_RESULT_LABELS, issueLifecycle } from '../issue/issueLifecycle';
import { hcmDateTime, periodLabel, rankedTotals } from './format';
import {
  addPageNumbers,
  assertFitsLandscape,
  createReportDocument,
  drawTable,
  drawTotals,
  finishDocument,
  sectionTitle,
  type Column,
} from './pdf';

export const INCIDENT_REPORT_TITLE = 'KAS – BÁO CÁO SỰ CỐ KHÁCH SẠN';

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  NEW: 'Sự cố khách sạn',
  IN_PROGRESS: 'Đang sửa',
  AWAITING_INSPECTION: 'Chờ nghiệm thu',
  COMPLETED: 'Đã hoàn thành',
};

/**
 * The incident table: 774pt against 777.89pt of usable width.
 *
 * IT USED TO SUM TO 906. Twelve columns were budgeted against a comment that
 * said 777 and never checked, so "Tiếp nhận", "Hoàn thành" and "Trạng thái" were
 * drawn past the right edge of the paper and had never once appeared in an
 * exported report. `assertFitsLandscape` now refuses that at import time.
 *
 * "Khu vực" is gone as a column because it was never separate information:
 * `describeLocation` already begins with the area name, so the old report
 * printed "Khu Vực Sảnh" beside "Khu Vực Sảnh · Sofa". "SĐT" moved to the
 * attempts table, where the phone belongs next to the person it reaches.
 */
const COLUMNS: Column<IssueDetail>[] = assertFitsLandscape('incident report', [
  { header: 'Chi nhánh', width: 68, value: (i) => i.branch?.code ?? '—' },
  { header: 'Vị trí', width: 100, value: (i) => describeLocation(i) },
  { header: 'Loại sự cố', width: 52, value: (i) => (i.category ? ISSUE_CATEGORY_LABELS[i.category] : '—') },
  // The cause rides in the description's cell rather than a column of its own:
  // the table is already at the page width, and "what is wrong" and "why" are
  // read together anyway.
  { header: 'Mô tả', width: 100, value: (i) => describeWithCause(i) },
  { header: 'Người báo', width: 56, value: (i) => i.reportedByNameSnapshot ?? i.reportedBy?.fullName ?? '—' },
  { header: 'Ca', width: 28, value: (i) => (i.shiftType ? shiftDefinition(i.shiftType).name : '—') },
  { header: 'Thời gian báo', width: 66, value: (i) => hcmDateTime(i.createdAt) },
  { header: 'Người sửa', width: 62, value: (i) => i.technicianName ?? '—' },
  { header: 'Tiếp nhận', width: 66, value: (i) => hcmDateTime(i.acceptedAt) },
  { header: 'Hoàn thành', width: 66, value: (i) => hcmDateTime(i.completedAt) },
  {
    header: 'Xử lý',
    width: 48,
    // Only for a FINISHED assignment. A running repair's elapsed time is a live
    // number, and printing it into a document that will be read next week would
    // freeze "12 phút" onto a job that took four hours.
    value: (i) => formatDuration(durationSeconds(i.acceptedAt, i.completedAt)) ?? '—',
  },
  { header: 'Trạng thái', width: 62, value: (i) => statusLabel(i) },
]);

/**
 * The status as an operator reads it — the SAME stage label every screen shows,
 * so "Cần sửa lại" is distinguished from a report nobody has touched.
 *
 * Both are NEW in the database, and printing both as "Sự cố khách sạn" would
 * hide the single most actionable fact in the report: that somebody already went
 * and it is not fixed.
 */
function statusLabel(issue: IssueDetail): string {
  return issueLifecycle(issue).stageLabel;
}

/** "Mô tả", then the ONE canonical cause when there is one. */
function describeWithCause(issue: IssueDetail): string {
  const { cause } = issueLifecycle(issue);
  return cause ? `${issue.description}\nNguyên nhân: ${cause}` : issue.description;
}

/**
 * Every INSPECTED attempt — who judged it, when, and why it failed.
 *
 * Its own table, for the reason the attempts have theirs: an incident can be
 * failed and passed, and a row per incident could show only one verdict.
 * Attempts nobody inspected (older work, or work still waiting) are not listed
 * here — an empty verdict is not a verdict.
 */
const INSPECTION_COLUMNS: Column<InspectionLine>[] = assertFitsLandscape('incident inspections', [
  { header: 'Chi nhánh', width: 60, value: (l) => l.branchCode },
  { header: 'Vị trí', width: 96, value: (l) => l.location },
  { header: 'Lần', width: 28, value: (l) => String(l.attemptNumber) },
  { header: 'Người sửa', width: 72, value: (l) => l.technicianName },
  { header: 'Nguyên nhân', width: 110, value: (l) => l.cause },
  { header: 'Kết quả sửa chữa', width: 118, value: (l) => l.result },
  { header: 'Nghiệm thu', width: 56, value: (l) => l.verdict },
  { header: 'Người nghiệm thu', width: 72, value: (l) => l.inspector },
  { header: 'Thời gian', width: 66, value: (l) => hcmDateTime(l.inspectedAt) },
  { header: 'Ghi chú / Lý do', width: 96, value: (l) => l.note },
]);

interface InspectionLine {
  branchCode: string;
  location: string;
  attemptNumber: number;
  technicianName: string;
  cause: string;
  result: string;
  verdict: string;
  inspector: string;
  inspectedAt: Date | null;
  note: string;
}

function inspectionLines(issues: IssueDetail[]): InspectionLine[] {
  const lines: InspectionLine[] = [];
  for (const issue of issues) {
    for (const attempt of issue.attempts) {
      if (!attempt.inspectionResult) continue;
      lines.push({
        branchCode: issue.branch?.code ?? '—',
        location: describeLocation(issue),
        attemptNumber: attempt.attemptNumber,
        technicianName: attempt.technicianNameSnapshot,
        cause: attempt.cause ?? '—',
        result: attempt.result ?? '—',
        verdict: INSPECTION_RESULT_LABELS[attempt.inspectionResult],
        inspector: attempt.inspectedByNameSnapshot ?? '—',
        inspectedAt: attempt.inspectedAt,
        note: attempt.inspectionNote ?? '—',
      });
    }
  }
  return lines;
}

/**
 * Every repair attempt, across every incident in the period.
 *
 * A SECOND TABLE RATHER THAN MORE COLUMNS. An incident has zero, one or five
 * attempts, and a row-per-incident table can only ever show one of them — which
 * in practice means the last, so the technician who spent forty minutes failing
 * disappears behind the one who succeeded in five. One row per attempt is the
 * only shape that can show both.
 */
const ATTEMPT_COLUMNS: Column<AttemptLine>[] = assertFitsLandscape('incident attempts', [
  { header: 'Chi nhánh', width: 68, value: (a) => a.branchCode },
  { header: 'Vị trí', width: 110, value: (a) => a.location },
  { header: 'Lần', width: 32, value: (a) => String(a.attemptNumber) },
  { header: 'Người sửa', width: 90, value: (a) => a.technicianName },
  { header: 'SĐT', width: 70, value: (a) => a.technicianPhone },
  { header: 'Tiếp nhận', width: 76, value: (a) => hcmDateTime(a.acceptedAt) },
  { header: 'Kết thúc', width: 76, value: (a) => hcmDateTime(a.outcomeAt) },
  { header: 'Kết quả', width: 76, value: (a) => a.outcomeLabel },
  { header: 'Thời gian', width: 58, value: (a) => a.duration },
  { header: 'Lý do', width: 120, value: (a) => a.reason },
]);

interface AttemptLine {
  branchCode: string;
  location: string;
  attemptNumber: number;
  technicianName: string;
  technicianPhone: string;
  acceptedAt: Date;
  outcomeAt: Date | null;
  outcomeLabel: string;
  duration: string;
  reason: string;
}

const OUTCOME_LABELS = {
  COMPLETED: 'Hoàn thành',
  CANNOT_REPAIR: 'Không sửa được',
} as const;

function attemptLines(issues: IssueDetail[]): AttemptLine[] {
  const lines: AttemptLine[] = [];
  for (const issue of issues) {
    for (const attempt of issue.attempts) {
      lines.push({
        branchCode: issue.branch?.code ?? '—',
        location: describeLocation(issue),
        attemptNumber: attempt.attemptNumber,
        technicianName: attempt.technicianNameSnapshot,
        technicianPhone: attempt.technicianPhone,
        acceptedAt: attempt.acceptedAt,
        outcomeAt: attempt.outcomeAt,
        // An attempt with no outcome is one a technician is working on RIGHT
        // NOW; it is listed rather than hidden, because "somebody is on it" is
        // exactly what a reader of an incident report wants to know.
        outcomeLabel: attempt.outcome ? OUTCOME_LABELS[attempt.outcome] : 'Đang sửa',
        duration: formatDuration(durationSeconds(attempt.acceptedAt, attempt.outcomeAt)) ?? '—',
        reason: attempt.reason ?? '—',
      });
    }
  }
  return lines;
}

export interface IncidentReportInput {
  from: string;
  to: string;
  scope: string;
  issues: IssueDetail[];
  generatedAt: Date;
  /**
   * The SAME counts the Admin screen shows, computed by the same query.
   *
   * Not derived from `issues` here. The rows in this report are the incidents
   * REPORTED in the period, and counting failed attempts across them answers a
   * different question from "how many attempts failed in the period" — an
   * incident reported on the 17th whose attempt failed on the 20th belongs to
   * one number and not the other. Both files claimed the screen and the file
   * could not disagree; computing the figure twice, from two different sets, is
   * exactly how they did.
   */
  summary: IncidentRangeSummary;
}

export async function buildIncidentReportPdf(input: IncidentReportInput): Promise<Buffer> {
  const doc = createReportDocument({
    title: INCIDENT_REPORT_TITLE,
    period: periodLabel(input.from, input.to),
    generatedAt: hcmDateTime(input.generatedAt),
    scope: input.scope,
  });

  if (input.issues.length === 0) {
    doc.text('Không có sự cố nào trong kỳ báo cáo này.');
    addPageNumbers(doc);
    return finishDocument(doc);
  }

  drawTable(doc, COLUMNS, input.issues);

  /*
    The attempt detail, on its own page.

    `addPage` rather than letting it flow: the two tables have different columns,
    and a reader who scrolls past the boundary mid-page has no way to tell which
    header the row under their eye belongs to.
  */
  const attempts = attemptLines(input.issues);
  if (attempts.length > 0) {
    doc.addPage();
    sectionTitle(doc, 'CHI TIẾT XỬ LÝ');
    drawTable(doc, ATTEMPT_COLUMNS, attempts);
  }

  // Only while inspection is part of the workflow; dormant, nothing about it prints.
  const inspections = input.summary.inspectionEnabled ? inspectionLines(input.issues) : [];
  if (inspections.length > 0) {
    doc.addPage();
    sectionTitle(doc, 'NGHIỆM THU');
    drawTable(doc, INSPECTION_COLUMNS, inspections);
  }

  const byBranch = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byArea = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const issue of input.issues) {
    bump(byBranch, issue.branch ? `${issue.branch.code} — ${issue.branch.address}` : 'Không rõ');
    bump(byStatus, statusLabel(issue));
    bump(byArea, issue.areaCategory ? ISSUE_AREA_LABELS[issue.areaCategory] : 'Không rõ');
  }

  doc.moveDown(0.8);
  sectionTitle(doc, 'TỔNG HỢP');
  doc.text(`Tổng số sự cố: ${input.issues.length}`);

  /*
    TWO NUMBERS THAT LOOK LIKE ONE, REPORTED SEPARATELY ON PURPOSE.

    "Lượt không sửa được" counts EVENTS in the period — one incident three
    technicians failed on contributes three. "Sự cố cần sửa lại" counts
    INCIDENTS currently waiting to be picked up again — that same incident
    contributes one, and contributes none at all once somebody accepts it.
    Printing either alone, or adding them together, produces a number nobody can
    interpret.

    Both come from `input.summary`, i.e. from the same query the screen reads,
    so the file and the table it was printed from cannot differ.
  */
  doc.text(`Lượt không sửa được: ${input.summary.cannotRepairAttempts}`);
  if (input.summary.inspectionEnabled) {
    doc.text(`Lượt nghiệm thu không đạt: ${input.summary.failedInspections}`);
  }
  doc.text(`Sự cố cần sửa lại: ${input.summary.needsReworkIssues}`);
  if (input.summary.inspectionEnabled) {
    doc.text(`Chờ nghiệm thu: ${input.summary.awaitingInspectionCount}`);
  }
  doc.text(`Chưa hoàn thành trên toàn hệ thống: ${input.summary.outstandingTotal}`);

  drawTotals(doc, 'Theo chi nhánh', rankedTotals(byBranch));
  drawTotals(doc, 'Theo trạng thái', rankedTotals(byStatus));
  drawTotals(doc, 'Theo khu vực', rankedTotals(byArea));

  addPageNumbers(doc);
  return finishDocument(doc);
}

export function incidentReportFileName(from: string, to: string): string {
  return `KAS-bao-cao-su-co-${from}-${to}.pdf`;
}
