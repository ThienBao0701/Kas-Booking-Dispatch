/**
 * "BÁO CÁO VẬN HÀNH BUỒNG PHÒNG" — the Excel workbook, from operationsReport.
 * (The PDF is "Báo cáo kiểm tra & dọn phòng", housekeepingCleaningPdf.ts,
 * written from the same rooms as the "Chi tiết dọn phòng" sheet below.)
 *
 * Written for a reader outside the building: per branch, business date and
 * worker, the rooms given and done, inspections and findings, the average
 * cleaning time, and the money collected and still pending. Objective figures
 * only — no score, no "tốt / kém". "Chi tiết dọn phòng" adds each room: its
 * code, times and form — King / Queen / Twin and counts, replacements, "Ghi
 * nhận đặc biệt", notes.
 */
import ExcelJS from 'exceljs';
import type { CleaningDetailRow, OperationsRow } from '../housekeeping/housekeepingKpi';
import { LINEN_ITEMS, ROOM_WORK_STATE_LABELS } from '../housekeeping/roomTaskCatalog';
import { formatDuration } from '../lib/duration';
import { hcmDateTime, hcmDayLabel } from './format';

export interface HousekeepingOpsData {
  from: string;
  to: string;
  scope: string;
  generatedAt: Date;
  rows: OperationsRow[];
  /** Each room's saved "Dọn phòng" form. */
  rooms?: CleaningDetailRow[];
}

/**
 * "08:10" — or "06/10 08:10" when it falls on a day other than the room's work
 * day. Shared by the PDF and the Excel sheet so the two print the same time.
 */
export function cleaningClock(instant: Date | string | null, workDate: string): string {
  if (!instant) return '';
  const full = hcmDateTime(new Date(instant));
  return full.slice(0, 10) === hcmDayLabel(workDate) ? full.slice(11) : `${full.slice(0, 5)} ${full.slice(11)}`;
}

/** "42 phút" — the cleaning's own time, from "Kiểm phòng" to "Hoàn thành". */
export function cleaningDuration(r: Pick<CleaningDetailRow, 'durationSeconds'>): string {
  return formatDuration(r.durationSeconds) ?? '';
}

const exceptions = (r: OperationsRow) =>
  [r.voided ? `${r.voided} phòng đã xóa` : '', r.notes ? `${r.notes} ghi chú` : ''].filter(Boolean).join(', ') || '—';

export async function buildHousekeepingOpsWorkbook(data: HousekeepingOpsData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kas';
  wb.created = data.generatedAt;
  const sheet = wb.addWorksheet('Vận hành buồng phòng');
  sheet.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 34 },
    { header: 'Ngày nghiệp vụ', key: 'date', width: 14 },
    { header: 'Nhân viên', key: 'employee', width: 24 },
    { header: 'Phòng được giao', key: 'assigned', width: 16 },
    { header: 'Phòng hoàn thành', key: 'completed', width: 16 },
    { header: 'Tỷ lệ hoàn thành (%)', key: 'rate', width: 18 },
    { header: 'Lượt kiểm phòng', key: 'inspections', width: 16 },
    { header: 'Số phát sinh', key: 'findings', width: 14 },
    { header: 'Thời gian dọn TB (phút)', key: 'avg', width: 20 },
    { header: 'Đã thu (VND)', key: 'collected', width: 16 },
    { header: 'Chưa thu (VND)', key: 'pending', width: 16 },
    { header: 'Số trường hợp chưa thu', key: 'pendingCount', width: 20 },
    { header: 'Ghi chú / ngoại lệ', key: 'notes', width: 28 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of data.rows) {
    sheet.addRow({
      branch: r.branchLabel,
      date: hcmDayLabel(r.workDate),
      employee: r.employee,
      assigned: r.assigned,
      completed: r.completed,
      rate: r.completionRate,
      inspections: r.inspections,
      findings: r.findings,
      avg: r.avgCleaningSeconds === null ? null : Math.round(r.avgCleaningSeconds / 60),
      collected: r.collectedAmount,
      pending: r.pendingAmount,
      pendingCount: r.pendingCount,
      notes: exceptions(r) === '—' ? '' : exceptions(r),
    });
  }
  sheet.addRow({});
  sheet.addRow({ branch: `Kỳ báo cáo: ${hcmDayLabel(data.from)} – ${hcmDayLabel(data.to)} · ${data.scope}` });
  for (const key of ['collected', 'pending']) sheet.getColumn(key).numFmt = '#,##0';

  const detail = wb.addWorksheet('Chi tiết dọn phòng');
  detail.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 34 },
    { header: 'Ngày nghiệp vụ', key: 'date', width: 14 },
    { header: 'Phòng', key: 'room', width: 10 },
    { header: 'Mã', key: 'code', width: 8 },
    { header: 'Nhân viên', key: 'employee', width: 24 },
    { header: 'Time In', key: 'timeIn', width: 12 },
    { header: 'Time Out', key: 'timeOut', width: 12 },
    { header: 'Thời gian dọn', key: 'duration', width: 14 },
    { header: 'Trạng thái', key: 'state', width: 14 },
    ...LINEN_ITEMS.map((i) => ({ header: i.label, key: i.code, width: 14 })),
    { header: 'Số lượng', key: 'quantities', width: 40 },
    { header: 'Đồ thay thế', key: 'replaced', width: 40 },
    { header: 'Ghi nhận đặc biệt', key: 'special', width: 44 },
    { header: 'Ghi chú', key: 'note', width: 40 },
  ];
  detail.getRow(1).font = { bold: true };
  detail.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of data.rooms ?? []) {
    detail.addRow({
      branch: r.branchLabel,
      date: hcmDayLabel(r.workDate),
      room: r.roomNumber,
      code: r.statusCode,
      employee: r.employee,
      timeIn: cleaningClock(r.startedAt, r.workDate),
      timeOut: cleaningClock(r.completedAt, r.workDate),
      duration: cleaningDuration(r),
      state: ROOM_WORK_STATE_LABELS[r.state],
      ...Object.fromEntries(r.linen.map((l) => [l.item, l.quantity === null ? l.sizeLabel : `${l.sizeLabel} × ${l.quantity}`])),
      quantities: r.quantities.map((q) => `${q.label}: ${q.quantity}`).join('; '),
      replaced: r.replaced.map((x) => x.label).join('; '),
      special: r.special.map((x) => `${x.short} : ${x.label}`).join('; '),
      note: r.note ?? '',
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * "Bao cao kiem tra don phong_<period>.pdf" / "Bao cao buong phong_<period>.xlsx"
 * — ASCII, like every other report file name.
 */
export function housekeepingOpsFileName(from: string, to: string, ext: 'pdf' | 'xlsx'): string {
  const d = (s: string) => s.split('-').reverse().join('-');
  const base = ext === 'pdf' ? 'Bao cao kiem tra don phong' : 'Bao cao buong phong';
  return `${base}_${from === to ? d(from) : `${d(from)}_${d(to)}`}.${ext}`;
}
