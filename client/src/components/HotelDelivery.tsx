/**
 * "GIAO NHẬN HÀNG HÓA CỦA KHÁCH SẠN" — the delivery table, and "Hoàn thành vấn đề".
 *
 * ONE TABLE FOR EVERY ROLE THAT READS DELIVERIES. Reception (with correct/void),
 * the Technical and Housekeeping departments (read-only, scoped by the server to
 * their department) and the archive under "Hoàn thành vấn đề" all render
 * `DeliveryTable` from the SAME rows the server serves — the reception journal's
 * own records. There is no per-role copy and no client-side filtering: which rows
 * a role sees, and which side of the 12-hour rule a row is on, are decided by
 * `/api/hotel-deliveries` and arrive already decided.
 *
 * COLUMNS: STT · Bộ phận · Tên hàng hóa · Số lượng · Trạng thái — the specified
 * five — with the note and the time as secondary columns that fold into the
 * row's detail panel on a phone.
 */
import { useState } from 'react';
import { SourceTag } from './SourceTag';
import { deliveryEditFields } from '../lib/recordEdit';
import { type OperationalReport, type ReportOptions } from '../api/receptionReports';
import { DataTable, type DataColumn } from './DataTable';
import type { SectionFrame } from './ReportSection';
import { RecordEditDialog, VoidDialog, VoidedNote } from './RecordDialogs';
import { Actions } from './RecordRowActions';
import { formatDateTime } from '../lib/format';
import { HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';

const statusBadge = (label: string) => (
  <span className="inline-flex whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
    {label}
  </span>
);

export function DeliveryTable({
  rows,
  title = HOTEL_DELIVERY_TITLE,
  testId = 'delivery-table',
  options,
  canEdit = false,
  onChanged,
  onToast,
  compact,
  section,
  isLoading,
  isError,
  error,
  onRetry,
  emptyTitle = 'Chưa có giao nhận hàng hóa nào',
  emptyMessage = 'Bản ghi sẽ hiện ngay tại đây sau khi được thêm.',
}: {
  rows: OperationalReport[];
  title?: string;
  testId?: string;
  options?: ReportOptions;
  /** Only Reception may correct or void; every other reader passes nothing. */
  canEdit?: boolean;
  onChanged?: () => Promise<void> | void;
  onToast?: (message: string) => void;
  compact?: boolean;
  section?: SectionFrame;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyMessage?: string;
}) {
  const [editing, setEditing] = useState<OperationalReport | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);

  // The shared correction fields — the same list the supervisors' dialog uses.
  const editFields = deliveryEditFields(options);

  const columns: DataColumn<OperationalReport>[] = [
    {
      key: 'stt',
      header: 'STT',
      className: 'w-[1%] whitespace-nowrap text-slate-400',
      render: (_r, i) => i + 1,
    },
    {
      key: 'department',
      header: 'Bộ phận',
      className: 'whitespace-nowrap',
      render: (r) => r.delivery?.departmentLabel ?? '—',
    },
    {
      key: 'item',
      header: 'Tên hàng hóa',
      className: 'min-w-[9rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.delivery?.itemName ?? '—'}
          <SourceTag label={r.sourceLabel} />
          <VoidedNote report={r} />
          {r.audits.some((a) => a.action === 'EDIT') ? (
            <span className="mt-0.5 block text-xs font-normal text-amber-700">Đã sửa</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'quantity',
      header: 'Số lượng',
      align: 'right',
      className: 'whitespace-nowrap',
      render: (r) => (r.delivery ? String(r.delivery.quantity) : '—'),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'whitespace-nowrap',
      render: (r) => (r.delivery ? statusBadge(r.delivery.statusLabel) : '—'),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      secondary: true,
      className: 'min-w-[8rem] max-w-xs',
      render: (r) => <span className="whitespace-pre-wrap break-words">{r.delivery?.note || '—'}</span>,
    },
    {
      key: 'at',
      header: 'Hoàn thành lúc',
      secondary: true,
      className: 'whitespace-nowrap text-slate-500',
      render: (r) => (
        <>
          {formatDateTime(r.delivery?.completedAt ?? r.createdAt)}
        </>
      ),
    },
  ];

  return (
    <>
      <DataTable
        testId={testId}
        title={title}
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(r) => (r.voided ? 'bg-slate-50 text-slate-400' : '')}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        compact={compact}
        section={section}
        emptyTitle={emptyTitle}
        emptyMessage={emptyMessage}
        actions={
          canEdit
            ? (row) => <Actions row={row} canEdit onEdit={() => setEditing(row)} onVoid={() => setVoiding(row.id)} />
            : undefined
        }
      />
      {voiding ? (
        <VoidDialog
          id={voiding}
          onClose={() => setVoiding(null)}
          onVoided={async () => {
            setVoiding(null);
            await onChanged?.();
            onToast?.('Đã hủy bản ghi. Dữ liệu vẫn được lưu lại.');
          }}
        />
      ) : null}
      {editing ? (
        <RecordEditDialog
          report={editing}
          block="delivery"
          fields={editFields}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged?.();
            onToast?.('Đã lưu chỉnh sửa.');
          }}
        />
      ) : null}
    </>
  );
}
