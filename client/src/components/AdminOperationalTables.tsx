/**
 * THE ADMIN'S TABLES over the same records reception enters.
 *
 * WHY THESE ARE NOT RECEPTION'S TABLES
 *
 * They read the same rows, but they answer a different question. Reception asks
 * "did the row I just typed land correctly?" — so its tables lead with what was
 * entered and keep who/when out of the way. An Admin asks "who recorded what, on
 * which shift, and does the branch add up?" — so NHÂN VIÊN and CA are columns
 * here, not secondary detail, and every category leads with the facts that make
 * a record accountable. Under a shift heading (`grouped`), which already names
 * the shift, the person and the branch, those columns are left out rather than
 * repeated on every row.
 *
 * What they DO share is `DataTable`: one row height, money right-aligned, one
 * empty state, one loading state. An Admin comparing a payment ledger against a
 * service list should not have to re-learn the table between them.
 *
 * READ-ONLY, DELIBERATELY. There is no edit, no void and no accept here. An
 * Admin correcting reception's record from a monitoring screen is how a journal
 * stops being reception's account of the shift.
 *
 * THE ROW IS A SUMMARY; THE RECORD IS UNDERNEATH. Every table expands a row into
 * `OperationalRecordDetail` — the same full-fidelity block reception sees,
 * including the correction history. That is what keeps the compact table honest:
 * nothing is dropped, it is one click down rather than eight lines tall.
 */
import type { ReactNode } from 'react';
import type {
  OperationalReport,
  ReportCategory,
  RoomServiceType,
} from '../api/receptionReports';
import { DataTable, type DataColumn } from './DataTable';
import { OperationalRecordDetail } from './OperationalRecord';
import { formatVnd } from '../lib/money';
import { formatDateTime } from '../lib/format';
import { roomServiceFields } from '../lib/roomServiceFields';

export interface AdminTableProps {
  rows: OperationalReport[];
  /**
   * The category's name, passed in rather than written here: it is the SERVER's
   * word (`/reception/reports/options`), and the same word is the heading of the
   * matching sheet in the exported XLSX. A table that titled itself would be the
   * fourth copy of a string that already has one owner.
   */
  title: string;
  /** Right-hand side of the table's heading — the shift's counts and status. */
  headerAction?: ReactNode;
  /**
   * Shown under a heading that already names the shift, the person and the
   * branch — so those columns would repeat it on every row, and cost the width
   * the record itself needs. The full record, one click down, still has them.
   */
  grouped?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
}

/** A voided row stays on screen, greyed — never removed, never hidden. */
const voidedRow = (r: OperationalReport) => (r.voided ? 'bg-slate-50 text-slate-400' : '');

/**
 * Zero reads as nothing in a ledger column; only a real figure earns digits.
 *
 * `slate-400`, not `slate-300`: the placeholder has to be legible enough that
 * an empty cell is obviously empty rather than obviously unrendered, and 300 on
 * white is under 2:1.
 */
const money = (value: number | null | undefined): ReactNode =>
  value ? formatVnd(value) : <span className="text-slate-400">—</span>;

const text = (value: string | null | undefined): ReactNode =>
  value ? value : <span className="text-slate-400">—</span>;

const stt = (): DataColumn<OperationalReport> => ({
  key: 'stt',
  header: 'STT',
  className: 'w-[1%] whitespace-nowrap text-slate-400',
  render: (_row, i) => i + 1,
});

const staff = (header = 'Nhân viên'): DataColumn<OperationalReport> => ({
  key: 'staff',
  header,
  className: 'whitespace-nowrap',
  render: (r) => r.createdByName,
});

const shift = (): DataColumn<OperationalReport> => ({
  key: 'shift',
  header: 'Ca',
  className: 'whitespace-nowrap text-slate-500',
  render: (r) => text(r.shiftName),
});

const when = (
  key: string,
  header: string,
  pick: (r: OperationalReport) => string | null,
  secondary = true,
): DataColumn<OperationalReport> => ({
  key,
  header,
  secondary,
  className: 'whitespace-nowrap text-slate-500',
  render: (r) => formatDateTime(pick(r)),
});

/**
 * Hủy and sửa are both facts about the RECORD rather than about what it says,
 * and an Admin scanning for a disputed figure is looking for exactly these two.
 */
function status(header = 'Trạng thái'): DataColumn<OperationalReport> {
  return {
    key: 'status',
    header,
    className: 'whitespace-nowrap',
    render: (r) => {
      if (r.voided) {
        return (
          <span
            data-testid={`admin-status-${r.id}`}
            className="inline-flex rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700"
          >
            Đã hủy
          </span>
        );
      }
      if (r.audits.some((a) => a.action === 'EDIT')) {
        return (
          <span
            data-testid={`admin-status-${r.id}`}
            className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
          >
            Đã sửa
          </span>
        );
      }
      return (
        <span data-testid={`admin-status-${r.id}`} className="text-xs text-slate-400">
          Hợp lệ
        </span>
      );
    },
  };
}

/** Long free text: two lines in the row, all of it in the expanded record. */
const clamped = (value: string | null | undefined): ReactNode =>
  value ? <span className="line-clamp-2 whitespace-pre-wrap">{value}</span> : <span className="text-slate-400">—</span>;

/** Every Admin table opens a row into the same full record. */
const detail = (row: OperationalReport) => <OperationalRecordDetail row={row} />;

/** The columns a shift heading already states. */
const STATED_BY_HEADING = new Set(['staff', 'shift', 'branch']);

function inContext(
  columns: DataColumn<OperationalReport>[],
  grouped: boolean | undefined,
): DataColumn<OperationalReport>[] {
  return grouped ? columns.filter((c) => !STATED_BY_HEADING.has(c.key)) : columns;
}

const SHARED = {
  rowKey: (r: OperationalReport) => r.id,
  rowClassName: voidedRow,
  renderDetail: detail,
  detailToggle: 'always' as const,
  // An Admin opens two rows BECAUSE they are comparing them.
  multiExpand: true,
};

/* ------------------------- Theo dõi thanh toán ------------------------- */

export function AdminPaymentTable({ rows, title, grouped, ...state }: AdminTableProps) {
  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    staff(),
    shift(),
    { key: 'ez', header: 'Mã EZ', secondary: true, className: 'whitespace-nowrap', render: (r) => text(r.payment?.ezCode) },
    { key: 'source', header: 'Nguồn', secondary: true, render: (r) => text(r.payment?.source) },
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'font-medium text-slate-800',
      render: (r) => text(r.payment?.guestName),
    },
    { key: 'room', header: 'Phòng', secondary: true, className: 'whitespace-nowrap', render: (r) => text(r.payment?.roomNumber) },
    {
      key: 'method',
      header: 'Phương thức',
      className: 'whitespace-nowrap',
      render: (r) => text(r.payment?.methodLabel),
    },
    /*
      THE HEADLINE FIGURE, AND IT IS THE ONE THAT SURVIVES A NARROW SCREEN.
      The split below it is per-method, so on a phone — where only the primary
      columns render — a card payment would otherwise show "Thu tiền mặt: —" and
      no amount anywhere. `amount` is the transaction, whatever it was paid with.
    */
    {
      key: 'amount',
      header: 'Số tiền',
      align: 'right',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => money(r.payment?.amount),
    },
    { key: 'cash', header: 'Thu tiền mặt', align: 'right', secondary: true, className: 'whitespace-nowrap', render: (r) => money(r.payment?.cash) },
    { key: 'transfer', header: 'Thu CK', align: 'right', secondary: true, className: 'whitespace-nowrap', render: (r) => money(r.payment?.transfer) },
    { key: 'card', header: 'Cà thẻ', align: 'right', secondary: true, className: 'whitespace-nowrap', render: (r) => money(r.payment?.card) },
    { key: 'receivable', header: 'Công nợ', align: 'right', secondary: true, className: 'whitespace-nowrap', render: (r) => money(r.payment?.receivable) },
    { key: 'expense', header: 'Chi', align: 'right', secondary: true, className: 'whitespace-nowrap', render: (r) => money(r.payment?.expense) },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
    status(),
  ];

  return (
    <DataTable
      {...SHARED}
      {...state}
      testId="admin-table-PAYMENT"
      title={title}
      badge={rows.length}
      columns={inContext(columns, grouped)}
      rows={rows}
      emptyTitle="Không có giao dịch"
      emptyMessage="Chi nhánh này chưa ghi nhận giao dịch nào trong kỳ đang xem."
    />
  );
}

/* ------------------------ Vấn đề khách yêu cầu ------------------------ */

export function AdminGuestRequestTable({ rows, title, grouped, ...state }: AdminTableProps) {
  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'item',
      header: 'Ký gửi',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => text(r.guestRequest?.itemType),
    },
    { key: 'guest', header: 'Tên khách', render: (r) => text(r.guestRequest?.guestName) },
    { key: 'note', header: 'Ghi chú', secondary: true, className: 'max-w-[18rem]', render: (r) => clamped(r.guestRequest?.note) },
    staff('Người tạo'),
    shift(),
    when('createdAt', 'Thời gian', (r) => r.createdAt),
    {
      key: 'accepted',
      header: 'Người nhận',
      className: 'whitespace-nowrap',
      render: (r) =>
        r.guestRequest?.accepted ? (
          <>
            {r.guestRequest.acceptedByName ?? '—'}
            {r.guestRequest.acceptedShiftName ? (
              <span className="block text-xs text-slate-400">{r.guestRequest.acceptedShiftName}</span>
            ) : null}
          </>
        ) : (
          <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
            Chưa tiếp nhận
          </span>
        ),
    },
    status(),
  ];

  return (
    <DataTable
      {...SHARED}
      {...state}
      testId="admin-table-GUEST_REQUEST"
      title={title}
      badge={rows.length}
      columns={inContext(columns, grouped)}
      rows={rows}
      emptyTitle="Không có yêu cầu"
      emptyMessage="Chi nhánh này chưa ghi nhận yêu cầu nào trong kỳ đang xem."
    />
  );
}

/* ------------------- Vấn đề về chất lượng dịch vụ ------------------- */

export function AdminServiceQualityTable({ rows, title, grouped, ...state }: AdminTableProps) {
  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => text(r.complaint?.guestName),
    },
    {
      key: 'location',
      header: 'Số phòng / Khác',
      className: 'whitespace-nowrap',
      render: (r) => text(r.complaint?.location),
    },
    {
      key: 'description',
      header: 'Mô tả',
      className: 'min-w-[14rem] max-w-[28rem]',
      render: (r) => clamped(r.complaint?.description),
    },
    staff('Người tạo'),
    shift(),
    when('createdAt', 'Thời gian', (r) => r.createdAt),
    status(),
  ];

  return (
    <DataTable
      {...SHARED}
      {...state}
      testId="admin-table-CUSTOMER_COMPLAINT"
      title={title}
      badge={rows.length}
      columns={inContext(columns, grouped)}
      rows={rows}
      emptyTitle="Không có ghi nhận"
      emptyMessage="Chi nhánh này chưa ghi nhận vấn đề chất lượng dịch vụ nào trong kỳ đang xem."
    />
  );
}

/* ------------------------- Dịch vụ phòng, KPI ------------------------- */

/**
 * ONE TABLE PER SUBTYPE, and only for subtypes that actually have rows.
 *
 * The columns differ by subtype — a sale has a phone and a room class, an
 * upgrade has a from/to pair — and they come from `roomServiceFields`, the same
 * table reception's form and correction dialog read. Rendering five tables when
 * four are empty would reintroduce exactly the whitespace this redesign removes.
 */
export function AdminRoomServiceTable({
  rows,
  title,
  serviceType,
  grouped,
  ...state
}: AdminTableProps & { serviceType: RoomServiceType }) {
  const needs = roomServiceFields(serviceType);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => text(r.roomService?.guestName),
    },
    ...(needs.phone
      ? [{ key: 'phone', header: 'SĐT', className: 'whitespace-nowrap', render: (r: OperationalReport) => text(r.roomService?.phone) }]
      : []),
    ...(needs.roomClass
      ? [{ key: 'roomClass', header: 'Loại phòng', className: 'whitespace-nowrap', render: (r: OperationalReport) => text(r.roomService?.roomClass) }]
      : []),
    ...(needs.upgrade
      ? [
          { key: 'from', header: 'Từ hạng', className: 'whitespace-nowrap', render: (r: OperationalReport) => text(r.roomService?.fromRoomClass) },
          { key: 'to', header: 'Đến hạng', className: 'whitespace-nowrap', render: (r: OperationalReport) => text(r.roomService?.toRoomClass) },
        ]
      : []),
    ...(needs.serviceName
      ? [{ key: 'serviceName', header: 'Loại dịch vụ', render: (r: OperationalReport) => text(r.roomService?.serviceName) }]
      : []),
    ...(needs.roomNumber
      ? [{ key: 'room', header: 'Phòng', className: 'whitespace-nowrap', render: (r: OperationalReport) => text(r.roomService?.roomNumber) }]
      : []),
    {
      key: 'price',
      header: 'Giá',
      align: 'right',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => money(r.roomService?.price),
    },
    staff(),
    shift(),
    when('createdAt', 'Thời gian', (r) => r.createdAt),
    { key: 'note', header: 'Ghi chú', secondary: true, className: 'max-w-[18rem]', render: (r) => clamped(r.roomService?.note) },
    status(),
  ];

  const live = rows.filter((r) => !r.voided);
  const revenue = live.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0);

  return (
    <DataTable
      {...SHARED}
      {...state}
      testId={`admin-table-ROOM_SERVICE-${serviceType}`}
      title={title}
      badge={rows.length}
      columns={inContext(columns, grouped)}
      rows={rows}
      emptyTitle={`Không có ${title.toLowerCase()}`}
      emptyMessage="Chi nhánh này chưa ghi nhận dịch vụ nào thuộc loại này trong kỳ đang xem."
      footer={
        rows.length > 0 ? (
          <p className="flex items-center justify-between text-sm" data-testid={`admin-table-ROOM_SERVICE-${serviceType}-total`}>
            <span className="text-slate-500">
              {live.length} bản ghi tính vào tổng
              {rows.length !== live.length ? ` · ${rows.length - live.length} đã hủy` : ''}
            </span>
            <span className="font-semibold tabular-nums text-slate-800">{formatVnd(revenue)}</span>
          </p>
        ) : null
      }
    />
  );
}

/* ----------------------------- Tất cả ----------------------------- */

/**
 * The one figure a record carries, whatever its category — with its direction.
 *
 * A payment row is not always money coming in. "Chi tiền mặt" is recorded with
 * `amount` 0 and `expense` set, and reading `amount` alone printed "—" against a
 * two-million-đồng outflow — a term of the cash formula, shown on the branch's
 * primary table as no figure at all. A debt-only row is the same story with
 * `receivable`.
 */
function recordValue(r: OperationalReport): ReactNode {
  if (r.payment) {
    if (r.payment.amount) return money(r.payment.amount);
    if (r.payment.expense) {
      return <span className="text-rose-600">−{formatVnd(r.payment.expense)}</span>;
    }
    if (r.payment.receivable) return money(r.payment.receivable);
    return money(null);
  }
  if (r.roomService) return money(r.roomService.price);
  return money(null);
}

/**
 * EVERY CATEGORY, CHRONOLOGICALLY — one table, not five stacked ones.
 *
 * "Tất cả" is the view somebody opens to ask "what happened at this branch?",
 * which is a question about sequence. The category becomes a column so the
 * sequence survives; the summary line is the server's own, so the words here are
 * the words in the export.
 */
export function AdminAllCategoriesTable({
  rows,
  title,
  labelOf,
  grouped,
  ...state
}: AdminTableProps & { labelOf: (c: ReportCategory) => string }) {
  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    when('createdAt', 'Thời gian', (r) => r.createdAt, false),
    {
      key: 'category',
      header: 'Danh mục',
      // Allowed to wrap: "Vấn đề về chất lượng dịch vụ" on one line pushed the
      // table past its card at laptop width.
      className: 'min-w-[8rem]',
      render: (r) => (
        <span className="inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
          {r.categoryLabel || labelOf(r.category)}
        </span>
      ),
    },
    staff(),
    shift(),
    {
      key: 'branch',
      header: 'Chi nhánh',
      secondary: true,
      className: 'whitespace-nowrap text-slate-500',
      render: (r) => text(r.branch?.address),
    },
    {
      key: 'summary',
      header: 'Tóm tắt',
      className: 'min-w-[12rem] max-w-[32rem] text-slate-700',
      render: (r) => clamped(r.summary),
    },
    {
      key: 'value',
      header: 'Giá trị',
      align: 'right',
      className: 'whitespace-nowrap',
      render: (r) => recordValue(r),
    },
    status(),
  ];

  return (
    <DataTable
      {...SHARED}
      {...state}
      testId="admin-table-ALL"
      title={title}
      badge={rows.length}
      columns={inContext(columns, grouped)}
      rows={rows}
      emptyTitle="Không có bản ghi"
      emptyMessage="Chi nhánh này chưa ghi nhận bản ghi nào trong kỳ đang xem."
    />
  );
}
