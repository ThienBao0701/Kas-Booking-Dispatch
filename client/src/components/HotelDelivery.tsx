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
import { Archive } from 'lucide-react';
import { type OperationalReport, type ReportOptions } from '../api/receptionReports';
import { useDeliveries } from '../hooks/useDeliveries';
import { DataTable, type DataColumn } from './DataTable';
import type { SectionFrame } from './ReportSection';
import { RecordEditDialog, VoidDialog, VoidedNote, type EditField } from './RecordDialogs';
import { Actions } from './RecordRowActions';
import { formatDateTime } from '../lib/format';
import { COMPLETED_ISSUES_TITLE, HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';

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

  const departments = options?.deliveryDepartments ?? [
    { code: 'RECEPTION', label: 'Lễ tân' },
    { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
    { code: 'TECHNICAL', label: 'Kỹ thuật' },
  ];
  const editFields: EditField[] = [
    {
      name: 'department',
      label: 'Bộ phận',
      kind: 'select',
      required: true,
      options: departments.map((d) => ({ value: d.code, label: d.label })),
    },
    { name: 'itemName', label: 'Tên hàng hóa', required: true },
    { name: 'quantity', label: 'Số lượng', kind: 'integer', required: true },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];

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
      render: (r) => formatDateTime(r.delivery?.completedAt ?? r.createdAt),
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

/**
 * "HOÀN THÀNH VẤN ĐỀ" — what has been completed for more than the archive window.
 *
 * It holds a DEDICATED "Giao nhận hàng hóa của khách sạn" table, and that table
 * is the only thing in it: nothing else in this application is archived by the
 * 12-hour rule, so nothing else is listed. The rows are the delivery records
 * themselves, read from the archived side of the server's split; there is no
 * second copy that was "moved".
 */
export function CompletedIssuesView({ hours }: { hours: number }) {
  const archived = useDeliveries('archived');
  return (
    <div className="space-y-3" data-testid="completed-issues">
      <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
        <span>
          Các mục đã hoàn thành quá {hours} giờ được chuyển từ danh mục đang theo dõi sang {COMPLETED_ISSUES_TITLE}.
          Bản ghi không bị sao chép hay xóa — chỉ đổi nơi hiển thị.
        </span>
      </p>
      <DeliveryTable
        rows={archived.data?.deliveries ?? []}
        testId="completed-delivery-table"
        isLoading={archived.isLoading}
        isError={archived.isError}
        error={archived.error}
        onRetry={() => void archived.refetch()}
        emptyTitle="Chưa có mục nào hoàn thành quá thời hạn"
        emptyMessage={`Các mục giao nhận sẽ xuất hiện ở đây sau ${hours} giờ kể từ khi hoàn thành.`}
        section={{}}
      />
    </div>
  );
}
