/**
 * "QUẢN LÝ BUỒNG PHÒNG" — six focused screens over one branch's housekeeping
 * (the Admin: any branch, with a branch picker):
 *
 *   Tổng quan            the day at a glance
 *   Tình trạng phòng     the board: each room's code, priority, note, worker
 *   Phân công công việc  who has which room; assign, reassign, history
 *   Theo dõi nhân viên   per worker: rooms, progress, inspections, money — and every detail
 *   KPI & Thu tiền       findings and collections credited to each worker
 *   Báo cáo              the operations report, PDF and Excel
 *
 * The SERVER scopes every read and write to the manager's branch; these screens
 * only ask. Every action is recorded in the room's history.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, ClipboardList, Coins, Download, Hourglass, ListChecks, Star, Users, Wallet } from 'lucide-react';
import {
  ROOM_WORK_KEY,
  formatMinutes,
  housekeepingReportUrl,
  roomWorkApi,
  type RoomTask,
  type StaffProgressRow,
  type KpiRow,
  type FindingLine,
  type OperationsRow,
} from '../api/roomWork';
import { branchesApi } from '../api/bookings';
import type { RoomCollectionStatus } from '../api/housekeeping';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel, type Branch } from '../auth/types';
import { useBranchRooms } from '../hooks/useBranchRooms';
import { Button } from '../components/Button';
import { DataTable, RowAction, type DataColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { BranchPicker, ReportFilterBar } from '../components/ReportFilter';
import { RoomBoard, RoomChip, RoomStateLegend } from '../components/RoomBoard';
import { RoomTaskDetail } from '../components/RoomTaskDetail';
import { StatCard } from '../components/StatCard';
import { Toast } from '../components/Toast';
import { initialReportFilter, reportBranchId, reportPeriod, type BranchChoice, type ReportFilterValue } from '../lib/reportFilter';
import { formatVnd } from '../lib/money';
import { formatDate, formatDateTime, hcmToday } from '../lib/format';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/* ------------------------------------------------------------------ *
 * The manager's branch (fixed) or the Admin's choice
 * ------------------------------------------------------------------ */

function useScope(allowAll: boolean) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const [choice, setChoice] = useState<BranchChoice>(allowAll ? 'ALL' : null);
  const branchId = isAdmin ? (typeof choice === 'number' ? choice : undefined) : (user?.branch?.id ?? undefined);
  const ready = !isAdmin || choice !== null;
  const picker: ReactNode = isAdmin ? (
    <div className="w-full sm:w-80">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Chi nhánh</p>
      <BranchPicker value={choice} onChange={setChoice} branches={branches.data?.branches ?? []} allowAll={allowAll} />
    </div>
  ) : user?.branch ? (
    <p className="text-sm font-semibold text-slate-800" data-testid="manager-branch">
      {branchLabel(user.branch as Branch)}
    </p>
  ) : null;
  return { isAdmin, branchId, ready, picker, branches: branches.data?.branches ?? [] };
}

function DayBar({ date, onDate, picker }: { date: string; onDate: (d: string) => void; picker: ReactNode }) {
  return (
    <section className="mb-4 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-sm">
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        Ngày
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onDate(e.target.value)}
          data-testid="hk-date"
          className={`${FIELD} normal-case tracking-normal`}
        />
      </label>
      {picker}
    </section>
  );
}

function PickBranchFirst() {
  return <EmptyState icon={<BedDouble className="h-6 w-6" aria-hidden="true" />} title="Chọn chi nhánh" message="Chọn một chi nhánh để xem công việc buồng phòng." />;
}

/* ------------------------------------------------------------------ *
 * Tổng quan
 * ------------------------------------------------------------------ */

export function HkOverviewPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(true);
  const data = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'overview', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.overview({ date, branchId: scope.branchId }),
    enabled: scope.ready,
    refetchInterval: 30_000,
  });
  const o = data.data;
  return (
    <div>
      <PageHeader title="Tổng quan buồng phòng" description={`Ngày nghiệp vụ ${formatDate(date)}.`} />
      <DayBar date={date} onDate={setDate} picker={scope.picker} />
      <QueryState isLoading={data.isLoading} isError={data.isError} error={data.error} onRetry={() => void data.refetch()}>
        {o ? (
          <div className="space-y-4" data-testid="hk-overview">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatCard label="Tổng phòng" value={o.rooms.total} icon={BedDouble} />
              <StatCard label="Chưa bắt đầu" value={o.rooms.notStarted} icon={Hourglass} />
              <StatCard label="Đang dọn" value={o.rooms.inProgress} icon={ListChecks} tone="amber" />
              <StatCard label="Hoàn thành" value={o.rooms.completed} icon={ClipboardList} tone="green" />
              <StatCard label="Ưu tiên" value={o.rooms.priority} icon={Star} tone="red" />
              <StatCard label="Chưa giao" value={o.rooms.unassigned} icon={Users} />
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatCard label="Lượt kiểm phòng" value={o.inspections} icon={ClipboardList} />
              <StatCard label="Phát sinh" value={o.findings} icon={ListChecks} tone="amber" />
              <StatCard label="Đã thu từ kiểm phòng" value={formatVnd(o.collectedAmount)} icon={Wallet} tone="green" />
              <StatCard label="Phát sinh chưa thu" value={o.pendingCollections} icon={Coins} tone="red" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-line bg-white p-4">
                <h2 className="mb-2 text-sm font-bold text-slate-900">Nhân viên đang trong ca</h2>
                {o.working.length === 0 ? (
                  <p className="text-sm text-slate-500">Chưa có nhân viên vào ca.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {o.working.map((w) => (
                      <li key={`${w.userId}-${w.since}`} className="flex justify-between gap-2">
                        <span className="font-medium">{w.name}</span>
                        <span className="text-slate-600">từ {formatDateTime(w.since)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="rounded-2xl border border-line bg-white p-4">
                <h2 className="mb-2 text-sm font-bold text-slate-900">Phòng theo nhân viên</h2>
                {o.employees.length === 0 ? (
                  <p className="text-sm text-slate-500">Chưa giao phòng nào.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500">
                      <tr>
                        <th className="py-1">Nhân viên</th>
                        <th className="py-1 text-right">Được giao</th>
                        <th className="py-1 text-right">Đang dọn</th>
                        <th className="py-1 text-right">Hoàn thành</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.employees.map((e) => (
                        <tr key={e.userId} className="border-t border-line-subtle">
                          <td className="py-1.5 font-medium">{e.name}</td>
                          <td className="py-1.5 text-right tabular-nums">{e.assigned}</td>
                          <td className="py-1.5 text-right tabular-nums">{e.inProgress}</td>
                          <td className="py-1.5 text-right tabular-nums">{e.completed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </QueryState>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The one room's dialog: everything, plus the manager's actions
 * ------------------------------------------------------------------ */

function TaskDialog({ task, staff, onClose, onChanged }: { task: RoomTask; staff: { id: number; fullName: string }[]; onClose: () => void; onChanged: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const [statusCode, setStatusCode] = useState(task.statusCode);
  const [priority, setPriority] = useState(task.priority);
  const [note, setNote] = useState(task.note ?? '');
  const [assignee, setAssignee] = useState<number | ''>(task.assignee?.id ?? '');
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const done = async (msg: string) => {
    await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
    onChanged(msg);
  };
  const save = useMutation({
    mutationFn: async () => {
      const changed = statusCode !== task.statusCode || priority !== task.priority || (note.trim() || null) !== task.note;
      if (changed) await roomWorkApi.updateTask(task.id, { statusCode, priority, note: note.trim() || null });
      if ((assignee === '' ? null : assignee) !== (task.assignee?.id ?? null)) await roomWorkApi.assign(task.id, assignee === '' ? null : assignee);
    },
    onSuccess: () => done('Đã lưu công việc phòng.'),
  });
  const remove = useMutation({ mutationFn: () => roomWorkApi.voidTask(task.id, reason.trim() || undefined), onSuccess: () => done('Đã xóa công việc phòng.') });
  const locked = task.voided;
  return (
    <Modal
      open
      size="2xl"
      title={`Phòng ${task.roomNumber} · ${formatDate(task.workDate)}`}
      onClose={onClose}
      footer={
        locked ? (
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setVoiding(true)} className="!border-rose-300 !text-rose-700 hover:!bg-rose-50" data-testid="task-void-open">
              Xóa
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Đóng
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} data-testid="task-save">
              Lưu
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!locked ? (
          <div className="grid gap-3 rounded-xl border border-line bg-slate-50 p-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Tình trạng phòng
              <select className={FIELD} value={statusCode} onChange={(e) => setStatusCode(e.target.value)} data-testid="task-code">
                {(catalog.data?.statusCodes ?? [task.statusCode]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Người được giao
              <select
                className={FIELD}
                value={assignee}
                disabled={task.state === 'COMPLETED'}
                onChange={(e) => setAssignee(e.target.value === '' ? '' : Number(e.target.value))}
                data-testid="task-assignee"
              >
                <option value="">— Chưa giao —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} className="h-5 w-5 accent-red-600" data-testid="task-priority" />
              Ưu tiên — cần dọn trước
            </label>
            <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
              Ghi chú / chỉ dẫn
              <textarea className={FIELD} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="task-note" />
            </label>
          </div>
        ) : null}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
        <RoomTaskDetail task={task} catalog={catalog.data} />
      </div>
      {voiding ? (
        <Modal
          open
          title="Xóa công việc phòng"
          onClose={() => setVoiding(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setVoiding(false)}>
                Hủy
              </Button>
              <Button onClick={() => remove.mutate()} loading={remove.isPending} className="!bg-rose-600 hover:!bg-rose-700" data-testid="task-void-confirm">
                Xóa
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-slate-700">
            <p>Phòng {task.roomNumber} sẽ rời khỏi bảng ngày {formatDate(task.workDate)}. Kiểm phòng, phát sinh, thu tiền và lịch sử vẫn được giữ.</p>
            <label className="block font-medium">
              Lý do <span className="font-normal text-slate-500">(không bắt buộc)</span>
              <input className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-testid="task-void-reason" />
            </label>
            {remove.isError ? <ErrorAlert>{toUserMessage(remove.error)}</ErrorAlert> : null}
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Tình trạng phòng — the board, and setting rooms up on it
 * ------------------------------------------------------------------ */

export function HkRoomBoardPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(false);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<RoomTask | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [code, setCode] = useState('');
  const [priority, setPriority] = useState(false);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState<number | ''>('');
  const [typed, setTyped] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const staff = useQuery({ queryKey: [...ROOM_WORK_KEY, 'staff'], queryFn: () => roomWorkApi.staff() });
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.tasks({ date, branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    refetchInterval: 30_000,
  });
  const { rooms } = useBranchRooms(scope.branchId ?? null);
  const live = tasks.data?.tasks ?? [];
  const onBoard = new Set(live.map((t) => t.roomNumber));
  const free = (rooms ?? []).filter((r) => !onBoard.has(r));
  const chosen = rooms ? [...picked] : typed.split(/[\s,;]+/).filter(Boolean);
  const effectiveCode = code || catalog.data?.statusCodes[0] || '';

  const create = useMutation({
    mutationFn: () =>
      roomWorkApi.createTasks({
        branchId: scope.branchId,
        workDate: date,
        roomNumbers: chosen,
        statusCode: effectiveCode,
        priority,
        note: note.trim() || undefined,
        assigneeUserId: assignee === '' ? null : assignee,
      }),
    onSuccess: async (r) => {
      setPicked(new Set());
      setTyped('');
      setNote('');
      setPriority(false);
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      setToast(r.skipped.length ? `Đã thêm ${r.created} phòng; ${r.skipped.join(', ')} đã có trên bảng.` : `Đã thêm ${r.created} phòng vào bảng.`);
    },
  });

  return (
    <div>
      <PageHeader title={`Tình trạng phòng ngày ${formatDate(date)}`} description="Mã phòng, ưu tiên, ghi chú và người dọn cho từng phòng trong ngày." />
      <DayBar date={date} onDate={setDate} picker={scope.picker} />
      {scope.branchId === undefined ? (
        <PickBranchFirst />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="space-y-3 rounded-2xl border border-line bg-white p-4">
            <RoomStateLegend />
            <QueryState isLoading={tasks.isLoading} isError={tasks.isError} error={tasks.error} onRetry={() => void tasks.refetch()}>
              {live.length === 0 ? (
                <p className="text-sm text-slate-500">Chưa có phòng nào trên bảng ngày này.</p>
              ) : (
                <RoomBoard tasks={live} codes={catalog.data?.statusCodes ?? []} onSelect={setOpen} labelOf={(t) => t.assignee?.name ?? 'Chưa giao'} />
              )}
            </QueryState>
          </section>
          <section className="space-y-3 rounded-2xl border border-line bg-white p-4" data-testid="board-setup">
            <h2 className="text-sm font-bold text-slate-900">Thêm phòng vào bảng</h2>
            {rooms ? (
              <div className="flex flex-wrap gap-1.5" data-testid="free-rooms">
                {free.length === 0 ? <p className="text-sm text-slate-500">Mọi phòng đã có trên bảng.</p> : null}
                {free.map((r) => (
                  <RoomChip
                    key={r}
                    task={{ id: r, roomNumber: r, state: 'NOT_STARTED', priority: false, stateLabel: 'Chưa xếp' }}
                    selected={picked.has(r)}
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(r)) next.delete(r);
                        else next.add(r);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <label className="block text-sm font-medium text-slate-700">
                Số phòng (cách nhau bởi dấu phẩy)
                <input className={FIELD} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="101, 102" data-testid="typed-rooms" />
              </label>
            )}
            <label className="block text-sm font-medium text-slate-700">
              Tình trạng phòng
              <select className={FIELD} value={effectiveCode} onChange={(e) => setCode(e.target.value)} data-testid="setup-code">
                {(catalog.data?.statusCodes ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Người dọn
              <select className={FIELD} value={assignee} onChange={(e) => setAssignee(e.target.value === '' ? '' : Number(e.target.value))} data-testid="setup-assignee">
                <option value="">— Giao sau —</option>
                {(staff.data?.staff ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} className="h-5 w-5 accent-red-600" data-testid="setup-priority" />
              Ưu tiên — cần dọn trước
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Ghi chú / chỉ dẫn
              <textarea className={FIELD} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: dọn trước 14:00" data-testid="setup-note" />
            </label>
            {create.isError ? <ErrorAlert>{toUserMessage(create.error)}</ErrorAlert> : null}
            <Button className="w-full" disabled={chosen.length === 0 || !effectiveCode} loading={create.isPending} onClick={() => create.mutate()} data-testid="setup-submit">
              Thêm {chosen.length || ''} phòng
            </Button>
          </section>
        </div>
      )}
      {open ? (
        <TaskDialog
          task={open}
          staff={staff.data?.staff ?? []}
          onClose={() => setOpen(null)}
          onChanged={(msg) => {
            setOpen(null);
            setToast(msg);
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Phân công công việc
 * ------------------------------------------------------------------ */

export function HkAssignPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(false);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<RoomTask | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const staff = useQuery({ queryKey: [...ROOM_WORK_KEY, 'staff'], queryFn: () => roomWorkApi.staff() });
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.tasks({ date, branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    refetchInterval: 30_000,
  });
  const assign = useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: number | null }) => roomWorkApi.assign(id, userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      setToast('Đã giao việc.');
    },
    onError: (e) => setToast(toUserMessage(e)),
  });
  const columns: DataColumn<RoomTask>[] = [
    { key: 'room', header: 'Phòng', render: (t) => <span className="text-base font-bold">{t.roomNumber}</span> },
    { key: 'code', header: 'Tình trạng phòng', render: (t) => t.statusCode },
    { key: 'priority', header: 'Ưu tiên', render: (t) => (t.priority ? <span className="font-semibold text-red-600">Ưu tiên</span> : '—') },
    {
      key: 'assignee',
      header: 'Người được giao',
      render: (t) => (
        <select
          aria-label={`Người được giao phòng ${t.roomNumber}`}
          value={t.assignee?.id ?? ''}
          disabled={t.state === 'COMPLETED' || assign.isPending}
          onChange={(e) => assign.mutate({ id: t.id, userId: e.target.value === '' ? null : Number(e.target.value) })}
          data-testid={`assign-${t.roomNumber}`}
          className="min-h-[2.5rem] rounded-lg border border-line-strong bg-white px-2 text-sm"
        >
          <option value="">— Chưa giao —</option>
          {(staff.data?.staff ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
      ),
    },
    { key: 'state', header: 'Trạng thái', render: (t) => t.stateLabel },
    { key: 'started', header: 'Thời gian bắt đầu', render: (t) => (t.startedAt ? formatDateTime(t.startedAt) : '—') },
    { key: 'completed', header: 'Thời gian hoàn thành', render: (t) => (t.completedAt ? formatDateTime(t.completedAt) : '—') },
  ];
  return (
    <div>
      <PageHeader title="Phân công công việc" description={`Ai dọn phòng nào ngày ${formatDate(date)} — giao, giao lại và lịch sử.`} />
      <DayBar date={date} onDate={setDate} picker={scope.picker} />
      {scope.branchId === undefined ? (
        <PickBranchFirst />
      ) : (
        <DataTable
          title="Phòng trong ngày"
          testId="assign-table"
          columns={columns}
          rows={[...(tasks.data?.tasks ?? [])].sort((a, b) => Number(b.priority) - Number(a.priority) || a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true }))}
          rowKey={(t) => t.id}
          isLoading={tasks.isLoading}
          isError={tasks.isError}
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
          emptyTitle="Chưa có phòng trên bảng"
          emptyMessage="Thêm phòng ở “Tình trạng phòng”, rồi giao việc tại đây."
          actions={(t) => (
            <RowAction onClick={() => setOpen(t)} testId={`task-open-${t.roomNumber}`}>
              Chi tiết
            </RowAction>
          )}
        />
      )}
      {open ? (
        <TaskDialog
          task={open}
          staff={staff.data?.staff ?? []}
          onClose={() => setOpen(null)}
          onChanged={(msg) => {
            setOpen(null);
            setToast(msg);
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared: the period filter for the reporting screens
 * ------------------------------------------------------------------ */

function usePeriodScope() {
  const today = hcmToday();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const [filter, setFilter] = useState<ReportFilterValue>(() => initialReportFilter(today, { branch: isAdmin ? 'ALL' : null }));
  const period = reportPeriod(filter, today);
  const scope = period ? { from: period.from, to: period.to, branchId: isAdmin ? reportBranchId(filter) : undefined } : null;
  const bar = (
    <ReportFilterBar
      value={filter}
      onChange={setFilter}
      today={today}
      branches={isAdmin ? (branches.data?.branches ?? []) : undefined}
      showShifts={false}
      testId="hk-period"
    />
  );
  return { scope, bar };
}

/* ------------------------------------------------------------------ *
 * Theo dõi nhân viên
 * ------------------------------------------------------------------ */

export function HkStaffPage() {
  const { scope, bar } = usePeriodScope();
  const [open, setOpen] = useState<StaffProgressRow | null>(null);
  const rows = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff-progress', scope],
    queryFn: () => roomWorkApi.staffProgress(scope!),
    enabled: scope !== null,
  });
  const columns: DataColumn<StaffProgressRow>[] = [
    { key: 'name', header: 'Nhân viên', render: (r) => <span className="font-medium">{r.fullName}</span> },
    { key: 'assigned', header: 'Số phòng được giao', align: 'right', render: (r) => r.assigned },
    { key: 'notStarted', header: 'Chưa bắt đầu', align: 'right', render: (r) => r.notStarted },
    { key: 'inProgress', header: 'Đang dọn', align: 'right', render: (r) => r.inProgress },
    { key: 'completed', header: 'Hoàn thành', align: 'right', render: (r) => r.completed },
    { key: 'rate', header: 'Tỷ lệ hoàn thành', align: 'right', render: (r) => `${r.completionRate}%` },
    { key: 'inspections', header: 'Lượt kiểm phòng', align: 'right', render: (r) => r.inspections },
    { key: 'collected', header: 'Tổng tiền thu được', align: 'right', render: (r) => formatVnd(r.collectedAmount) },
  ];
  return (
    <div>
      <PageHeader title="Theo dõi nhân viên" description="Tiến độ, kiểm phòng và tiền thu được của từng nhân viên buồng phòng." />
      {bar}
      <DataTable
        title="Nhân viên"
        testId="staff-table"
        columns={columns}
        rows={rows.data?.rows ?? []}
        rowKey={(r) => String(r.userId)}
        isLoading={rows.isLoading}
        isError={rows.isError}
        error={rows.error}
        onRetry={() => void rows.refetch()}
        emptyTitle="Chưa có dữ liệu"
        emptyMessage="Nhân viên được giao phòng hoặc kiểm phòng trong khoảng này sẽ hiện ở đây."
        actions={(r) => (
          <RowAction onClick={() => setOpen(r)} testId={`staff-open-${r.userId}`}>
            Chi tiết
          </RowAction>
        )}
      />
      {open && scope ? <StaffDetailModal userId={open.userId} name={open.fullName} scope={scope} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

const FINDING_COLUMNS: DataColumn<FindingLine>[] = [
  { key: 'when', header: 'Thời gian', render: (f) => formatDateTime(f.createdAt) },
  { key: 'room', header: 'Phòng', render: (f) => `${f.roomNumber} · CN ${f.branch.branchNumber}` },
  { key: 'type', header: 'Phát sinh', render: (f) => (f.note ? `${f.typeLabel} — ${f.note}` : f.typeLabel) },
  { key: 'inspector', header: 'Người kiểm phòng', render: (f) => f.inspectorName },
  { key: 'status', header: 'Thu tiền', render: (f) => f.collectionStatusLabel },
  { key: 'amount', header: 'Số tiền', align: 'right', render: (f) => (f.amount === null ? '—' : formatVnd(f.amount)) },
  { key: 'by', header: 'Lễ tân xác nhận', secondary: true, render: (f) => (f.collectedByName ? `${f.collectedByName}${f.collectedAt ? ` · ${formatDateTime(f.collectedAt)}` : ''}` : '—') },
];

function StaffDetailModal({ userId, name, scope, onClose }: { userId: number; name: string; scope: { from: string; to: string; branchId?: number }; onClose: () => void }) {
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const detail = useQuery({ queryKey: [...ROOM_WORK_KEY, 'staff', userId, scope], queryFn: () => roomWorkApi.staffDetail(userId, scope) });
  const [openTask, setOpenTask] = useState<string | null>(null);
  const d = detail.data;
  return (
    <Modal open size="4xl" title={`Nhân viên: ${name}`} onClose={onClose}>
      <QueryState isLoading={detail.isLoading} isError={detail.isError} error={detail.error}>
        {d ? (
          <div className="space-y-4" data-testid="staff-detail">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Lượt kiểm phòng" value={d.kpi.inspections} icon={ClipboardList} />
              <StatCard label="Phát sinh" value={d.kpi.findings} icon={ListChecks} tone="amber" />
              <StatCard label="Đã thu" value={formatVnd(d.kpi.collectedAmount)} icon={Wallet} tone="green" />
              <StatCard label="Chưa thu" value={formatVnd(d.kpi.pendingAmount)} icon={Coins} tone="red" />
            </div>
            <section>
              <h3 className="mb-2 text-sm font-bold text-slate-900">Phòng ({d.tasks.length})</h3>
              <ul className="space-y-2">
                {d.tasks.map((t) => (
                  <li key={t.id} className="rounded-xl border border-line">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                      onClick={() => setOpenTask(openTask === t.id ? null : t.id)}
                      data-testid={`staff-task-${t.id}`}
                    >
                      <span className="font-semibold">
                        {formatDate(t.workDate)} · Phòng {t.roomNumber} · {t.statusCode}
                        {t.voided ? ' · đã xóa' : ''}
                      </span>
                      <span className="text-slate-600">
                        {t.stateLabel} · {formatMinutes(t.durationSeconds ?? t.elapsedSeconds)}
                      </span>
                    </button>
                    {openTask === t.id ? (
                      <div className="border-t border-line px-3 py-3">
                        <RoomTaskDetail task={t} catalog={catalog.data} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <DataTable title="Phát sinh khi kiểm phòng" testId="staff-findings" columns={FINDING_COLUMNS} rows={d.findings} rowKey={(f) => f.id} emptyTitle="Không có phát sinh" emptyMessage="" />
            <section>
              <h3 className="mb-2 text-sm font-bold text-slate-900">Ca làm việc</h3>
              {d.shifts.length === 0 ? (
                <p className="text-sm text-slate-500">Không có ca trong khoảng này.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {d.shifts.flatMap((s) =>
                    s.segments.map((seg) => (
                      <li key={seg.id}>
                        {branchLabel(seg.branch)} · {formatDateTime(seg.startedAt)} – {seg.endedAt ? formatDateTime(seg.endedAt) : 'đang làm'}
                      </li>
                    )),
                  )}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </QueryState>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * KPI & Thu tiền
 * ------------------------------------------------------------------ */

export function HkKpiPage() {
  const { scope, bar } = usePeriodScope();
  const [userId, setUserId] = useState<number | ''>('');
  const [status, setStatus] = useState<RoomCollectionStatus | ''>('');
  const [open, setOpen] = useState<KpiRow | null>(null);
  const staff = useQuery({ queryKey: [...ROOM_WORK_KEY, 'staff'], queryFn: () => roomWorkApi.staff() });
  const params = scope ? { ...scope, userId: userId === '' ? undefined : userId, status: status || undefined } : null;
  const kpi = useQuery({ queryKey: [...ROOM_WORK_KEY, 'kpi', params], queryFn: () => roomWorkApi.kpi(params!), enabled: params !== null });
  const columns: DataColumn<KpiRow>[] = [
    { key: 'name', header: 'Nhân viên', render: (r) => <span className="font-medium">{r.fullName}</span> },
    { key: 'inspections', header: 'Lượt kiểm phòng', align: 'right', render: (r) => r.inspections },
    { key: 'findings', header: 'Phát sinh', align: 'right', render: (r) => r.findings },
    { key: 'collected', header: 'Đã thu', align: 'right', render: (r) => r.collectedCount },
    { key: 'pending', header: 'Chưa thu', align: 'right', render: (r) => r.pendingCount },
    { key: 'amount', header: 'Tổng tiền đã thu', align: 'right', render: (r) => formatVnd(r.collectedAmount) },
  ];
  const totals = kpi.data?.totals;
  return (
    <div>
      <PageHeader title="KPI & Thu tiền" description="Phát sinh mỗi nhân viên ghi nhận khi kiểm phòng, và số tiền lễ tân đã thu từ các phát sinh đó." />
      {bar}
      <section className="mb-4 grid gap-3 rounded-xl border border-line bg-white px-4 py-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Nhân viên
          <select className={FIELD} value={userId} onChange={(e) => setUserId(e.target.value === '' ? '' : Number(e.target.value))} data-testid="kpi-employee">
            <option value="">Tất cả</option>
            {(staff.data?.staff ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Trạng thái thu tiền
          <select className={FIELD} value={status} onChange={(e) => setStatus(e.target.value as RoomCollectionStatus | '')} data-testid="kpi-status">
            <option value="">Tất cả</option>
            <option value="COLLECTED">Đã thu</option>
            <option value="PENDING">Chưa thu</option>
            <option value="UNCOLLECTIBLE">Không thu được</option>
          </select>
        </label>
      </section>
      {totals ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="kpi-totals">
          <StatCard label="Lượt kiểm phòng" value={totals.inspections} icon={ClipboardList} />
          <StatCard label="Phát sinh" value={totals.findings} icon={ListChecks} tone="amber" />
          <StatCard label="Tổng tiền đã thu" value={formatVnd(totals.collectedAmount)} icon={Wallet} tone="green" />
          <StatCard label="Chưa thu" value={formatVnd(totals.pendingAmount)} icon={Coins} tone="red" />
        </div>
      ) : null}
      <DataTable
        title="KPI theo nhân viên"
        testId="kpi-table"
        columns={columns}
        rows={kpi.data?.rows ?? []}
        rowKey={(r) => String(r.userId)}
        isLoading={kpi.isLoading}
        isError={kpi.isError}
        error={kpi.error}
        onRetry={() => void kpi.refetch()}
        emptyTitle="Chưa có dữ liệu"
        emptyMessage="Lượt kiểm phòng trong khoảng này sẽ hiện ở đây."
        actions={(r) => (
          <RowAction onClick={() => setOpen(r)} testId={`kpi-open-${r.userId}`}>
            Chi tiết
          </RowAction>
        )}
      />
      {open && scope ? <KpiDetailModal row={open} scope={scope} status={status || undefined} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function KpiDetailModal({ row, scope, status, onClose }: { row: KpiRow; scope: { from: string; to: string; branchId?: number }; status?: RoomCollectionStatus; onClose: () => void }) {
  const detail = useQuery({ queryKey: [...ROOM_WORK_KEY, 'kpi-detail', row.userId, scope, status], queryFn: () => roomWorkApi.kpi({ ...scope, userId: row.userId, status }) });
  return (
    <Modal open size="4xl" title={`KPI: ${row.fullName}`} onClose={onClose}>
      <DataTable
        title="Phát sinh và thu tiền"
        testId="kpi-findings"
        columns={FINDING_COLUMNS}
        rows={detail.data?.findings ?? []}
        rowKey={(f) => f.id}
        isLoading={detail.isLoading}
        isError={detail.isError}
        error={detail.error}
        emptyTitle="Không có phát sinh"
        emptyMessage=""
      />
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Báo cáo
 * ------------------------------------------------------------------ */

export function HkReportPage() {
  const { scope, bar } = usePeriodScope();
  const report = useQuery({ queryKey: [...ROOM_WORK_KEY, 'report', scope], queryFn: () => roomWorkApi.report(scope!), enabled: scope !== null });
  const columns = useMemo<DataColumn<OperationsRow>[]>(
    () => [
      { key: 'branch', header: 'Chi nhánh', render: (r) => r.branchLabel },
      { key: 'date', header: 'Ngày', render: (r) => formatDate(r.workDate) },
      { key: 'employee', header: 'Nhân viên', render: (r) => r.employee },
      { key: 'assigned', header: 'Được giao', align: 'right', render: (r) => r.assigned },
      { key: 'completed', header: 'Hoàn thành', align: 'right', render: (r) => `${r.completed} (${r.completionRate}%)` },
      { key: 'inspections', header: 'Kiểm phòng', align: 'right', render: (r) => r.inspections },
      { key: 'findings', header: 'Phát sinh', align: 'right', render: (r) => r.findings },
      { key: 'avg', header: 'TB dọn phòng', render: (r) => formatMinutes(r.avgCleaningSeconds) },
      { key: 'collected', header: 'Đã thu', align: 'right', render: (r) => formatVnd(r.collectedAmount) },
      { key: 'pending', header: 'Chưa thu', align: 'right', render: (r) => `${formatVnd(r.pendingAmount)} (${r.pendingCount})` },
      {
        key: 'notes',
        header: 'Ghi chú',
        secondary: true,
        render: (r) => [r.voided ? `${r.voided} phòng đã xóa` : '', r.notes ? `${r.notes} ghi chú` : ''].filter(Boolean).join(', ') || '—',
      },
    ],
    [],
  );
  const link = (kind: 'pdf' | 'xlsx', text: string) => (
    <a
      href={scope ? housekeepingReportUrl(kind, scope) : undefined}
      aria-disabled={scope ? undefined : true}
      data-testid={`hk-report-${kind}`}
      className={`inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${scope ? '' : 'pointer-events-none opacity-50'}`}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {text}
    </a>
  );
  return (
    <div>
      <PageHeader
        title="Báo cáo vận hành buồng phòng"
        description="Theo chi nhánh, ngày và nhân viên: phòng được giao và hoàn thành, kiểm phòng, phát sinh, thời gian dọn, tiền đã thu và chưa thu."
        actions={
          <div className="flex gap-2">
            {link('pdf', 'Xuất PDF')}
            {link('xlsx', 'Xuất Excel')}
          </div>
        }
      />
      {bar}
      <DataTable
        title="Vận hành buồng phòng"
        testId="hk-report"
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(r) => `${r.branchLabel}|${r.workDate}|${r.employee}`}
        isLoading={report.isLoading}
        isError={report.isError}
        error={report.error}
        onRetry={() => void report.refetch()}
        emptyTitle="Chưa có dữ liệu"
        emptyMessage="Công việc buồng phòng trong khoảng này sẽ hiện ở đây."
      />
    </div>
  );
}
