/**
 * Chứng từ — the list, its filters, and the create form.
 *
 * Filtering happens on the SERVER. Every control here sends a query and renders
 * what comes back; the browser never holds the whole table in order to hide
 * rows from itself.
 *
 * The card column shows "•••• 1234" and can show nothing else — the list
 * response has no field carrying a full number.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Search } from 'lucide-react';
import {
  CHARGE_STATUSES,
  CHARGE_STATUS_LABEL,
  CHARGE_STATUS_TONE,
  chargeDocumentsApi,
  type ChargeListFilters,
  type ChargeStatus,
} from '../api/chargeDocuments';
import { branchesApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { branchLabel } from '../auth/types';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageState';
import { formatDate, formatMoney } from '../lib/format';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium text-slate-600">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function StatusChip({ status }: { status: ChargeStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${CHARGE_STATUS_TONE[status]}`}
    >
      {CHARGE_STATUS_LABEL[status]}
    </span>
  );
}

const EMPTY_FORM = {
  branchId: '',
  guestName: '',
  bookingCode: '',
  amount: '',
  cardNumber: '',
  cardExpiry: '',
  checkIn: '',
  checkOut: '',
  reason: '',
};

export function ChargeDocumentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // What is typed, and what has been submitted. The query keys off the latter,
  // so typing does not fire a request per keystroke.
  const [draft, setDraft] = useState<ChargeListFilters>({});
  const [filters, setFilters] = useState<ChargeListFilters>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);

  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });

  const list = useQuery({
    queryKey: ['charge-documents', filters],
    queryFn: () => chargeDocumentsApi.list(filters),
  });

  const create = useMutation({
    mutationFn: () =>
      chargeDocumentsApi.create({
        branchId: Number(form.branchId),
        guestName: form.guestName,
        bookingCode: form.bookingCode,
        amount: Number(form.amount.replace(/[^\d]/g, '')),
        cardNumber: form.cardNumber,
        cardExpiry: form.cardExpiry,
        checkIn: form.checkIn,
        checkOut: form.checkOut,
        reason: form.reason,
      }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setForm({ ...EMPTY_FORM });
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['charge-documents'] });
      navigate(`/app/charge-documents/${res.document.id}`);
    },
    onError: (err) => setFormError(toUserMessage(err)),
  });

  /**
   * Client-side checks for the two fields the operator most often forgets.
   * The server validates everything again — this only saves a round trip.
   */
  function submitCreate() {
    if (!form.branchId) {
      setFormError('Vui lòng chọn chi nhánh.');
      return;
    }
    if (form.reason.trim().length === 0) {
      setFormError('Vui lòng nhập lý do charge.');
      return;
    }
    setFormError(null);
    create.mutate();
  }

  const documents = list.data?.documents ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chứng từ"
        description="Lưu và kiểm tra chứng từ charge của khách."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/app/charge-documents/report')}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              Báo cáo tháng
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Tạo chứng từ
            </Button>
          </>
        }
      />

      {/* Filters — every one of them applied by the server. */}
      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Chi nhánh">
            <select
              aria-label="Chi nhánh"
              className={inputClass}
              value={draft.branchId ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, branchId: e.target.value ? Number(e.target.value) : undefined })
              }
            >
              <option value="">— Tất cả chi nhánh —</option>
              {branches.data?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {branchLabel(b)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Trạng thái">
            <select
              aria-label="Trạng thái"
              className={inputClass}
              value={draft.status ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, status: (e.target.value || undefined) as ChargeStatus | undefined })
              }
            >
              <option value="">— Tất cả trạng thái —</option>
              {CHARGE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {CHARGE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Ngày charge từ">
            <input
              type="date"
              aria-label="Ngày charge từ"
              className={inputClass}
              value={draft.chargedFrom ?? ''}
              onChange={(e) => setDraft({ ...draft, chargedFrom: e.target.value || undefined })}
            />
          </Field>

          <Field label="Ngày charge đến">
            <input
              type="date"
              aria-label="Ngày charge đến"
              className={inputClass}
              value={draft.chargedTo ?? ''}
              onChange={(e) => setDraft({ ...draft, chargedTo: e.target.value || undefined })}
            />
          </Field>

          <Field label="Check-in từ">
            <input
              type="date"
              aria-label="Check-in từ"
              className={inputClass}
              value={draft.checkInFrom ?? ''}
              onChange={(e) => setDraft({ ...draft, checkInFrom: e.target.value || undefined })}
            />
          </Field>

          <Field label="Check-in đến">
            <input
              type="date"
              aria-label="Check-in đến"
              className={inputClass}
              value={draft.checkInTo ?? ''}
              onChange={(e) => setDraft({ ...draft, checkInTo: e.target.value || undefined })}
            />
          </Field>

          <Field label="Tên khách">
            <input
              aria-label="Tên khách"
              className={inputClass}
              value={draft.guestName ?? ''}
              placeholder="Tìm theo tên khách"
              onChange={(e) => setDraft({ ...draft, guestName: e.target.value || undefined })}
            />
          </Field>

          <Field label="Mã đặt phòng">
            <input
              aria-label="Mã đặt phòng"
              className={inputClass}
              value={draft.bookingCode ?? ''}
              placeholder="Tìm theo mã đặt phòng"
              onChange={(e) => setDraft({ ...draft, bookingCode: e.target.value || undefined })}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setFilters(draft)} loading={list.isFetching}>
            <Search className="h-4 w-4" aria-hidden="true" />
            Tìm kiếm
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft({});
              setFilters({});
            }}
          >
            Xoá bộ lọc
          </Button>
        </div>
      </Card>

      {list.isError ? <ErrorAlert>{toUserMessage(list.error)}</ErrorAlert> : null}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="charge-table">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Chi nhánh</th>
                <th className="px-4 py-3">Tên khách</th>
                <th className="px-4 py-3">Mã đặt phòng</th>
                <th className="px-4 py-3">Số tiền</th>
                <th className="px-4 py-3">Thẻ</th>
                <th className="px-4 py-3">Check-in</th>
                <th className="px-4 py-3">Check-out</th>
                <th className="px-4 py-3">Trạng thái</th>
                <th className="px-4 py-3">Ngày charge</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr
                  key={doc.id}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                  onClick={() => navigate(`/app/charge-documents/${doc.id}`)}
                >
                  <td className="px-4 py-3 text-slate-600">Chi nhánh {doc.branch.branchNumber}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{doc.guestName}</td>
                  <td className="px-4 py-3 font-mono text-slate-600">{doc.bookingCode}</td>
                  <td className="px-4 py-3 text-slate-900">{formatMoney(doc.amount)}</td>
                  {/* Masked, always. */}
                  <td className="px-4 py-3 font-mono text-slate-500">{doc.cardMasked}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(doc.checkIn)}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(doc.checkOut)}</td>
                  <td className="px-4 py-3">
                    <StatusChip status={doc.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {doc.chargedAt ? formatDate(doc.chargedAt.slice(0, 10)) : '—'}
                  </td>
                </tr>
              ))}
              {documents.length === 0 && !list.isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                    Chưa có chứng từ nào khớp bộ lọc.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={createOpen}
        title="Tạo chứng từ"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Huỷ
            </Button>
            <Button onClick={submitCreate} loading={create.isPending}>
              Lưu chứng từ
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Chi nhánh *">
            <select
              aria-label="Chi nhánh của chứng từ"
              className={inputClass}
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
            >
              <option value="">— Chọn chi nhánh —</option>
              {branches.data?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {branchLabel(b)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tên khách *">
            <input
              aria-label="Tên khách của chứng từ"
              className={inputClass}
              value={form.guestName}
              onChange={(e) => setForm({ ...form, guestName: e.target.value })}
            />
          </Field>
          <Field label="Mã đặt phòng *">
            <input
              aria-label="Mã đặt phòng của chứng từ"
              className={inputClass}
              value={form.bookingCode}
              onChange={(e) => setForm({ ...form, bookingCode: e.target.value })}
            />
          </Field>
          <Field label="Số tiền *">
            <input
              inputMode="numeric"
              aria-label="Số tiền"
              className={inputClass}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </Field>
          <Field label="Số thẻ *">
            <input
              aria-label="Số thẻ"
              className={inputClass}
              // Never autofilled, never remembered by the browser.
              autoComplete="off"
              inputMode="numeric"
              placeholder="•••• •••• •••• ••••"
              value={form.cardNumber}
              onChange={(e) => setForm({ ...form, cardNumber: e.target.value })}
            />
          </Field>
          <Field label="Date expire *">
            <input
              aria-label="Ngày hết hạn thẻ"
              className={inputClass}
              autoComplete="off"
              placeholder="MM/YY"
              value={form.cardExpiry}
              onChange={(e) => setForm({ ...form, cardExpiry: e.target.value })}
            />
          </Field>
          <Field label="Ngày check-in *">
            <input
              type="date"
              aria-label="Ngày check-in"
              className={inputClass}
              value={form.checkIn}
              onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
            />
          </Field>
          <Field label="Ngày check-out *">
            <input
              type="date"
              aria-label="Ngày check-out"
              className={inputClass}
              value={form.checkOut}
              onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
            />
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Lý do charge *">
            <textarea
              aria-label="Lý do charge"
              className={inputClass}
              rows={3}
              placeholder="Ví dụ: Khách không đến nhận phòng (no-show)…"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          Số thẻ được mã hoá trước khi lưu. Hệ thống không lưu CVV/CVC trong bất kỳ trường hợp nào.
        </p>

        {formError ? (
          <div className="mt-3">
            <ErrorAlert>{formError}</ErrorAlert>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
