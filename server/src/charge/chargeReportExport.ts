/**
 * XLSX export of the monthly charge report.
 *
 * IT COMPUTES NOTHING. The workbook is built from the exact `MonthlyChargeReport`
 * the JSON endpoint returns, so a total in the spreadsheet cannot disagree with
 * the total on screen — there is one query and one set of arithmetic, upstream
 * of both.
 *
 * WHAT IT DELIBERATELY OMITS: the card number. Only `cardLast4` is written, and
 * the report shape it is handed has no field that could carry a full number
 * anyway. There is no CVV column because there is no CVV anywhere in this
 * system.
 */
import ExcelJS from 'exceljs';
import type { MonthlyChargeReport } from './chargeService';
import { CHARGE_STATUS_LABEL } from './chargeStatus';

/** Rendered as a real date so Excel can filter and sort by it. */
function toDate(iso: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

export async function buildMonthlyReportWorkbook(
  report: MonthlyChargeReport,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kas';
  wb.created = new Date();

  /* ---------------- Summary ---------------- */
  const summary = wb.addWorksheet('Tổng hợp');
  summary.columns = [
    { header: 'Chỉ tiêu', key: 'label', width: 32 },
    { header: 'Số lượng', key: 'count', width: 14 },
    { header: 'Số tiền (VND)', key: 'amount', width: 20 },
  ];
  summary.getRow(1).font = { bold: true };

  summary.addRow({ label: `Tháng ${report.month}`, count: null, amount: null });
  summary.addRow({ label: 'Tổng số chứng từ', count: report.totals.documentCount, amount: null });
  // The primary KPI, first among the money rows.
  const chargedRow = summary.addRow({
    label: 'Đã bị charge',
    count: report.totals.chargedCount,
    amount: report.totals.chargedAmount,
  });
  chargedRow.font = { bold: true };
  summary.addRow({
    label: 'Charge thất bại',
    count: report.totals.failedCount,
    amount: report.totals.failedAmount,
  });
  summary.addRow({
    label: 'Chưa xử lý',
    count: report.totals.pendingCount,
    amount: report.totals.pendingAmount,
  });
  summary.addRow({});
  summary.addRow({
    label: 'TỔNG TIỀN ĐÃ CHARGE',
    count: report.totals.chargedCount,
    amount: report.totals.chargedAmount,
  }).font = { bold: true };
  // Says in the file itself what the headline number does and does not include,
  // so a spreadsheet read months later cannot be misread.
  summary.addRow({
    label: 'Chỉ tính chứng từ có trạng thái "Đã bị charge"; không cộng charge thất bại hoặc chưa xử lý.',
  });
  summary.getColumn('amount').numFmt = '#,##0';

  /* ---------------- Detail ---------------- */
  const detail = wb.addWorksheet('Chi tiết đã charge');
  detail.columns = [
    { header: 'Tên khách', key: 'guestName', width: 26 },
    { header: 'Mã đặt phòng', key: 'bookingCode', width: 20 },
    { header: 'Chi nhánh', key: 'branch', width: 26 },
    { header: 'Số tiền (VND)', key: 'amount', width: 16 },
    { header: 'Thẻ', key: 'card', width: 12 },
    { header: 'Check-in', key: 'checkIn', width: 14 },
    { header: 'Check-out', key: 'checkOut', width: 14 },
    { header: 'Ngày charge', key: 'chargedAt', width: 18 },
    { header: 'Trạng thái', key: 'status', width: 18 },
    { header: 'Lý do charge', key: 'reason', width: 46 },
  ];
  detail.getRow(1).font = { bold: true };

  for (const row of report.rows) {
    detail.addRow({
      guestName: row.guestName,
      bookingCode: row.bookingCode,
      branch: `${row.branch.hotelName} — ${row.branch.address}`,
      amount: row.amount,
      // Masked, and it is all the report shape carries.
      card: `••••${row.cardLast4}`,
      checkIn: new Date(row.checkIn),
      checkOut: new Date(row.checkOut),
      chargedAt: toDate(row.chargedAt),
      status: CHARGE_STATUS_LABEL[row.status],
      reason: row.reason,
    });
  }

  detail.getColumn('amount').numFmt = '#,##0';
  detail.getColumn('checkIn').numFmt = 'dd/mm/yyyy';
  detail.getColumn('checkOut').numFmt = 'dd/mm/yyyy';
  detail.getColumn('chargedAt').numFmt = 'dd/mm/yyyy hh:mm';
  detail.autoFilter = { from: 'A1', to: 'J1' };

  const totalRow = detail.addRow({
    guestName: 'TỔNG',
    amount: report.totals.chargedAmount,
  });
  totalRow.font = { bold: true };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
