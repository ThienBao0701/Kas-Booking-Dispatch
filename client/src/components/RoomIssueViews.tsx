/**
 * THE PIECES OF "BUỒNG PHÒNG" THAT THREE ROLES ALL RENDER.
 *
 * Bộ phận buồng phòng's history, Reception's collection screen and the Admin's
 * report are three views of the SAME issue rows, so the table, the status badge
 * and the collection dialog live here once. What differs per role is only which
 * columns and actions are switched on — never a second copy of a row.
 *
 * THE MONEY RULES ARE THE SERVER'S (and the database's): "Đã thu" needs a method,
 * "Không thu được" needs a reason. The dialog mirrors them so the operator is told
 * before the round trip, but the server refuses whatever this lets through.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleDollarSign, History, Trash2 } from 'lucide-react';
import {
  ROOM_COLLECTION_METHODS,
  ROOM_COLLECTION_STATUSES,
  ROOM_ISSUES_KEY,
  housekeepingApi,
  type RoomCollectionMethod,
  type RoomCollectionStatus,
  type RoomIssue,
  type RoomIssueSummary,
} from '../api/housekeeping';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';
import { branchOptionLabel } from '../lib/branchTone';
import { formatDateTime } from '../lib/format';
import { formatVnd, groupDigits, parseVnd } from '../lib/money';

const STATUS_TONE: Record<RoomCollectionStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  COLLECTED: 'bg-emerald-50 text-emerald-700',
  UNCOLLECTIBLE: 'bg-slate-100 text-slate-600',
};

export function CollectionStatusBadge({ status, label }: { status: RoomCollectionStatus; label: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {label}
    </span>
  );
}

/** What the money column says: the status, and beneath it the amount and how or why. */
function CollectionCell({ issue }: { issue: RoomIssue }) {
  const c = issue.collection;
  // Housekeeping is sent no collection state at all.
  if (issue.collectionStatus === null) return null;
  return (
    <>
      <CollectionStatusBadge status={issue.collectionStatus} label={issue.collectionStatusLabel ?? ''} />
      {c ? (
        <span className="mt-0.5 block text-xs text-slate-600">
          {formatVnd(c.amount)}
          {c.methodLabel ? ` · ${c.methodLabel}` : ''}
          {c.reason ? <span className="block text-slate-500">Lý do: {c.reason}</span> : null}
        </span>
      ) : null}
    </>
  );
}

export type RoomIssueMode = 'housekeeping' | 'reception' | 'admin';

export function RoomIssueTable({
  issues,
  mode,
  title,
  testId = 'room-issue-table',
  isLoading,
  isError,
  error,
  onRetry,
  onCollect,
  onVoid,
  emptyTitle = 'Chưa có vấn đề phòng nào',
  emptyMessage = 'Các vấn đề Bộ phận buồng phòng ghi nhận sẽ hiện ở đây.',
}: {
  issues: RoomIssue[];
  mode: RoomIssueMode;
  title: string;
  testId?: string;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Reception and the Admin settle an issue; Bộ phận buồng phòng only reads. */
  onCollect?: (issue: RoomIssue) => void;
  /** Admin only. */
  onVoid?: (issue: RoomIssue) => void;
  emptyTitle?: string;
  emptyMessage?: string;
}) {
  const columns: DataColumn<RoomIssue>[] = [
    {
      key: 'at',
      header: 'Thời gian',
      className: 'whitespace-nowrap text-slate-500',
      render: (i) => formatDateTime(i.createdAt),
    },
    ...(mode === 'admin'
      ? [
          {
            key: 'branch',
            header: 'Chi nhánh',
            className: 'min-w-[8rem] text-slate-700',
            render: (i: RoomIssue) => branchOptionLabel(i.branch),
          } satisfies DataColumn<RoomIssue>,
        ]
      : []),
    {
      key: 'room',
      header: 'Phòng',
      className: 'whitespace-nowrap font-semibold text-slate-900',
      render: (i) => i.roomNumber,
    },
    {
      key: 'staff',
      header: 'Người dọn phòng',
      secondary: true,
      className: 'whitespace-nowrap',
      render: (i) => i.staffName,
    },
    {
      key: 'issue',
      header: 'Tình trạng',
      className: 'min-w-[10rem] max-w-xs',
      render: (i) => (
        <>
          <span className={`font-medium ${i.voided ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{i.typeLabel}</span>
          {i.note ? <span className="block whitespace-pre-wrap break-words text-xs text-slate-500">{i.note}</span> : null}
          {i.voided ? (
            <span className="mt-0.5 block text-xs font-medium text-rose-600">
              Đã hủy: {i.voidReason} ({i.voidedByName})
            </span>
          ) : null}
        </>
      ),
    },
    /*
      NO COLLECTION COLUMN FOR HOUSEKEEPING. "Đã thu / Chưa thu / Không thu được",
      the amount and the method are the front desk's business; Bộ phận buồng
      phòng records the room's condition, and the server sends it none of this.
    */
    ...(mode === 'housekeeping'
      ? []
      : [
          {
            key: 'collection',
            header: 'Thu tiền',
            className: 'min-w-[8rem]',
            render: (i: RoomIssue) => <CollectionCell issue={i} />,
          } satisfies DataColumn<RoomIssue>,
        ]),
  ];

  const actionable = (mode === 'reception' || mode === 'admin') && onCollect;
  return (
    <DataTable
      testId={testId}
      title={title}
      badge={issues.length}
      columns={columns}
      rows={issues}
      rowKey={(i) => i.id}
      rowClassName={(i) => (i.voided ? 'bg-slate-50 text-slate-400' : '')}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={onRetry}
      emptyTitle={emptyTitle}
      emptyMessage={emptyMessage}
      actions={
        actionable
          ? (i) =>
              i.voided ? (
                <span className="text-xs text-slate-300">—</span>
              ) : (
                <>
                  <RowAction onClick={() => onCollect(i)} testId={`collect-${i.id}`}>
                    <CircleDollarSign className="h-3 w-3" aria-hidden="true" />
                    {i.collection ? 'Cập nhật' : 'Thu tiền'}
                  </RowAction>
                  {mode === 'admin' && onVoid ? (
                    <RowAction onClick={() => onVoid(i)} tone="danger" testId={`void-room-${i.id}`}>
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      Hủy
                    </RowAction>
                  ) : null}
                </>
              )
          : undefined
      }
      renderDetail={mode === 'housekeeping' ? undefined : (i) => <CollectionHistory issue={i} />}
      detailToggle="always"
    />
  );
}

/** Every save of the issue's collection, oldest first — the trail behind the current state. */
function CollectionHistory({ issue }: { issue: RoomIssue }) {
  if (issue.history.length === 0) {
    return <p className="text-sm text-slate-400">Chưa có cập nhật thu tiền nào.</p>;
  }
  return (
    <div data-testid={`room-history-${issue.id}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        Lịch sử thu tiền
      </p>
      <ul className="mt-1 space-y-1">
        {issue.history.map((h) => (
          <li key={h.id} className="text-xs text-slate-600">
            <span className="font-medium">{h.statusLabel}</span> · {formatVnd(h.amount)}
            {h.methodLabel ? ` · ${h.methodLabel}` : ''}
            {h.reason ? ` · Lý do: ${h.reason}` : ''}
            {h.note ? ` · ${h.note}` : ''} · {h.actorName} · {formatDateTime(h.createdAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Cập nhật thu tiền" for ONE issue.
 *
 * Amount, status, and — depending on the status — the method or the reason. The
 * fields that do not apply are not rendered at all rather than disabled, so a
 * value typed under one status cannot be submitted invisibly under another.
 */
export function CollectionDialog({
  issue,
  onClose,
  onSaved,
}: {
  issue: RoomIssue;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const current = issue.collection;
  const [status, setStatus] = useState<RoomCollectionStatus>(current?.status ?? 'COLLECTED');
  const [amount, setAmount] = useState(current ? groupDigits(String(current.amount)) : '');
  const [method, setMethod] = useState<RoomCollectionMethod | ''>(current?.method ?? '');
  const [reason, setReason] = useState(current?.reason ?? '');
  const [note, setNote] = useState(current?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const parsed = parseVnd(amount);
  const ready =
    parsed !== null &&
    (status !== 'COLLECTED' || (method !== '' && parsed > 0)) &&
    (status !== 'UNCOLLECTIBLE' || reason.trim().length > 0);

  const save = useMutation({
    mutationFn: () =>
      housekeepingApi.saveCollection(issue.id, {
        status,
        amount: parsed ?? 0,
        method: status === 'COLLECTED' && method !== '' ? method : undefined,
        reason: status === 'UNCOLLECTIBLE' ? reason.trim() : undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ROOM_ISSUES_KEY });
      onSaved('Đã cập nhật thu tiền.');
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  return (
    <Modal
      open
      title={`Thu tiền — Phòng ${issue.roomNumber} · ${issue.typeLabel}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="collection-save">
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Khoản thu này tách riêng khỏi sổ thanh toán và không làm thay đổi tiền mặt trong ca.
        </p>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">Trạng thái thu tiền</legend>
          <div className="flex flex-wrap gap-2">
            {ROOM_COLLECTION_STATUSES.map((s) => (
              <label
                key={s.code}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  status === s.code ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-300 text-slate-600'
                }`}
              >
                <input
                  type="radio"
                  name="collection-status"
                  value={s.code}
                  checked={status === s.code}
                  onChange={() => setStatus(s.code)}
                  data-testid={`collection-status-${s.code}`}
                  className="accent-brand-600"
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>

        <MoneyInput
          label="Số tiền"
          required
          value={amount}
          onChange={setAmount}
          data-testid="collection-amount"
        />

        {status === 'COLLECTED' ? (
          <label className="block space-y-1.5 text-sm font-medium text-slate-700">
            Hình thức thu tiền
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as RoomCollectionMethod | '')}
              data-testid="collection-method"
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
            >
              <option value="">— Chọn hình thức —</option>
              {ROOM_COLLECTION_METHODS.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {status === 'UNCOLLECTIBLE' ? (
          <label className="block space-y-1.5 text-sm font-medium text-slate-700">
            Lý do không thu được <span className="text-red-600">*</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={1000}
              data-testid="collection-reason"
              className="block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </label>
        ) : null}

        <label className="block space-y-1.5 text-sm font-medium text-slate-700">
          Ghi chú (không bắt buộc)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            data-testid="collection-note"
            className="block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
          />
        </label>

        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** Admin only: withdraw a mistaken issue. It stays on file, with the reason. */
export function VoidRoomIssueDialog({
  issue,
  onClose,
  onVoided,
}: {
  issue: RoomIssue;
  onClose: () => void;
  onVoided: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => housekeepingApi.voidIssue(issue.id, reason.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_ISSUES_KEY });
      onVoided('Đã hủy vấn đề phòng. Dữ liệu vẫn được lưu lại.');
    },
    onError: (e) => setError(toUserMessage(e)),
  });
  return (
    <Modal
      open
      title={`Hủy vấn đề — Phòng ${issue.roomNumber} · ${issue.typeLabel}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="danger" onClick={() => run.mutate()} disabled={reason.trim().length === 0} loading={run.isPending} data-testid="void-room-confirm">
            Xác nhận hủy
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Vấn đề sẽ không còn được tính vào tổng và không thể cập nhật thu tiền nữa, nhưng vẫn được lưu lại cùng lý
          do. Hệ thống không xóa dữ liệu.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          Lý do hủy
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            data-testid="void-room-reason"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </label>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * The totals over EVERY matching issue (the server's, not the page's) — counts by
 * status, and the money by how it was actually collected. Reception's and the
 * Admin's screens both open with it.
 */
export function RoomIssueSummaryStrip({ summary }: { summary: RoomIssueSummary }) {
  const cells: { label: string; value: string; tone?: string }[] = [
    { label: 'Tổng vấn đề', value: String(summary.total) },
    { label: 'Chưa thu', value: String(summary.byStatus.PENDING), tone: 'text-amber-700' },
    { label: 'Đã thu', value: String(summary.byStatus.COLLECTED), tone: 'text-emerald-700' },
    { label: 'Không thu được', value: String(summary.byStatus.UNCOLLECTIBLE) },
    { label: 'Tiền mặt', value: formatVnd(summary.collectedByMethod.CASH) },
    { label: 'Chuyển khoản', value: formatVnd(summary.collectedByMethod.TRANSFER) },
    { label: 'Cà thẻ', value: formatVnd(summary.collectedByMethod.CARD) },
    { label: 'Tổng đã thu', value: formatVnd(summary.collectedTotal), tone: 'text-emerald-700' },
  ];
  return (
    <div data-testid="room-issue-summary" className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="bg-white px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className={`mt-0.5 text-base font-semibold tabular-nums ${c.tone ?? 'text-slate-900'}`}>{c.value}</p>
          </div>
        ))}
      </div>
      <p className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
        Khoản thu buồng phòng tách riêng khỏi sổ thanh toán; không tính vào tiền mặt trong ca.
        {summary.pendingAmount > 0 ? ` Đã ghi nhận chờ thu: ${formatVnd(summary.pendingAmount)}.` : ''}
        {summary.uncollectibleAmount > 0 ? ` Không thu được: ${formatVnd(summary.uncollectibleAmount)}.` : ''}
      </p>
    </div>
  );
}
