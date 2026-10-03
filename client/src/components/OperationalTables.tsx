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
import { SourceTag } from './SourceTag';
import { GUEST_REQUEST_EDIT, SERVICE_QUALITY_EDIT, roomServiceEditFields } from '../lib/recordEdit';
import { CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import { type OperationalReport, type RoomServiceType } from '../api/receptionReports';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { Actions } from './RecordRowActions';
import { ReportSection, type SectionFrame } from './ReportSection';
import {
  CompleteRecordDialog,
  RecordEditDialog,
  VoidDialog,
  VoidedNote,
} from './RecordDialogs';
import { formatVnd } from '../lib/money';
import { completionText } from '../lib/completionVerdict';
import { formatDateTime } from '../lib/format';
import { ROOM_SERVICE_PRICE_LABEL, reviewTotal, roomServiceFields, serviceRevenue } from '../lib/roomServiceFields';

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
  /** The overview shows the same table under the category's own name. */
  title?: string;
  /** A one-line empty state, for a page that stacks several tables. */
  compact?: boolean;
  /** Drawn as one section of the reception overview. */
  section?: SectionFrame;
  /**
   * 'summary' — the OVERVIEW's and the archive's compact form: STT, Tên khách,
   * Mã EZ, the content, and a status that is only "Đã tiếp nhận" or "Đã hoàn
   * thành". No times, no handling text, no controls. 'detail' (the default) is
   * the category's own complete table.
   */
  variant?: 'detail' | 'summary';
  /** The empty state's line, where the default ("nothing recorded yet") does not fit. */
  emptyTitle?: string;
}

/** The one status a summary row states — the words, nothing beneath them. */
function summaryStatus(completed: boolean | undefined) {
  return completed ? statusBadge('emerald', 'Đã hoàn thành') : statusBadge('amber', 'Đã tiếp nhận');
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

/* -------------- Vấn đề khách yêu cầu thực hiện (Request) -------------- */

const statusBadge = (tone: 'amber' | 'emerald', text: string) => (
  <span
    className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${
      tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
    }`}
  >
    {text}
  </span>
);

/** "Đã tiếp nhận" until the server has stamped a completion time. */
function RequestCompletion({ row }: { row: OperationalReport }) {
  const request = row.guestRequest;
  if (row.voided || !request) return <span className="text-slate-300">—</span>;
  if (!request.completed) return statusBadge('amber', 'Đã tiếp nhận');
  return (
    <>
      <span className="block text-slate-600">{formatDateTime(request.completedAt)}</span>
      <span className="mt-0.5 block">{statusBadge('emerald', 'Đã hoàn thành')}</span>
    </>
  );
}

/** How it was handled — or, until then, the way to say so. */
function RequestHandling({
  row,
  canEdit,
  onComplete,
  onEdit,
  onVoid,
}: {
  row: OperationalReport;
  canEdit: boolean;
  onComplete: () => void;
  onEdit: () => void;
  onVoid: () => void;
}) {
  const request = row.guestRequest;
  if (row.voided || !request) return <span className="text-xs text-slate-300">—</span>;
  return (
    <div className="space-y-1.5">
      {request.completed ? (
        <p className="whitespace-pre-wrap break-words text-slate-700">{completionText(request) || '—'}</p>
      ) : (
        <RowAction onClick={onComplete} testId={`complete-${row.id}`}>
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Hoàn thành
        </RowAction>
      )}
      {canEdit ? (
        <div className="flex flex-wrap gap-y-1">
          <RowAction onClick={onEdit} testId={`edit-${row.id}`}>
            <Pencil className="h-3 w-3" aria-hidden="true" />
            Sửa
          </RowAction>
          <RowAction onClick={onVoid} tone="danger" testId={`void-${row.id}`}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Hủy
          </RowAction>
        </div>
      ) : null}
    </div>
  );
}

/**
 * SEVEN COLUMNS: STT, Tên khách, Mã EZ, Nội dung, the two times, and "Cách xử
 * lý (nếu có)". No status or action column of its own.
 *
 * The status is shown in "Thời gian hoàn thành" — "Đã tiếp nhận" until the
 * server has stamped a completion time — and the way to change it sits in
 * "Cách xử lý", which is where its result is written. "Sửa" and "Hủy" sit there
 * too when the table may edit.
 *
 * THE SUMMARY (overview, "Hoàn thành vấn đề") keeps five: STT, Tên khách, Mã
 * EZ, Nội dung and a status that is only "Đã tiếp nhận" or "Đã hoàn thành".
 */
export function GuestRequestTable({
  rows,
  onChanged,
  onToast,
  canEdit,
  isLoading,
  isError,
  error,
  onRetry,
  title = 'Danh sách vấn đề khách yêu cầu',
  compact,
  section,
  variant = 'detail',
  emptyTitle = 'Chưa có yêu cầu nào',
}: TableProps) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);
  const [completing, setCompleting] = useState<string | null>(null);

  /*
    ON A PHONE the glance is the guest, the content and the status: STT and Mã
    EZ fold into the row's expander (below `md` only). The content may break
    anywhere, so one long unbroken word cannot push the status off screen; the
    name keeps a readable width and breaks only between words.
  */
  const summaryColumns: DataColumn<OperationalReport>[] = [
    { ...stt<OperationalReport>(), secondary: true },
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[5.5rem] sm:min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.guestRequest?.guestName ?? '—'}
          <SourceTag label={r.sourceLabel} />
        </>
      ),
    },
    { key: 'ez', header: 'Mã EZ', secondary: true, className: 'whitespace-nowrap', render: (r) => r.guestRequest?.ezCode || '—' },
    {
      key: 'content',
      header: 'Nội dung',
      className: 'sm:min-w-[10rem] max-w-md',
      render: (r) => <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{r.guestRequest?.content || '—'}</span>,
    },
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'whitespace-nowrap',
      render: (r) => summaryStatus(r.guestRequest?.completed),
    },
  ];

  const detailColumns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.guestRequest?.guestName ?? '—'}
          <SourceTag label={r.sourceLabel} />
          <VoidedNote report={r} />
        </>
      ),
    },
    {
      key: 'ez',
      header: 'Mã EZ',
      className: 'whitespace-nowrap',
      render: (r) => r.guestRequest?.ezCode || '—',
    },
    /*
      THE CONTENT IS THE COLUMN THAT MUST BREATHE: short headers may wrap and
      the two times break between date and hour, so "Nội dung" keeps enough
      width to be read instead of collapsing to a word per line. An older row
      reads its "Ký gửi" here too — the server's `content`.
    */
    {
      key: 'content',
      header: 'Nội dung',
      className: 'min-w-[10rem] max-w-xs',
      render: (r) => <span className="whitespace-pre-wrap break-words">{r.guestRequest?.content || '—'}</span>,
    },
    {
      key: 'receivedAt',
      header: 'Thời gian tiếp nhận',
      secondary: true,
      className: 'min-w-[5.5rem] text-slate-500',
      render: (r) => (
        <>
          {formatDateTime(r.createdAt)}
        </>
      ),
    },
    {
      key: 'completedAt',
      header: 'Thời gian hoàn thành',
      className: 'min-w-[6.5rem]',
      render: (r) => <RequestCompletion row={r} />,
    },
    {
      key: 'resolution',
      header: 'Cách xử lý (nếu có)',
      className: 'min-w-[8rem] max-w-xs',
      render: (r) => (
        <RequestHandling
          row={r}
          canEdit={canEdit}
          onComplete={() => setCompleting(r.id)}
          onEdit={() => setEditing(r)}
          onVoid={() => setVoiding(r.id)}
        />
      ),
    },
  ];
  const columns = variant === 'summary' ? summaryColumns : detailColumns;

  return (
    <>
      <DataTable
        testId="guest-request-table"
        title={title}
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        compact={compact}
        section={section}
        emptyTitle={emptyTitle}
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
      />
      {voidNode}
      {completing ? (
        <CompleteRecordDialog
          id={completing}
          title="Hoàn thành yêu cầu"
          fieldLabel="Cách xử lý (nếu có)"
          onClose={() => setCompleting(null)}
          onCompleted={async () => {
            setCompleting(null);
            await onChanged();
            onToast('Đã hoàn thành yêu cầu của khách.');
          }}
        />
      ) : null}
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

/* ------------------- Vấn đề về chất lượng và dịch vụ ------------------- */

/**
 * "Đã tiếp nhận", or "Đã hoàn thành" with the server's completion time — and,
 * until then, the way to complete it.
 *
 * THE COMPLETION LIVES IN THE STATUS CELL, not in an action column: the table
 * has no "Thao tác" column, so the one interaction it offers sits where its
 * result is shown.
 */
function ComplaintStatus({ row, onComplete }: { row: OperationalReport; onComplete: () => void }) {
  const complaint = row.complaint;
  if (row.voided || !complaint) return <span className="text-slate-300">—</span>;
  if (complaint.completed) {
    return (
      <>
        {statusBadge('emerald', 'Đã hoàn thành')}
        <span className="mt-0.5 block text-xs text-slate-500">{formatDateTime(complaint.completedAt)}</span>
      </>
    );
  }
  return (
    <div className="space-y-1.5">
      {statusBadge('amber', 'Đã tiếp nhận')}
      <div>
        <RowAction onClick={onComplete} testId={`complete-${row.id}`}>
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Hoàn thành
        </RowAction>
      </div>
    </div>
  );
}

/**
 * THE CATEGORY'S OWN SCREEN — SEVEN COLUMNS: STT, Tên khách, Mã EZ, Mô tả, Trạng
 * thái, Hướng xử lý (nếu có), Thời gian. No room, no staff and no action column:
 * the shift says who, completing a report is done in its status cell, and "Sửa"
 * sits with the handling.
 *
 * THE SUMMARY (overview, "Hoàn thành vấn đề"): STT, Tên khách, Mã EZ, Mô tả,
 * Trạng thái — and nothing to press.
 */
export function ServiceQualityTable({
  rows,
  onChanged,
  onToast,
  isLoading,
  isError,
  error,
  onRetry,
  title = 'Danh sách vấn đề về chất lượng và dịch vụ',
  compact,
  section,
  canEdit,
  variant = 'detail',
  emptyTitle = 'Chưa có ghi nhận nào',
}: TableProps) {
  const [completing, setCompleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<OperationalReport | null>(null);

  // As the request summary: on a phone STT and Mã EZ fold away so the status stays in view.
  const summaryColumns: DataColumn<OperationalReport>[] = [
    { ...stt<OperationalReport>(), secondary: true },
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[5.5rem] sm:min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.complaint?.guestName ?? '—'}
          <SourceTag label={r.sourceLabel} />
        </>
      ),
    },
    { key: 'ez', header: 'Mã EZ', secondary: true, className: 'whitespace-nowrap', render: (r) => r.complaint?.ezCode || '—' },
    {
      key: 'description',
      header: 'Mô tả',
      className: 'sm:min-w-[12rem] max-w-xl',
      render: (r) => <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{r.complaint?.description ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'whitespace-nowrap',
      render: (r) => summaryStatus(r.complaint?.completed),
    },
  ];

  const detailColumns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.complaint?.guestName ?? '—'}
          <SourceTag label={r.sourceLabel} />
          <VoidedNote report={r} />
        </>
      ),
    },
    {
      key: 'ez',
      header: 'Mã EZ',
      className: 'whitespace-nowrap',
      render: (r) => r.complaint?.ezCode || '—',
    },
    {
      key: 'description',
      header: 'Mô tả',
      // The one column that must breathe: it is the whole content of the record.
      className: 'min-w-[14rem] max-w-xl',
      render: (r) => <span className="whitespace-pre-wrap break-words">{r.complaint?.description ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'min-w-[7.5rem]',
      render: (r) => <ComplaintStatus row={r} onComplete={() => setCompleting(r.id)} />,
    },
    /*
      "SỬA" SITS WITH THE HANDLING, as it does in the request table — no action
      column of its own. It corrects Tên khách, Mã EZ and Mô tả only: the times
      and the completion stay as the server recorded them, and the old values
      go to the correction history. Offered before and after completion.
    */
    {
      key: 'resolution',
      header: 'Hướng xử lý (nếu có)',
      className: 'min-w-[8rem] max-w-xs',
      render: (r) => (
        <div className="space-y-1.5">
          {r.complaint?.completed && completionText(r.complaint) ? (
            <p className="whitespace-pre-wrap break-words text-slate-700">{completionText(r.complaint)}</p>
          ) : (
            <p className="text-slate-300">—</p>
          )}
          {canEdit && !r.voided ? (
            <RowAction onClick={() => setEditing(r)} testId={`edit-${r.id}`}>
              <Pencil className="h-3 w-3" aria-hidden="true" />
              Sửa
            </RowAction>
          ) : null}
        </div>
      ),
    },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
  ];
  const summary = variant === 'summary';
  const columns = summary ? summaryColumns : detailColumns;

  return (
    <>
      <DataTable
        testId="service-quality-table"
        title={title}
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        compact={compact}
        section={section}
        emptyTitle={emptyTitle}
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
      />
      {editing ? (
        <RecordEditDialog
          report={editing}
          block="complaint"
          fields={SERVICE_QUALITY_EDIT}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
            onToast('Đã lưu chỉnh sửa.');
          }}
        />
      ) : null}
      {completing ? (
        <CompleteRecordDialog
          id={completing}
          title="Hoàn thành vấn đề"
          fieldLabel="Hướng xử lý (nếu có)"
          onClose={() => setCompleting(null)}
          onCompleted={async () => {
            setCompleting(null);
            await onChanged();
            onToast('Đã hoàn thành vấn đề về chất lượng và dịch vụ.');
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------- Dịch vụ phòng, KPI ------------------------- */

/**
 * ONE SERVICE'S TABLE, COLUMNS CHOSEN BY THE SERVICE.
 *
 *   Bán phòng    STT · Tên khách · Mã EZ · Hạng phòng · Số đêm · Tổng giá tiền · Ghi chú · Thời gian
 *   Upgrade      STT · Tên khách · Mã EZ · Từ / Tới hạng phòng · Số đêm · Tổng giá tiền · Ghi chú · Thời gian
 *   the rest     STT · Tên khách · Mã EZ · Tổng giá tiền · Ghi chú · Thời gian
 *
 * What differs is decided by `roomServiceFields`, the same table the entry form
 * reads. "Thời gian" is the server's creation stamp, shown on every width.
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
  compact,
  section,
}: TableProps & {
  serviceType: RoomServiceType;
  serviceLabel: string;
}) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);
  const needs = roomServiceFields(serviceType);
  const text = (value: string | null | undefined) => value || '—';

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.roomService?.guestName ?? '—'}
          <SourceTag label={r.sourceLabel} />
          <VoidedNote report={r} />
        </>
      ),
    },
    {
      key: 'ez',
      header: 'Mã EZ',
      className: 'whitespace-nowrap',
      render: (r) => text(r.roomService?.ezCode),
    },
    // A floor under the room-class columns, so a short class ("Std") does not
    // leave "Tới hạng phòng" wrapping a word per line above it.
    ...(needs.roomClass
      ? [{ key: 'roomClass', header: 'Hạng phòng', className: 'min-w-[6rem]', render: (r: OperationalReport) => text(r.roomService?.roomClass) }]
      : []),
    ...(needs.upgrade
      ? [
          { key: 'from', header: 'Từ hạng phòng', className: 'min-w-[6rem]', render: (r: OperationalReport) => text(r.roomService?.fromRoomClass) },
          { key: 'to', header: 'Tới hạng phòng', className: 'min-w-[6rem]', render: (r: OperationalReport) => text(r.roomService?.toRoomClass) },
        ]
      : []),
    ...(needs.nights
      ? [
          {
            key: 'nights',
            header: 'Số đêm',
            align: 'right' as const,
            className: 'whitespace-nowrap',
            render: (r: OperationalReport) => (r.roomService?.nights ? String(r.roomService.nights) : '—'),
          },
        ]
      : []),
    // "Review": the two counts, and no price or note — it is not a sale.
    ...(needs.review
      ? [
          {
            key: 'tripadvisor',
            header: 'Tripadvisor',
            align: 'right' as const,
            className: 'whitespace-nowrap font-medium tabular-nums text-slate-800',
            render: (r: OperationalReport) => String(r.roomService?.tripadvisorCount ?? 0),
          },
          {
            key: 'google',
            header: 'Google',
            align: 'right' as const,
            className: 'whitespace-nowrap font-medium tabular-nums text-slate-800',
            render: (r: OperationalReport) => String(r.roomService?.googleCount ?? 0),
          },
        ]
      : [
          {
            key: 'price',
            header: ROOM_SERVICE_PRICE_LABEL,
            align: 'right' as const,
            className: 'whitespace-nowrap font-medium text-slate-800',
            render: (r: OperationalReport) => formatVnd(r.roomService?.price ?? null),
          },
          {
            key: 'note',
            header: 'Ghi chú',
            secondary: true,
            className: 'min-w-[8rem] max-w-xs',
            render: (r: OperationalReport) => (
              <span className="whitespace-pre-wrap break-words">{text(r.roomService?.note)}</span>
            ),
          },
        ]),
    {
      key: 'createdAt',
      header: 'Thời gian',
      className: 'whitespace-nowrap text-slate-500',
      render: (r) => (
        <>
          {formatDateTime(r.createdAt)}
        </>
      ),
    },
  ];

  // Derived from the rows on screen — arithmetic on real records, not a metric.
  const live = rows.filter((r) => !r.voided);
  const revenue = serviceRevenue(rows);
  const reviews = reviewTotal(rows);

  return (
    <>
      <DataTable
        testId={`room-service-table-${serviceType}`}
        title={serviceLabel}
        badge={rows.length}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={voidedRow}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        compact={compact}
        section={section}
        emptyTitle={`Chưa có ${serviceLabel.toLowerCase()} nào`}
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm dịch vụ."
        actions={(row: OperationalReport) => (
          <Actions
            row={row}
            canEdit={canEdit}
            onEdit={() => setEditing(row)}
            onVoid={() => setVoiding(row.id)}
          />
        )}
        footer={
          rows.length > 0 ? (
            <p className="flex items-center justify-between text-sm" data-testid={`room-service-total-${serviceType}`}>
              <span className="text-slate-500">
                {live.length} bản ghi tính vào tổng
                {rows.length !== live.length ? ` · ${rows.length - live.length} đã hủy` : ''}
              </span>
              <span className="font-semibold tabular-nums text-slate-800">
                {needs.review ? `${reviews} review` : formatVnd(revenue)}
              </span>
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
 * "DỊCH VỤ PHÒNG, KPI" ON THE OVERVIEW — two figures, and nothing else.
 *
 * TỔNG DOANH THU is arithmetic on this shift's own service rows (voided ones
 * excluded), the same sum the category's tables foot to — never a "Review".
 *
 * TỔNG ĐÁNH GIÁ (REVIEW) is the reviews the desk itself recorded this shift:
 * SUM(Tripadvisor) + SUM(Google) over the live "Review" rows. A count the
 * receptionist entered, not a rating fetched from anywhere — and no breakdown
 * here; the category's own "Review" table has that.
 */
export function RoomServiceOverview({
  rows,
  title,
  marker,
  isLoading,
  isError,
}: {
  rows: OperationalReport[];
  title: string;
  marker?: string;
  isLoading?: boolean;
  isError?: boolean;
}) {
  const revenue = serviceRevenue(rows);
  const reviews = reviewTotal(rows);
  const pending = isLoading || isError;

  return (
    <ReportSection testId="room-service-overview" marker={marker} title={title} count={rows.length}>
      <dl className="divide-y-rule divide-line-subtle text-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="font-medium text-slate-600">Tổng doanh thu</dt>
          <dd
            className="shrink-0 whitespace-nowrap text-base font-semibold tabular-nums text-slate-900"
            data-testid="room-service-revenue"
          >
            {pending ? '—' : formatVnd(revenue)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="font-medium text-slate-600">Tổng đánh giá (review)</dt>
          <dd
            className="shrink-0 whitespace-nowrap text-base font-semibold tabular-nums text-slate-900"
            data-testid="room-service-review"
          >
            {pending ? '—' : reviews}
          </dd>
        </div>
      </dl>
    </ReportSection>
  );
}

/**
 * Totals for every subtype — the Admin's "tổng hợp" over the rows it is
 * showing.
 *
 * NOT A KPI MODULE. This project has no KPI data source, and inventing a metric
 * would be worse than showing none: an operator cannot tell a fabricated target
 * from a real one. These are counts and sums of the records already on the
 * screen, which is arithmetic, not a judgement.
 */
export function RoomServiceTotals({
  rows,
  order,
  labelOf,
  scope = 'trong ca',
}: {
  rows: OperationalReport[];
  order: RoomServiceType[];
  labelOf: (t: RoomServiceType) => string;
  /**
   * What the rows are a total OF. A heading that said "trong ca" over a
   * branch's takings would be a figure claiming a scope it does not have.
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
      review: type === 'REVIEW',
      revenue: serviceRevenue(mine),
      reviews: reviewTotal(mine),
    };
  });
  // Revenue only — a review is a count, and never adds to money.
  const grand = serviceRevenue(rows);

  return (
    <section data-testid="room-service-summary" className="rounded-xl border-section border-line bg-white">
      <header className="border-b-rule border-line bg-slate-50/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-800">Tổng hợp dịch vụ {scope}</h3>
      </header>
      <div className="grid gap-0.5 bg-line-subtle sm:grid-cols-3 lg:grid-cols-6">
        {totals.map((t) => (
          <div key={t.type} className="bg-white px-4 py-3" data-testid={`service-total-${t.type}`}>
            <p className="text-xs uppercase tracking-wide text-slate-500">{t.label}</p>
            <p className="text-sm font-semibold tabular-nums text-slate-800">
              {t.review ? `${t.reviews} review` : formatVnd(t.revenue)}
            </p>
            <p className="text-xs text-slate-500">{t.count} bản ghi</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t-rule border-line px-4 py-2.5">
        <span className="text-sm font-medium text-slate-600">Tổng doanh thu dịch vụ {scope}</span>
        {/* A sum of money never breaks between its digits and its "₫". */}
        <span
          className="ml-3 shrink-0 whitespace-nowrap text-base font-semibold tabular-nums text-slate-900"
          data-testid="service-grand-total"
        >
          {formatVnd(grand)}
        </span>
      </div>
    </section>
  );
}
