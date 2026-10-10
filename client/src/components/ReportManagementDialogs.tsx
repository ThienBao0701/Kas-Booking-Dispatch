/**
 * "LỊCH SỬ XÓA" and "NHẬP BÙ" — two supervision dialogs of "Báo cáo vấn đề".
 *
 * Lịch sử xóa: the deleted records the reader may see (the server scopes them:
 * Reception its branch, a supervisor its branches) — who created each, on which
 * business date and shift, and who deleted it, in what role, when and why.
 *
 * Nhập bù: a record the receptionist missed, entered by a manager on the
 * ORIGINAL shift. The manager picks a finished shift (which names the
 * receptionist who worked it — nobody else can be chosen), a category and the
 * required reason, then fills Reception's own form for that category; the
 * server files it on that shift and date, for that receptionist.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Trash2 } from 'lucide-react';
import { reportsApi, type NewReportInput, type OperationalReport, type ReportCategory, type ReportOptions } from '../api/receptionReports';
import { ApiError, toUserMessage } from '../api/errors';
import { branchLabel, type Branch } from '../auth/types';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { QueryState } from './PageState';
import { NewPaymentForm } from './PaymentLedger';
import { DeliveryForm, GuestRequestForm, RoomServiceForm, ServiceQualityForm } from './OperationalForms';
import { NewIssueModal } from './IncidentReporting';
import { CATEGORY_MARKERS, CATEGORY_ORDER, PAYMENT_SOURCE_FALLBACK } from '../lib/reportCategories';
import { ReportSubmitContext, type ReportSubmit } from '../lib/reportSubmit';
import { formatDateTime, hcmToday } from '../lib/format';

const FIELD =
  'min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-800 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const STEP = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600';

/** "07/10/2026" from "2026-10-07". */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/* ------------------------------------------------------------------ *
 * Lịch sử xóa
 * ------------------------------------------------------------------ */

export function DeletedHistoryDialog({
  period,
  branchId,
  labelOf,
  onClose,
}: {
  /** The screen's business-date period; omitted, the newest deletions. */
  period?: { from: string; to: string } | null;
  branchId?: number;
  labelOf: (c: ReportCategory) => string;
  onClose: () => void;
}) {
  const params = { ...(period ? period : {}), ...(branchId ? { branchId } : {}) };
  const list = useQuery({
    queryKey: ['reception', 'reports', 'deleted', params],
    queryFn: () => reportsApi.deleted(params),
  });
  const rows = list.data?.reports ?? [];

  return (
    <Modal open size="4xl" title="Lịch sử xóa" onClose={onClose}>
      <div className="space-y-3" data-testid="deleted-history">
        <p className="text-sm text-slate-600">
          Các bản ghi đã xóa{period ? ` thuộc ngày ${dayLabel(period.from)}${period.to !== period.from ? ` – ${dayLabel(period.to)}` : ''}` : ''}.
          Bản ghi không còn được tính vào danh sách và tổng tiền; người tạo, ca và ngày gốc được giữ nguyên.
        </p>
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
        <div className="flex justify-end border-t border-line-subtle pt-3">
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
        </div>
      </div>
    </Modal>
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
        {r.lateEntry ? ` · Nhập bù bởi ${r.lateEntry.enteredBy.name}` : ''}
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
  const [branchId, setBranchId] = useState<number | null>(
    initialBranchId && branches.some((b) => b.id === initialBranchId) ? initialBranchId : null,
  );
  const [date, setDate] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [reason, setReason] = useState('');
  const [incidentOpen, setIncidentOpen] = useState(false);
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
          bạn, thời điểm nhập và lý do được lưu kèm.
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
              }}
              className={`${FIELD} sm:w-60`}
            />
            {date && !dateValid ? <p className="mt-1 text-xs text-rose-700">Chọn một ngày không sau hôm nay.</p> : null}
          </section>
        ) : null}

        {branch && dateValid ? (
          <section>
            <h3 className={STEP}>3. Ca và lễ tân</h3>
            <QueryState isLoading={sessions.isLoading} isError={sessions.isError} error={sessions.error} onRetry={() => void sessions.refetch()}>
              {(sessions.data?.sessions ?? []).length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="late-no-session">
                  Không có ca đã kết thúc vào ngày này tại chi nhánh.
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
                        <span className="block text-xs font-normal text-slate-600">Lễ tân: {s.receptionist.name}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </QueryState>
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
              <h3 className={STEP}>5. Lý do nhập bù (bắt buộc)</h3>
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
