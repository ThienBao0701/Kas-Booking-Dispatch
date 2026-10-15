/**
 * HOUSEKEEPING WORK ITEMS — the manager's side, one row per room / area.
 * (Creating them — work groups — is `HkWorkGroups.tsx`.)
 *
 *   WorkOrderTable      "Các công việc trong ngày": ONE ROW PER ITEM — two jobs
 *                       for room 502 are two rows — with Khu vực, Việc cần làm,
 *                       Trạng thái, Người thực hiện, Ghi chú, filters, and the
 *                       full instructions one click down.
 *   ReassignDialog      "Giao lại" an item inspected and waiting for cleaning.
 *
 * The areas are the branch's own catalog, served by the server; the server
 * checks every rule again (required notes, rooms of the branch, who may
 * reassign, the state) — these screens only ask.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserCog } from 'lucide-react';
import {
  ROOM_WORK_KEY,
  WORK_PHASE_ORDER,
  roomWorkApi,
  type RoomTask,
  type WorkPhase,
} from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { Button } from './Button';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';
const LABEL = 'block text-sm font-medium text-slate-700';

const PHASE_TONES: Record<WorkPhase, string> = {
  UNCLAIMED: 'bg-slate-100 text-slate-700 ring-slate-300',
  ACCEPTED: 'bg-sky-50 text-sky-800 ring-sky-300',
  INSPECTING: 'bg-violet-50 text-violet-800 ring-violet-300',
  AWAITING_CLEANING: 'bg-amber-50 text-amber-900 ring-amber-300',
  CLEANING: 'bg-blue-100 text-blue-800 ring-blue-300',
  COMPLETED: 'bg-green-100 text-green-800 ring-green-300',
  NO_CLEAN_PENDING: 'bg-orange-50 text-orange-900 ring-orange-300',
  NO_CLEAN: 'bg-slate-100 text-slate-600 ring-slate-300',
  VOIDED: 'bg-rose-50 text-rose-700 ring-rose-300',
};

/** Where an item stands — the server's word, in its own colour (never colour alone). */
export function PhaseBadge({ task }: { task: RoomTask }) {
  const phase = task.phase ?? 'UNCLAIMED';
  return (
    <span
      data-testid={`phase-${task.id}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${PHASE_TONES[phase]}`}
    >
      {task.phaseLabel ?? task.stateLabel}
    </span>
  );
}

const areaOf = (t: RoomTask) => t.areaLabel ?? `Phòng - ${t.roomNumber}`;
const jobOf = (t: RoomTask) => t.taskLabel ?? t.statusCode;

/* ------------------------------------------------------------------ *
 * "Các công việc trong ngày"
 * ------------------------------------------------------------------ */

export function WorkOrderTable({
  tasks,
  isLoading,
  isError,
  error,
  onRetry,
  onOpen,
  onReassign,
  canReassign,
  showBranch = false,
  frame,
}: {
  tasks: RoomTask[];
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** "Chi tiết" — the item's full record (the board's own dialog). */
  onOpen?: (task: RoomTask) => void;
  /** "Giao lại" an item waiting for cleaning. */
  onReassign?: (task: RoomTask) => void;
  canReassign: boolean;
  showBranch?: boolean;
  /** The table's frame — "light" on the housekeeping manager's board. */
  frame?: 'default' | 'light';
}) {
  const [area, setArea] = useState('');
  const [phase, setPhase] = useState<WorkPhase | ''>('');
  const [person, setPerson] = useState('');
  const areaGroups = useMemo(() => [...new Set(tasks.map((t) => groupOf(t)))].sort(), [tasks]);
  const people = useMemo(
    () => [...new Map(tasks.filter((t) => t.assignee).map((t) => [String(t.assignee!.id), t.assignee!.name])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'vi')),
    [tasks],
  );
  const shown = tasks.filter(
    (t) =>
      (!area || groupOf(t) === area) &&
      (!phase || t.phase === phase) &&
      (!person || (person === 'NONE' ? !t.assignee : String(t.assignee?.id) === person)),
  );

  const columns: DataColumn<RoomTask>[] = [
    ...(showBranch
      ? [{ key: 'branch', header: 'Chi nhánh', hideBelow: 'xl' as const, render: (t: RoomTask) => `CN ${t.branch.branchNumber}` }]
      : []),
    {
      key: 'area',
      header: 'Khu vực',
      className: 'min-w-[8rem] font-medium text-slate-900',
      render: (t) => (
        <>
          {t.workGroup ? <span className="mr-1 text-xs font-semibold text-slate-500">CV {t.workGroup.number} ·</span> : null}
          {areaOf(t)}
          {t.priority ? <span className="ml-1.5 rounded bg-red-600 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-white">Ưu tiên</span> : null}
        </>
      ),
    },
    { key: 'job', header: 'Việc cần làm', className: 'min-w-[7rem]', render: (t) => jobOf(t) },
    { key: 'phase', header: 'Trạng thái', className: 'whitespace-nowrap', render: (t) => <PhaseBadge task={t} /> },
    {
      key: 'person',
      header: 'Người thực hiện',
      className: 'min-w-[7rem]',
      render: (t) => (t.assignee ? t.assignee.name : <span className="text-slate-400">— Chưa có —</span>),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      hideBelow: 'lg',
      coveredByDetail: true,
      className: 'min-w-[10rem] max-w-[24rem]',
      render: (t) => (t.note ? <span className="line-clamp-2 whitespace-pre-wrap">{t.note}</span> : <span className="text-slate-400">—</span>),
    },
  ];

  const select = 'min-h-[2.5rem] rounded-xl border border-line-strong bg-white px-3 py-1.5 text-sm text-slate-800';
  return (
    <div className="space-y-3" data-testid="work-orders">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc công việc">
        <select aria-label="Khu vực" className={select} value={area} onChange={(e) => setArea(e.target.value)} data-testid="work-filter-area">
          <option value="">Mọi khu vực</option>
          {areaGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select aria-label="Trạng thái" className={select} value={phase} onChange={(e) => setPhase(e.target.value as WorkPhase | '')} data-testid="work-filter-phase">
          <option value="">Mọi trạng thái</option>
          {WORK_PHASE_ORDER.map((p) => (
            <option key={p} value={p}>
              {PHASE_NAMES[p]}
            </option>
          ))}
        </select>
        <select aria-label="Người thực hiện" className={select} value={person} onChange={(e) => setPerson(e.target.value)} data-testid="work-filter-person">
          <option value="">Mọi nhân viên</option>
          <option value="NONE">Chưa có người nhận</option>
          {people.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <DataTable
        frame={frame}
        testId="work-orders-table"
        title="Các công việc trong ngày"
        badge={shown.length}
        columns={columns}
        rows={shown}
        rowKey={(t) => t.id}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        emptyTitle={tasks.length === 0 ? 'Chưa có công việc nào trong ngày' : 'Không có công việc khớp bộ lọc'}
        emptyMessage={tasks.length === 0 ? 'Bấm “+ Tạo công việc” để giao việc cho buồng phòng.' : ''}
        detailToggle="always"
        multiExpand
        renderDetail={(t) => <WorkOrderDetail task={t} />}
        actions={(t) => (
          <span className="inline-flex flex-wrap justify-end gap-1">
            {canReassign && onReassign && t.phase === 'AWAITING_CLEANING' ? (
              <RowAction onClick={() => onReassign(t)} testId={`work-reassign-${t.id}`}>
                <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                Giao lại
              </RowAction>
            ) : null}
            {onOpen ? (
              <RowAction onClick={() => onOpen(t)} testId={`work-open-${t.id}`}>
                Chi tiết
              </RowAction>
            ) : null}
          </span>
        )}
      />
    </div>
  );
}

const PHASE_NAMES: Record<WorkPhase, string> = {
  UNCLAIMED: 'Chưa giao',
  ACCEPTED: 'Đã nhận / Chờ kiểm tra',
  INSPECTING: 'Đang kiểm tra',
  AWAITING_CLEANING: 'Chờ dọn phòng',
  CLEANING: 'Đang dọn phòng',
  COMPLETED: 'Hoàn thành',
  NO_CLEAN_PENDING: 'Chờ duyệt không cần dọn',
  NO_CLEAN: 'Không cần dọn',
  VOIDED: 'Đã xóa',
};

/** The floor (or group) an item belongs to, for the "Khu vực" filter. */
function groupOf(t: RoomTask): string {
  return t.floor ? `Tầng ${t.floor}` : t.areaKind && t.areaKind !== 'ROOM' ? (t.areaKindLabel ?? 'Khu vực chung') : 'Phòng chưa xác định tầng';
}

/** The item in full: every instruction, and where the work stands. */
function WorkOrderDetail({ task: t }: { task: RoomTask }) {
  const fact = (label: string, value: string | null | undefined) => (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value || '—'}</dd>
    </div>
  );
  return (
    <div className="space-y-2" data-testid={`work-detail-${t.id}`}>
      {t.note ? (
        <p className="whitespace-pre-wrap rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <span className="font-semibold">Ghi chú / Hướng dẫn: </span>
          {t.note}
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {fact('Khu vực', areaOf(t))}
        {fact('Việc cần làm', jobOf(t))}
        {fact('Nhận việc', t.acceptedAt ? formatDateTime(t.acceptedAt) : null)}
        {fact('Bắt đầu kiểm tra', t.inspectionStartedAt ? formatDateTime(t.inspectionStartedAt) : null)}
        {fact('Kiểm tra xong', t.inspectedAt ? formatDateTime(t.inspectedAt) : null)}
        {fact('Bắt đầu dọn', t.startedAt ? formatDateTime(t.startedAt) : null)}
        {fact('Hoàn thành', t.completedAt ? formatDateTime(t.completedAt) : null)}
        {fact('Người tạo', t.createdByName)}
      </dl>
      {t.inspectionNote ? <p className="text-sm text-slate-700">Ghi nhận khi kiểm tra: {t.inspectionNote}</p> : null}
      {t.inspection && t.inspection.findings.length > 0 ? (
        <p className="text-sm text-slate-700">Tình trạng phòng: {t.inspection.findings.map((f) => f.typeLabel).join(', ')}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * "Giao lại"
 * ------------------------------------------------------------------ */

export function ReassignDialog({
  task,
  staff,
  onClose,
  onDone,
}: {
  task: RoomTask;
  staff: { id: number; fullName: string }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const others = staff.filter((s) => s.id !== task.assignee?.id);
  const name = others.find((s) => s.id === target)?.fullName ?? '';
  const save = useMutation({
    mutationFn: () => roomWorkApi.reassign(task.id, { assigneeUserId: target as number, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onDone(`Đã giao lại ${areaOf(task)} · ${jobOf(task)} cho ${name}.`);
    },
  });
  return (
    <Modal
      open
      title="Giao lại công việc"
      onClose={onClose}
      footer={
        confirming ? (
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={save.isPending}>
              Quay lại
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} data-testid="reassign-confirm">
              Xác nhận giao lại
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={target === ''} data-testid="reassign-next">
              Tiếp tục
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3" data-testid="reassign-dialog">
        <p className="text-sm text-slate-700">
          <span className="font-semibold">{areaOf(task)}</span> · {jobOf(task)} — đã kiểm tra, đang chờ dọn phòng.
          <span className="block">Người thực hiện hiện tại: {task.assignee?.name ?? '—'}</span>
        </p>
        {confirming ? (
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="reassign-summary">
            Giao <span className="font-semibold">{areaOf(task)} · {jobOf(task)}</span> từ{' '}
            <span className="font-semibold">{task.assignee?.name ?? '—'}</span> cho <span className="font-semibold">{name}</span>?
            {reason.trim() ? <span className="block">Lý do: {reason.trim()}</span> : null}
          </p>
        ) : (
          <>
            <label className={LABEL}>
              Giao cho
              <select className={FIELD} value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))} data-testid="reassign-target">
                <option value="">— Chọn nhân viên buồng phòng —</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Lý do (không bắt buộc)
              <textarea className={FIELD} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="reassign-reason" />
            </label>
          </>
        )}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
