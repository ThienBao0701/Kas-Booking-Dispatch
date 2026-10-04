/**
 * "BÁO CÁO VẬN HÀNH BUỒNG PHÒNG" — PDF and Excel, from \`operationsReport\`.
 *
 * Written for a reader outside the building: per branch, business date and
 * worker, the rooms given and done, inspections and findings, the average
 * cleaning time, and the money collected and still pending. Objective figures
 * only — no score, no "tốt / kém". The workbook adds "Chi tiết dọn phòng": each
 * room's form — King / Queen / Twin and counts, replacements, "Ghi nhận đặc
 * biệt", notes.
 */
import ExcelJS from 'exceljs';
import type { CleaningDetailRow, OperationsRow } from '../housekeeping/housekeepingKpi';
import { LINEN_ITEMS, ROOM_WORK_STATE_LABELS } from '../housekeeping/roomTaskCatalog';
import { formatDuration } from '../lib/duration';
import { formatVndPlain } from '../reception/reportTypes';
import { hcmDateTime, hcmDayLabel, periodLabel } from './format';
import {
  addPageNumbers,
  assertFitsLandscape,
  assertHeadersFit,
  createReportDocument,
  drawTable,
  finishDocument,
  sectionTitle,
  type Column,
} from './pdf';

export const HOUSEKEEPING_OPS_TITLE = 'KAS – BÁO CÁO VẬN HÀNH BUỒNG PHÒNG';

export interface HousekeepingOpsData {
  from: string;
  to: string;
  scope: string;
  generatedAt: Date;
  rows: OperationsRow[];
  /** Each room's saved "Dọn phòng" form. */
  rooms?: CleaningDetailRow[];
}

const money = (n: number) => formatVndPlain(n);
const cleaning = (s: number | null) => (s === null ? '—' : (formatDuration(s) ?? '—'));
const exceptions = (r: OperationsRow) =>
  [r.voided ? `${r.voided} phòng đã xóa` : '', r.notes ? `${r.notes} ghi chú` : ''].filter(Boolean).join(', ') || '—';

const COLUMNS: Column<OperationsRow>[] = assertHeadersFit(
  'housekeeping operations',
  assertFitsLandscape('housekeeping operations', [
    { header: 'Chi nhánh', width: 118, value: (r) => r.branchLabel },
    { header: 'Ngày', width: 52, value: (r) => hcmDayLabel(r.workDate) },
    { header: 'Nhân viên', width: 92, value: (r) => r.employee },
    { header: 'Được giao', width: 46, value: (r) => String(r.assigned), align: 'right' },
    { header: 'Hoàn thành', width: 50, value: (r) => String(r.completed), align: 'right' },
    { header: 'Tỷ lệ', width: 36, value: (r) => `${r.completionRate}%`, align: 'right' },
    { header: 'Kiểm phòng', width: 50, value: (r) => String(r.inspections), align: 'right' },
    { header: 'Phát sinh', width: 44, value: (r) => String(r.findings), align: 'right' },
    { header: 'TB dọn', width: 52, value: (r) => cleaning(r.avgCleaningSeconds) },
    { header: 'Đã thu', width: 70, value: (r) => money(r.collectedAmount), align: 'right' },
    { header: 'Chưa thu', width: 66, value: (r) => `${money(r.pendingAmount)} (${r.pendingCount})`, align: 'right' },
    { header: 'Ghi chú', width: 76, value: exceptions },
  ]),
);

export async function buildHousekeepingOpsPdf(data: HousekeepingOpsData): Promise<Buffer> {
  const doc = createReportDocument({
    title: HOUSEKEEPING_OPS_TITLE,
    period: periodLabel(data.from, data.to),
    generatedAt: hcmDateTime(data.generatedAt),
    scope: data.scope,
  });
  if (data.rows.length === 0) {
    doc.text('Không có công việc buồng phòng nào trong kỳ báo cáo này.');
  } else {
    sectionTitle(doc, 'THEO CHI NHÁNH, NGÀY VÀ NHÂN VIÊN');
    drawTable(doc, COLUMNS, data.rows);
    const t = totals(data.rows);
    doc.moveDown();
    doc.text(
      `Tổng: ${t.assigned} phòng được giao, ${t.completed} hoàn thành · ${t.inspections} lượt kiểm phòng · ${t.findings} phát sinh · đã thu ${money(t.collectedAmount)} · chưa thu ${money(t.pendingAmount)}.`,
    );
  }
  addPageNumbers(doc);
  return finishDocument(doc);
}

function totals(rows: OperationsRow[]) {
  return rows.reduce(
    (t, r) => ({
      assigned: t.assigned + r.assigned,
      completed: t.completed + r.completed,
      inspections: t.inspections + r.inspections,
      findings: t.findings + r.findings,
      collectedAmount: t.collectedAmount + r.collectedAmount,
      pendingAmount: t.pendingAmount + r.pendingAmount,
    }),
    { assigned: 0, completed: 0, inspections: 0, findings: 0, collectedAmount: 0, pendingAmount: 0 },
  );
}

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
    { header: 'Nhân viên', key: 'employee', width: 24 },
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
      employee: r.employee,
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

/** "Bao cao buong phong_<period>.pdf" — ASCII, like every other report file name. */
export function housekeepingOpsFileName(from: string, to: string, ext: 'pdf' | 'xlsx'): string {
  const d = (s: string) => s.split('-').reverse().join('-');
  return `Bao cao buong phong_${from === to ? d(from) : `${d(from)}_${d(to)}`}.${ext}`;
}
