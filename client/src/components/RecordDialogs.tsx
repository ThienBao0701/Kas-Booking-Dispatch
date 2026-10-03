/**
 * The two things a receptionist does to a record AFTER writing it: correct it,
 * or withdraw it.
 *
 * BOTH ARE AUDITED, AND NEITHER DELETES ANYTHING. The server keeps the old value
 * of every corrected field and keeps a voided row fully readable with the reason
 * attached. These dialogs exist to make that obvious to the person doing it —
 * "Xóa" that silently meant "hide" would be worse than no button at all.
 *
 * WHY THE EDIT DIALOG IS GENERIC
 *
 * Guest requests, quality reports and room services differ only in which fields
 * they carry; the correction flow is identical. One dialog driven by a field
 * list keeps the three from drifting into three slightly different behaviours.
 * Payments are the exception and edit in the row itself — a cashier correcting a
 * figure is looking at the column it sits in.
 */
import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CompletionVerdictFields } from './CompletionVerdict';
import { EMPTY_VERDICT, verdictPayload, verdictReady, type VerdictValue } from '../lib/completionVerdict';
import { reportsApi, type OperationalReport, type UpdateReportInput } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { ErrorAlert } from './ErrorAlert';
import { MoneyInput } from './MoneyInput';
import { groupDigits, parseVnd } from '../lib/money';
import { EXPENSE_SOURCE } from '../lib/reportCategories';

/**
 * "Xóa" asks for a reason and says plainly what it is about to do.
 *
 * The wording matters: an operator who believes they deleted a row will be
 * surprised to find it in the Admin's report. They are told it stays.
 */
export function VoidDialog({
  id,
  onClose,
  onVoided,
}: {
  id: string;
  onClose: () => void;
  onVoided: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => reportsApi.void(id, reason.trim()),
    onSuccess: async () => {
      setError(null);
      await onVoided();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  return (
    <Modal
      open
      title="Hủy bản ghi"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={reason.trim().length === 0}
            loading={run.isPending}
            data-testid="void-confirm"
          >
            Xác nhận hủy
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Bản ghi sẽ không còn được tính vào tổng, nhưng vẫn được lưu lại đầy đủ cùng lý do và người
          thực hiện. Hệ thống không xóa dữ liệu.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          Lý do hủy
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            data-testid="void-reason"
            className="mt-1 w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </label>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * "Hoàn thành" on a guest request or a service-quality report: was the report
 * right ("Đúng" / "Sai", the rule every completion shares), and how it was
 * handled or why it was wrong.
 *
 * "Đúng" keeps the handling text OPTIONAL — plenty of completions need no
 * explanation, and blank sends nothing. "Sai" needs its reason.
 *
 * The completion time is not shown as an input because it is not one — the
 * server stamps it, together with who completed it and on which shift.
 */
export function CompleteRecordDialog({
  id,
  title,
  fieldLabel,
  onClose,
  onCompleted,
}: {
  id: string;
  /** "Hoàn thành yêu cầu" / "Hoàn thành vấn đề". */
  title: string;
  /** "Cách xử lý (nếu có)" / "Hướng xử lý (nếu có)". */
  fieldLabel: string;
  onClose: () => void;
  onCompleted: () => void | Promise<void>;
}) {
  const [verdict, setVerdict] = useState<VerdictValue>(EMPTY_VERDICT);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => reportsApi.complete(id, verdictPayload(verdict)),
    onSuccess: async () => {
      setError(null);
      await onCompleted();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <Button
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={!verdictReady(verdict)}
            data-testid="complete-confirm"
          >
            Hoàn thành
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <CompletionVerdictFields value={verdict} onChange={setVerdict} resolutionLabel={fieldLabel} />
        <p className="text-xs text-slate-500">Thời gian hoàn thành do hệ thống ghi nhận.</p>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Correcting a record
 * ------------------------------------------------------------------ */

export interface EditField {
  /** The server's own field name — it is what the audit row will record. */
  name: string;
  label: string;
  /**
   * `integer`: a whole number of at least 1, such as "Số đêm".
   * `count`: a whole number of at least 0, such as a review count.
   * `select`: one of `options`.
   */
  kind?: 'text' | 'textarea' | 'money' | 'integer' | 'count' | 'select';
  required?: boolean;
  placeholder?: string;
  /** The choices of a `select`, as `{ value: the server's code, label }`. */
  options?: { value: string; label: string }[];
}

/** A whole number from 0 up as typed, or null — never a silent zero for blank. */
function parseCount(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A positive whole number as typed, or null — never a silent zero. */
function parseWhole(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/**
 * Corrects one record.
 *
 * ONLY THE BLOCK THAT BELONGS TO THE RECORD'S CATEGORY IS SENT, because the
 * server reads only that one — a patch naming the wrong block changes nothing,
 * by design. The caller says which block it is.
 */
export function RecordEditDialog({
  report,
  fields,
  block,
  onClose,
  onSaved,
}: {
  report: OperationalReport;
  fields: EditField[];
  block: 'payment' | 'guestRequest' | 'complaint' | 'roomService' | 'delivery';
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const source = (report[block] ?? {}) as Record<string, unknown>;

  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const raw = source[f.name];
        if (f.kind === 'money') return [f.name, raw == null ? '' : groupDigits(String(raw))];
        return [f.name, raw == null ? '' : String(raw)];
      }),
    ),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        const value = draft[f.name] ?? '';
        payload[f.name] =
          f.kind === 'money'
            ? (parseVnd(value) ?? 0)
            : f.kind === 'integer'
              ? parseWhole(value)
              : f.kind === 'count'
                ? parseCount(value)
                : value.trim();
      }
      // A payment moved to "Chi tiền" is a pure cash payout — the server's rule.
      if (block === 'payment' && payload.source === EXPENSE_SOURCE) {
        payload.amount = 0;
        payload.method = 'CASH';
      }
      const patch = { [block]: payload, reason: reason.trim() || undefined } as UpdateReportInput;
      return reportsApi.update(report.id, patch);
    },
    onSuccess: async () => {
      setError(null);
      await onSaved();
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  const everyFieldReady = fields.every((f) => {
    const value = (draft[f.name] ?? '').trim();
    if (!f.required) return true;
    if (f.kind === 'money') return parseVnd(value) !== null;
    if (f.kind === 'integer') return parseWhole(value) !== null;
    if (f.kind === 'count') return parseCount(value) !== null;
    return value.length > 0;
  });
  // The counts of a Review are judged together: at least one review, as on creation.
  const countFields = fields.filter((f) => f.kind === 'count');
  const countsReady =
    countFields.length === 0 || countFields.reduce((sum, f) => sum + (parseCount(draft[f.name] ?? '') ?? 0), 0) > 0;
  const ready = everyFieldReady && countsReady;

  return (
    <Modal
      open
      title="Sửa bản ghi"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="record-edit-cancel">
            Hủy
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!ready}
            loading={save.isPending}
            data-testid="record-edit-save"
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/*
          The trail is shown, not hidden. A receptionist who can see that the
          correction is recorded is one who knows it exists.
        */}
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Giá trị cũ được giữ lại trong lịch sử chỉnh sửa cùng tên người sửa và thời điểm sửa.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) =>
            f.kind === 'money' ? (
              <MoneyInput
                key={f.name}
                label={f.label}
                required={f.required}
                value={draft[f.name] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
                data-testid={`record-edit-${f.name}`}
              />
            ) : f.kind === 'integer' || f.kind === 'count' ? (
              <Input
                key={f.name}
                label={f.label}
                inputMode="numeric"
                value={draft[f.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value.replace(/\D/g, '') }))}
                data-testid={`record-edit-${f.name}`}
              />
            ) : f.kind === 'select' ? (
              <label key={f.name} className="block space-y-1.5 text-sm font-medium text-slate-700">
                {f.label}
                <select
                  value={draft[f.name] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                  data-testid={`record-edit-${f.name}`}
                  className="block w-full rounded-xl border border-line-strong bg-white px-3 py-2.5 text-sm font-normal text-slate-900 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : f.kind === 'textarea' ? (
              <label key={f.name} className="block text-sm font-medium text-slate-700 sm:col-span-2">
                {f.label}
                <textarea
                  value={draft[f.name] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                  rows={3}
                  maxLength={4000}
                  data-testid={`record-edit-${f.name}`}
                  className="mt-1 w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                />
              </label>
            ) : (
              <Input
                key={f.name}
                label={f.label}
                value={draft[f.name] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                data-testid={`record-edit-${f.name}`}
              />
            ),
          )}
        </div>

        <Input
          label="Lý do sửa (không bắt buộc)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ví dụ: Khách đọc nhầm số phòng"
          data-testid="record-edit-reason"
        />

        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** The "Đã hủy" strip a voided row carries wherever it is shown. */
export function VoidedNote({ report }: { report: OperationalReport }): ReactNode {
  if (!report.voided) return null;
  return (
    <span className="mt-0.5 block text-xs font-medium text-rose-600">
      Đã hủy: {report.voidReason}
    </span>
  );
}
