/**
 * "KAS – BÁO CÁO BÀN GIAO CA" as a PDF.
 *
 * TWO TABLES, BECAUSE THEY ANSWER TWO QUESTIONS.
 *
 *   ĐỔI CA        who handed the desk to whom, when, and why the shift ended
 *                 early. One row per handover.
 *   BÀN GIAO CA   what the outgoing shift said was still outstanding. One row
 *                 per note, including the notes written without a shift change.
 *
 * Merging them would force every handover row to carry an empty note column and
 * every note to invent an incoming shift it may not have.
 *
 * WHAT IS DELIBERATELY NOT IN IT: nothing about an account beyond the display
 * name that was recorded at the time. No username, no role, no id.
 */
import type { HandoverRow } from '../shift/handoverService';
import type { HandoverNoteRow } from '../shift/handoverNoteService';
import { shiftDefinition } from '../shift/shiftTypes';
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

export const HANDOVER_REPORT_TITLE = 'KAS – BÁO CÁO BÀN GIAO CA';

const PRIORITY_LABELS = { NORMAL: 'Bình thường', HIGH: 'Ưu tiên' } as const;

const HANDOVER_COLUMNS: Column<HandoverRow>[] = assertFitsLandscape('handover report', [
  { header: 'Chi nhánh', width: 80, value: (h) => h.branch?.code ?? '—' },
  { header: 'Thời điểm đổi ca', width: 96, value: (h) => hcmDateTime(h.actualHandoverAt) },
  { header: 'Người bàn giao', width: 110, value: (h) => h.outgoingNameSnapshot },
  { header: 'Ca bàn giao', width: 74, value: (h) => shiftDefinition(h.outgoingShiftType).name },
  { header: 'Người nhận ca', width: 110, value: (h) => h.incomingNameSnapshot },
  { header: 'Ca nhận', width: 74, value: (h) => shiftDefinition(h.incomingShiftType).name },
  {
    header: 'Tài khoản riêng',
    width: 78,
    // Says whether the desk changed hands WITH the login or within a shared one.
    // Both are normal; which one it was matters when an audit asks whose
    // account created an order either side of the boundary.
    value: (h) => (h.incomingUserId === null ? 'Dùng chung' : 'Có'),
  },
  { header: 'Lý do', width: 150, value: (h) => h.reason },
]);

const NOTE_COLUMNS: Column<HandoverNoteRow>[] = assertFitsLandscape('handover notes', [
  { header: 'Chi nhánh', width: 80, value: (n) => n.branch?.code ?? '—' },
  { header: 'Thời gian', width: 96, value: (n) => hcmDateTime(n.createdAt) },
  { header: 'Người bàn giao', width: 110, value: (n) => n.outgoingNameSnapshot },
  { header: 'Ca', width: 60, value: (n) => shiftDefinition(n.outgoingShiftType).name },
  { header: 'Người nhận', width: 100, value: (n) => n.incomingNameSnapshot ?? '—' },
  { header: 'Mức độ', width: 66, value: (n) => PRIORITY_LABELS[n.priority] },
  { header: 'Nội dung bàn giao', width: 260, value: (n) => n.content },
]);

export interface HandoverReportInput {
  from: string;
  to: string;
  scope: string;
  handovers: HandoverRow[];
  notes: HandoverNoteRow[];
  /**
   * The period's REAL sizes, counted in the database.
   *
   * Not `handovers.length`. The lists are capped, and printing their lengths as
   * the totals made a long period report exactly the cap while silently dropping
   * the oldest rows — a wrong number presented as an audit figure.
   */
  handoverTotal: number;
  noteTotal: number;
  /** True when the tables below do not show every row the totals count. */
  truncated: boolean;
  generatedAt: Date;
}

export async function buildHandoverReportPdf(input: HandoverReportInput): Promise<Buffer> {
  const doc = createReportDocument({
    title: HANDOVER_REPORT_TITLE,
    period: periodLabel(input.from, input.to),
    generatedAt: hcmDateTime(input.generatedAt),
    scope: input.scope,
  });

  if (input.handovers.length === 0 && input.notes.length === 0) {
    doc.text('Không có lượt đổi ca hoặc bàn giao nào trong kỳ báo cáo này.');
    addPageNumbers(doc);
    return finishDocument(doc);
  }

  sectionTitle(doc, 'ĐỔI CA');
  if (input.handovers.length === 0) {
    doc.text('Không có lượt đổi ca nào trong kỳ báo cáo này.');
  } else {
    drawTable(doc, HANDOVER_COLUMNS, input.handovers);
  }

  if (input.notes.length > 0) {
    // Its own page: the two tables have different columns, and a reader who
    // meets the boundary mid-page cannot tell which header a row belongs to.
    doc.addPage();
    sectionTitle(doc, 'BÀN GIAO CA');
    drawTable(doc, NOTE_COLUMNS, input.notes);
  }

  const byBranch = new Map<string, number>();
  const byOutgoing = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const h of input.handovers) {
    bump(byBranch, h.branch ? `${h.branch.code} — ${h.branch.address}` : 'Không rõ');
    bump(byOutgoing, h.outgoingNameSnapshot);
  }

  doc.moveDown(0.8);
  sectionTitle(doc, 'TỔNG HỢP');
  doc.text(`Tổng số lượt đổi ca: ${input.handoverTotal}`);
  doc.text(`Tổng số bàn giao: ${input.noteTotal}`);
  if (input.truncated) {
    // SAID OUT LOUD. A report that quietly shows fewer rows than it counts is
    // one an operator will read as complete.
    doc.text(
      `Lưu ý: báo cáo chỉ liệt kê ${input.handovers.length} lượt đổi ca và ${input.notes.length} bàn giao gần nhất. ` +
        'Vui lòng thu hẹp khoảng thời gian để xem đầy đủ.',
    );
  }

  drawTotals(doc, 'Đổi ca theo chi nhánh', rankedTotals(byBranch));
  drawTotals(doc, 'Đổi ca theo người bàn giao', rankedTotals(byOutgoing));

  addPageNumbers(doc);
  return finishDocument(doc);
}

export function handoverReportFileName(from: string, to: string): string {
  return `KAS-bao-cao-ban-giao-ca-${from}-${to}.pdf`;
}
