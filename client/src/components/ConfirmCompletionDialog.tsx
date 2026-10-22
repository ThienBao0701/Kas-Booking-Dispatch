/**
 * "XÁC NHẬN HOÀN THÀNH" — a manager's decision on a repair a technician has
 * finished ("Đã hoàn thành chờ quản lý xác nhận").
 *
 *   Xác nhận hoàn thành       the incident is finally completed: it leaves the
 *                              pending queue and enters "Đã hoàn thành".
 *   Không đạt — sửa lại       back to the queue with the required reason; the
 *                              next "Tiếp nhận" opens a new attempt.
 *
 * Shown to Admin, Tổng quản lý / Quản lý lễ tân and Quản lý / Tổng quản lý kỹ
 * thuật (`technical.confirmCompletion`), never to whoever completed the repair.
 * The button grants nothing: the server checks the role, the branch, the state
 * and the self-confirmation rule again, and a second press gets a clean 409.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { issuesApi, type Issue } from '../api/issues';
import { toUserMessage } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

const FIELD =
  'mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function ConfirmCompletionDialog({
  issue,
  onClose,
  onDone,
}: {
  issue: Issue;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'confirm' | 'reject'>('confirm');
  const [note, setNote] = useState('');
  const last = issue.attempts[issue.attempts.length - 1];
  const decide = useMutation({
    mutationFn: () =>
      issuesApi.inspect(issue.id, {
        result: mode === 'confirm' ? 'PASSED' : 'FAILED',
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone(mode === 'confirm' ? 'Đã xác nhận hoàn thành sự cố.' : 'Đã chuyển sự cố về cần sửa lại.');
    },
  });
  const ready = mode === 'confirm' || note.trim() !== '';

  return (
    <Modal
      open
      title="Xác nhận hoàn thành sự cố"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => decide.mutate()}
            disabled={!ready}
            loading={decide.isPending}
            variant={mode === 'confirm' ? 'primary' : 'danger'}
            data-testid="confirm-completion-submit"
          >
            {mode === 'confirm' ? 'Xác nhận hoàn thành' : 'Yêu cầu sửa lại'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="confirm-completion">
        <div className="rounded-xl border border-line bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <p className="font-medium text-slate-900">
            {issue.branch?.address ?? '—'} · {issue.locationLabel}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{issue.description}</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div>
              <dt className="inline text-slate-500">Kỹ thuật hoàn thành: </dt>
              <dd className="inline font-medium">{issue.completedByName ?? issue.repairerName ?? '—'}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Lúc: </dt>
              <dd className="inline">{issue.completedAt ? formatDateTime(issue.completedAt) : '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="inline text-slate-500">Kết quả sửa chữa: </dt>
              <dd className="inline">{last?.result ?? 'Không ghi'}</dd>
            </div>
          </dl>
        </div>

        <div role="radiogroup" aria-label="Quyết định" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['confirm', 'Xác nhận hoàn thành', 'Sự cố chuyển sang "Đã hoàn thành".', CheckCircle2],
              ['reject', 'Không đạt — yêu cầu sửa lại', 'Sự cố quay lại hàng chờ kỹ thuật.', RotateCcw],
            ] as const
          ).map(([value, label, hint, Icon]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                mode === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-700'
              }`}
            >
              <input
                type="radio"
                name="confirm-mode"
                className="mt-1"
                checked={mode === value}
                onChange={() => setMode(value)}
                data-testid={`confirm-mode-${value}`}
              />
              <span>
                <span className="flex items-center gap-1.5 font-semibold">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </span>
                <span className="block text-xs text-slate-600">{hint}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="block text-sm font-medium text-slate-700">
          {mode === 'confirm' ? 'Ghi chú (không bắt buộc)' : 'Lý do không đạt (bắt buộc)'}
          <textarea
            className={FIELD}
            rows={2}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="confirm-completion-note"
          />
        </label>
        <p className="text-xs text-slate-500">Người xác nhận và thời điểm xác nhận do hệ thống ghi nhận.</p>
        {decide.isError ? <ErrorAlert>{toUserMessage(decide.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
