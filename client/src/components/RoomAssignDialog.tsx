/**
 * "GIAO KỸ THUẬT" FOR A ROOM — one dialog for every waiting incident of one
 * place (Phòng 206's four faults), each a checkbox. The assigner ticks the ones
 * to give — any subset — and one technician; only those are assigned, together
 * (one server transaction, one notification). Nothing is pre-ticked: an incident
 * is never assigned just because it shares a room.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { issueCategoryLabel, issuesApi, type Issue } from '../api/issues';
import { toUserMessage } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

export function RoomAssignDialog({
  place,
  branchLabel,
  issues,
  onClose,
  onAssigned,
}: {
  /** "Phòng 206". */
  place: string;
  branchLabel: string;
  /** The room's incidents still waiting (status NEW) — assigned or not. */
  issues: Issue[];
  onClose: () => void;
  onAssigned: (count: number, technicianName: string) => void;
}) {
  const technicians = useQuery({
    queryKey: ['issues', 'technicians'],
    queryFn: () => issuesApi.technicians(),
    staleTime: 60_000,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [choice, setChoice] = useState<number | ''>('');
  const all = selected.size === issues.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const assign = useMutation({
    mutationFn: () => issuesApi.assignMany([...selected], Number(choice)),
    onSuccess: () =>
      onAssigned(selected.size, technicians.data?.technicians.find((t) => t.id === choice)?.fullName ?? 'kỹ thuật viên'),
  });

  return (
    <Modal
      open
      size="2xl"
      title={`Giao kỹ thuật — ${place}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={selected.size === 0 || choice === ''}
            loading={assign.isPending}
            data-testid="room-assign-confirm"
          >
            Giao {selected.size} sự cố
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">{branchLabel}</p>
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="font-medium text-slate-800" data-testid="room-assign-count">
              {selected.size}/{issues.length} đã chọn
            </span>
            <button
              type="button"
              onClick={() => setSelected(all ? new Set() : new Set(issues.map((i) => i.id)))}
              className="text-sm font-medium text-brand-700 hover:underline"
              data-testid="room-assign-all"
            >
              {all ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
            </button>
          </div>
          <ul className="space-y-2">
            {issues.map((issue) => {
              const on = selected.has(issue.id);
              return (
                <li key={issue.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${
                      on ? 'border-brand-600 bg-brand-50/50' : 'border-line hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(issue.id)}
                      className="mt-1 h-4 w-4 accent-brand-600"
                      data-testid={`room-assign-pick-${issue.id}`}
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block whitespace-pre-wrap break-words text-[15px] font-medium leading-snug text-slate-900">
                        {issue.description}
                      </span>
                      <span className="block text-slate-600">
                        {issue.category ? `${issueCategoryLabel(issue)} · ` : ''}
                        {issue.locationLabel} · báo lúc {formatDateTime(issue.createdAt)}
                      </span>
                      <span className="block text-slate-600">
                        {issue.assignedTechnician ? `Đang giao cho ${issue.assignedTechnician.name}` : (issue.assignmentStateLabel ?? 'Chưa giao kỹ thuật')}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <label className="block font-medium text-slate-700">
          Kỹ thuật viên
          <select
            aria-label="Kỹ thuật viên"
            data-testid="room-assign-technician"
            value={choice}
            onChange={(e) => setChoice(e.target.value === '' ? '' : Number(e.target.value))}
            className="mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <option value="">— Chọn kỹ thuật viên —</option>
            {(technicians.data?.technicians ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-slate-500">
          Chỉ các sự cố được chọn mới được giao; sự cố còn lại vẫn chờ giao kỹ thuật. Kỹ thuật viên nhận một thông báo cho cả nhóm.
        </p>
        {technicians.isError ? <ErrorAlert>{toUserMessage(technicians.error)}</ErrorAlert> : null}
        {assign.isError ? <ErrorAlert>{toUserMessage(assign.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
