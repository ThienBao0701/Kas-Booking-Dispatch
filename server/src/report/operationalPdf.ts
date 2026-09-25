/**
 * "BÁO CÁO VẤN ĐỀ VẬN HÀNH LỄ TÂN", as a PDF.
 *
 * LAID OUT AS CHI NHÁNH -> NGÀY -> CA / NHÂN VIÊN -> one table per category, from
 * the server's own session data. The file answers the question an Admin brings
 * to it — who recorded what, on which shift — without making them reconstruct
 * the shifts by reading timestamps. It is scoped to the same period, branch and
 * category as the screen it was exported from.
 *
 * IT CONTAINS THE ROWS, NOT THE COUNTS. The whole reason this file exists is
 * that "Thu tiền: 15 giao dịch" is unauditable: it cannot be reconciled against
 * a drawer, checked against a PMS or questioned. Every payment, every guest
 * request, every complaint and every service is printed in full.
 *
 * IT COMPUTES NOTHING. Same convention as every other report here: the caller
 * hands over the exact structure the JSON endpoint returns, so a total on the
 * page cannot disagree with the total on the screen it was printed from. The
 * cash arithmetic happens once, in `reception/cashService.ts`.
 *
 * EVERY COLUMN SET IS CHECKED AT IMPORT TIME by `assertFitsLandscape`. An
 * over-wide table does not fail at runtime — it draws its last columns off the
 * edge of the paper, where they are simply missing from the report and nobody
 * notices until they need the number. That failure shipped once in this codebase
 * already; it cannot ship again from this file.
 */
import type { OperationalReportCategory } from '@prisma/client';
import type { BranchOperationalReport, OperationalReportData } from '../reception/operationalReport';
import type { CashSummary } from '../reception/cashService';
import { OPEN_SHIFT_WARNING } from '../reception/businessDate';
import type { SerializedReport } from '../reception/reportService';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_NUMERALS,
  formatVnd,
  formatVndPlain,
} from '../reception/reportTypes';
import { MAX_VND } from '../reception/reportService';
import { hcmDateTime, periodLabel } from './format';
import {
  FONT_BOLD,
  FONT_REGULAR,
  addPageNumbers,
  assertCellsFit,
  assertFitsLandscape,
  assertHeadersFit,
  createReportDocument,
  DATE_SAMPLE,
  drawTable,
  ensureSpace,
  finishDocument,
  sectionTitle,
  tableLeadHeight,
  type Column,
  type PdfDoc,
} from './pdf';

/**
 * THE WIDEST AMOUNT THE REPORT UNDERTAKES TO PRINT ON ONE LINE.
 *
 * Deliberately larger than `MAX_VND`, which the INT4 columns cap at
 * 2.147.483.647. Sizing the columns to today's storage limit would mean the
 * report needed re-measuring the day anybody widened a column to `BigInt` — and
 * that day the failure would be silent, because a too-narrow money cell does not
 * error, it wraps: "9.999.999.99" over "9" reads as a tenth of the real figure.
 *
 * Ten digits costs 10pt of a 777.89pt page against nine. That is a cheap price
 * for never having to think about it again.
 */
export const PDF_MONEY_CEILING = 9_999_999_999;

/**
 * THE REPORT MUST BE ABLE TO PRINT ANYTHING THE SYSTEM CAN STORE.
 *
 * Checked at import, so raising `MAX_VND` past what these columns were measured
 * for stops the server rather than quietly corrupting a printed amount.
 */
if (PDF_MONEY_CEILING < MAX_VND) {
  throw new Error(
    `operational report: money columns are sized for ${PDF_MONEY_CEILING} but amounts up to ${MAX_VND} can be stored.`,
  );
}

/** "9.999.999.999" — the string the columns were actually measured against. */
export const MONEY_SAMPLE = formatVndPlain(PDF_MONEY_CEILING);

/**
 * What one money column must be.
 *
 * "9.999.999.999" measures 61.26pt in Be Vietnam Pro at 8pt, and `drawTable`
 * takes 8pt of the column for padding — so 72 leaves 64pt of usable width, a
 * 2.7pt margin. Five of these are 360pt of a 777.89pt page, which is what the
 * surrounding columns were rebalanced against.
 */
export const MONEY_COLUMN_WIDTH = 72;

/**
 * The widest value each measured column is REQUIRED to hold on one line.
 *
 * "19/09/2026 06:00" does NOT fit a timestamp column and is not meant to — it
 * breaks at the space into a date over a time, which reads correctly. What must
 * never break is the DATE itself, so that is what is asserted.
 */
const WIDEST = {
  'Thu tiền mặt (₫)': MONEY_SAMPLE,
  'Thu CK (₫)': MONEY_SAMPLE,
  'Cà thẻ (₫)': MONEY_SAMPLE,
  'Công nợ (₫)': MONEY_SAMPLE,
  'Chi (₫)': MONEY_SAMPLE,
  'Giá tiền (₫)': MONEY_SAMPLE,
  'Mã EZ': 'EZ100000',
  Nguồn: 'Booking.com',
  'Thời gian': DATE_SAMPLE,
  'Giờ nhập': DATE_SAMPLE,
  'Giờ tiếp nhận': DATE_SAMPLE,
};

/** Every guard, in the order a failure is easiest to read. */
function checked<T>(label: string, columns: Column<T>[]): Column<T>[] {
  return assertCellsFit(label, assertHeadersFit(label, assertFitsLandscape(label, columns)), WIDEST);
}

/** Rows carry their own sequence number so "STT" survives a page break. */
type Numbered<T> = T & { stt: number };

function numbered(rows: SerializedReport[]): Numbered<SerializedReport>[] {
  return rows.map((row, i) => ({ ...row, stt: i + 1 }));
}

/** A voided row still prints — with its status said out loud, never hidden. */
function voidMark(row: SerializedReport): string {
  return row.voided ? `ĐÃ HỦY — ${row.voidReason ?? ''}`.trim() : '';
}

function withVoid(row: SerializedReport, text: string | null | undefined): string {
  const mark = voidMark(row);
  const body = (text ?? '').trim();
  if (!mark) return body;
  return body ? `${body}\n[${mark}]` : `[${mark}]`;
}

/* --------------------------- I. Thu tiền thanh toán --------------------------- */

/*
  WIDTHS ARE MEASURED, NOT GUESSED.

  Every one of these was set from `widthOfString` against the embedded
  Be Vietnam Pro at 8pt, plus the 8pt of cell padding `drawTable` adds:

    "9.999.999.999"  61.26pt  ->  a money column needs 72 (the schema maximum)
    "Booking.com"    51.38pt  ->  Nguồn needs 60
    "44/44/4444"     52.5pt   ->  Thời gian needs 61 for any date alone
                                  (DATE_SAMPLE; "19/09/2026" was once used,
                                  and passed a column "22/09/2026" overflowed)
    "EZ100000"       40.36pt  ->  Mã EZ needs 49

  The five money columns take 360pt of the 777.89pt page between them. Everything
  else was rebalanced around that, because an amount the API accepts and the
  report cannot print is a worse failure than a guest name wrapping onto a third
  line.

  The first version was eyeballed, and it showed: "Booking.com" came out as
  "Booking.c / om" and 1.234.567.890 ₫ broke in the middle of the number. A word
  or an amount split across two lines is not a wrap, it is a corrupted value.

  THE "₫" LIVES IN THE HEADER. Five money columns × 6.6pt of repeated symbol is
  33pt of an A4 landscape page spent saying the same thing forty times, and it
  was exactly what pushed the amounts onto a second line.
*/
const PAYMENT_COLUMNS = checked<Numbered<SerializedReport>>('operational payments', [
  { header: 'STT', width: 26, value: (r) => String(r.stt) },
  { header: 'Nhân viên', width: 48, value: (r) => r.createdByName },
  { header: 'Mã EZ', width: 50, value: (r) => r.payment?.ezCode ?? '' },
  { header: 'Nguồn', width: 62, value: (r) => r.payment?.source ?? '' },
  { header: 'Tên khách', width: 56, value: (r) => r.payment?.guestName ?? '' },
  { header: 'Phòng', width: 36, value: (r) => r.payment?.roomNumber ?? '' },
  { header: 'Thu tiền mặt (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => (r.payment?.cash ? formatVndPlain(r.payment.cash) : '') },
  { header: 'Thu CK (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => (r.payment?.transfer ? formatVndPlain(r.payment.transfer) : '') },
  { header: 'Cà thẻ (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => (r.payment?.card ? formatVndPlain(r.payment.card) : '') },
  { header: 'Công nợ (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => (r.payment?.receivable ? formatVndPlain(r.payment.receivable) : '') },
  { header: 'Chi (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => (r.payment?.expense ? formatVndPlain(r.payment.expense) : '') },
  { header: 'Thời gian', width: 64, value: (r) => hcmDateTime(new Date(r.createdAt)) },
  { header: 'Ghi chú', width: 74, value: (r) => withVoid(r, r.payment?.note) },
]);

/* ------------------------ II. Vấn đề khách yêu cầu ------------------------ */

/**
 * A legacy field, printed where it belongs rather than in a column of its own.
 *
 * Older reports carry "Số phòng" on a request and "Phòng / Khác" on a
 * complaint, which the current forms no longer ask for. A column that is empty
 * on every current row would cost the page its width; dropping the value would
 * lose what an older report said. So it rides along in brackets.
 */
function withLegacy(text: string, legacy: string | null | undefined): string {
  const extra = legacy?.trim();
  return extra ? `${text} (${extra})`.trim() : text;
}

const GUEST_REQUEST_COLUMNS = checked<Numbered<SerializedReport>>('operational guest requests', [
  { header: 'STT', width: 26, value: (r) => String(r.stt) },
  { header: 'Tên khách', width: 80, value: (r) => r.guestRequest?.guestName ?? '' },
  { header: 'Mã EZ', width: 50, value: (r) => r.guestRequest?.ezCode ?? '' },
  {
    header: 'Nội dung',
    width: 150,
    value: (r) =>
      withVoid(
        r,
        withLegacy(
          r.guestRequest?.content ?? '',
          r.guestRequest?.roomNumber ? `P. ${r.guestRequest.roomNumber}` : null,
        ),
      ),
  },
  { header: 'Người nhập', width: 66, value: (r) => r.createdByName },
  { header: 'Ca nhập', width: 40, value: (r) => r.shiftName ?? '' },
  { header: 'Giờ nhập', width: 72, value: (r) => hcmDateTime(new Date(r.createdAt)) },
  {
    header: 'Người hoàn thành',
    width: 66,
    value: (r) => r.guestRequest?.completedByName ?? 'Chưa hoàn thành',
  },
  { header: 'Ca hoàn thành', width: 44, value: (r) => r.guestRequest?.completedShiftName ?? '' },
  {
    header: 'Giờ hoàn thành',
    width: 72,
    value: (r) => (r.guestRequest?.completedAt ? hcmDateTime(new Date(r.guestRequest.completedAt)) : ''),
  },
  { header: 'Cách xử lý (nếu có)', width: 106, value: (r) => r.guestRequest?.resolution ?? '' },
]);

/* ------------------- III. Sự cố cơ sở vật chất đang xử lý ------------------- */

const ISSUE_STATUS_LABEL: Record<string, string> = {
  NEW: 'Chờ tiếp nhận',
  IN_PROGRESS: 'Đang sửa',
  COMPLETED: 'Hoàn thành',
};

function issueStatus(r: SerializedReport): string {
  const issue = r.facility?.issue;
  if (!issue) return '';
  // "Cần xử lý lại" is a NEW incident that has already been attempted — the
  // status alone would call it new and hide that somebody has already tried.
  if (issue.needsRework) return 'Cần xử lý lại';
  return ISSUE_STATUS_LABEL[issue.status] ?? issue.status;
}

const FACILITY_COLUMNS = checked<Numbered<SerializedReport>>('operational facilities', [
  { header: 'STT', width: 26, value: (r) => String(r.stt) },
  { header: 'Vị trí', width: 120, value: (r) => r.facility?.issue.locationLabel ?? '' },
  { header: 'Mô tả', width: 180, value: (r) => withVoid(r, r.facility?.issue.description) },
  { header: 'Trạng thái', width: 80, value: issueStatus },
  {
    header: 'Kỹ thuật',
    width: 90,
    value: (r) => r.facility?.issue.technicianName ?? '',
  },
  { header: 'Người báo', width: 80, value: (r) => r.createdByName },
  { header: 'Ca', width: 30, value: (r) => r.shiftName ?? '' },
  { header: 'Thời gian', width: 70, value: (r) => hcmDateTime(new Date(r.createdAt)) },
  {
    header: 'Số lần',
    width: 40,
    align: 'right',
    value: (r) => String(r.facility?.issue.attempts.length ?? 0),
  },
]);

/* ----------------- IV. Vấn đề về chất lượng và dịch vụ ----------------- */

/** "Đã tiếp nhận", or "Đã hoàn thành" with the server's completion time. */
function complaintStatus(r: SerializedReport): string {
  const c = r.complaint;
  if (!c) return '';
  if (!c.completed) return 'Đã tiếp nhận';
  return c.completedAt ? `Đã hoàn thành ${hcmDateTime(new Date(c.completedAt))}` : 'Đã hoàn thành';
}

const COMPLAINT_COLUMNS = checked<Numbered<SerializedReport>>('operational complaints', [
  { header: 'STT', width: 26, value: (r) => String(r.stt) },
  { header: 'Tên khách', width: 90, value: (r) => r.complaint?.guestName ?? '' },
  { header: 'Mã EZ', width: 50, value: (r) => r.complaint?.ezCode ?? '' },
  {
    header: 'Mô tả',
    width: 236,
    value: (r) => withVoid(r, withLegacy(r.complaint?.description ?? '', r.complaint?.location)),
  },
  { header: 'Trạng thái', width: 72, value: complaintStatus },
  { header: 'Hướng xử lý (nếu có)', width: 120, value: (r) => r.complaint?.resolution ?? '' },
  { header: 'Nhân viên', width: 80, value: (r) => r.createdByName },
  { header: 'Ca', width: 30, value: (r) => r.shiftName ?? '' },
  { header: 'Thời gian', width: 70, value: (r) => hcmDateTime(new Date(r.createdAt)) },
]);

/* ---------------------------- V. Dịch vụ phòng ---------------------------- */

/**
 * The fields that differ by subtype, printed as one readable cell.
 *
 * THE UPGRADE READS AS WORDS, NOT AN ARROW. Be Vietnam Pro has no glyph for
 * U+2192, so "Superior Twin -> Executive Suite" printed as the two room classes
 * with an empty gap between them: nothing said which one the guest moved TO.
 * A missing glyph does not fail, it renders as nothing, which is precisely the
 * failure mode this font was embedded to avoid for Vietnamese diacritics.
 * "Từ X lên Y" also matches the words on the form that captured it.
 */
function serviceDetail(r: SerializedReport): string {
  const s = r.roomService;
  if (!s) return '';
  const parts: string[] = [];
  if (s.roomClass) parts.push(`Hạng: ${s.roomClass}`);
  if (s.fromRoomClass || s.toRoomClass) {
    parts.push(`Từ ${s.fromRoomClass ?? '?'} lên ${s.toRoomClass ?? '?'}`);
  }
  if (s.nights) parts.push(`${s.nights} đêm`);
  // Legacy fields an older row may carry; never on a row recorded since.
  if (s.serviceName) parts.push(s.serviceName);
  if (s.roomNumber) parts.push(`P. ${s.roomNumber}`);
  if (s.phone) parts.push(`SĐT ${s.phone}`);
  if (s.note) parts.push(s.note);
  return withVoid(r, parts.join(' · '));
}

const ROOM_SERVICE_COLUMNS = checked<Numbered<SerializedReport>>('operational room services', [
  { header: 'STT', width: 26, value: (r) => String(r.stt) },
  { header: 'Loại', width: 70, value: (r) => r.roomService?.serviceTypeLabel ?? '' },
  { header: 'Tên khách', width: 110, value: (r) => r.roomService?.guestName ?? '' },
  { header: 'Mã EZ', width: 50, value: (r) => r.roomService?.ezCode ?? '' },
  { header: 'Chi tiết', width: 236, value: serviceDetail },
  { header: 'Giá tiền (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => formatVndPlain(r.roomService?.price ?? null) },
  { header: 'Nhân viên', width: 80, value: (r) => r.createdByName },
  { header: 'Ca', width: 30, value: (r) => r.shiftName ?? '' },
  { header: 'Thời gian', width: 70, value: (r) => hcmDateTime(new Date(r.createdAt)) },
]);

/* ------------------------------ Assembly ------------------------------ */

const COLUMNS_BY_CATEGORY: Record<OperationalReportCategory, Column<Numbered<SerializedReport>>[]> = {
  PAYMENT: PAYMENT_COLUMNS,
  GUEST_REQUEST: GUEST_REQUEST_COLUMNS,
  FACILITY_ISSUE: FACILITY_COLUMNS,
  CUSTOMER_COMPLAINT: COMPLAINT_COLUMNS,
  ROOM_SERVICE: ROOM_SERVICE_COLUMNS,
};

/** "2026-09-22" -> "22/09/2026". */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** The drawer as one line — opening, takings, outflow, ending. */
function cashLine(cash: CashSummary): string {
  return [
    `Tiền đầu ca: ${cash.openingCash === null ? 'Chưa kiểm đếm' : formatVnd(cash.openingCash)}`,
    `Thu tiền mặt: ${formatVnd(cash.cashCollected)}`,
    `Chuyển khoản: ${formatVnd(cash.transferCollected)}`,
    `Cà thẻ: ${formatVnd(cash.cardCollected)}`,
    `Công nợ: ${formatVnd(cash.receivable)}`,
    `Chi tiền mặt: ${formatVnd(cash.cashExpense)}`,
    `Tiền cuối ca: ${cash.endingCash === null ? 'Chưa xác định' : formatVnd(cash.endingCash)}`,
  ].join('  ·  ');
}

/** "Theo dõi thanh toán: 3 · Dịch vụ phòng, KPI: 2" — the categories that have rows. */
function categoryCounts(counts: Partial<Record<OperationalReportCategory, number>>): string {
  const parts = CATEGORIES.filter((c) => (counts[c] ?? 0) > 0).map(
    (c) => `${CATEGORY_LABELS[c]}: ${counts[c]}`,
  );
  return parts.length ? parts.join('  ·  ') : 'Không có bản ghi';
}

/** Muted small print, from the left margin. */
function note(doc: PdfDoc, text: string, bold = false): void {
  doc.x = doc.page.margins.left;
  doc.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(8).text(text);
  doc.font(FONT_REGULAR).fontSize(8);
}

/**
 * OPEN SHIFTS ARE NAMED, NEVER PRINTED AS FIGURES.
 *
 * The report is official only for shifts that have pressed "Kết thúc ca". Any
 * that have not are listed here so the reader knows the day is not finished —
 * a silently shorter report reads exactly like a quieter day.
 */
function openShiftBlock(doc: PdfDoc, section: BranchOperationalReport): void {
  if (section.openShifts.length === 0) return;
  note(doc, `CHÚ Ý: ${OPEN_SHIFT_WARNING}`, true);
  for (const s of section.openShifts) {
    note(doc, `  - Ngày ${dayLabel(s.businessDate)} · ${s.shiftName} (${s.shiftWindow}) · ${s.receptionistName}`);
  }
  doc.moveDown(0.3);
}

export async function buildOperationalReportPdf(data: OperationalReportData): Promise<Buffer> {
  const singleBranch = data.branches.length === 1 ? data.branches[0]! : null;
  const branchScope = singleBranch
    ? `Chi nhánh ${singleBranch.branch.branchNumber} — ${singleBranch.branch.address}`
    : `Tất cả chi nhánh (${data.branches.length})`;
  const showCash = data.category === undefined || data.category === 'PAYMENT';

  const doc = createReportDocument({
    title: 'KAS HOTEL & RESTAURANT — BÁO CÁO VẤN ĐỀ VẬN HÀNH LỄ TÂN',
    // The period is of BUSINESS DATES, and only closed shifts are in it.
    period: `${periodLabel(data.from, data.to)} (ngày nghiệp vụ của ca, chỉ gồm ca đã kết thúc)`,
    generatedAt: hcmDateTime(data.generatedAt),
    // The category is NAMED when the file is scoped to one, so a PDF of
    // payments alone cannot be read as "nothing else happened".
    scope: data.category ? `${branchScope} · Danh mục: ${CATEGORY_LABELS[data.category]}` : branchScope,
  });

  if (data.branches.length === 0) {
    doc.font(FONT_REGULAR).fontSize(9).text('Không có chi nhánh nào trong phạm vi báo cáo.');
    addPageNumbers(doc);
    return finishDocument(doc);
  }

  data.branches.forEach((section, index) => {
    /*
      EACH BRANCH STARTS ON ITS OWN PAGE. Branches must not run together into
      one indistinguishable table — and a page break is the one separator that
      survives printing, scrolling and photocopying three pages out of the middle.
    */
    if (index > 0) doc.addPage();

    doc.x = doc.page.margins.left;
    doc.font(FONT_BOLD).fontSize(12);
    doc.text(`CHI NHÁNH ${section.branch.branchNumber} — ${section.branch.address.toUpperCase()}`);
    doc.font(FONT_REGULAR).fontSize(8);
    doc.text(`${section.branch.hotelName} · ${section.total} bản ghi · ${section.shifts.length} ca đã kết thúc`);
    if (section.truncated) {
      note(
        doc,
        `CHÚ Ý: chi nhánh này có ${section.total} bản ghi; báo cáo chỉ in phần đầu. Vui lòng thu hẹp khoảng thời gian.`,
        true,
      );
    }
    doc.moveDown(0.3);
    openShiftBlock(doc, section);

    if (section.shifts.length === 0) {
      note(doc, 'Không có ca nào đã kết thúc trong kỳ.');
      return;
    }

    // The branch's rows, by the shift that wrote them.
    const rowsOf = new Map<string, Record<OperationalReportCategory, SerializedReport[]>>();
    for (const category of CATEGORIES) {
      for (const row of section.byCategory[category]) {
        if (!row.shiftSessionId) continue;
        let bucket = rowsOf.get(row.shiftSessionId);
        if (!bucket) {
          bucket = { PAYMENT: [], GUEST_REQUEST: [], FACILITY_ISSUE: [], CUSTOMER_COMPLAINT: [], ROOM_SERVICE: [] };
          rowsOf.set(row.shiftSessionId, bucket);
        }
        bucket[category].push(row);
      }
    }

    /*
      NGÀY NGHIỆP VỤ -> CA -> NHÂN VIÊN -> DANH MỤC. Driven by the closed SHIFTS,
      not by the rows, so a shift that recorded nothing still appears — "Ca B
      ran and recorded nothing" and "Ca B is missing" are different facts.
    */
    const dates = [...new Set(section.shifts.map((s) => s.businessDate))].sort();
    for (const date of dates) {
      sectionTitle(doc, `NGÀY ${dayLabel(date)}`);
      for (const shift of section.shifts.filter((s) => s.businessDate === date)) {
        const rows = rowsOf.get(shift.sessionId);
        doc.x = doc.page.margins.left;
        // The shift heading plus a table header's worth of room, so a shift is
        // never announced at the foot of one page and listed on the next.
        ensureSpace(doc, 44);
        doc.font(FONT_BOLD).fontSize(9.5);
        doc.text(`${shift.shiftName} · ${shift.shiftWindow}   -   Nhân viên: ${shift.receptionistName}`);
        const counts = Object.fromEntries(CATEGORIES.map((c) => [c, rows?.[c].length ?? 0]));
        note(doc, categoryCounts(counts));
        doc.moveDown(0.15);

        for (const category of CATEGORIES) {
          const list = rows?.[category] ?? [];
          if (list.length === 0) continue;
          doc.x = doc.page.margins.left;
          const table = numbered(list);
          // The heading, the table header and its first row stay together.
          ensureSpace(doc, 12 + tableLeadHeight(doc, COLUMNS_BY_CATEGORY[category], table));
          doc.font(FONT_BOLD).fontSize(8);
          doc.text(`${CATEGORY_NUMERALS[category]}. ${CATEGORY_LABELS[category]} (${list.length})`);
          doc.font(FONT_REGULAR).fontSize(8);
          drawTable(doc, COLUMNS_BY_CATEGORY[category], table);
          doc.moveDown(0.2);
        }

        // THE SHIFT'S OWN DRAWER — its subtotal, closing the shift's section.
        if (showCash) {
          ensureSpace(doc, 14);
          note(doc, `Tiền mặt của ca  ·  ${cashLine(shift.cash)}`, true);
        }
        doc.moveDown(0.4);
      }
    }

    /* THE BRANCH SUBTOTAL, immediately below its own records. */
    sectionTitle(doc, `TỔNG KẾT CHI NHÁNH ${section.branch.branchNumber}`);
    note(doc, `${section.shifts.length} ca đã kết thúc  ·  ${section.total} bản ghi`);
    note(doc, categoryCounts(section.counts));
    if (showCash) note(doc, `Tiền mặt trong kỳ  ·  ${cashLine(section.cash)}`, true);
    if (section.cash.voidedCount > 0) note(doc, `(${section.cash.voidedCount} dòng đã hủy, không tính vào tổng)`);
  });

  addPageNumbers(doc);
  return finishDocument(doc);
}
