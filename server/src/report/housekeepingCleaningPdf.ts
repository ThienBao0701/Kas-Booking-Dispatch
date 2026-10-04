/**
 * "KAS – BÁO CÁO KIỂM TRA & DỌN PHÒNG" — the PDF of what the Buồng phòng worker
 * entered in "Dọn phòng", room by room, after the paper housekeeping form.
 *
 * For each branch and business day, five framed tables, each led by the room
 * number so a room is followed across them:
 *
 *   Phòng, thời gian và ghi nhận đặc biệt   code, worker, Time In / Out, time, L/B … LNL
 *   Đồ vải (Bedding)                         King / Queen / Twin and the count, per item
 *   Vật dụng — số lượng                      every counted item of the form
 *   Đồ thay thế                              the six replacement items
 *   Ghi chú                                  the saved notes
 *
 * A ticked box is a drawn check mark and an unticked one is empty, as on paper.
 * The rows are `operationsReport().rooms` — the same rows the Excel "Chi tiết
 * dọn phòng" sheet is written from, so the two cannot disagree. Money and KPI
 * figures are deliberately absent: they belong to "KPI & Thu tiền".
 */
import type { CleaningDetailRow } from '../housekeeping/housekeepingKpi';
import { LINEN_ITEMS, LINEN_SIZES, QUANTITY_ITEMS, REPLACEMENT_ITEMS, ROOM_WORK_STATE_LABELS, SPECIAL_STATUSES } from '../housekeeping/roomTaskCatalog';
import { cleaningClock, cleaningDuration } from './housekeepingOpsReport';
import { hcmDateTime, hcmDayLabel, periodLabel } from './format';
import {
  FONT_BOLD,
  FONT_REGULAR,
  addPageNumbers,
  assertFitsLandscape,
  assertHeadersFit,
  createReportDocument,
  drawTable,
  ensureSpace,
  finishDocument,
  sectionTitle,
  tableLeadHeight,
  type Column,
  type PdfDoc,
} from './pdf';

export const HOUSEKEEPING_CLEANING_TITLE = 'KAS – BÁO CÁO KIỂM TRA & DỌN PHÒNG';

export interface HousekeepingCleaningData {
  from: string;
  to: string;
  /** "Chi nhánh 1 — 05 Trương Định" or "Tất cả chi nhánh". */
  scope: string;
  generatedAt: Date;
  rooms: CleaningDetailRow[];
}

type Row = CleaningDetailRow;

/** `drawTable` prints "—" for an empty string; a checklist leaves an unfilled box empty. */
const BLANK = ' ';

const checked = (label: string, test: (r: Row) => boolean): Column<Row> => ({ header: label, width: 0, value: () => '', mark: test, align: 'center' });
const sized = (column: Column<Row>, width: number): Column<Row> => ({ ...column, width });
const fits = (label: string, columns: Column<Row>[]) => assertHeadersFit(label, assertFitsLandscape(label, columns));

const ROOM: Column<Row> = { header: 'Phòng', width: 44, value: (r) => r.roomNumber };

/** Room, code, who, when — and the six special statuses as boxes. */
export const ROOM_COLUMNS = fits('housekeeping cleaning — rooms', [
  ROOM,
  { header: 'Mã', width: 40, value: (r) => r.statusCode, align: 'center' },
  { header: 'Người thực hiện', width: 132, value: (r) => r.employee },
  { header: 'Time In', width: 54, value: (r) => cleaningClock(r.startedAt, r.workDate) || BLANK, align: 'center' },
  { header: 'Time Out', width: 54, value: (r) => cleaningClock(r.completedAt, r.workDate) || BLANK, align: 'center' },
  { header: 'Thời gian dọn', width: 66, value: (r) => cleaningDuration(r) || BLANK, align: 'center' },
  { header: 'Trạng thái', width: 72, value: (r) => ROOM_WORK_STATE_LABELS[r.state] },
  ...SPECIAL_STATUSES.map((s) => sized(checked(s.short, (r) => r.special.some((x) => x.code === s.code)), 44)),
]);

/** Per linen item: King / Queen / Twin as boxes, then the count. */
export const BEDDING_COLUMNS = fits('housekeeping cleaning — bedding', [
  ROOM,
  ...LINEN_ITEMS.flatMap((item): Column<Row>[] => {
    const entry = (r: Row) => r.linen.find((l) => l.item === item.code);
    return [
      ...LINEN_SIZES.map((size) => sized(checked(`${item.label}\n${size.label}`, (r) => entry(r)?.size === size.code), 52)),
      { header: `${item.label}\nSố lượng`, width: 56, value: (r) => (entry(r)?.quantity ?? BLANK).toString(), align: 'center' },
    ];
  }),
]);

/** Every counted item of the form, in its order. */
export const QUANTITY_COLUMNS = fits('housekeeping cleaning — quantities', [
  ROOM,
  ...QUANTITY_ITEMS.map((item): Column<Row> => ({
    header: item.label,
    width: 60,
    value: (r) => (r.quantities.find((q) => q.item === item.code)?.quantity ?? BLANK).toString(),
    align: 'center',
  })),
]);

/** The six replacement items as boxes. */
export const REPLACEMENT_COLUMNS = fits('housekeeping cleaning — replacements', [
  ROOM,
  ...REPLACEMENT_ITEMS.map((item) => sized(checked(item.label, (r) => r.replaced.some((x) => x.code === item.code)), 112)),
]);

const NOTE_COLUMNS = fits('housekeeping cleaning — notes', [
  ROOM,
  { header: 'Người thực hiện', width: 140, value: (r) => r.employee },
  { header: 'Ghi chú', width: 590, value: (r) => r.note ?? '' },
]);

const SPECIAL_LEGEND = SPECIAL_STATUSES.map((s) => `${s.short}: ${s.label}`).join(' · ');

/** A table's own heading, kept on the page with the table's header and first row. */
function table(doc: PdfDoc, title: string, group: string, columns: Column<Row>[], rows: Row[], caption?: string): void {
  doc.x = doc.page.margins.left;
  doc.moveDown(0.5);
  ensureSpace(doc, 18 + (caption ? 12 : 0) + tableLeadHeight(doc, columns, rows));
  doc.fillColor('#000').font(FONT_BOLD).fontSize(9.5).text(title);
  if (caption) doc.font(FONT_REGULAR).fontSize(8).fillColor('#475569').text(caption).fillColor('#000');
  doc.moveDown(0.2);
  drawTable(doc, columns, rows, { frame: true, continuedTitle: `${group} — ${title} (tiếp)` });
}

export async function buildHousekeepingCleaningPdf(data: HousekeepingCleaningData): Promise<Buffer> {
  const employees = [...new Set(data.rooms.map((r) => r.employee))].sort((a, b) => a.localeCompare(b, 'vi'));
  const doc = createReportDocument({
    title: HOUSEKEEPING_CLEANING_TITLE,
    period: periodLabel(data.from, data.to),
    generatedAt: hcmDateTime(data.generatedAt),
    scope: data.scope,
    lines: [
      { label: 'Chi nhánh', value: data.scope },
      data.from === data.to
        ? { label: 'Ngày nghiệp vụ', value: hcmDayLabel(data.from) }
        : { label: 'Khoảng ngày', value: periodLabel(data.from, data.to) },
      { label: 'Nhân viên', value: employees.join(', ') || '—' },
      { label: 'Xuất lúc', value: hcmDateTime(data.generatedAt) },
    ],
  });

  if (data.rooms.length === 0) {
    doc.text('Không có phòng nào trong kỳ báo cáo này.');
  }
  // One block per branch and business day; the rows arrive in that order.
  const groups = new Map<string, Row[]>();
  for (const r of data.rooms) {
    const key = `${r.branchLabel}|${r.workDate}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const group = `${rows[0]!.branchLabel} · Ngày ${hcmDayLabel(rows[0]!.workDate)}`;
    sectionTitle(doc, `${group} · ${rows.length} phòng`);
    table(doc, 'Phòng, thời gian và ghi nhận đặc biệt', group, ROOM_COLUMNS, rows, SPECIAL_LEGEND);
    table(doc, 'Đồ vải (Bedding)', group, BEDDING_COLUMNS, rows);
    table(doc, 'Vật dụng — số lượng', group, QUANTITY_COLUMNS, rows);
    table(doc, 'Đồ thay thế', group, REPLACEMENT_COLUMNS, rows);
    const noted = rows.filter((r) => r.note);
    if (noted.length > 0) {
      table(doc, 'Ghi chú', group, NOTE_COLUMNS, noted);
    } else {
      doc.x = doc.page.margins.left;
      doc.moveDown(0.5);
      doc.font(FONT_BOLD).fontSize(9.5).text('Ghi chú');
      doc.font(FONT_REGULAR).fontSize(8).text('Không có ghi chú.');
    }
  }
  addPageNumbers(doc);
  return finishDocument(doc);
}
