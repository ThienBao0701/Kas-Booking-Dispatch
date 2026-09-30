/**
 * "GIAO KỸ THUẬT" — give an incident to one technician, or move it to another.
 *
 * The technicians are the ACTIVE Bộ phận kỹ thuật accounts, by FULL NAME (never
 * a username), from the server. Who holds it now — and who tried before, after a
 * "Không sửa được" — is said above the choice, so a reassignment is a decision
 * made with the history in view. The server re-checks everything: the branch is
 * the supervisor's, the incident still waits, the technician is active.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { issuesApi, type Issue } from '../api/issues';
import { toUserMessage } from '../api/errors';
import { Modal } from './Modal';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { formatDateTime } from '../lib/format';

export function AssignTechnicianDialog({
  issue,
  onClose,
  onAssigned,
}: {
  issue: Issue;
  onClose: () => void;
  onAssigned: (issue: Issue) => void;
}) {
  const technicians = useQuery({
    queryKey: ['issues', 'technicians'],
    queryFn: () => issuesApi.technicians(),
    staleTime: 60_000,
  });
  const current = issue.assignedTechnician ?? null;
  const [choice, setChoice] = useState<number | ''>('');
  const assign = useMutation({
    mutationFn: () => issuesApi.assign(issue.id, Number(choice)),
    onSuccess: ({ issue: updated }) => onAssigned(updated),
  });
  const failed = issue.attempts.filter((a) => a.outcome === 'CANNOT_REPAIR');

  return (
    <Modal
      open
      title={current ? 'Giao lại kỹ thuật' : 'Giao kỹ thuật'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={choice === '' || choice === current?.id}
            loading={assign.isPending}
            data-testid="assign-confirm"
          >
            Giao việc
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-xl border border-line bg-slate-50 px-3 py-2">
          <p className="font-medium text-slate-900">
            {issue.branch?.address ?? '—'} · {issue.locationLabel}
          </p>
          <p className="mt-0.5 text-slate-700">{issue.description}</p>
          <p className="mt-1 text-xs text-slate-600" data-testid="assign-current">
            {current
              ? `Đang giao cho ${current.name}${issue.assignedAt ? ` từ ${formatDateTime(issue.assignedAt)}` : ''}.`
              : issue.assignmentStateLabel ?? 'Chưa giao kỹ thuật.'}
          </p>
        </div>

        {failed.length > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" data-testid="assign-history">
            <p className="font-semibold">Đã có người không sửa được:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {failed.map((a) => (
                <li key={a.id}>
                  {a.technicianName} · {a.outcomeAt ? formatDateTime(a.outcomeAt) : '—'} — {a.reason ?? '—'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <label className="block font-medium text-slate-700">
          Kỹ thuật viên
          <select
            aria-label="Kỹ thuật viên"
            data-testid="assign-technician"
            value={choice}
            onChange={(e) => setChoice(e.target.value === '' ? '' : Number(e.target.value))}
            className="mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <option value="">— Chọn kỹ thuật viên —</option>
            {(technicians.data?.technicians ?? []).map((t) => (
              <option key={t.id} value={t.id} disabled={t.id === current?.id}>
                {t.fullName}
                {t.id === current?.id ? ' (đang giao)' : ''}
              </option>
            ))}
          </select>
        </label>
        {technicians.isError ? <ErrorAlert>{toUserMessage(technicians.error)}</ErrorAlert> : null}
        {assign.isError ? <ErrorAlert>{toUserMessage(assign.error)}</ErrorAlert> : null}
        <p className="text-xs text-slate-500">Kỹ thuật viên nhận thông báo ngay khi được giao.</p>
      </div>
    </Modal>
  );
}
