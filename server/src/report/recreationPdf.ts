/**
 * "KAS – BÁO CÁO ĐƠN CẦN TẠO LẠI" as a PDF.
 *
 * ONE SECTION PER BRANCH, NEVER ONE MIXED TABLE. Eight branches in a single
 * continuous table meant reading a branch column on every row to know whose
 * order it was — and a manager reviewing one property had to pick its rows out
 * of everyone else's. Each branch now opens on its own page with its own
 * summary, its own orders and its own subtotal; the whole-report totals come
 * last, on a page of their own.
 *
 * It renders the report object it is handed and computes nothing but grouping
 * and counting of those same rows, so a total here cannot disagree with the
 * same total on screen.
 */
import { REVIEW_REASON_LABELS } from '../booking/proof';
import {
  branchLabelOf,
  receptionistOf,
  shiftLabelOf,
  type RecreationReport,
  type RecreationRow,
} from '../booking/recreationReport';
import { hcmDateTime, periodLabel, rankedTotals } from './format';
import {
  FONT_BOLD,
  FONT_REGULAR,
  addPageNumbers,
  assertCellsFit,
  createReportDocument,
  DATE_SAMPLE,
  drawTable,
  finishDocument,
  sectionTitle,
  type Column,
  type PdfDoc,
} from './pdf';

export const RECREATION_REPORT_TITLE = 'KAS – BÁO CÁO ĐƠN CẦN TẠO LẠI';

/*
  A4 landscape usable width is 778pt at a 32pt margin; these sum to 777. There
  is no branch column: every row of a section belongs to the branch in its
  heading, and the 192pt that column used to take went to the reason, which is
  the one cell a manager actually reads.
*/
const COLUMNS: Column<RecreationRow>[] = assertCellsFit('recreation', [
  { header: 'Mã đơn', width: 90, value: (r) => r.booking.bookingCode },
  // Wide enough for the longest source code, BOOKING_COM, on one line.
  { header: 'Nguồn', width: 84, value: (r) => r.booking.sourcePlatform ?? '—' },
  { header: 'Ngày tạo đơn', width: 88, value: (r) => hcmDateTime(r.booking.createdAt) },
  { header: 'Lễ tân', width: 118, value: (r) => receptionistOf(r) },
  { header: 'Ca', width: 44, value: (r) => shiftLabelOf(r) },
  { header: 'Lần tạo', width: 44, value: (r) => String(r.attemptNumber) },
  { header: 'Bị từ chối lúc', width: 88, value: (r) => hcmDateTime(r.reviewedAt) },
  { header: 'Lý do', width: 221, value: (r) => reasonText(r) },
], {
  // Checked at import: "BOOKING_CO" over "M" shipped once, in a 66pt column.
  Nguồn: 'BOOKING_COM',
  'Ngày tạo đơn': DATE_SAMPLE,
  'Bị từ chối lúc': DATE_SAMPLE,
});

/** Label | count, for the totals tables at the end. */
const COUNT_COLUMNS = (label: string): Column<[string, number]>[] => [
  { header: label, width: 300, value: ([name]) => name },
  { header: 'Số đơn', width: 70, align: 'right', value: ([, n]) => String(n) },
];

function reasonText(row: RecreationRow): string {
  const code = row.reviewReasonCode ? REVIEW_REASON_LABELS[row.reviewReasonCode] : null;
  // The free-text note is the part a manager actually reads, so it is not
  // dropped when a code is present — both are printed.
  return [code, row.reviewNote].filter(Boolean).join(' — ') || '—';
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export interface RecreationBranchSection {
  /** Null for orders with no branch — kept, in a section of their own. */
  branch: RecreationRow['booking']['branch'];
  /** Only this branch's rows, never another's. */
  rows: RecreationRow[];
  total: number;
  byShift: Map<string, number>;
  byReceptionist: Map<string, number>;
  bySource: Map<string, number>;
}

/**
 * The report, split by branch, in branch-number order.
 *
 * Exported so the separation itself is tested — every row lands in exactly one
 * section, the one its order belongs to, and each subtotal is the count of its
 * own section's rows.
 */
export function recreationSections(report: RecreationReport): RecreationBranchSection[] {
  const sections = new Map<string, RecreationBranchSection>();
  for (const row of report.rows) {
    const b = row.booking.branch;
    const key = b ? String(b.id) : 'none';
    let section = sections.get(key);
    if (!section) {
      section = {
        branch: b,
        rows: [],
        total: 0,
        byShift: new Map(),
        byReceptionist: new Map(),
        bySource: new Map(),
      };
      sections.set(key, section);
    }
    section.rows.push(row);
    section.total += 1;
    bump(section.byShift, shiftLabelOf(row));
    bump(section.byReceptionist, receptionistOf(row));
    bump(section.bySource, row.booking.sourcePlatform ?? 'Không rõ');
  }
  // Numbered branches in order; a branchless section, if any, last.
  return [...sections.values()].sort(
    (a, b) => (a.branch?.branchNumber ?? Infinity) - (b.branch?.branchNumber ?? Infinity),
  );
}

/** "Ca A: 3  ·  Ca C: 1" — biggest first, ties by name. */
function inline(map: Map<string, number>): string {
  const entries = rankedTotals(map);
  return entries.length ? entries.map(([k, n]) => `${k}: ${n}`).join('  ·  ') : '—';
}

function line(doc: PdfDoc, text: string, bold = false): void {
  doc.x = doc.page.margins.left;
  doc.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(8.5).text(text);
  doc.font(FONT_REGULAR).fontSize(8);
}

function branchHeading(doc: PdfDoc, section: RecreationBranchSection): void {
  doc.x = doc.page.margins.left;
  const b = section.branch;
  doc.font(FONT_BOLD).fontSize(12).text(b ? `CHI NHÁNH ${b.branchNumber}` : 'KHÔNG RÕ CHI NHÁNH');
  if (b) {
    doc.font(FONT_BOLD).fontSize(10).text(b.hotelName);
    doc.font(FONT_REGULAR).fontSize(9).text(b.address);
  }
  doc.moveDown(0.4);
}

export async function buildRecreationReportPdf(
  report: RecreationReport,
  scope: string,
  generatedAt: Date,
): Promise<Buffer> {
  const doc = createReportDocument({
    title: RECREATION_REPORT_TITLE,
    period: periodLabel(report.range.from, report.range.to),
    generatedAt: hcmDateTime(generatedAt),
    scope,
  });

  if (report.rows.length === 0) {
    // Said explicitly. A report that is silently blank reads as a broken export.
    doc.text('Không có đơn nào cần tạo lại trong kỳ báo cáo này.');
    addPageNumbers(doc);
    return finishDocument(doc);
  }

  const sections = recreationSections(report);

  sections.forEach((section, index) => {
    if (index > 0) doc.addPage();
    branchHeading(doc, section);

    // The branch's summary, before its orders.
    line(doc, `Tổng đơn cần tạo lại: ${section.total}`, true);
    line(doc, `Theo ca: ${inline(section.byShift)}`);
    line(doc, `Theo lễ tân: ${inline(section.byReceptionist)}`);
    line(doc, `Theo nguồn: ${inline(section.bySource)}`);
    doc.moveDown(0.4);

    // Only this branch's orders — `drawTable` repeats its header on every page.
    drawTable(doc, COLUMNS, section.rows);

    // The branch subtotal, immediately below its own orders.
    doc.moveDown(0.4);
    const name = section.branch ? `CHI NHÁNH ${section.branch.branchNumber}` : 'KHÔNG RÕ CHI NHÁNH';
    line(doc, `TỔNG ${name}: ${section.total} đơn cần tạo lại`, true);
  });

  /* TỔNG KẾT TOÀN BỘ BÁO CÁO — on a page of its own, after every branch. */
  doc.addPage();
  sectionTitle(doc, 'TỔNG KẾT TOÀN BỘ BÁO CÁO');
  line(doc, `Tổng số đơn cần tạo lại: ${report.totals.total} (${sections.length} chi nhánh)`, true);
  doc.moveDown(0.3);
  drawTable(
    doc,
    COUNT_COLUMNS('Chi nhánh'),
    // Named as the sections are — "Chi nhánh 1 — 05 Trương Định" — not by the
    // internal branch code.
    sections.map((s): [string, number] => [
      s.branch ? `Chi nhánh ${s.branch.branchNumber} — ${s.branch.address}` : 'Không rõ chi nhánh',
      s.total,
    ]),
  );
  doc.moveDown(0.5);
  drawTable(doc, COUNT_COLUMNS('Ca làm việc'), rankedTotals(report.totals.byShift));
  doc.moveDown(0.5);
  drawTable(doc, COUNT_COLUMNS('Lễ tân'), rankedTotals(report.totals.byReceptionist));

  addPageNumbers(doc);
  return finishDocument(doc);
}

/** Exported for the route and for the tests that assert the header. */
export function recreationReportFileName(from: string, to: string): string {
  return `KAS-don-can-tao-lai-${from}-${to}.pdf`;
}

/** Re-exported so callers need not reach into the booking module for a label. */
export { branchLabelOf };
