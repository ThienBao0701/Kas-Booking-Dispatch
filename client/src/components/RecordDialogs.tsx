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
import { reportsApi, type OperationalReport, type UpdateReportInput } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { ErrorAlert } from './ErrorAlert';
import { MoneyInput } from './MoneyInput';
import { groupDigits, parseVnd } from '../lib/money';

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
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </label>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * "Hoàn thành" on a guest request or a service-quality report: optionally, how
 * it was handled — and nothing else.
 *
 * THE HANDLING TEXT IS OPTIONAL, so the button is never disabled for an empty
 * box: plenty of completions need no explanation. Left blank, nothing is sent
 * and nothing is stored — no placeholder sentence standing in for one.
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
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => reportsApi.complete(id, resolution.trim() || undefined),
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
          <Button onClick={() => run.mutate()} loading={run.isPending} data-testid="complete-confirm">
            Hoàn thành
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm font-medium text-slate-700">
          {fieldLabel}
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={3}
            maxLength={2000}
            data-testid="complete-resolution"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </label>
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
  /** `integer`: a whole number, such as "Số đêm". */
  kind?: 'text' | 'textarea' | 'money' | 'integer';
  required?: boolean;
  placeholder?: string;
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
  block: 'guestRequest' | 'complaint' | 'roomService';
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
              : value.trim();
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

  const ready = fields.every((f) => {
    const value = (draft[f.name] ?? '').trim();
    if (!f.required) return true;
    if (f.kind === 'money') return parseVnd(value) !== null;
    if (f.kind === 'integer') return parseWhole(value) !== null;
    return value.length > 0;
  });

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
            ) : f.kind === 'integer' ? (
              <Input
                key={f.name}
                label={f.label}
                inputMode="numeric"
                value={draft[f.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value.replace(/\D/g, '') }))}
                data-testid={`record-edit-${f.name}`}
              />
            ) : f.kind === 'textarea' ? (
              <label key={f.name} className="block text-sm font-medium text-slate-700 sm:col-span-2">
                {f.label}
                <textarea
                  value={draft[f.name] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                  rows={3}
                  maxLength={4000}
                  data-testid={`record-edit-${f.name}`}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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
