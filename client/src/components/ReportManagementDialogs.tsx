/**
 * "LỊCH SỬ CHỈNH SỬA" and "NHẬP BÙ" — two supervision dialogs of "Báo cáo vấn đề".
 *
 * Lịch sử chỉnh sửa: two separate sections over the reader's records (the
 * server scopes them: Reception its branch, a supervisor its branches):
 *   * Lịch sử chỉnh sửa — every audited correction: which record, who (in what
 *     role), when, and each changed field old → new. Only what was audited is
 *     shown; a record corrected before auditing simply has no entry.
 *   * Lịch sử xóa — the deleted records: who created each, on which business
 *     date and shift, and who deleted it, in what role, when and why.
 * A deletion is never counted or labelled as an edit, nor an edit as a deletion.
 *
 * Nhập bù: a record the receptionist missed, entered by a manager on the
 * ORIGINAL shift. The manager picks a finished shift (which names the
 * receptionist who worked it — nobody else can be chosen), a category and the
 * required reason, then fills Reception's own form for that category; the
 * server files it on that shift and date, for that receptionist, and stamps the
 * manager as "Người nhập bù". When the whole shift was never checked in to,
 * "Thêm ca" adds it first (historically, closed, never a live shift).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, History, PencilLine, Trash2 } from 'lucide-react';
import {
  reportsApi,
  type LateEntrySession,
  type NewReportInput,
  type OperationalReport,
  type ReportCategory,
  type ReportEditEvent,
  type ReportOptions,
} from '../api/receptionReports';
import { shiftsApi, type ShiftType } from '../api/shifts';
import { ApiError, toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/capabilities';
import { branchLabel, type Branch } from '../auth/types';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ErrorAlert } from './ErrorAlert';
import { LateEntryBadge } from './LateEntry';
import { Modal } from './Modal';
import { QueryState } from './PageState';
import { NewPaymentForm } from './PaymentLedger';
import { DeliveryForm, GuestRequestForm, RoomServiceForm, ServiceQualityForm } from './OperationalForms';
import { NewIssueModal } from './IncidentReporting';
import { CATEGORY_MARKERS, CATEGORY_ORDER, PAYMENT_SOURCE_FALLBACK } from '../lib/reportCategories';
import { ReportSubmitContext, type ReportSubmit } from '../lib/reportSubmit';
import { formatDateTime, hcmToday } from '../lib/format';
import { SHIFT_OPTIONS_KEY } from '../hooks/useShiftSession';

const FIELD =
  'min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-800 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const STEP = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600';

/** "07/10/2026" from "2026-10-07". */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/* ------------------------------------------------------------------ *
 * Lịch sử chỉnh sửa (edits + deletions)
 * ------------------------------------------------------------------ */

/**
 * The fields a correction can change, as the forms name them. Unknown names
 * (a field added later) show as recorded rather than being hidden.
 */
const FIELD_LABELS: Record<string, string> = {
  amount: 'Tổng tiền thu',
  allocations: 'Phương thức thanh toán',
  method: 'Phương thức thanh toán',
  source: 'Nguồn',
  ezCode: 'Mã EZ',
  guestName: 'Tên khách',
  receivable: 'Công nợ',
  expense: 'Chi tiền',
  note: 'Nội dung / ghi chú',
  description: 'Nội dung',
  severity: 'Mức độ',
  roomClass: 'Hạng phòng',
  fromRoomClass: 'Từ hạng phòng',
  toRoomClass: 'Sang hạng phòng',
  nights: 'Số đêm',
  price: 'Giá',
  quantity: 'Số lượng',
  department: 'Bộ phận',
  tripadvisorCount: 'Tripadvisor',
  googleCount: 'Google',
  itemName: 'Hàng hóa',
  roomNumber: 'Số phòng',
};

const fieldLabel = (field: string | null): string => (field ? (FIELD_LABELS[field] ?? field) : '—');

/** The fields ONE save changed share its record, its actor and its instant. */
interface EditEvent {
  key: string;
  report: ReportEditEvent['report'];
  actorName: string;
  actorRoleLabel: string | null;
  createdAt: string;
  reason: string | null;
  changes: { id: string; field: string | null; oldValue: string | null; newValue: string | null }[];
}

function groupEdits(rows: ReportEditEvent[]): EditEvent[] {
  const events = new Map<string, EditEvent>();
  for (const r of rows) {
    const key = `${r.report.id}|${r.actor.id}|${r.createdAt}`;
    const event =
      events.get(key) ??
      ({
        key,
        report: r.report,
        actorName: r.actor.name,
        actorRoleLabel: r.actorRoleLabel ?? null,
        createdAt: r.createdAt,
        reason: r.reason,
        changes: [],
      } satisfies EditEvent);
    event.changes.push({ id: r.id, field: r.field, oldValue: r.oldValue, newValue: r.newValue });
    events.set(key, event);
  }
  return [...events.values()];
}

type HistoryTab = 'edits' | 'deleted';

export function ReportHistoryDialog({
  period,
  branchId,
  labelOf,
  initialTab = 'edits',
  initialCategory,
  onClose,
}: {
  /** The screen's business-date period; omitted, the newest entries. */
  period?: { from: string; to: string } | null;
  branchId?: number;
  labelOf: (c: ReportCategory) => string;
  initialTab?: HistoryTab;
  /** The screen's category, preselected (a payment page opens on payments). */
  initialCategory?: ReportCategory | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  // While the session is still loading both sections are offered; the server
  // refuses either one to a reader without the capability anyway.
  const mayEdits = !user || can(user.role, 'reports.editHistory');
  const mayDeleted = !user || can(user.role, 'reports.deletionHistory');
  const [chosenTab, setTab] = useState<HistoryTab>(initialTab);
  const tab: HistoryTab = chosenTab === 'edits' ? (mayEdits ? 'edits' : 'deleted') : mayDeleted ? 'deleted' : 'edits';
  const [category, setCategory] = useState<ReportCategory | ''>(initialCategory ?? '');
  const params = {
    ...(period ? period : {}),
    ...(branchId ? { branchId } : {}),
    ...(category ? { category } : {}),
  };

  const tabs: [HistoryTab, string, typeof PencilLine, boolean][] = [
    ['edits', 'Lịch sử chỉnh sửa', PencilLine, mayEdits],
    ['deleted', 'Lịch sử xóa', Trash2, mayDeleted],
  ];

  return (
    <Modal open size="4xl" title="Lịch sử chỉnh sửa" onClose={onClose}>
      <div className="space-y-3" data-testid="report-history">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Loại lịch sử"
            className="inline-flex overflow-hidden rounded-xl border border-line-strong bg-white"
          >
            {tabs
              .filter(([, , , allowed]) => allowed)
              .map(([key, text, Icon], i) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  data-testid={`history-tab-${key}`}
                  onClick={() => setTab(key)}
                  className={`inline-flex min-h-[2.5rem] items-center gap-1.5 px-3.5 text-sm transition-colors focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                    i > 0 ? 'border-l border-line-strong' : ''
                  } ${tab === key ? 'bg-brand-50 font-semibold text-brand-700' : 'font-medium text-slate-600 hover:bg-slate-50'}`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {text}
                </button>
              ))}
          </div>
          <select
            aria-label="Danh mục"
            data-testid="history-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as ReportCategory | '')}
            className={`${FIELD} sm:w-64`}
          >
            <option value="">Tất cả danh mục</option>
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {labelOf(c)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-sm text-slate-600">
          {tab === 'edits' ? 'Các lần sửa bản ghi' : 'Các bản ghi đã xóa'}
          {period ? ` thuộc ngày ${dayLabel(period.from)}${period.to !== period.from ? ` – ${dayLabel(period.to)}` : ''}` : ''}.{' '}
          {tab === 'edits'
            ? 'Mỗi dòng là một lần lưu: người sửa, thời điểm và từng trường thay đổi (trước → sau).'
            : 'Bản ghi không còn được tính vào danh sách và tổng tiền; người tạo, ca và ngày gốc được giữ nguyên.'}
        </p>
        {tab === 'edits' ? (
          <EditHistorySection params={params} labelOf={labelOf} />
        ) : (
          <DeletedHistorySection params={params} labelOf={labelOf} />
        )}
        <div className="flex justify-end border-t border-line-subtle pt-3">
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type HistoryParams = { from?: string; to?: string; branchId?: number; category?: ReportCategory };

function EditHistorySection({ params, labelOf }: { params: HistoryParams; labelOf: (c: ReportCategory) => string }) {
  const list = useQuery({
    queryKey: ['reception', 'reports', 'edits', params],
    queryFn: () => reportsApi.edits(params),
  });
  const events = useMemo(() => groupEdits(list.data?.edits ?? []), [list.data]);
  return (
    <section data-testid="edit-history" aria-label="Lịch sử chỉnh sửa">
      <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error} onRetry={() => void list.refetch()}>
        {events.length === 0 ? (
          <EmptyState icon={<PencilLine className="h-6 w-6" aria-hidden="true" />} title="Không có lần chỉnh sửa nào" message="" />
        ) : (
          <ul className="divide-y divide-line-subtle rounded-xl border border-line">
            {events.map((e) => (
              <EditRow key={e.key} event={e} label={labelOf(e.report.category)} />
            ))}
          </ul>
        )}
        {list.data?.truncated ? (
          <p className="mt-2 text-xs text-amber-800" data-testid="edit-history-truncated">
            Chỉ hiển thị các lần sửa mới nhất. Thu hẹp khoảng ngày hoặc danh mục để xem đầy đủ.
          </p>
        ) : null}
      </QueryState>
    </section>
  );
}

function EditRow({ event: e, label }: { event: EditEvent; label: string }) {
  return (
    <li className="space-y-1 px-3 py-2.5 text-sm" data-testid={`edit-${e.report.id}-${e.changes[0]!.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{label}</span>
        {e.report.branch ? <span className="text-xs text-slate-500">CN {e.report.branch.branchNumber}</span> : null}
        <span className="text-xs text-slate-500">
          {dayLabel(e.report.shiftDate)}
          {e.report.shiftName ? ` · ${e.report.shiftName}` : ''}
        </span>
        {e.report.voided ? (
          <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700">Đã xóa sau đó</span>
        ) : null}
      </div>
      <p className="break-words text-slate-800">{e.report.summary}</p>
      <p className="text-xs text-slate-500">
        Người tạo: <span className="font-medium text-slate-700">{e.report.createdByName}</span>
        {e.report.lateEntry ? <LateEntryBadge lateEntry={e.report.lateEntry} forName={e.report.createdByName} /> : null}
      </p>
      <ul className="space-y-0.5 rounded-lg bg-slate-50 px-2.5 py-1.5">
        {e.changes.map((c) => (
          <li key={c.id} className="text-xs text-slate-700" data-testid={`edit-change-${c.id}`}>
            <span className="font-semibold">{fieldLabel(c.field)}</span>: <span className="text-slate-500">{c.oldValue ?? '—'}</span>{' '}
            → <span className="font-medium text-slate-900">{c.newValue ?? '—'}</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-center gap-x-1 text-xs text-slate-600">
        <PencilLine className="h-3 w-3" aria-hidden="true" />
        Sửa bởi <span className="font-semibold">{e.actorName}</span>
        {e.actorRoleLabel ? ` (${e.actorRoleLabel})` : ''} lúc {formatDateTime(e.createdAt)}
        {e.reason ? ` — ${e.reason}` : ''}
      </p>
    </li>
  );
}

function DeletedHistorySection({ params, labelOf }: { params: HistoryParams; labelOf: (c: ReportCategory) => string }) {
  const list = useQuery({
    queryKey: ['reception', 'reports', 'deleted', params],
    queryFn: () => reportsApi.deleted(params),
  });
  const rows = list.data?.reports ?? [];
  return (
    <section data-testid="deleted-history" aria-label="Lịch sử xóa">
      <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error} onRetry={() => void list.refetch()}>
        {rows.length === 0 ? (
          <EmptyState icon={<History className="h-6 w-6" aria-hidden="true" />} title="Không có bản ghi đã xóa" message="" />
        ) : (
          <ul className="divide-y divide-line-subtle rounded-xl border border-line">
            {rows.map((r) => (
              <DeletedRow key={r.id} report={r} label={labelOf(r.category)} />
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}

function DeletedRow({ report: r, label }: { report: OperationalReport; label: string }) {
  return (
    <li className="space-y-1 px-3 py-2.5 text-sm" data-testid={`deleted-${r.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{label}</span>
        {r.branch ? <span className="text-xs text-slate-500">CN {r.branch.branchNumber}</span> : null}
        <span className="text-xs text-slate-500">
          {dayLabel(r.shiftDate)}
          {r.shiftName ? ` · ${r.shiftName}` : ''}
        </span>
      </div>
      <p className="break-words text-slate-800">{r.summary}</p>
      <p className="text-xs text-slate-500">
        Người tạo: <span className="font-medium text-slate-700">{r.createdByName}</span>
        {r.lateEntry ? <LateEntryBadge lateEntry={r.lateEntry} forName={r.createdByName} /> : null}
      </p>
      <p className="flex flex-wrap items-center gap-x-1 text-xs text-rose-700">
        <Trash2 className="h-3 w-3" aria-hidden="true" />
        Xóa bởi <span className="font-semibold">{r.voidedByName ?? '—'}</span>
        {r.voidedByRoleLabel ? ` (${r.voidedByRoleLabel})` : ''}
        {r.voidedAt ? ` lúc ${formatDateTime(r.voidedAt)}` : ''} — {r.voidReason}
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Nhập bù
 * ------------------------------------------------------------------ */

/**
 * Every category a receptionist reports. A facility incident goes through the
 * incident form itself (validation, duplicate warning, photo), filed on the
 * original shift together with its journal entry.
 */
const LATE_CATEGORIES = CATEGORY_ORDER;

export function LateEntryDialog({
  branches,
  options,
  initialBranchId,
  labelOf,
  onClose,
  onCreated,
}: {
  /** The reader's branches — from the server's scope. */
  branches: Branch[];
  options?: ReportOptions;
  initialBranchId?: number | null;
  labelOf: (c: ReportCategory) => string;
  onClose: () => void;
  onCreated: (message: string) => void | Promise<void>;
}) {
  const today = hcmToday();
  const { user } = useAuth();
  const [branchId, setBranchId] = useState<number | null>(
    initialBranchId && branches.some((b) => b.id === initialBranchId) ? initialBranchId : null,
  );
  const [date, setDate] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [reason, setReason] = useState('');
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [addingShift, setAddingShift] = useState(false);
  const branch = branches.find((b) => b.id === branchId) ?? null;
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today;

  const sessions = useQuery({
    queryKey: ['reception', 'reports', 'late-entry-sessions', branchId, date],
    queryFn: () => reportsApi.lateEntrySessions(branchId!, date),
    enabled: branchId !== null && dateValid,
  });
  const chosen = sessions.data?.sessions.find((s) => s.id === sessionId) ?? null;

  // The SAME category forms, submitted to "Nhập bù" with the shift and the reason.
  const submit = useMemo<ReportSubmit>(
    () => (input: NewReportInput) => {
      if (!sessionId) return Promise.reject(new ApiError('VALIDATION_ERROR', 'Vui lòng chọn ca.', 422));
      if (!reason.trim()) return Promise.reject(new ApiError('VALIDATION_ERROR', 'Vui lòng nhập lý do nhập bù.', 422));
      return reportsApi.lateEntry({ ...input, shiftSessionId: sessionId, reason: reason.trim() });
    },
    [sessionId, reason],
  );
  const done = async () => {
    await onCreated(
      `Đã nhập bù cho ${chosen?.receptionist.name ?? 'lễ tân'} — ${chosen ? `${chosen.shiftName}, ${dayLabel(chosen.businessDate)}` : ''}.`,
    );
  };

  return (
    <Modal open size="4xl" title="Nhập bù báo cáo" onClose={onClose}>
      <div className="space-y-4" data-testid="late-entry">
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Ghi lại bản ghi lễ tân đã quên nhập. Bản ghi được tính vào đúng ngày và ca gốc, đứng tên lễ tân của ca đó; tên
          bạn (người nhập bù), thời điểm nhập và nội dung bổ sung được lưu kèm và hiển thị nhãn “NHẬP BÙ”.
        </p>

        <section>
          <h3 className={STEP}>1. Chi nhánh</h3>
          <select
            aria-label="Chi nhánh"
            data-testid="late-branch"
            value={branchId ?? ''}
            onChange={(e) => {
              setBranchId(e.target.value === '' ? null : Number(e.target.value));
              setSessionId(null);
              setCategory(null);
              setAddingShift(false);
            }}
            className={FIELD}
          >
            <option value="">— Chọn một chi nhánh cụ thể —</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchLabel(b)}
              </option>
            ))}
          </select>
        </section>

        {branch ? (
          <section>
            <h3 className={STEP}>2. Ngày làm việc của ca</h3>
            <input
              type="date"
              aria-label="Ngày làm việc"
              data-testid="late-date"
              max={today}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setSessionId(null);
                setCategory(null);
                setAddingShift(false);
              }}
              className={`${FIELD} sm:w-60`}
            />
            {date && !dateValid ? <p className="mt-1 text-xs text-rose-700">Chọn một ngày không sau hôm nay.</p> : null}
          </section>
        ) : null}

        {branch && dateValid ? (
          <section>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className={`${STEP} !mb-0`}>3. Ca và lễ tân</h3>
              {!addingShift ? (
                <Button
                  variant="secondary"
                  onClick={() => setAddingShift(true)}
                  data-testid="late-add-shift"
                  className="!px-3 !py-1.5"
                >
                  <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                  Thêm ca
                </Button>
              ) : null}
            </div>
            <QueryState isLoading={sessions.isLoading} isError={sessions.isError} error={sessions.error} onRetry={() => void sessions.refetch()}>
              {(sessions.data?.sessions ?? []).length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="late-no-session">
                  Không có ca đã kết thúc vào ngày này tại chi nhánh. Nếu lễ tân quên vào ca, bấm “Thêm ca”.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Ca">
                  {sessions.data!.sessions.map((s) => (
                    <label
                      key={s.id}
                      className={`flex min-h-[2.75rem] cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                        sessionId === s.id ? 'border-brand-600 bg-brand-50 font-semibold text-brand-800' : 'border-line bg-white text-slate-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="late-session"
                        checked={sessionId === s.id}
                        onChange={() => setSessionId(s.id)}
                        data-testid={`late-session-${s.id}`}
                      />
                      <span>
                        {s.shiftName} <span className="text-xs font-normal text-slate-500">({s.shiftWindow})</span>
                        {s.backfill ? (
                          <span
                            data-testid={`late-session-backfill-${s.id}`}
                            title={`Thêm bởi ${s.backfill.backfilledByName} lúc ${formatDateTime(s.backfill.backfilledAt)}${s.backfill.reason ? ` — ${s.backfill.reason}` : ''}`}
                            className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] font-bold uppercase text-amber-900"
                          >
                            Ca thêm bù
                          </span>
                        ) : null}
                        <span className="block text-xs font-normal text-slate-600">Lễ tân: {s.receptionist.name}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </QueryState>
            {addingShift ? (
              <AddShiftForm
                branchId={branch.id}
                date={date}
                onCancel={() => setAddingShift(false)}
                onAdded={(session) => {
                  setAddingShift(false);
                  setSessionId(session.id);
                  setCategory(null);
                }}
              />
            ) : null}
          </section>
        ) : null}

        {chosen ? (
          <>
            <section>
              <h3 className={STEP}>4. Danh mục</h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Danh mục">
                {LATE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={category === c}
                    data-testid={`late-category-${c}`}
                    onClick={() => setCategory(c)}
                    className={`flex min-h-[2.75rem] items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                      category === c ? 'border-brand-600 bg-brand-50 font-semibold text-brand-800' : 'border-line bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="inline-flex h-6 min-w-[1.75rem] items-center justify-center rounded-md bg-slate-100 px-1 text-xs font-bold text-slate-600">
                      {CATEGORY_MARKERS[c]}
                    </span>
                    {labelOf(c)}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3 className={STEP}>5. Nội dung lễ tân đã quên nhập / lý do nhập bù (bắt buộc)</h3>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={1000}
                aria-label="Lý do nhập bù"
                data-testid="late-reason"
                placeholder="Ví dụ: Lễ tân quên ghi khoản thu của khách phòng 302"
                className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              />
            </section>

            {category && reason.trim() ? (
              <section className="border-t-rule border-line-subtle pt-3">
                {/* The confirmation summary: who is entering it, for whom, and where it will count. */}
                <dl
                  data-testid="late-summary"
                  className="mb-3 grid gap-x-6 gap-y-1 rounded-xl border border-amber-300 bg-amber-50/70 px-3 py-2 text-sm text-amber-950 sm:grid-cols-2"
                >
                  <div>
                    <dt className="inline text-amber-800">Người nhập bù: </dt>
                    <dd className="inline font-semibold">{user?.fullName ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="inline text-amber-800">Nhập bù cho: </dt>
                    <dd className="inline font-semibold">{chosen.receptionist.name}</dd>
                  </div>
                  <div>
                    <dt className="inline text-amber-800">Ca gốc: </dt>
                    <dd className="inline">
                      {chosen.shiftName}, {dayLabel(chosen.businessDate)} · {branchLabel(branch!)}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-amber-800">Mục bổ sung: </dt>
                    <dd className="inline">{labelOf(category)}</dd>
                  </div>
                </dl>
                <h3 className={STEP}>
                  6. {labelOf(category)} — {chosen.shiftName}, {dayLabel(chosen.businessDate)}, lễ tân {chosen.receptionist.name}
                </h3>
                <ReportSubmitContext.Provider value={submit}>
                  {category === 'PAYMENT' ? (
                    <NewPaymentForm
                      bare
                      methods={options?.paymentMethods}
                      sources={options?.paymentSources ?? PAYMENT_SOURCE_FALLBACK}
                      onCancel={onClose}
                      onCreated={done}
                    />
                  ) : category === 'GUEST_REQUEST' ? (
                    <GuestRequestForm bare onCancel={onClose} onCreated={done} />
                  ) : category === 'CUSTOMER_COMPLAINT' ? (
                    <ServiceQualityForm bare onCancel={onClose} onCreated={done} />
                  ) : category === 'ROOM_SERVICE' ? (
                    <RoomServiceForm bare options={options} onCancel={onClose} onCreated={done} />
                  ) : category === 'HOTEL_DELIVERY' ? (
                    <DeliveryForm bare options={options} onCancel={onClose} onCreated={done} />
                  ) : category === 'FACILITY_ISSUE' ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
                      <p className="text-sm text-slate-600">
                        Sự cố được tạo bằng biểu mẫu báo cáo sự cố (kiểm tra trùng lặp như thường lệ) và ghi vào nhật ký ca gốc.
                      </p>
                      <Button onClick={() => setIncidentOpen(true)} data-testid="late-facility-open">
                        Mở biểu mẫu sự cố
                      </Button>
                    </div>
                  ) : null}
                </ReportSubmitContext.Provider>
              </section>
            ) : category ? (
              <p className="text-sm text-slate-500" data-testid="late-reason-first">
                Nhập lý do nhập bù để mở biểu mẫu.
              </p>
            ) : null}
          </>
        ) : null}

        {!category || !reason.trim() ? (
          <div className="flex justify-end border-t border-line-subtle pt-3">
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
          </div>
        ) : null}
        {sessions.isError ? <ErrorAlert>{toUserMessage(sessions.error)}</ErrorAlert> : null}
      </div>
      {incidentOpen && chosen && branch && category === 'FACILITY_ISSUE' && reason.trim() ? (
        <NewIssueModal
          branchId={branch.id}
          branchLabel={`${branchLabel(branch)} — nhập bù ${chosen.shiftName}, ${dayLabel(chosen.businessDate)}`}
          lateEntry={{ shiftSessionId: chosen.id, reason: reason.trim() }}
          onClose={() => setIncidentOpen(false)}
          onCreated={() => void done()}
        />
      ) : null}
    </Modal>
  );
}

/**
 * "THÊM CA" — the shift the receptionist worked but never checked in to.
 *
 * Its window is the shift's own (from the server's shift definitions), on the
 * chosen business date; the receptionist is one of the branch's active Reception
 * accounts; the reason is required. The server refuses a shift still running,
 * one that already exists for that receptionist, or one overlapping theirs —
 * and when an equivalent shift exists it is selected instead of duplicated.
 */
function AddShiftForm({
  branchId,
  date,
  onCancel,
  onAdded,
}: {
  branchId: number;
  date: string;
  onCancel: () => void;
  onAdded: (session: LateEntrySession) => void;
}) {
  const queryClient = useQueryClient();
  const [shiftType, setShiftType] = useState<ShiftType | ''>('');
  const [receptionistId, setReceptionistId] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const shiftOptions = useQuery({ queryKey: SHIFT_OPTIONS_KEY, queryFn: () => shiftsApi.options(), staleTime: 60 * 60 * 1000 });
  const receptionists = useQuery({
    queryKey: ['reception', 'reports', 'late-entry-receptionists', branchId],
    queryFn: () => reportsApi.lateEntryReceptionists(branchId),
  });
  const sessionsKey = ['reception', 'reports', 'late-entry-sessions', branchId, date];
  const add = useMutation({
    mutationFn: () =>
      reportsApi.addLateEntrySession({
        branchId,
        date,
        shiftType: shiftType as ShiftType,
        receptionistUserId: receptionistId as number,
        reason: reason.trim(),
      }),
    onSuccess: async ({ session }) => {
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
      onAdded(session);
    },
    onError: async (error) => {
      // An equivalent shift already exists: use it rather than adding a second one.
      const existing =
        error instanceof ApiError && error.status === 409
          ? (error.details as { shiftSessionId?: string } | undefined)?.shiftSessionId
          : undefined;
      if (existing) {
        const fresh = await queryClient.fetchQuery({
          queryKey: sessionsKey,
          queryFn: () => reportsApi.lateEntrySessions(branchId, date),
        });
        const found = fresh.sessions.find((s) => s.id === existing);
        if (found) onAdded(found);
      }
    },
  });
  const def = shiftOptions.data?.shifts.find((s) => s.code === shiftType) ?? null;
  const ready = shiftType !== '' && receptionistId !== '' && reason.trim() !== '';

  return (
    <div data-testid="late-add-shift-form" className="mt-3 space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 px-3 py-3">
      <p className="text-sm font-semibold text-slate-800">Thêm ca lễ tân đã quên vào — {dayLabel(date)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Ca
          <select
            className={`${FIELD} mt-1`}
            value={shiftType}
            data-testid="late-add-shift-type"
            onChange={(e) => setShiftType(e.target.value as ShiftType | '')}
          >
            <option value="">— Chọn ca —</option>
            {(shiftOptions.data?.shifts ?? []).map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.startLocalTime} – {s.endLocalTime})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Lễ tân của ca
          <select
            className={`${FIELD} mt-1`}
            value={receptionistId}
            data-testid="late-add-shift-receptionist"
            disabled={receptionists.isLoading}
            onChange={(e) => setReceptionistId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">— Chọn lễ tân —</option>
            {(receptionists.data?.receptionists ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {def ? (
        <p className="text-xs text-slate-600" data-testid="late-add-shift-window">
          Ca được ghi nhận từ {def.startLocalTime} ngày {dayLabel(date)} đến {def.endLocalTime}
          {def.crossesMidnight ? ' ngày hôm sau' : ''} (giờ Việt Nam), đã kết thúc — không mở ca mới và không thay đổi lịch làm việc.
        </p>
      ) : null}
      <label className="block text-sm font-medium text-slate-700">
        Lý do thêm ca (bắt buộc)
        <textarea
          className="mt-1 w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ví dụ: Lễ tân làm ca A nhưng quên vào ca trên hệ thống"
          data-testid="late-add-shift-reason"
        />
      </label>
      {receptionists.data && receptionists.data.receptionists.length === 0 ? (
        <p className="text-xs text-rose-700">Chi nhánh này chưa có tài khoản lễ tân đang hoạt động.</p>
      ) : null}
      {add.isError ? <ErrorAlert>{toUserMessage(add.error)}</ErrorAlert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Hủy
        </Button>
        <Button onClick={() => add.mutate()} disabled={!ready} loading={add.isPending} data-testid="late-add-shift-submit">
          Thêm ca
        </Button>
      </div>
    </div>
  );
}
