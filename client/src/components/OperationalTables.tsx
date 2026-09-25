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
import { CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import { type OperationalReport, type RoomServiceType } from '../api/receptionReports';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { ReportSection, type SectionFrame } from './ReportSection';
import {
  CompleteRecordDialog,
  RecordEditDialog,
  VoidDialog,
  VoidedNote,
  type EditField,
} from './RecordDialogs';
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
  /** The overview shows the same table under the category's own name. */
  title?: string;
  /** A one-line empty state, for a page that stacks several tables. */
  compact?: boolean;
  /** Drawn as one section of the reception overview. */
  section?: SectionFrame;
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

/* -------------- Vấn đề khách yêu cầu thực hiện (Request) -------------- */

const GUEST_REQUEST_EDIT: EditField[] = [
  { name: 'guestName', label: 'Tên khách', required: true },
  { name: 'ezCode', label: 'Mã EZ' },
  { name: 'note', label: 'Nội dung', kind: 'textarea', required: true },
];

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
        <p className="whitespace-pre-wrap break-words text-slate-700">{request.resolution || '—'}</p>
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
}: TableProps) {
  const { editing, setEditing, setVoiding, voidNode } = useRowActions(onChanged, onToast);
  const [completing, setCompleting] = useState<string | null>(null);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.guestRequest?.guestName ?? '—'}
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
      render: (r) => formatDateTime(r.createdAt),
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
        emptyTitle="Chưa có yêu cầu nào"
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
 * SEVEN COLUMNS: STT, Tên khách, Mã EZ, Mô tả, Trạng thái, Hướng xử lý (nếu
 * có), Thời gian. No room, no staff and no action column — the shift says who,
 * and completing a report is done in its status cell.
 *
 * The same table on the overview and on the category's own screen, so the two
 * cannot show different columns.
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
}: TableProps) {
  const [completing, setCompleting] = useState<string | null>(null);

  const columns: DataColumn<OperationalReport>[] = [
    stt(),
    {
      key: 'guest',
      header: 'Tên khách',
      className: 'min-w-[7rem] font-medium text-slate-800',
      render: (r) => (
        <>
          {r.complaint?.guestName ?? '—'}
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
    {
      key: 'resolution',
      header: 'Hướng xử lý (nếu có)',
      className: 'min-w-[8rem] max-w-xs',
      render: (r) =>
        r.complaint?.completed && r.complaint.resolution ? (
          <span className="whitespace-pre-wrap break-words text-slate-700">{r.complaint.resolution}</span>
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    when('createdAt', 'Thời gian', (r) => r.createdAt),
  ];

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
        emptyTitle="Chưa có ghi nhận nào"
        emptyMessage="Bản ghi sẽ hiện ngay tại đây sau khi bạn bấm Thêm."
      />
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

/** The correction fields for one service — the same rules the entry form renders. */
function roomServiceEditFields(type: RoomServiceType): EditField[] {
  const needs = roomServiceFields(type);
  return [
    { name: 'guestName', label: 'Tên khách', required: true },
    { name: 'ezCode', label: 'Mã EZ' },
    ...(needs.roomClass ? [{ name: 'roomClass', label: 'Hạng phòng', required: true } as EditField] : []),
    ...(needs.upgrade
      ? ([
          { name: 'fromRoomClass', label: 'Từ hạng phòng', required: true },
          { name: 'toRoomClass', label: 'Tới hạng phòng', required: true },
        ] as EditField[])
      : []),
    ...(needs.nights ? [{ name: 'nights', label: 'Số đêm', kind: 'integer', required: true } as EditField] : []),
    { name: 'price', label: 'Giá tiền', kind: 'money', required: true },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];
}

/**
 * ONE SERVICE'S TABLE, COLUMNS CHOSEN BY THE SERVICE.
 *
 *   Bán phòng    STT · Tên khách · Mã EZ · Hạng phòng · Số đêm · Giá tiền · Ghi chú · Thời gian
 *   Upgrade      STT · Tên khách · Mã EZ · Từ / Tới hạng phòng · Số đêm · Giá tiền · Ghi chú · Thời gian
 *   the rest     STT · Tên khách · Mã EZ · Giá tiền · Ghi chú · Thời gian
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
    {
      key: 'price',
      header: 'Giá tiền',
      align: 'right',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => formatVnd(r.roomService?.price ?? null),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      secondary: true,
      className: 'min-w-[8rem] max-w-xs',
      render: (r) => <span className="whitespace-pre-wrap break-words">{text(r.roomService?.note)}</span>,
    },
    {
      key: 'createdAt',
      header: 'Thời gian',
      className: 'whitespace-nowrap text-slate-500',
      render: (r) => formatDateTime(r.createdAt),
    },
  ];

  // Derived from the rows on screen — arithmetic on real records, not a metric.
  const live = rows.filter((r) => !r.voided);
  const revenue = live.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0);

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
            <p className="flex items-center justify-between text-sm" data-testid={`room-service-total-${serviceType}`}>
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
 * "DỊCH VỤ PHÒNG, KPI" ON THE OVERVIEW — two figures, and nothing else.
 *
 * TỔNG DOANH THU is arithmetic on this shift's own service rows (voided ones
 * excluded), the same sum the category's tables foot to.
 *
 * TỔNG ĐÁNH GIÁ (REVIEW) HAS NO SOURCE IN THIS SYSTEM, and it says so. Nothing
 * in KAS records a guest's review or rating — every "review" in the schema is
 * an Admin reviewing a booking — so the line reads "Chưa có dữ liệu" rather than
 * a number. A fabricated score would be worse than none: an operator cannot tell
 * an invented figure from a real one.
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
  const live = rows.filter((r) => !r.voided);
  const revenue = live.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0);
  const pending = isLoading || isError;

  return (
    <ReportSection testId="room-service-overview" marker={marker} title={title} count={rows.length}>
      <dl className="divide-y divide-slate-200 text-sm">
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
            className="shrink-0 text-right text-sm text-slate-500"
            data-testid="room-service-review"
            title="Hệ thống chưa có nguồn dữ liệu đánh giá của khách."
          >
            Chưa có dữ liệu
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
      revenue: mine.reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0),
    };
  });
  const grand = totals.reduce((sum, t) => sum + t.revenue, 0);

  return (
    <section data-testid="room-service-summary" className="rounded-xl border border-slate-200 bg-white">
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
