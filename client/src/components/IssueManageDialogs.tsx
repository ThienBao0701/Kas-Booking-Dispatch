/**
 * "CHUYỂN VỀ CHỜ GIAO KỸ THUẬT" and "XÓA" — the two management actions on an
 * open incident, one dialog each, shared by every screen that offers them
 * (Reception's board, the Admin and the managers' incident page, the technical
 * report). The server decides who may (the incident's branch, or a supervisor
 * in scope) — a visible button is never the permission.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { issuesApi, type Issue } from '../api/issues';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

function IssueLine({ issue }: { issue: Issue }) {
  return (
    <div className="rounded-xl border border-line bg-slate-50 px-3 py-2 text-sm">
      <p className="font-medium text-slate-900">
        {issue.branch?.address ?? '—'} · {issue.locationLabel}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-700">{issue.description}</p>
    </div>
  );
}

/** Takes an assigned (not yet accepted) incident back to "Chờ giao kỹ thuật". */
export function UnassignIssueDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => issuesApi.unassign(issue.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone();
    },
  });
  return (
    <Modal
      open
      title="Chuyển về chờ giao kỹ thuật"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} data-testid="unassign-confirm">
            Chuyển về chờ giao
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <IssueLine issue={issue} />
        <p>
          Sự cố đang giao cho <span className="font-semibold">{issue.assignedTechnician?.name ?? '—'}</span>. Sau khi
          chuyển, sự cố trở về “Chờ giao kỹ thuật” và có thể giao lại. Lịch sử giao việc được giữ nguyên.
        </p>
        {run.isError ? <ErrorAlert>{toUserMessage(run.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** "Xóa": confirmed, with an optional reason; the record and its history stay. */
export function DeleteIssueDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => issuesApi.voidIssue(issue.id, reason.trim() || undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone();
    },
  });
  return (
    <Modal
      open
      title="Xóa sự cố"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => run.mutate()}
            loading={run.isPending}
            className="!bg-rose-600 hover:!bg-rose-700"
            data-testid="delete-issue-confirm"
          >
            Xóa sự cố
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <IssueLine issue={issue} />
        <p>
          Bạn chắc chắn muốn xóa sự cố này? Sự cố sẽ không còn trong danh sách xử lý
          {issue.assignedTechnician || issue.acceptedBy ? ' và kỹ thuật viên đang giữ sẽ được thông báo' : ''}. Bản ghi và
          lịch sử vẫn được lưu lại.
        </p>
        <label className="block font-medium text-slate-700">
          Lý do <span className="font-normal text-slate-500">(không bắt buộc)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            placeholder="Ví dụ: Báo trùng"
            data-testid="delete-issue-reason"
            className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
        </label>
        {run.isError ? <ErrorAlert>{toUserMessage(run.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
