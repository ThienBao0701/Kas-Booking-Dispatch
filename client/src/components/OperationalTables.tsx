/**
 * THE PRIMARY RECORD TABLE for each non-payment category.
 *
 * WHY EACH CATEGORY HAS ITS OWN TABLE AND NOT JUST THE SHIFT JOURNAL
 *
 * The journal is chronological and cross-category: it answers "what has happened
 * this shift?". It does not answer "what have I recorded in THIS category, and
 * does it look right?" — which is the question somebody has while they are still
 * typing. Making them read a mixed list to check the row they just added is the
 * difference between a form and a ledger.
 *
 * So: form, then the table for that category directly beneath it, then the
 * journal underneath as the secondary cross-category view.
 *
 * ALL THREE SHARE `DataTable`, so a row is the same height, money is right
 * aligned and the empty state reads the same wherever the receptionist is.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import {
  reportsApi,
  type OperationalReport,
  type ReportOptions,
  type RoomServiceType,
} from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { RecordEditDialog, VoidDialog, VoidedNote, type EditField } from './RecordDialogs';
import { formatVnd } from '../lib/money';
import { formatDateTime } from '../lib/format';
import { roomServiceFields } from '../lib/roomServiceFields';

interface TableProps {
  rows: OperationalReport[];
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
  /** Reception may write; an Admin reading the same screen may not. */
  canEdit: boolean;
}

/** A voided row stays on screen, greyed and struck through — never removed. */
const voidedRow = (r: OperationalReport) => (r.voided ? 'bg-slate-50 text-slate-400' : '');

const stt = <T,>(): DataColumn<T> => ({
  key: 'stt',
  header: 'STT',
  className: 'w-[1%] whitespace-nowrap text-slate-400',
  render: (_row, i) => i + 1,
});

const when = (key: string, header: string, pick: (r: OperationalReport) => string | null): DataColumn<OperationalReport> => ({
  key,
  header,
  secondary: true,
  className: 'whitespace-nowrap text-slate-500',
  render: (r) => formatDateTime(pick(r)),
});

/**
 * The shared edit/void pair.
 *
 * Edit is visually secondary and void is destructive-but-quiet: neither should
 * compete with "Thêm", which is the action being used forty times a shift.
 */
function useRowActions(onChanged: () => Promise<void>, onToast: (m: string) => void) {
  const [voiding, setVoiding] = useState<string | null>(null);
  const [editing, setEditing] = useState<OperationalReport | null>(null);
  return {
    voiding,
    editing,
    setVoiding,
    setEditing,
    voidNode: voiding ? (
      <VoidDialog
        id={voiding}
        onClose={() => setVoiding(null)}
        onVoided={async () => {
          setVoiding(null);
          await onChanged();
          onToast('Đã hủy bản ghi. Dữ liệu vẫn được lưu lại.');
        }}
      />
    ) : null,
  };
}

function Actions({
  row,
  canEdit,
  onEdit,
  onVoid,
}: {
  row: OperationalReport;
  canEdit: boolean;
  onEdit: () => void;
  onVoid: () => void;
}) {
  if (!canEdit || row.voided) return <span className="text-xs text-slate-300">—</span>;
  return (
    <>
      <RowAction onClick={onEdit} testId={`edit-${row.id}`}>
        <Pencil className="h-3 w-3" aria-hidden="true" />
        Sửa
      </RowAction>
      <RowAction onClick={onVoid} tone="danger" testId={`void-${row.id}`}>
        <Trash2 className="h-3 w-3" aria-hidden="true" />
        Hủy
      </RowAction>
    </>
  );
}

/**
 * Guest requests keep a THIRD action: "Tiếp nhận" — a second actor accepting
 * the request, recorded separately from whoever created it (see
 * `acceptGuestRequest` on the server). It is offered only while the request is
 * both live and not yet accepted, and never on top of a voided row.
 */
function GuestRequestActions({
  row,
  canEdit,
  onEdit,
  onVoid,
  onChanged,
  onToast,
}: {
  row: OperationalReport;
  canEdit: boolean;
  onEdit: () => void;
  onVoid: () => void;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const accept = useMutation({
    mutationFn: () => reportsApi.accept(row.id),
    onSuccess: async () => {
      await onChanged();
      onToast('Đã tiếp nhận yêu cầu của khách.');
    },
    onError: (e) => onToast(toUserMessage(e)),
  });

  if (row.voided) return <span className="text-xs text-slate-300">—</span>;

  return (
    <>
      {row.guestRequest && !row.guestRequest.accepted ? (
        <RowAction onClick={() => accept.mutate()} disabled={accept.isPending} testId={`accept-${row.id}`}>
          Tiếp nhận
        </RowAction>
      ) : null}
      {canEdit ? (
        <>
          <RowAction onClick={onEdit} testId={`edit-${row.id}`}>
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Sửa
          </RowAction>
          <RowAction onClick={onVoid} tone="danger" testId={`void-${row.id}`}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Hủy
          </RowAction>
        </>
      ) : null}
    </>
  );
}

/* ------------------------ Vấn đề khách yêu cầu ------------------------ */

const GUEST_REQUEST_EDIT: EditField[] = [
  { name: 'itemType', label: 'Ký gửi', required: true },
  { name: 'guestName', label: 'Tên khách', required: true },
  { name: 'note', label: 'Ghi chú', kind: 'textarea' },
];

export function GuestRequestTable({
  rows,
  onChanged,
  onToast,
  canEdit,
  isLoading,
  isError,
  error,
  onRetry,
}: TableProps) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'item',
      header: 'Ký gửi',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => r.guestRequest?.itemType ?? '—',
    },
    {
      key: 'guest',
      header: 'Tên khách',
      render: (r) => (
        <>
          {r.guestRequest?.guestName ?? '—'}
          <VoidedNote report={r} />
        </>
      ),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      secondary: true,
      render: (r) => r.guestRequest?.note || '—',
    },
    {
      key: 'createdBy',
      header: 'Người tạo',
      secondary: true,
      render: (r) => (
        <>
          {r.createdByName}
          {r.shiftName ? <span className="block text-xs text-slate-400">{r.shiftName}</span> : null}
        </>
      ),
    },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
    {
      key: 'accepted',
      header: 'Tiếp nhận',
      render: (r) =>
        r.guestRequest?.accepted ? (
          <>
            <span className="inline-flex rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
              Đã tiếp nhận
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {r.guestRequest.acceptedByName}
              {r.guestRequest.acceptedShiftName ? ` · ${r.guestRequest.acceptedShiftName}` : ''}
            </span>
          </>
        ) : (
          <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
            Chờ tiếp nhận
          </span>
        ),
    },
  ];

  return (
    <>
      <DataTable
        testId="guest-request-table"
        title="Danh sách vấn đề khách yêu cầu"
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        emptyTitle="Chưa có yêu cầu nào"
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
        actions={(row) => (
          <GuestRequestActions
            row={row}
            canEdit={canEdit}
            onEdit={() => setEditing(row)}
            onVoid={() => setVoiding(row.id)}
            onChanged={onChanged}
            onToast={onToast}
          />
        )}
      />
      {voidNode}
      {editing ? (
        <RecordEditDialog
          report={editing}
          block="guestRequest"
          fields={GUEST_REQUEST_EDIT}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
            onToast('Đã lưu chỉnh sửa.');
          }}
        />
      ) : null}
    </>
  );
}

/* --------------------- Vấn đề về chất lượng dịch vụ --------------------- */

const COMPLAINT_EDIT: EditField[] = [
  { name: 'guestName', label: 'Tên khách', required: true },
  { name: 'location', label: 'Số phòng / Khác', required: true },
  { name: 'description', label: 'Mô tả', kind: 'textarea', required: true },
];

export function ServiceQualityTable({
  rows,
  onChanged,
  onToast,
  canEdit,
  isLoading,
  isError,
  error,
  onRetry,
}: TableProps) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'font-medium text-slate-800',
      render: (r) => r.complaint?.guestName ?? '—',
    },
    {
      key: 'location',
      header: 'Số phòng / Khác',
      className: 'whitespace-nowrap',
      render: (r) => r.complaint?.location ?? '—',
    },
    {
      key: 'description',
      header: 'Mô tả',
      // The one column that must breathe: it is the whole content of the record.
      className: 'min-w-[16rem] max-w-xl',
      render: (r) => (
        <>
          <span className="whitespace-pre-wrap">{r.complaint?.description ?? '—'}</span>
          <VoidedNote report={r} />
        </>
      ),
    },
    {
      key: 'staff',
      header: 'Nhân viên',
      secondary: true,
      render: (r) => (
        <>
          {r.createdByName}
          {r.shiftName ? <span className="block text-xs text-slate-400">{r.shiftName}</span> : null}
        </>
      ),
    },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
  ];

  return (
    <>
      <DataTable
        testId="service-quality-table"
        title="Danh sách vấn đề về chất lượng dịch vụ"
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        emptyTitle="Chưa có ghi nhận nào"
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
        actions={(row) => (
          <Actions
            row={row}
            canEdit={canEdit}
            onEdit={() => setEditing(row)}
            onVoid={() => setVoiding(row.id)}
          />
        )}
      />
      {voidNode}
      {editing ? (
        <RecordEditDialog
          report={editing}
          block="complaint"
          fields={COMPLAINT_EDIT}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
            onToast('Đã lưu chỉnh sửa.');
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------- Dịch vụ phòng, KPI ------------------------- */

/** The edit fields for one subtype — the same rules the entry form renders. */
function roomServiceEditFields(type: RoomServiceType): EditField[] {
  const needs = roomServiceFields(type);
  return [
    { name: 'guestName', label: 'Tên khách', required: true },
    ...(needs.phone ? [{ name: 'phone', label: 'SĐT' } as EditField] : []),
    ...(needs.roomClass ? [{ name: 'roomClass', label: 'Hạng phòng', required: true } as EditField] : []),
    ...(needs.upgrade
      ? ([
          { name: 'fromRoomClass', label: 'Từ hạng phòng', required: true },
          { name: 'toRoomClass', label: 'Lên hạng phòng', required: true },
        ] as EditField[])
      : []),
    ...(needs.roomNumber ? [{ name: 'roomNumber', label: 'Phòng', required: true } as EditField] : []),
    ...(needs.serviceName
      ? [{ name: 'serviceName', label: 'Loại hình dịch vụ', required: true } as EditField]
      : []),
    { name: 'price', label: 'Giá tiền', kind: 'money', required: true },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];
}

/**
 * ONE TABLE, COLUMNS CHOSEN BY SUBTYPE.
 *
 * Five separate tables would be five places to fix the next alignment bug, and
 * they share seven of their nine columns. What differs — a phone and a room
 * class for a sale, a from/to pair for an upgrade, a room for the rest — is
 * decided by `roomServiceFields`, the same table the entry form reads.
 */
export function RoomServiceTable({
  rows,
  serviceType,
  serviceLabel,
  onChanged,
  onToast,
  canEdit,
  isLoading,
  isError,
  error,
  onRetry,
}: TableProps & { serviceType: RoomServiceType; serviceLabel: string }) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);
  const needs = roomServiceFields(serviceType);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'font-medium text-slate-800',
      render: (r) => (
        <>
          {r.roomService?.guestName ?? '—'}
          <VoidedNote report={r} />
        </>
      ),
    },
    ...(needs.phone
      ? [
          {
            key: 'phone',
            header: 'SĐT',
            className: 'whitespace-nowrap',
            render: (r: OperationalReport) => r.roomService?.phone || '—',
          },
        ]
      : []),
    ...(needs.roomClass
      ? [
          {
            key: 'roomClass',
            header: 'Loại phòng',
            render: (r: OperationalReport) => r.roomService?.roomClass || '—',
          },
        ]
      : []),
    ...(needs.upgrade
      ? [
          {
            key: 'from',
            header: 'Từ hạng',
            render: (r: OperationalReport) => r.roomService?.fromRoomClass || '—',
          },
          {
            key: 'to',
            header: 'Đến hạng',
            render: (r: OperationalReport) => r.roomService?.toRoomClass || '—',
          },
        ]
      : []),
    ...(needs.roomNumber
      ? [
          {
            key: 'room',
            header: 'Phòng',
            className: 'whitespace-nowrap',
            render: (r: OperationalReport) => r.roomService?.roomNumber || '—',
          },
        ]
      : []),
    ...(needs.serviceName
      ? [
          {
            key: 'serviceName',
            header: 'Loại dịch vụ',
            render: (r: OperationalReport) => r.roomService?.serviceName || '—',
          },
        ]
      : []),
    {
      key: 'price',
      header: 'Giá',
      align: 'right',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => formatVnd(r.roomService?.price ?? null),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      secondary: true,
      render: (r) => r.roomService?.note || '—',
    },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
  ];

  // Derived from the rows on screen — arithmetic on real records, not a metric.
  const live = rows.filter((r) => !r.voided);
  const revenue = live.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0);

  return (
    <>
      <DataTable
        testId="room-service-table"
        title={`Danh sách ${serviceLabel.toLowerCase()}`}
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        emptyTitle={`Chưa có ${serviceLabel.toLowerCase()} nào`}
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
        actions={(row) => (
          <Actions
            row={row}
            canEdit={canEdit}
            onEdit={() => setEditing(row)}
            onVoid={() => setVoiding(row.id)}
          />
        )}
        footer={
          rows.length > 0 ? (
            <p className="flex items-center justify-between text-sm" data-testid="room-service-total">
              <span className="text-slate-500">
                {live.length} bản ghi tính vào tổng
                {rows.length !== live.length ? ` · ${rows.length - live.length} đã hủy` : ''}
              </span>
              <span className="font-semibold tabular-nums text-slate-800">{formatVnd(revenue)}</span>
            </p>
          ) : null
        }
      />
      {voidNode}
      {editing ? (
        <RecordEditDialog
          report={editing}
          block="roomService"
          fields={roomServiceEditFields(editing.roomService?.serviceType ?? serviceType)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
            onToast('Đã lưu chỉnh sửa.');
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Totals for every subtype in the shift — the "tổng hợp" half of the
 * "Dịch vụ phòng, KPI" section.
 *
 * NOT A KPI MODULE. This project has no KPI data source, and inventing a metric
 * would be worse than showing none: an operator cannot tell a fabricated target
 * from a real one. These are counts and sums of the records already on the
 * screen, which is arithmetic, not a judgement.
 */
export function RoomServiceTotals({
  rows,
  options,
  order,
  labelOf,
  scope = 'trong ca',
}: {
  rows: OperationalReport[];
  options?: ReportOptions;
  order: RoomServiceType[];
  labelOf: (t: RoomServiceType) => string;
  /**
   * What the rows are a total OF. Reception's rows are one shift's, so that is
   * the default; the Admin's are a branch's, and a heading that said "trong ca"
   * over a branch's takings would be a figure claiming a scope it does not have.
   */
  scope?: string;
}) {
  const live = rows.filter((r) => !r.voided);
  const totals = order.map((type) => {
    const mine = live.filter((r) => r.roomService?.serviceType === type);
    return {
      type,
      label: labelOf(type),
      count: mine.length,
      revenue: mine.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0),
    };
  });
  const grand = totals.reduce((sum, t) => sum + t.revenue, 0);
  void options;

  return (
    <section
      data-testid="room-service-summary"
      className="rounded-xl border border-slate-200 bg-white"
    >
      <header className="border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-800">Tổng hợp dịch vụ {scope}</h3>
      </header>
      <div className="grid gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
        {totals.map((t) => (
          <div key={t.type} className="bg-white px-4 py-3" data-testid={`service-total-${t.type}`}>
            <p className="text-xs uppercase tracking-wide text-slate-400">{t.label}</p>
            <p className="text-sm font-semibold tabular-nums text-slate-800">{formatVnd(t.revenue)}</p>
            <p className="text-xs text-slate-500">{t.count} bản ghi</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5">
        <span className="text-sm font-medium text-slate-600">Tổng doanh thu dịch vụ {scope}</span>
        <span className="text-base font-semibold tabular-nums text-slate-900" data-testid="service-grand-total">
          {formatVnd(grand)}
        </span>
      </div>
    </section>
  );
}
