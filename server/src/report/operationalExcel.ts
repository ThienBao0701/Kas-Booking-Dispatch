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
import { CATEGORY_LABELS, CATEGORY_NUMERALS, ROOM_SERVICE_PRICE_LABEL } from '../reception/reportTypes';
import { shiftDefinition } from '../shift/shiftTypes';
import { OPEN_SHIFT_WARNING } from '../reception/businessDate';
import { inspectionEnabled } from '../issue/issueLifecycle';
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

/** The creator, and "(Admin tạo)" when a supervisor entered the record. */
function creator(row: SerializedReport): string {
  return row.sourceLabel ? `${row.createdByName} (${row.sourceLabel})` : row.createdByName;
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

  // A department's report: its own sheets only.
  if (data.section === 'TECHNICAL') return technicalWorkbook(wb, data);
  if (data.section === 'HOUSEKEEPING') return housekeepingWorkbook(wb, data);

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
    { header: CATEGORY_LABELS.HOTEL_DELIVERY, key: 'deliveries', width: 20 },
    { header: 'Tổng bản ghi', key: 'total', width: 14 },
    { header: 'Đơn mới', key: 'bookings', width: 12 },
    { header: 'Buồng phòng', key: 'rooms', width: 14 },
    { header: 'Hoàn thành vấn đề', key: 'archived', width: 18 },
  ];
  headerRow(summary);

  summary.addRow({
    branch: `Kỳ báo cáo: ${hcmDayLabel(data.from)} – ${hcmDayLabel(data.to)} (ngày nghiệp vụ của ca, chỉ gồm ca đã kết thúc)`,
  });
  // Named when the file is scoped to one category, so a workbook of payments
  // alone cannot be read as "nothing else was recorded".
  if (data.category) summary.addRow({ branch: `Danh mục: ${CATEGORY_LABELS[data.category]}` });
  // …and to one shift, likewise. "Đơn mới" and "Buồng phòng" are by day, so a
  // one-shift workbook has none of their rows.
  if (data.shiftType) {
    summary.addRow({ branch: `Ca: ${shiftDefinition(data.shiftType).name} (Đơn mới và Buồng phòng ghi theo ngày, không theo ca)` });
  }
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
      deliveries: section.counts.HOTEL_DELIVERY,
      total: section.total,
      bookings: section.bookingsTotal,
      rooms: section.housekeeping.length,
      archived: section.completed.length,
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
        staff: creator(row),
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
        createdBy: creator(row),
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
    // The ONE canonical cause — the latest technician's, else the reported one.
    { header: 'Nguyên nhân', key: 'cause', width: 36 },
    { header: 'Trạng thái kỹ thuật', key: 'status', width: 18 },
    // THE ASSIGNMENT MODEL: who holds it, where it stands, and every move.
    { header: 'Tình trạng giao', key: 'assignmentState', width: 26 },
    { header: 'Kỹ thuật được giao', key: 'assigned', width: 22 },
    { header: 'Lịch sử giao kỹ thuật', key: 'assignments', width: 56 },
    { header: 'Kết quả sửa chữa', key: 'result', width: 36 },
    { header: 'Báo lại sau lần hoàn thành trước', key: 'repeat', width: 40 },
    { header: 'Người xử lý', key: 'technician', width: 20 },
    { header: 'SĐT kỹ thuật', key: 'phone', width: 16 },
    { header: 'Thời gian hoàn thành', key: 'completedAt', width: 20 },
    // "Nghiệm thu" only while it is part of the workflow. Dormant, the file has
    // no such columns — the values stay on the attempts, not in the export.
    ...(inspectionEnabled()
      ? [
          { header: 'Nghiệm thu', key: 'inspection', width: 16 },
          { header: 'Người nghiệm thu', key: 'inspector', width: 20 },
          { header: 'Thời gian nghiệm thu', key: 'inspectedAt', width: 20 },
          { header: 'Ghi chú nghiệm thu', key: 'inspectionNote', width: 36 },
        ]
      : []),
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
      // The verdict the "Nghiệm thu" column states, and only that one: while a
      // later repair awaits inspection the column says "Chưa nghiệm thu", and an
      // earlier round's inspector and reason beside it would read as a verdict
      // on the repair nobody has judged yet. Never inferred for older work.
      const judged =
        issue && (issue.inspectionState === 'PASSED' || issue.inspectionState === 'FAILED')
          ? [...issue.attempts].reverse().find((a) => a.inspection)
          : undefined;
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
        cause: issue?.cause ?? '',
        status: issue?.stageLabel ?? '',
        assignmentState: issue?.assignmentStateLabel ?? '',
        assigned: issue?.assignedTechnician?.name ?? '',
        // "15/09 09:10 Nguyễn Văn A (giao bởi Admin); 16/09 08:00 Trần B, thay Nguyễn Văn A"
        assignments: (issue?.assignments ?? [])
          .map(
            (a) =>
              `${when(a.createdAt)} ${a.technicianName}` +
              (a.previousTechnicianName ? `, thay ${a.previousTechnicianName}` : '') +
              ` (giao bởi ${a.assignedByName})`,
          )
          .join('; '),
        // Every attempt's outcome, oldest first — the repair history in one cell.
        result: (issue?.attempts ?? [])
          .filter((a) => a.outcome)
          .map(
            (a) =>
              `Lần ${a.attemptNumber} ${a.technicianName}: ` +
              (a.outcome === 'CANNOT_REPAIR' ? `không sửa được — ${a.reason ?? ''}` : a.result ?? 'hoàn thành'),
          )
          .join('; '),
        repeat: issue?.repeatOf
          ? `Lần trước: ${issue.repeatOf.technicianName ?? '—'}, hoàn thành ${
              issue.repeatOf.completedAt ? when(issue.repeatOf.completedAt) : '—'
            }`
          : '',
        technician: issue?.repairerName ?? '',
        phone: issue?.technicianPhone ?? '',
        completedAt: issue?.completedAt ? when(issue.completedAt) : '',
        inspection: issue?.inspectionLabel ?? '',
        inspector: judged?.inspection?.inspectedByName ?? '',
        inspectedAt: judged?.inspection?.inspectedAt ? when(judged.inspection.inspectedAt) : '',
        inspectionNote: judged?.inspection?.note ?? '',
        attempts: issue?.attempts.length ?? 0,
        cannotRepair: issue?.cannotRepairCount ?? 0,
        createdBy: creator(row),
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
        staff: creator(row),
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
    // "Review" rows: the counts, as numbers. Blank on every other service.
    { header: 'Tripadvisor', key: 'tripadvisor', width: 12 },
    { header: 'Google', key: 'google', width: 10 },
    { header: ROOM_SERVICE_PRICE_LABEL, key: 'price', width: 18 },
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
        // A review is a count, not a sale: no price to state.
        price: s && !s.countsAsRevenue ? null : (s?.price ?? 0),
        tripadvisor: s?.tripadvisorCount ?? null,
        google: s?.googleCount ?? null,
        note: s?.note ?? '',
        staff: creator(row),
        shift: row.shiftName ?? '',
        at: when(row.createdAt),
        state: voidState(row),
      });
    });
  }
  moneyColumns(services, ['price']);

  /* --------------------- 7. Giao nhận hàng hóa --------------------- */
  const deliveries = wb.addWorksheet(CATEGORY_LABELS.HOTEL_DELIVERY);
  deliveries.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Ngày ca', key: 'shiftDay', width: 12 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Bộ phận', key: 'department', width: 14 },
    { header: 'Tên hàng hóa', key: 'item', width: 34 },
    // A real number, like every other quantity in the workbook.
    { header: 'Số lượng', key: 'quantity', width: 10 },
    { header: 'Ghi chú', key: 'note', width: 32 },
    { header: 'Trạng thái', key: 'status', width: 14 },
    { header: 'Hoàn thành lúc', key: 'completedAt', width: 18 },
    { header: 'Nhân viên', key: 'staff', width: 20 },
    { header: 'Ca', key: 'shift', width: 8 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Tình trạng bản ghi', key: 'state', width: 14 },
    { header: 'Lịch sử chỉnh sửa', key: 'edits', width: 40 },
  ];
  headerRow(deliveries);

  for (const section of data.branches) {
    section.byCategory.HOTEL_DELIVERY.forEach((row, i) => {
      const d = row.delivery;
      deliveries.addRow({
        branch: branchLabel(section),
        shiftDay: hcmDayLabel(row.shiftDate),
        stt: i + 1,
        department: d?.departmentLabel ?? '',
        item: d?.itemName ?? '',
        quantity: d?.quantity ?? null,
        note: d?.note ?? '',
        status: d?.statusLabel ?? '',
        completedAt: d ? when(d.completedAt) : '',
        staff: creator(row),
        shift: row.shiftName ?? '',
        at: when(row.createdAt),
        state: voidState(row),
        edits: editHistory(row),
      });
    });
  }

  /* ------------- 8. Buồng phòng — room findings and their collection ------------- */
  const rooms = wb.addWorksheet('Buồng phòng');
  rooms.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Phòng', key: 'room', width: 10 },
    { header: 'Tình trạng', key: 'type', width: 28 },
    { header: 'Mô tả', key: 'note', width: 40 },
    { header: 'Người kiểm tra', key: 'staff', width: 20 },
    { header: 'Ghi nhận bởi', key: 'recordedBy', width: 20 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Thu tiền', key: 'status', width: 16 },
    { header: 'Số tiền', key: 'amount', width: 16 },
    { header: 'Phương thức', key: 'method', width: 16 },
    { header: 'Lý do không thu được', key: 'reason', width: 30 },
    { header: 'Người thu', key: 'collector', width: 20 },
    { header: 'Bản ghi', key: 'state', width: 12 },
  ];
  headerRow(rooms);
  moneyColumns(rooms, ['amount']);
  for (const section of data.branches) {
    section.housekeeping.forEach((issue, i) => {
      rooms.addRow({
        branch: branchLabel(section),
        stt: i + 1,
        room: issue.roomNumber,
        type: issue.typeLabel,
        note: issue.note ?? '',
        staff: issue.staffName,
        recordedBy: issue.recordedByName,
        at: when(issue.createdAt),
        status: issue.collectionStatusLabel ?? '',
        amount: issue.collection?.amount ?? null,
        method: issue.collection?.methodLabel ?? '',
        reason: issue.collection?.reason ?? '',
        collector: issue.collection?.recordedByName ?? '',
        state: issue.voided ? `Đã hủy — ${issue.voidReason ?? ''}` : 'Hiệu lực',
      });
    });
  }

  /* ------------- 9. Đơn mới — the orders sent to each branch in the period ------------- */
  const orders = wb.addWorksheet('Đơn mới');
  orders.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Mã Booking', key: 'code', width: 18 },
    { header: 'Khách', key: 'guest', width: 26 },
    { header: 'Nguồn', key: 'source', width: 14 },
    { header: 'Nhận phòng', key: 'checkIn', width: 12 },
    { header: 'Trả phòng', key: 'checkOut', width: 12 },
    { header: 'Gửi lúc', key: 'sentAt', width: 18 },
    { header: 'Trạng thái', key: 'state', width: 18 },
    { header: 'Lễ tân xử lý', key: 'handledBy', width: 22 },
    { header: 'Thời gian xử lý', key: 'handledAt', width: 18 },
  ];
  headerRow(orders);
  for (const section of data.branches) {
    section.bookings.forEach((b, i) => {
      orders.addRow({
        branch: branchLabel(section),
        stt: i + 1,
        code: b.bookingCode,
        guest: b.customerName,
        source: b.sourceLabel,
        checkIn: b.checkInDate ? hcmDayLabel(b.checkInDate) : '',
        checkOut: b.checkOutDate ? hcmDayLabel(b.checkOutDate) : '',
        sentAt: when(b.sentAt),
        state: b.stateLabel,
        handledBy: b.handledBy ?? '',
        handledAt: when(b.handledAt),
      });
    });
  }

  /* ---- 10. Hoàn thành vấn đề — the rows the 12-hour rule has archived ---- */
  const archived = wb.addWorksheet('Hoàn thành vấn đề');
  archived.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Danh mục', key: 'category', width: 34 },
    { header: 'Khách / Vị trí', key: 'subject', width: 24 },
    { header: 'Nội dung', key: 'content', width: 44 },
    { header: 'Tiếp nhận', key: 'receivedAt', width: 18 },
    { header: 'Hoàn thành', key: 'completedAt', width: 18 },
    { header: 'Người hoàn thành', key: 'completedBy', width: 22 },
  ];
  headerRow(archived);
  for (const section of data.branches) {
    section.completed.forEach((row, i) => {
      const issue = row.facility?.issue;
      archived.addRow({
        branch: branchLabel(section),
        stt: i + 1,
        category: `${CATEGORY_NUMERALS[row.category]}. ${CATEGORY_LABELS[row.category]}`,
        subject:
          row.guestRequest?.guestName ?? row.complaint?.guestName ?? issue?.locationLabel ?? row.delivery?.departmentLabel ?? '',
        content:
          row.guestRequest?.content ??
          row.complaint?.description ??
          issue?.description ??
          (row.delivery ? `${row.delivery.itemName} × ${row.delivery.quantity}` : ''),
        receivedAt: when(issue ? issue.createdAt : row.createdAt),
        completedAt: when(
          row.guestRequest?.completedAt ?? row.complaint?.completedAt ?? issue?.completedAt ?? row.delivery?.completedAt ?? null,
        ),
        completedBy:
          row.guestRequest?.completedByName ??
          row.complaint?.completedByName ??
          (issue ? (issue.completedByName ?? issue.technicianName ?? '') : row.createdByName),
      });
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}


/* ------------------------------ Kỹ thuật ------------------------------ */

async function technicalWorkbook(wb: ExcelJS.Workbook, data: OperationalReportData): Promise<Buffer> {
  const sheet = wb.addWorksheet('Kỹ thuật');
  sheet.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Vị trí', key: 'location', width: 26 },
    { header: 'Loại sự cố', key: 'category', width: 16 },
    { header: 'Sự cố', key: 'description', width: 40 },
    { header: 'Nguyên nhân', key: 'cause', width: 26 },
    { header: 'Người báo', key: 'reporter', width: 20 },
    { header: 'Thời gian báo', key: 'reportedAt', width: 18 },
    { header: 'Nguồn', key: 'source', width: 16 },
    { header: 'Kỹ thuật viên', key: 'technician', width: 20 },
    { header: 'Giao lúc', key: 'assignedAt', width: 18 },
    { header: 'Giao bởi', key: 'assignedBy', width: 18 },
    { header: 'Số lần giao lại', key: 'reassigned', width: 10 },
    { header: 'Trạng thái', key: 'state', width: 24 },
    { header: 'Cần sửa lại', key: 'rework', width: 10 },
    { header: 'Báo lại sau hoàn thành', key: 'repeat', width: 14 },
    { header: 'Số giai đoạn', key: 'stages', width: 10 },
    { header: 'Không sửa được (lần)', key: 'cannot', width: 12 },
    { header: 'Hoàn thành lúc', key: 'completedAt', width: 18 },
  ];
  headerRow(sheet);
  const stages = wb.addWorksheet('Giai đoạn sửa chữa');
  stages.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Vị trí', key: 'location', width: 26 },
    { header: 'Sự cố', key: 'description', width: 36 },
    { header: 'Giai đoạn', key: 'stage', width: 10 },
    { header: 'Kỹ thuật viên', key: 'technician', width: 20 },
    { header: 'Bắt đầu', key: 'startedAt', width: 18 },
    { header: 'Hoàn thành', key: 'completedAt', width: 18 },
    { header: 'Công việc hoàn thành', key: 'workDone', width: 40 },
    { header: 'Công việc cần xử lý tiếp', key: 'nextWork', width: 40 },
    { header: 'Giai đoạn cuối', key: 'final', width: 12 },
  ];
  headerRow(stages);
  for (const section of data.branches) {
    section.technical.forEach((i, n) => {
      sheet.addRow({
        branch: branchLabel(section),
        stt: n + 1,
        location: i.locationLabel,
        category: i.category ?? '',
        description: i.description,
        cause: i.cause ?? i.reportedCause ?? '',
        reporter: i.reporterName ?? '',
        reportedAt: when(i.createdAt),
        source: i.sourceLabel ?? 'Lễ tân',
        technician: i.assignedTechnician?.name ?? i.attempts.at(-1)?.technicianName ?? '',
        assignedAt: when(i.assignedAt),
        assignedBy: i.assignedByName ?? '',
        reassigned: i.assignments.filter((a) => a.reassigned).length,
        state: i.assignmentStateLabel,
        rework: i.needsRework ? 'Có' : '',
        repeat: i.repeatOf ? 'Có' : '',
        stages: i.stages.length,
        cannot: i.cannotRepairCount,
        completedAt: when(i.completedAt),
      });
      for (const st of i.stages) {
        stages.addRow({
          branch: branchLabel(section),
          location: i.locationLabel,
          description: i.description,
          stage: st.stageNumber,
          technician: st.technicianName,
          startedAt: when(st.startedAt),
          completedAt: when(st.completedAt),
          workDone: st.workDone,
          nextWork: st.nextWork ?? '',
          final: st.final ? 'Có' : '',
        });
      }
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------ Buồng phòng ------------------------------ */

async function housekeepingWorkbook(wb: ExcelJS.Workbook, data: OperationalReportData): Promise<Buffer> {
  const shifts = wb.addWorksheet('Ca buồng phòng');
  shifts.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Tài khoản', key: 'account', width: 22 },
    { header: 'Người dọn buồng', key: 'staff', width: 22 },
    { header: 'Bắt đầu', key: 'startedAt', width: 18 },
    { header: 'Kết thúc', key: 'endedAt', width: 18 },
    { header: 'Số phòng', key: 'rooms', width: 10 },
    { header: 'Lượt kiểm tra', key: 'inspections', width: 12 },
    { header: 'Vấn đề', key: 'issues', width: 10 },
  ];
  headerRow(shifts);
  const rooms = wb.addWorksheet('Vấn đề phòng');
  rooms.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Phòng', key: 'room', width: 10 },
    { header: 'Tình trạng', key: 'type', width: 28 },
    { header: 'Mô tả', key: 'note', width: 40 },
    { header: 'Người dọn buồng', key: 'staff', width: 20 },
    { header: 'Ghi nhận bởi', key: 'recordedBy', width: 20 },
    { header: 'Thời gian', key: 'at', width: 18 },
    { header: 'Thu tiền', key: 'status', width: 16 },
    { header: 'Số tiền', key: 'amount', width: 16 },
    { header: 'Phương thức', key: 'method', width: 16 },
    { header: 'Lý do không thu được', key: 'reason', width: 30 },
    { header: 'Bản ghi', key: 'state', width: 12 },
  ];
  headerRow(rooms);
  moneyColumns(rooms, ['amount']);
  for (const section of data.branches) {
    for (const seg of section.workSegments) {
      shifts.addRow({
        branch: branchLabel(section),
        account: seg.accountName,
        staff: seg.staffName,
        startedAt: when(seg.startedAt),
        endedAt: seg.endedAt ? when(seg.endedAt) : 'Đang làm',
        rooms: seg.rooms,
        inspections: seg.inspections,
        issues: seg.issues,
      });
    }
    const ordered = [...section.housekeeping].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true }));
    for (const issue of ordered) {
      rooms.addRow({
        branch: branchLabel(section),
        room: issue.roomNumber,
        type: issue.typeLabel,
        note: issue.note ?? '',
        staff: issue.staffName,
        recordedBy: issue.recordedByName,
        at: when(issue.createdAt),
        status: issue.collectionStatusLabel ?? '',
        amount: issue.collection?.amount ?? null,
        method: issue.collection?.methodLabel ?? '',
        reason: issue.collection?.reason ?? '',
        state: issue.voided ? `Đã hủy — ${issue.voidReason ?? ''}` : 'Hiệu lực',
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
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
