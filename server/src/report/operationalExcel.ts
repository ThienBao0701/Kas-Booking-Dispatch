/**
 * "BÁO CÁO VẤN ĐỀ LỄ TÂN", as an XLSX workbook.
 *
 * SIX SHEETS: a branch summary, then one per category. That split is what makes
 * the file usable — an accountant reconciling cash wants the payment rows on
 * their own, sortable and filterable, not interleaved with complaints.
 *
 * MONEY IS WRITTEN AS A NUMBER, NEVER AS "7.570.000 ₫". A currency string is a
 * label: Excel cannot sum it, and the first thing anybody does with a payment
 * sheet is sum a column. The Vietnamese formatting is a cell FORMAT (`#.##0 "₫"`)
 * applied over a real integer, so the sheet both reads correctly and adds up.
 *
 * IT COMPUTES NOTHING, like `chargeReportExport.ts` and the PDF beside it. The
 * caller hands over the same structure the JSON endpoint returns.
 *
 * EVERY SHEET CARRIES ITS BRANCH COLUMN. An all-branch export whose rows cannot
 * be told apart is the failure the specification names outright, and one sheet
 * per branch would produce forty sheets across eight branches and five
 * categories. A branch column plus a frozen header row is filterable in one
 * click and stays one sheet.
 */
import ExcelJS from 'exceljs';
import type { BranchOperationalReport, OperationalReportData } from '../reception/operationalReport';
import type { SerializedReport } from '../reception/reportService';
import { CATEGORY_LABELS } from '../reception/reportTypes';
import { OPEN_SHIFT_WARNING } from '../reception/businessDate';
import { hcmDateTime, hcmDayLabel } from './format';

/** Vietnamese thousands separators over a real number. */
const VND_FORMAT = '#,##0 "₫"';

function headerRow(sheet: ExcelJS.Worksheet): void {
  sheet.getRow(1).font = { bold: true };
  // Frozen so the columns stay labelled however far down somebody scrolls.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function moneyColumns(sheet: ExcelJS.Worksheet, keys: string[]): void {
  for (const key of keys) {
    const column = sheet.getColumn(key);
    column.numFmt = VND_FORMAT;
  }
}

function branchLabel(section: BranchOperationalReport): string {
  return `CN${section.branch.branchNumber} — ${section.branch.address}`;
}

/** "ĐÃ HỦY" is a column of its own, so a filter can exclude voided rows. */
function voidState(row: SerializedReport): string {
  return row.voided ? 'Đã hủy' : '';
}

function when(iso: string | null): string {
  return iso ? hcmDateTime(new Date(iso)) : '';
}

export async function buildOperationalReportWorkbook(
  data: OperationalReportData,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kas';
  wb.created = data.generatedAt;

  /* ------------------------- 1. Tổng hợp chi nhánh ------------------------- */
  const summary = wb.addWorksheet('Tổng hợp chi nhánh');
  summary.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 34 },
    { header: 'Tiền đầu ca', key: 'opening', width: 16 },
    { header: 'Thu tiền mặt', key: 'cash', width: 16 },
    { header: 'Chuyển khoản', key: 'transfer', width: 16 },
    { header: 'Cà thẻ', key: 'card', width: 16 },
    { header: 'Công nợ', key: 'receivable', width: 16 },
    { header: 'Chi tiền mặt', key: 'expense', width: 16 },
    { header: 'Tiền cuối ca', key: 'ending', width: 18 },
    { header: CATEGORY_LABELS.PAYMENT, key: 'payments', width: 22 },
    { header: CATEGORY_LABELS.GUEST_REQUEST, key: 'requests', width: 22 },
    { header: CATEGORY_LABELS.FACILITY_ISSUE, key: 'facilities', width: 24 },
    { header: CATEGORY_LABELS.CUSTOMER_COMPLAINT, key: 'complaints', width: 26 },
    { header: CATEGORY_LABELS.ROOM_SERVICE, key: 'services', width: 20 },
    { header: 'Tổng bản ghi', key: 'total', width: 14 },
  ];
  headerRow(summary);

  summary.addRow({
    branch: `Kỳ báo cáo: ${hcmDayLabel(data.from)} – ${hcmDayLabel(data.to)} (ngày nghiệp vụ của ca, chỉ gồm ca đã kết thúc)`,
  });
  // Named when the file is scoped to one category, so a workbook of payments
  // alone cannot be read as "nothing else was recorded".
  if (data.category) summary.addRow({ branch: `Danh mục: ${CATEGORY_LABELS[data.category]}` });
  // Open shifts are named, never counted: the day is not finished until they end.
  const open = data.branches.flatMap((b) => b.openShifts);
  if (open.length > 0) {
    summary.addRow({ branch: `CHÚ Ý: ${OPEN_SHIFT_WARNING}` });
    for (const s of open) {
      summary.addRow({
        branch: `${s.branchAddress} · ${hcmDayLabel(s.businessDate)} · ${s.shiftName} (${s.shiftWindow}) · ${s.receptionistName}`,
      });
    }
  }
  summary.addRow({});

  for (const section of data.branches) {
    summary.addRow({
      branch: branchLabel(section),
      // Null, not 0, when the drawer was never counted — Excel shows an empty
      // cell and nobody reads it as "there was no money".
      opening: section.cash.openingCash,
      cash: section.cash.cashCollected,
      transfer: section.cash.transferCollected,
      card: section.cash.cardCollected,
      receivable: section.cash.receivable,
      expense: section.cash.cashExpense,
      ending: section.cash.endingCash,
      payments: section.counts.PAYMENT,
      requests: section.counts.GUEST_REQUEST,
      facilities: section.counts.FACILITY_ISSUE,
      complaints: section.counts.CUSTOMER_COMPLAINT,
      services: section.counts.ROOM_SERVICE,
      total: section.total,
    });
  }
  moneyColumns(summary, ['opening', 'cash', 'transfer', 'card', 'receivable', 'expense', 'ending']);

  /* ---------------------- 2. Thu tiền thanh toán ---------------------- */
  const payments = wb.addWorksheet(CATEGORY_LABELS.PAYMENT);
  payments.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    // The SHIFT's day, from the session — Ca C's 02:15 entries sit under the day it began.
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Nhân viên', key: 'staff', width: 20 },
    { header: 'Ca', key: 'shift', width: 8 },
    { header: 'Mã EZ', key: 'ez', width: 16 },
    { header: 'Nguồn', key: 'source', width: 16 },
    { header: 'Tên khách', key: 'guest', width: 24 },
    { header: 'Số phòng', key: 'room', width: 10 },
    { header: 'Thu tiền mặt', key: 'cash', width: 16 },
    { header: 'Thu CK', key: 'transfer', width: 16 },
    { header: 'Thu cà thẻ', key: 'card', width: 16 },
    { header: 'Công nợ', key: 'receivable', width: 14 },
    { header: 'Chi', key: 'expense', width: 14 },
    { header: 'Ghi chú', key: 'note', width: 32 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Trạng thái', key: 'state', width: 12 },
    { header: 'Lý do hủy', key: 'voidReason', width: 24 },
    { header: 'Lịch sử sửa', key: 'edits', width: 44 },
  ];
  headerRow(payments);

  for (const section of data.branches) {
    section.byCategory.PAYMENT.forEach((row, i) => {
      payments.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        staff: row.createdByName,
        shift: row.shiftName ?? '',
        ez: row.payment?.ezCode ?? '',
        source: row.payment?.source ?? '',
        guest: row.payment?.guestName ?? '',
        room: row.payment?.roomNumber ?? '',
        // Zero rather than null: a payment row genuinely collected 0 by the two
        // methods it did not use, and a blank would break a column sum.
        cash: row.payment?.cash ?? 0,
        transfer: row.payment?.transfer ?? 0,
        card: row.payment?.card ?? 0,
        receivable: row.payment?.receivable ?? 0,
        expense: row.payment?.expense ?? 0,
        note: row.payment?.note ?? '',
        at: when(row.createdAt),
        state: voidState(row),
        voidReason: row.voidReason ?? '',
        edits: editHistory(row),
      });
    });
  }
  moneyColumns(payments, ['cash', 'transfer', 'card', 'receivable', 'expense']);

  /* --------------------- 3. Vấn đề khách yêu cầu --------------------- */
  const requests = wb.addWorksheet(CATEGORY_LABELS.GUEST_REQUEST);
  requests.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    // The SHIFT's day, from the session — Ca C's 02:15 entries sit under the day it began.
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Tên khách', key: 'guest', width: 24 },
    { header: 'Mã EZ', key: 'ez', width: 16 },
    { header: 'Nội dung', key: 'content', width: 44 },
    { header: 'Người nhập', key: 'createdBy', width: 20 },
    { header: 'Ca nhập', key: 'createdShift', width: 10 },
    { header: 'Thời gian tiếp nhận', key: 'createdAt', width: 20 },
    { header: 'Người hoàn thành', key: 'completedBy', width: 20 },
    { header: 'Ca hoàn thành', key: 'completedShift', width: 14 },
    { header: 'Thời gian hoàn thành', key: 'completedAt', width: 20 },
    { header: 'Cách xử lý (nếu có)', key: 'resolution', width: 40 },
    { header: 'Trạng thái', key: 'state', width: 14 },
    // THE COMPLETE RECORD: fields older requests carry and current ones do not.
    { header: 'Ký gửi (dữ liệu cũ)', key: 'item', width: 18 },
    { header: 'Số phòng (dữ liệu cũ)', key: 'room', width: 14 },
  ];
  headerRow(requests);

  for (const section of data.branches) {
    section.byCategory.GUEST_REQUEST.forEach((row, i) => {
      requests.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        guest: row.guestRequest?.guestName ?? '',
        ez: row.guestRequest?.ezCode ?? '',
        // The note alone: a legacy "Ký gửi" has its own column on this sheet.
        content: row.guestRequest?.note ?? '',
        createdBy: row.createdByName,
        createdShift: row.shiftName ?? '',
        createdAt: when(row.createdAt),
        completedBy: row.guestRequest?.completedByName ?? '',
        completedShift: row.guestRequest?.completedShiftName ?? '',
        completedAt: when(row.guestRequest?.completedAt ?? null),
        resolution: row.guestRequest?.resolution ?? '',
        state: row.voided ? 'Đã hủy' : row.guestRequest?.completed ? 'Đã hoàn thành' : 'Đã tiếp nhận',
        item: row.guestRequest?.itemType ?? '',
        room: row.guestRequest?.roomNumber ?? '',
      });
    });
  }

  /* ------------------- 4. Sự cố cơ sở vật chất ------------------- */
  const facilities = wb.addWorksheet(CATEGORY_LABELS.FACILITY_ISSUE);
  facilities.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    // The SHIFT's day, from the session — Ca C's 02:15 entries sit under the day it began.
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Mã sự cố', key: 'issueId', width: 28 },
    { header: 'Khu vực / Vị trí', key: 'location', width: 30 },
    { header: 'Loại sự cố', key: 'category', width: 18 },
    { header: 'Mô tả', key: 'description', width: 46 },
    { header: 'Trạng thái kỹ thuật', key: 'status', width: 18 },
    { header: 'Người xử lý', key: 'technician', width: 20 },
    { header: 'SĐT kỹ thuật', key: 'phone', width: 16 },
    { header: 'Số lần sửa', key: 'attempts', width: 12 },
    { header: 'Không sửa được', key: 'cannotRepair', width: 16 },
    { header: 'Người báo', key: 'createdBy', width: 20 },
    { header: 'Ca', key: 'shift', width: 8 },
    { header: 'Thời gian báo', key: 'createdAt', width: 18 },
  ];
  headerRow(facilities);

  for (const section of data.branches) {
    section.byCategory.FACILITY_ISSUE.forEach((row, i) => {
      const issue = row.facility?.issue;
      facilities.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        // The reference itself, so a row here can be found in the Technical
        // system it belongs to. This sheet holds no maintenance data of its own.
        issueId: row.facility?.issueId ?? '',
        location: issue?.locationLabel ?? '',
        category: issue?.category ?? '',
        description: issue?.description ?? '',
        status: issue ? (issue.needsRework ? 'Cần xử lý lại' : issue.status) : '',
        technician: issue?.technicianName ?? '',
        phone: issue?.technicianPhone ?? '',
        attempts: issue?.attempts.length ?? 0,
        cannotRepair: issue?.cannotRepairCount ?? 0,
        createdBy: row.createdByName,
        shift: row.shiftName ?? '',
        createdAt: when(row.createdAt),
      });
    });
  }

  /* ------------- 5. Vấn đề về chất lượng và dịch vụ ------------- */
  // The label is 31 characters — Excel's sheet-name limit exactly.
  const complaints = wb.addWorksheet(CATEGORY_LABELS.CUSTOMER_COMPLAINT);
  complaints.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    // The SHIFT's day, from the session — Ca C's 02:15 entries sit under the day it began.
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Tên khách', key: 'guest', width: 24 },
    { header: 'Mã EZ', key: 'ez', width: 16 },
    { header: 'Mô tả', key: 'description', width: 56 },
    { header: 'Trạng thái', key: 'lifecycle', width: 16 },
    { header: 'Hướng xử lý (nếu có)', key: 'resolution', width: 40 },
    { header: 'Người hoàn thành', key: 'completedBy', width: 20 },
    { header: 'Thời gian hoàn thành', key: 'completedAt', width: 20 },
    { header: 'Nhân viên', key: 'staff', width: 20 },
    { header: 'Ca', key: 'shift', width: 8 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Bản ghi', key: 'state', width: 12 },
    { header: 'Phòng / Khác (dữ liệu cũ)', key: 'location', width: 18 },
  ];
  headerRow(complaints);

  for (const section of data.branches) {
    section.byCategory.CUSTOMER_COMPLAINT.forEach((row, i) => {
      const c = row.complaint;
      complaints.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        guest: c?.guestName ?? '',
        ez: c?.ezCode ?? '',
        description: c?.description ?? '',
        lifecycle: c?.completed ? 'Đã hoàn thành' : 'Đã tiếp nhận',
        resolution: c?.resolution ?? '',
        completedBy: c?.completedByName ?? '',
        completedAt: when(c?.completedAt ?? null),
        staff: row.createdByName,
        shift: row.shiftName ?? '',
        at: when(row.createdAt),
        state: voidState(row),
        location: c?.location ?? '',
      });
    });
  }

  /* --------------------- 6. Dịch vụ phòng --------------------- */
  const services = wb.addWorksheet(CATEGORY_LABELS.ROOM_SERVICE);
  services.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    // The SHIFT's day, from the session — Ca C's 02:15 entries sit under the day it began.
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Loại dịch vụ', key: 'type', width: 16 },
    { header: 'Tên khách', key: 'guest', width: 24 },
    { header: 'Mã EZ', key: 'ez', width: 16 },
    { header: 'Hạng phòng', key: 'roomClass', width: 18 },
    { header: 'Từ hạng phòng', key: 'from', width: 18 },
    { header: 'Tới hạng phòng', key: 'to', width: 18 },
    { header: 'Số đêm', key: 'nights', width: 10 },
    { header: 'Giá tiền', key: 'price', width: 16 },
    { header: 'Ghi chú', key: 'note', width: 32 },
    { header: 'Nhân viên', key: 'staff', width: 20 },
    { header: 'Ca', key: 'shift', width: 8 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Trạng thái', key: 'state', width: 12 },
    // THE COMPLETE RECORD: fields older rows carry and current ones do not.
    { header: 'SĐT (dữ liệu cũ)', key: 'phone', width: 16 },
    { header: 'Số phòng (dữ liệu cũ)', key: 'room', width: 14 },
    { header: 'Loại hình (dữ liệu cũ)', key: 'serviceName', width: 22 },
  ];
  headerRow(services);

  for (const section of data.branches) {
    section.byCategory.ROOM_SERVICE.forEach((row, i) => {
      const s = row.roomService;
      services.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        type: s?.serviceTypeLabel ?? '',
        guest: s?.guestName ?? '',
        ez: s?.ezCode ?? '',
        roomClass: s?.roomClass ?? '',
        from: s?.fromRoomClass ?? '',
        to: s?.toRoomClass ?? '',
        // A real number, like the price — never a "3 đêm" string.
        nights: s?.nights ?? null,
        phone: s?.phone ?? '',
        room: s?.roomNumber ?? '',
        serviceName: s?.serviceName ?? '',
        price: s?.price ?? 0,
        note: s?.note ?? '',
        staff: row.createdByName,
        shift: row.shiftName ?? '',
        at: when(row.createdAt),
        state: voidState(row),
      });
    });
  }
  moneyColumns(services, ['price']);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * The correction trail, flattened into one cell.
 *
 * A sheet cannot hold a child table, and splitting corrections into a seventh
 * sheet would separate them from the row they explain. "amount: 300.000 → 3.150.000
 * (Nguyễn Văn A, 17/09/2026 14:05)" keeps the whole answer beside the number it
 * changed.
 */
function editHistory(row: SerializedReport): string {
  return row.audits
    .filter((a) => a.action === 'EDIT')
    .map(
      (a) =>
        `${a.field}: ${a.oldValue ?? '—'} → ${a.newValue ?? '—'} (${a.actor.name}, ${when(a.createdAt)})`,
    )
    .join('\n');
}
