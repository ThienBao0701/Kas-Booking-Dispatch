/**
 * "XUẤT EXCEL" OF THE HOUSEKEEPING WAREHOUSES — the stock per branch, item and
 * state, the damage reports, and the counting differences: the same figures the
 * screens show (read from `inventoryService`), never recomputed here.
 */
import ExcelJS from 'exceljs';
import type { listCounts, listDamageReports, listItems } from '../housekeeping/inventoryService';
import { STATE_LABELS, WAREHOUSE_LABELS, WAREHOUSE_STATES } from '../housekeeping/inventoryLedger';
import { hcmDateTime } from './format';

export interface InventoryExportData {
  scope: string;
  generatedAt: Date;
  items: Awaited<ReturnType<typeof listItems>>;
  damage: Awaited<ReturnType<typeof listDamageReports>>;
  /** The counting differences — the Admin's only; absent, the sheet is not written. */
  counts?: Awaited<ReturnType<typeof listCounts>>;
}

const ALL_STATES = ['AVAILABLE', 'DIRTY', 'ISSUED', 'DAMAGED'] as const;

export async function buildInventoryWorkbook(data: InventoryExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kas';
  wb.created = data.generatedAt;

  const stock = wb.addWorksheet('Tồn kho');
  stock.columns = [
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Kho', key: 'warehouse', width: 22 },
    { header: 'Mặt hàng', key: 'item', width: 30 },
    { header: 'Mã', key: 'code', width: 12 },
    { header: 'Đơn vị', key: 'unit', width: 10 },
    ...ALL_STATES.map((s) => ({ header: STATE_LABELS[s], key: s, width: 13 })),
    { header: 'Ngưỡng sắp hết', key: 'threshold', width: 15 },
    { header: 'Ghi chú', key: 'flags', width: 24 },
  ];
  stock.getRow(1).font = { bold: true };
  stock.views = [{ state: 'frozen', ySplit: 1 }];
  for (const i of data.items) {
    const states = WAREHOUSE_STATES[i.warehouse];
    stock.addRow({
      branch: i.branch.address,
      warehouse: WAREHOUSE_LABELS[i.warehouse],
      item: i.label,
      code: i.code ?? '',
      unit: i.unit,
      // A state the warehouse does not keep is left blank, not written as 0.
      ...Object.fromEntries(ALL_STATES.map((s) => [s, states.includes(s) ? (i.balances[s] ?? 0) : null])),
      threshold: i.lowStockThreshold,
      flags: [i.lowStock ? 'Sắp hết' : null, i.archived ? 'Ngừng sử dụng' : null, i.pendingDamage > 0 ? `${i.pendingDamage} báo hỏng chờ xem` : null]
        .filter(Boolean)
        .join(' · '),
    });
  }
  stock.addRow({});
  stock.addRow({ branch: `Phạm vi: ${data.scope} · Xuất lúc ${hcmDateTime(data.generatedAt)}` });

  const damage = wb.addWorksheet('Báo hỏng');
  damage.columns = [
    { header: 'Báo lúc', key: 'at', width: 18 },
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Kho', key: 'warehouse', width: 22 },
    { header: 'Mặt hàng', key: 'item', width: 28 },
    { header: 'Số lượng', key: 'quantity', width: 10 },
    { header: 'Từ trạng thái', key: 'from', width: 14 },
    { header: 'Lý do', key: 'reason', width: 36 },
    { header: 'Phòng', key: 'room', width: 8 },
    { header: 'Người báo', key: 'by', width: 22 },
    { header: 'Trạng thái', key: 'status', width: 22 },
    { header: 'Người xem xét', key: 'reviewer', width: 22 },
    { header: 'Ghi chú Admin', key: 'note', width: 30 },
  ];
  damage.getRow(1).font = { bold: true };
  for (const r of data.damage) {
    damage.addRow({
      at: hcmDateTime(r.reportedAt),
      branch: r.branch.address,
      warehouse: r.warehouseLabel,
      item: r.label,
      quantity: r.quantity,
      from: r.fromStateLabel,
      reason: r.reason,
      room: r.roomNumber ?? '',
      by: r.reportedBy.name,
      status: r.statusLabel,
      reviewer: r.reviewedBy?.name ?? '',
      note: r.reviewNote ?? '',
    });
  }

  if (!data.counts) return Buffer.from(await wb.xlsx.writeBuffer());
  const counts = wb.addWorksheet('Chênh lệch kiểm kho');
  counts.columns = [
    { header: 'Kiểm lúc', key: 'at', width: 18 },
    { header: 'Chi nhánh', key: 'branch', width: 30 },
    { header: 'Mặt hàng', key: 'item', width: 28 },
    { header: 'Trạng thái', key: 'state', width: 14 },
    { header: 'Trên sổ', key: 'system', width: 10 },
    { header: 'Thực tế', key: 'counted', width: 10 },
    { header: 'Chênh lệch', key: 'difference', width: 11 },
    { header: 'Lý do', key: 'reason', width: 34 },
    { header: 'Người kiểm', key: 'by', width: 22 },
  ];
  counts.getRow(1).font = { bold: true };
  for (const c of data.counts) {
    for (const l of c.lines.filter((x) => x.difference !== 0)) {
      counts.addRow({
        at: hcmDateTime(c.createdAt),
        branch: c.branch.address,
        item: l.label,
        state: l.stateLabel,
        system: l.systemQuantity,
        counted: l.countedQuantity,
        difference: l.difference,
        reason: l.reason ?? '',
        by: c.createdBy.name,
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function inventoryFileName(at: Date): string {
  const d = new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  return `ton-kho-buong-phong-${d}.xlsx`;
}
