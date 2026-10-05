/**
 * "QUẢN LÝ BUỒNG PHÒNG" — six focused screens over one branch's housekeeping
 * (the Admin: any branch, with a branch picker):
 *
 *   Tổng quan            the day at a glance, and the way into the rest
 *   Tình trạng phòng     the board: rooms being cleaned, rooms waiting for "Đạt" /
 *                        "Không đạt", and the rooms that can be added again
 *   Phân công công việc  who has which room; assign, reassign, history
 *   Theo dõi nhân viên   per worker: rooms and progress — every detail one click down
 *   KPI & Thu tiền       findings and collections credited to each worker
 *   Báo cáo              the operations report, PDF and Excel
 *
 * Every screen opens with the same context — "Quản lý buồng phòng · Chi nhánh ·
 * Ngày nghiệp vụ" — then its own title. The SERVER scopes every read and write
 * to the manager's branch (and offers only that branch's own workers); these
 * screens only ask. Every action is recorded in the room's history.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BedDouble, ClipboardCheck, Download, FileSpreadsheet, FileText, Users, Wallet, type LucideIcon } from 'lucide-react';
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
import { DataTable, type DataColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { QueryState } from '../components/PageState';
import { BranchPicker, ReportFilterBar } from '../components/ReportFilter';
import { RoomTaskDetail } from '../components/RoomTaskDetail';
import { Toast } from '../components/Toast';
import {
  Badge,
  CodeTag,
  HkHeader,
  HkSection,
  ManagerLegend,
  ManagerRoomBoard,
  Metric,
  PickChip,
  PriorityBadge,
  ProgressBar,
  RateBar,
  ReviewCard,
  StateBadge,
  type Tone,
} from '../components/HkManagerUi';
import { initialReportFilter, reportBranchId, reportPeriod, type BranchChoice, type ReportFilterValue } from '../lib/reportFilter';
import { formatVnd } from '../lib/money';
import { formatDate, formatDateTime, hcmTimeOfDay, hcmToday } from '../lib/format';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const LABEL = 'block text-sm font-medium text-slate-700';

/** A row's action: small, but a real tap target. */
const ROW_BUTTON =
  'inline-flex min-h-[2.25rem] items-center gap-1 whitespace-nowrap rounded-lg border border-line-strong bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const SECTION_LINK =
  'inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 rounded';

/** A column the phone folds into the row's first cell instead. */
const WIDE = 'hidden md:table-cell';

/** "08:42", Asia/Ho_Chi_Minh. */
const hhmm = (iso: string | null) => (iso ? hcmTimeOfDay(new Date(iso)) : '—');

/* ------------------------------------------------------------------ *
 * The manager's branch (fixed) or the Admin's choice
 * ------------------------------------------------------------------ */

function useScope(allowAll: boolean) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const [choice, setChoice] = useState<BranchChoice>(allowAll ? 'ALL' : null);
  const list = branches.data?.branches ?? [];
  const branchId = isAdmin ? (typeof choice === 'number' ? choice : undefined) : (user?.branch?.id ?? undefined);
  const ready = !isAdmin || choice !== null;
  const chosen = typeof choice === 'number' ? list.find((b) => b.id === choice) : undefined;
  const label = !isAdmin
    ? user?.branch
      ? branchLabel(user.branch as Branch)
      : '—'
    : choice === 'ALL'
      ? 'Tất cả chi nhánh'
      : chosen
        ? branchLabel(chosen)
        : 'Chưa chọn';
  const picker: ReactNode = isAdmin ? (
    <div className="w-full sm:w-72">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Chi nhánh</p>
      <BranchPicker value={choice} onChange={setChoice} branches={list} allowAll={allowAll} />
    </div>
  ) : null;
  return { isAdmin, branchId, ready, picker, label };
}

function DateField({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  return (
    // The label on its own line, a modest gap, then the field — the KAS form rhythm.
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Ngày</span>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onDate(e.target.value)}
        data-testid="hk-date"
        className={`${FIELD} !mt-0 sm:w-44`}
      />
    </label>
  );
}

function PickBranchFirst() {
  return <EmptyState icon={<BedDouble className="h-6 w-6" aria-hidden="true" />} title="Chọn chi nhánh" message="Chọn một chi nhánh để xem công việc buồng phòng." />;
}

/**
 * The day's cycles by where each stands: being cleaned (Chưa bắt đầu, Đang dọn,
 * Cần dọn lại), waiting for the manager (Chờ đánh giá), or reviewed.
 */
function splitBoard(tasks: RoomTask[]) {
  const active = tasks.filter((t) => t.state !== 'COMPLETED');
  return {
    active,
    awaiting: tasks.filter((t) => t.review?.status === 'PENDING').sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? '')),
    notStarted: active.filter((t) => t.state === 'NOT_STARTED' && !t.reclean).length,
    inProgress: active.filter((t) => t.state === 'IN_PROGRESS').length,
    reclean: active.filter((t) => t.state === 'NOT_STARTED' && t.reclean).length,
    passed: tasks.filter((t) => t.review?.status === 'PASSED').length,
    priority: active.filter((t) => t.priority).length,
  };
}

/** One cycle in a word: Chưa bắt đầu / Cần dọn lại / Đang dọn / Chờ đánh giá / Đạt / Không đạt (— dọn lại). */
function cycleOutcome(t: RoomTask): string {
  if (t.review) return t.review.status === 'FAILED' && t.review.recleanRequested ? `${t.review.label} — dọn lại` : t.review.label;
  if (t.state === 'NOT_STARTED' && t.reclean) return 'Cần dọn lại';
  return t.stateLabel;
}

function CycleBadge({ task }: { task: RoomTask }) {
  if (task.review?.status === 'PENDING') return <Badge tone="amber">Chờ đánh giá</Badge>;
  if (task.review?.status === 'PASSED') return <Badge tone="green">Đạt</Badge>;
  if (task.review?.status === 'FAILED') return <Badge tone="red">Không đạt</Badge>;
  if (task.reclean && task.state === 'NOT_STARTED') return <Badge tone="red">Cần dọn lại</Badge>;
  return <StateBadge state={task.state} label={task.stateLabel} />;
}

/** Every cleaning cycle of the room that day: who, when, how long, and the review. */
function CycleHistory({ task }: { task: RoomTask }) {
  const history = useQuery({ queryKey: [...ROOM_WORK_KEY, 'history', task.id], queryFn: () => roomWorkApi.history(task.id) });
  const cycles = history.data?.cycles ?? [];
  const latest = cycles.filter((c) => !c.voided).at(-1);
  const fact = (label: string, value: string) => (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-slate-500">{label}:</dt>
      <dd className="min-w-0 text-slate-900">{value}</dd>
    </div>
  );
  return (
    <section data-testid="cycle-history">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Lịch sử các lần dọn</h3>
      <QueryState isLoading={history.isLoading} isError={history.isError} error={history.error}>
        {latest ? (
          <p className="mb-2 text-sm" data-testid="cycle-current">
            <span className="text-slate-500">Hiện tại: </span>
            <span className="font-semibold text-slate-900">{cycleOutcome(latest)}</span>
          </p>
        ) : null}
        <ol className="space-y-2">
          {cycles.map((c) => (
            <li
              key={c.id}
              data-testid={`cycle-${c.cycleNumber}`}
              className={`rounded-lg border px-3 py-2 text-sm ${c.id === task.id ? 'border-brand-300 bg-brand-50/40' : 'border-line-subtle bg-white'}`}
            >
              <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                Lần dọn #{c.cycleNumber}
                <CycleBadge task={c} />
                {c.voided ? <Badge tone="slate">đã xóa</Badge> : null}
              </p>
              <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {fact('Người dọn', c.cleanedBy?.name ?? c.assignee?.name ?? '—')}
                {fact('Thời gian', `${hhmm(c.startedAt)} → ${hhmm(c.completedAt)} · ${formatMinutes(c.durationSeconds)}`)}
                {c.review && c.review.status !== 'PENDING'
                  ? fact('Người đánh giá', `${c.review.reviewedByName ?? '—'} · ${hhmm(c.review.reviewedAt)}`)
                  : null}
                {c.review?.status === 'FAILED' ? fact('Yêu cầu dọn lại', c.review.recleanRequested ? 'Có' : 'Không') : null}
              </dl>
              {c.review?.status === 'FAILED' ? (
                <p className="mt-1 text-red-800">
                  <span className="text-slate-500">Lý do: </span>
                  {c.review.failureReason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </QueryState>
    </section>
  );
}

/** "Đạt": confirmed once — a review cannot be changed afterwards. */
function PassDialog({ task, onClose, onDone }: { task: RoomTask; onClose: () => void; onDone: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const pass = useMutation({
    mutationFn: () => roomWorkApi.review(task.id, { result: 'PASSED' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onDone(`Phòng ${task.roomNumber}: Đạt.`);
    },
  });
  return (
    <Modal
      open
      title={`Đạt — Phòng ${task.roomNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => pass.mutate()} loading={pass.isPending} className="!bg-green-600 hover:!bg-green-700" data-testid="pass-confirm">
            Đạt
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Phòng {task.roomNumber}
          {task.cycleNumber > 1 ? ` (lần dọn ${task.cycleNumber})` : ''} đạt yêu cầu. Phòng trở lại “Thêm phòng vào bảng”. Kết quả đánh giá không thể sửa sau khi lưu.
        </p>
        {pass.isError ? <ErrorAlert>{toUserMessage(pass.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** "Không đạt": the reason is required; "Yêu cầu dọn lại" opens the next cycle for a worker of the branch. */
function FailDialog({ task, staff, onClose, onDone }: { task: RoomTask; staff: { id: number; fullName: string }[]; onClose: () => void; onDone: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reclean, setReclean] = useState(true);
  const [assignee, setAssignee] = useState<number | ''>(task.assignee?.id ?? '');
  const people = task.assignee && !staff.some((x) => x.id === task.assignee!.id) ? [{ id: task.assignee.id, fullName: task.assignee.name }, ...staff] : staff;
  const fail = useMutation({
    mutationFn: () =>
      roomWorkApi.review(task.id, {
        result: 'FAILED',
        reason: reason.trim(),
        reclean,
        ...(reclean ? { assigneeUserId: assignee === '' ? null : assignee } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onDone(reclean ? `Phòng ${task.roomNumber}: Không đạt — đã yêu cầu dọn lại.` : `Phòng ${task.roomNumber}: Không đạt.`);
    },
  });
  return (
    <Modal
      open
      title={`Không đạt — Phòng ${task.roomNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button variant="danger" onClick={() => fail.mutate()} disabled={!reason.trim()} loading={fail.isPending} data-testid="fail-confirm">
            Xác nhận không đạt
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className={LABEL}>
          Lý do không đạt <span className="text-red-600">*</span>
          <textarea
            className={FIELD}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Thiếu khăn tắm"
            data-testid="fail-reason"
          />
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={reclean} onChange={(e) => setReclean(e.target.checked)} className="h-5 w-5 accent-red-600" data-testid="fail-reclean" />
          Yêu cầu dọn lại
        </label>
        {reclean ? (
          <label className={LABEL}>
            Giao dọn lại cho
            <select className={FIELD} value={assignee} onChange={(e) => setAssignee(e.target.value === '' ? '' : Number(e.target.value))} data-testid="fail-assignee">
              <option value="">— Chưa giao —</option>
              {people.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm text-slate-500">Không dọn lại: phòng trở lại “Thêm phòng vào bảng”.</p>
        )}
        {fail.isError ? <ErrorAlert>{toUserMessage(fail.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Tổng quan
 * ------------------------------------------------------------------ */

const QUICK: { to: string; label: string; hint: string; icon: LucideIcon }[] = [
  { to: '/app/hk/rooms', label: 'Tình trạng phòng', hint: 'Bảng phòng trong ngày', icon: BedDouble },
  { to: '/app/hk/assign', label: 'Phân công công việc', hint: 'Giao và giao lại phòng', icon: ClipboardCheck },
  { to: '/app/hk/staff', label: 'Theo dõi nhân viên', hint: 'Tiến độ từng người', icon: Users },
  { to: '/app/hk/kpi', label: 'KPI & Thu tiền', hint: 'Phát sinh và tiền đã thu', icon: Wallet },
  { to: '/app/hk/report', label: 'Báo cáo', hint: 'Xuất PDF và Excel', icon: FileText },
];

function QuickLinks() {
  return (
    <nav aria-label="Truy cập nhanh" data-testid="hk-quick">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Truy cập nhanh</h2>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        {QUICK.map(({ to, label, hint, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex min-h-[3.5rem] items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-2.5 transition-colors hover:border-brand-500 hover:bg-brand-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-900">{label}</span>
              <span className="block truncate text-xs text-slate-500">{hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

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
  const everyBranch = scope.isAdmin && scope.branchId === undefined;
  return (
    <div>
      <HkHeader
        title="Tổng quan"
        description="Tình hình buồng phòng trong ngày: phòng, nhân viên đang làm và tiến độ."
        branch={scope.label}
        period={{ label: 'Ngày nghiệp vụ', value: formatDate(date) }}
        controls={
          <>
            <DateField date={date} onDate={setDate} />
            {scope.picker}
          </>
        }
      />
      <QueryState isLoading={data.isLoading} isError={data.isError} error={data.error} onRetry={() => void data.refetch()}>
        {o ? (
          <div className="space-y-5" data-testid="hk-overview">
            <HkSection
              title="Phòng trong ngày"
              testId="hk-overview-rooms"
              aside={
                <span className="text-sm text-slate-600">
                  <span className="font-semibold tabular-nums text-slate-900">
                    {o.rooms.completed}/{o.rooms.total}
                  </span>{' '}
                  phòng hoàn thành
                </span>
              }
            >
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
                <Metric label="Tổng phòng" value={o.rooms.total} />
                <Metric label="Chưa bắt đầu" value={o.rooms.notStarted} tone="gray" />
                <Metric label="Đang dọn" value={o.rooms.inProgress} tone="blue" />
                <Metric label="Hoàn thành" value={o.rooms.completed} tone="green" />
                <Metric label="Ưu tiên" value={o.rooms.priority} tone="red" />
                <Metric label="Chưa giao" value={o.rooms.unassigned} tone="amber" />
              </div>
              <div className="mt-3">
                <ProgressBar notStarted={o.rooms.notStarted} inProgress={o.rooms.inProgress} completed={o.rooms.completed} />
              </div>
            </HkSection>

            <div className="grid gap-5 lg:grid-cols-5">
              <HkSection
                title="Tiến độ theo nhân viên"
                className="lg:col-span-3"
                bodyClassName=""
                aside={
                  <Link to="/app/hk/staff" className={SECTION_LINK}>
                    Theo dõi nhân viên <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                }
              >
                {o.employees.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate-500">Chưa giao phòng nào.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm" data-testid="hk-overview-employees">
                      <thead>
                        <tr className="border-b-rule border-line-subtle text-left text-xs uppercase tracking-wide text-slate-600">
                          <th className="px-4 py-2 font-medium">Nhân viên</th>
                          <th className="px-3 py-2 text-right font-medium">Được giao</th>
                          <th className="px-3 py-2 text-right font-medium">Đang dọn</th>
                          <th className="px-3 py-2 text-right font-medium">Hoàn thành</th>
                          <th className="hidden px-4 py-2 font-medium sm:table-cell">Tiến độ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line-subtle">
                        {o.employees.map((e) => (
                          <tr key={e.userId}>
                            <td className="px-4 py-2 font-medium text-slate-900">{e.name}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{e.assigned}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-blue-700">{e.inProgress}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-green-700">{e.completed}</td>
                            <td className="hidden w-40 px-4 py-2 sm:table-cell">
                              <ProgressBar
                                notStarted={Math.max(0, e.assigned - e.inProgress - e.completed)}
                                inProgress={e.inProgress}
                                completed={e.completed}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </HkSection>
              <HkSection
                title="Nhân viên đang trong ca"
                className="lg:col-span-2"
                testId="hk-working"
                aside={<Badge tone={o.working.length > 0 ? 'green' : 'gray'}>{o.working.length} người</Badge>}
              >
                {o.working.length === 0 ? (
                  <p className="text-sm text-slate-500">Chưa có nhân viên vào ca.</p>
                ) : (
                  <ul className="divide-y divide-line-subtle">
                    {o.working.map((w) => (
                      <li key={`${w.userId}-${w.since}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-green-600" aria-hidden="true" />
                          <span className="truncate font-medium text-slate-900">{w.name}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">
                          {everyBranch ? `CN ${w.branch.branchNumber} · ` : ''}từ {hhmm(w.since)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </HkSection>
            </div>

            <HkSection
              title="Kiểm phòng và thu tiền trong ngày"
              aside={
                <Link to="/app/hk/kpi" className={SECTION_LINK}>
                  KPI & Thu tiền <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              }
            >
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <Metric label="Lượt kiểm phòng" value={o.inspections} />
                <Metric label="Phát sinh" value={o.findings} tone="amber" />
                <Metric label="Đã thu từ kiểm phòng" value={formatVnd(o.collectedAmount)} tone="green" />
                <Metric label="Phát sinh chưa thu" value={o.pendingCollections} tone="red" />
              </div>
            </HkSection>

            <QuickLinks />
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
  // A reviewed cycle is history: nothing on it can change.
  const locked = task.voided || (task.review !== null && task.review.status !== 'PENDING');
  // The current assignee stays choosable even when the branch list has moved on.
  const people = task.assignee && !staff.some((s) => s.id === task.assignee!.id) ? [{ id: task.assignee.id, fullName: task.assignee.name }, ...staff] : staff;
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
            <Button variant="secondary" onClick={() => setVoiding(true)} className="mr-auto !border-rose-300 !text-rose-700 hover:!bg-rose-50" data-testid="task-void-open">
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
        <div className="flex flex-wrap items-center gap-2" data-testid="task-facts">
          <CodeTag code={task.statusCode} />
          <CycleBadge task={task} />
          {task.cycleNumber > 1 ? <span className="text-sm font-semibold text-slate-700">Lần dọn {task.cycleNumber}</span> : null}
          {task.priority ? <PriorityBadge /> : null}
          <span className="text-sm text-slate-600">{task.assignee ? `Người dọn: ${task.assignee.name}` : 'Chưa giao'}</span>
        </div>
        {!locked ? (
          <section className="rounded-xl border border-line bg-slate-50 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Điều chỉnh</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={LABEL}>
                Tình trạng phòng
                <select className={FIELD} value={statusCode} onChange={(e) => setStatusCode(e.target.value)} data-testid="task-code">
                  {(catalog.data?.statusCodes ?? [task.statusCode]).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Người được giao
                <select
                  className={FIELD}
                  value={assignee}
                  disabled={task.state === 'COMPLETED'}
                  onChange={(e) => setAssignee(e.target.value === '' ? '' : Number(e.target.value))}
                  data-testid="task-assignee"
                >
                  <option value="">— Chưa giao —</option>
                  {people.map((s) => (
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
              <label className={`${LABEL} sm:col-span-2`}>
                Ghi chú / chỉ dẫn
                <textarea className={FIELD} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="task-note" />
              </label>
            </div>
          </section>
        ) : null}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
        <CycleHistory task={task} />
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
              <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending} data-testid="task-void-confirm">
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

/** The branch's own Buồng phòng accounts — the only people the server lets a room go to. */
function useBranchStaff(branchId: number | undefined) {
  return useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff', 'branch', branchId ?? null],
    queryFn: () => roomWorkApi.staff({ branchId }),
    enabled: branchId !== undefined,
  });
}

/* ------------------------------------------------------------------ *
 * Tình trạng phòng — the board, and setting rooms up on it
 * ------------------------------------------------------------------ */

export function HkRoomBoardPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(false);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<RoomTask | null>(null);
  const [passing, setPassing] = useState<RoomTask | null>(null);
  const [failing, setFailing] = useState<RoomTask | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [code, setCode] = useState('');
  const [priority, setPriority] = useState(false);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState<number | ''>('');
  const [typed, setTyped] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const staff = useBranchStaff(scope.branchId);
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.tasks({ date, branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    refetchInterval: 30_000,
  });
  const { rooms } = useBranchRooms(scope.branchId ?? null);
  const live = tasks.data?.tasks ?? [];
  const b = splitBoard(live);
  // A room is taken while it has an OPEN cycle; a reviewed room can be added again.
  const onBoard = new Set([...b.active, ...b.awaiting].map((t) => t.roomNumber));
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
      <HkHeader
        title={`Tình trạng phòng ngày ${formatDate(date)}`}
        description="Phòng đang thực hiện, phòng chờ đánh giá “Đạt / Không đạt”, và phòng có thể thêm lại. Chọn một phòng để xem chi tiết và lịch sử."
        branch={scope.label}
        period={{ label: 'Ngày nghiệp vụ', value: formatDate(date) }}
        controls={
          <>
            <DateField date={date} onDate={setDate} />
            {scope.picker}
          </>
        }
      />
      {scope.branchId === undefined ? (
        <PickBranchFirst />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7" data-testid="board-summary">
            <Metric label="Đang thực hiện" value={b.active.length} />
            <Metric label="Chưa bắt đầu" value={b.notStarted} tone="gray" />
            <Metric label="Đang dọn" value={b.inProgress} tone="blue" />
            <Metric label="Cần dọn lại" value={b.reclean} tone="red" />
            <Metric label="Chờ đánh giá" value={b.awaiting.length} tone="amber" />
            <Metric label="Đạt" value={b.passed} tone="green" />
            <Metric label="Ưu tiên" value={b.priority} tone="red" />
          </div>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-5">
              <HkSection title="Phòng đang thực hiện" testId="board-active" aside={<ManagerLegend />}>
                <QueryState isLoading={tasks.isLoading} isError={tasks.isError} error={tasks.error} onRetry={() => void tasks.refetch()}>
                  {live.length === 0 ? (
                    <p className="py-6 text-center text-sm text-slate-500">Chưa có phòng nào trên bảng ngày này — thêm phòng ở khung “Thêm phòng vào bảng”.</p>
                  ) : b.active.length === 0 ? (
                    <p className="py-4 text-center text-sm text-slate-500">Không có phòng đang thực hiện.</p>
                  ) : (
                    <ManagerRoomBoard tasks={b.active} codes={catalog.data?.statusCodes ?? []} onSelect={setOpen} />
                  )}
                </QueryState>
              </HkSection>
              <HkSection
                title="Phòng chờ đánh giá"
                testId="board-review"
                accent
                aside={<Badge tone={b.awaiting.length > 0 ? 'amber' : 'gray'}>{b.awaiting.length} phòng</Badge>}
              >
                {b.awaiting.length === 0 ? (
                  <p className="py-2 text-sm text-slate-500">Chưa có phòng chờ đánh giá. Phòng nhân viên bấm “Hoàn thành” sẽ hiện ở đây.</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
                    {b.awaiting.map((t) => (
                      <ReviewCard
                        key={t.id}
                        task={t}
                        finishedAt={hhmm(t.completedAt)}
                        duration={formatMinutes(t.durationSeconds)}
                        onOpen={() => setOpen(t)}
                        onPass={() => setPassing(t)}
                        onFail={() => setFailing(t)}
                      />
                    ))}
                  </div>
                )}
              </HkSection>
            </div>
            <HkSection title="Thêm phòng vào bảng" testId="board-setup" bodyClassName="space-y-4 p-4">
              {rooms ? (
                <div>
                  <p className="mb-1.5 flex items-baseline justify-between gap-2 text-sm font-medium text-slate-700">
                    Chọn phòng
                    <span className="text-xs font-normal text-slate-500">
                      {picked.size > 0 ? `Đã chọn ${picked.size}` : `${free.length} phòng có thể thêm`}
                    </span>
                  </p>
                  <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto" data-testid="free-rooms">
                    {free.length === 0 ? <p className="text-sm text-slate-500">Mọi phòng đã có trên bảng.</p> : null}
                    {free.map((r) => (
                      <PickChip
                        key={r}
                        room={r}
                        selected={picked.has(r)}
                        onToggle={() =>
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
                </div>
              ) : (
                <label className={LABEL}>
                  Số phòng (cách nhau bởi dấu phẩy)
                  <input className={FIELD} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="101, 102" data-testid="typed-rooms" />
                </label>
              )}
              <label className={LABEL}>
                Tình trạng phòng
                <select className={FIELD} value={effectiveCode} onChange={(e) => setCode(e.target.value)} data-testid="setup-code">
                  {(catalog.data?.statusCodes ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
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
              <label className={LABEL}>
                Ghi chú / chỉ dẫn
                <textarea className={FIELD} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: dọn trước 14:00" data-testid="setup-note" />
              </label>
              {create.isError ? <ErrorAlert>{toUserMessage(create.error)}</ErrorAlert> : null}
              <Button className="w-full" disabled={chosen.length === 0 || !effectiveCode} loading={create.isPending} onClick={() => create.mutate()} data-testid="setup-submit">
                Thêm {chosen.length || ''} phòng
              </Button>
            </HkSection>
          </div>
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
      {passing ? (
        <PassDialog
          task={passing}
          onClose={() => setPassing(null)}
          onDone={(msg) => {
            setPassing(null);
            setToast(msg);
          }}
        />
      ) : null}
      {failing ? (
        <FailDialog
          task={failing}
          staff={staff.data?.staff ?? []}
          onClose={() => setFailing(null)}
          onDone={(msg) => {
            setFailing(null);
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

function TimeCell({ task }: { task: RoomTask }) {
  if (!task.startedAt) return <span className="text-slate-400">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {hhmm(task.startedAt)} → {task.completedAt ? hhmm(task.completedAt) : '…'}
      {task.durationSeconds !== null ? <span className="ml-1.5 text-xs text-slate-500">({formatMinutes(task.durationSeconds)})</span> : null}
    </span>
  );
}

export function HkAssignPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(false);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<RoomTask | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const staff = useBranchStaff(scope.branchId);
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
  const people = staff.data?.staff ?? [];
  // Open cycles only — a reviewed cycle is history (the room's dialog shows it).
  const rows = (tasks.data?.tasks ?? []).filter((t) => !t.review || t.review.status === 'PENDING').sort(
    (a, b) => Number(b.priority) - Number(a.priority) || a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true }),
  );
  const unassigned = rows.filter((t) => !t.assignee).length;
  const columns: DataColumn<RoomTask>[] = [
    {
      key: 'room',
      header: 'Phòng',
      className: 'w-[1%]',
      render: (t) => (
        <div className="flex flex-col gap-1">
          <span className="text-base font-bold tabular-nums text-slate-900">{t.roomNumber}</span>
          <span className="flex flex-wrap gap-1 md:hidden">
            <CodeTag code={t.statusCode} />
            {t.priority ? <PriorityBadge /> : null}
            <CycleBadge task={t} />
          </span>
          {t.startedAt ? (
            <span className="text-xs text-slate-500 md:hidden">
              <TimeCell task={t} />
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'code', header: 'Tình trạng', className: `w-[1%] whitespace-nowrap ${WIDE}`, render: (t) => <CodeTag code={t.statusCode} /> },
    { key: 'priority', header: 'Ưu tiên', className: `w-[1%] whitespace-nowrap ${WIDE}`, render: (t) => (t.priority ? <PriorityBadge /> : <span className="text-slate-400">—</span>) },
    {
      key: 'assignee',
      header: 'Nhân viên',
      render: (t) => {
        // The current assignee stays in the list even when the branch list has moved on.
        const options = t.assignee && !people.some((s) => s.id === t.assignee!.id) ? [{ id: t.assignee.id, fullName: t.assignee.name }, ...people] : people;
        return (
          <select
            aria-label={`Người được giao phòng ${t.roomNumber}`}
            value={t.assignee?.id ?? ''}
            disabled={t.state === 'COMPLETED' || assign.isPending}
            onChange={(e) => assign.mutate({ id: t.id, userId: e.target.value === '' ? null : Number(e.target.value) })}
            data-testid={`assign-${t.roomNumber}`}
            className={`min-h-[2.5rem] w-full min-w-[8rem] max-w-[16rem] rounded-lg border bg-white px-2 text-sm disabled:bg-slate-50 disabled:text-slate-600 md:min-w-[10rem] ${
              t.assignee ? 'border-line-strong text-slate-900' : 'border-amber-400 text-amber-800'
            }`}
          >
            <option value="">— Chưa giao —</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        );
      },
    },
    { key: 'state', header: 'Trạng thái', className: `whitespace-nowrap ${WIDE}`, render: (t) => <CycleBadge task={t} /> },
    { key: 'time', header: 'Thời gian', className: WIDE, render: (t) => <TimeCell task={t} /> },
  ];
  return (
    <div>
      <HkHeader
        title="Phân công công việc"
        description="Ai dọn phòng nào trong ngày — giao, giao lại; mọi thay đổi được ghi vào lịch sử của phòng. Chỉ nhân viên buồng phòng thuộc chi nhánh mới có trong danh sách."
        branch={scope.label}
        period={{ label: 'Ngày nghiệp vụ', value: formatDate(date) }}
        controls={
          <>
            <DateField date={date} onDate={setDate} />
            {scope.picker}
          </>
        }
      />
      {scope.branchId === undefined ? (
        <PickBranchFirst />
      ) : (
        <DataTable
          title="Phòng trong ngày"
          badge={rows.length}
          headerAction={unassigned > 0 ? <Badge tone="amber">{unassigned} phòng chưa giao</Badge> : rows.length > 0 ? <Badge tone="green">Đã giao hết</Badge> : undefined}
          testId="assign-table"
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          isLoading={tasks.isLoading}
          isError={tasks.isError}
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
          emptyTitle="Chưa có phòng trên bảng"
          emptyMessage="Thêm phòng ở “Tình trạng phòng”, rồi giao việc tại đây."
          actions={(t) => (
            <button type="button" onClick={() => setOpen(t)} data-testid={`task-open-${t.roomNumber}`} className={ROW_BUTTON}>
              Chi tiết
            </button>
          )}
        />
      )}
      {open ? (
        <TaskDialog
          task={open}
          staff={people}
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
  const chosenId = isAdmin ? reportBranchId(filter) : undefined;
  const scope = period ? { from: period.from, to: period.to, branchId: chosenId } : null;
  const list = branches.data?.branches ?? [];
  const chosen = chosenId !== undefined ? list.find((b) => b.id === chosenId) : undefined;
  const branch = !isAdmin
    ? user?.branch
      ? branchLabel(user.branch as Branch)
      : '—'
    : filter.branch === 'ALL'
      ? 'Tất cả chi nhánh'
      : chosen
        ? branchLabel(chosen)
        : 'Chưa chọn';
  const context = !period
    ? { label: 'Kỳ báo cáo', value: 'Chưa chọn đủ khoảng ngày' }
    : period.from === period.to
      ? { label: 'Ngày nghiệp vụ', value: formatDate(period.from) }
      : { label: 'Kỳ báo cáo', value: `${formatDate(period.from)} – ${formatDate(period.to)}` };
  const bar = (
    <ReportFilterBar
      value={filter}
      onChange={setFilter}
      today={today}
      branches={isAdmin ? list : undefined}
      showShifts={false}
      testId="hk-period"
    />
  );
  return { scope, bar, branch, context };
}

/* ------------------------------------------------------------------ *
 * Theo dõi nhân viên
 * ------------------------------------------------------------------ */

/** Where a worker stands in the period, in one word. */
function staffStatus(r: StaffProgressRow): { tone: Tone; label: string } {
  if (r.assigned === 0) return { tone: 'slate', label: 'Chưa được giao' };
  if (r.completed === r.assigned) return { tone: 'green', label: 'Đã xong' };
  if (r.inProgress > 0) return { tone: 'blue', label: 'Đang dọn' };
  if (r.completed > 0) return { tone: 'blue', label: 'Đang thực hiện' };
  return { tone: 'gray', label: 'Chưa bắt đầu' };
}

export function HkStaffPage() {
  const { scope, bar, branch, context } = usePeriodScope();
  const [open, setOpen] = useState<StaffProgressRow | null>(null);
  const progress = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff-progress', scope],
    queryFn: () => roomWorkApi.staffProgress(scope!),
    enabled: scope !== null,
  });
  const rows = progress.data?.rows ?? [];
  const team = rows.reduce(
    (t, r) => ({ assigned: t.assigned + r.assigned, inProgress: t.inProgress + r.inProgress, completed: t.completed + r.completed }),
    { assigned: 0, inProgress: 0, completed: 0 },
  );
  const teamRate = team.assigned === 0 ? 0 : Math.round((team.completed / team.assigned) * 100);
  const columns: DataColumn<StaffProgressRow>[] = [
    {
      key: 'name',
      header: 'Nhân viên',
      render: (r) => {
        const s = staffStatus(r);
        return (
          <div className="flex flex-col gap-1">
            <span className="font-semibold text-slate-900">{r.fullName}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 md:hidden">
              <Badge tone={s.tone}>{s.label}</Badge>
              <span className="tabular-nums">
                Giao {r.assigned} · <span className="text-blue-700">Đang dọn {r.inProgress}</span> · <span className="text-green-700">Xong {r.completed}</span> ·{' '}
                {r.completionRate}%
              </span>
            </span>
          </div>
        );
      },
    },
    { key: 'assigned', header: 'Được giao', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.assigned}</span> },
    { key: 'inProgress', header: 'Đang dọn', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums text-blue-700">{r.inProgress}</span> },
    { key: 'completed', header: 'Hoàn thành', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums text-green-700">{r.completed}</span> },
    { key: 'rate', header: 'Tỷ lệ hoàn thành', align: 'right', className: WIDE, render: (r) => <RateBar rate={r.completionRate} /> },
    {
      key: 'status',
      header: 'Trạng thái',
      className: WIDE,
      render: (r) => {
        const s = staffStatus(r);
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
  ];
  return (
    <div>
      <HkHeader
        title="Theo dõi nhân viên"
        description="Toàn đội trong một bảng: phòng được giao, đang dọn, hoàn thành. Bấm “Chi tiết” để xem từng phòng, phát sinh và ca làm việc."
        branch={branch}
        period={context}
      />
      {bar}
      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-testid="staff-summary">
        <Metric label="Nhân viên" value={rows.length} />
        <Metric label="Được giao" value={team.assigned} />
        <Metric label="Đang dọn" value={team.inProgress} tone="blue" />
        <Metric label="Hoàn thành" value={team.completed} tone="green" hint={`${teamRate}% số phòng được giao`} />
      </div>
      <DataTable
        title="Nhân viên"
        badge={rows.length}
        testId="staff-table"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.userId)}
        isLoading={progress.isLoading}
        isError={progress.isError}
        error={progress.error}
        onRetry={() => void progress.refetch()}
        emptyTitle="Chưa có dữ liệu"
        emptyMessage="Nhân viên được giao phòng hoặc kiểm phòng trong khoảng này sẽ hiện ở đây."
        actions={(r) => (
          <button type="button" onClick={() => setOpen(r)} data-testid={`staff-open-${r.userId}`} className={ROW_BUTTON}>
            Chi tiết
          </button>
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
  { key: 'inspector', header: 'Người kiểm phòng', secondary: true, render: (f) => f.inspectorName },
  { key: 'status', header: 'Thu tiền', render: (f) => <Badge tone={f.collectionStatus === 'COLLECTED' ? 'green' : f.collectionStatus === 'PENDING' ? 'red' : 'slate'}>{f.collectionStatusLabel}</Badge> },
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
          <div className="space-y-5" data-testid="staff-detail">
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <Metric label="Lượt kiểm phòng" value={d.kpi.inspections} />
              <Metric label="Phát sinh" value={d.kpi.findings} tone="amber" />
              <Metric label="Đã thu" value={formatVnd(d.kpi.collectedAmount)} tone="green" />
              <Metric label="Chưa thu" value={formatVnd(d.kpi.pendingAmount)} tone="red" />
            </div>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Phòng ({d.tasks.length})</h3>
              {d.tasks.length === 0 ? <p className="text-sm text-slate-500">Không có phòng trong khoảng này.</p> : null}
              <ul className="space-y-2">
                {d.tasks.map((t) => (
                  <li key={t.id} className="overflow-hidden rounded-lg border border-line">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
                      aria-expanded={openTask === t.id}
                      onClick={() => setOpenTask(openTask === t.id ? null : t.id)}
                      data-testid={`staff-task-${t.id}`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold tabular-nums text-slate-900">Phòng {t.roomNumber}</span>
                        <CodeTag code={t.statusCode} />
                        <span className="text-slate-500">{formatDate(t.workDate)}</span>
                        {t.voided ? <Badge tone="red">đã xóa</Badge> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <CycleBadge task={t} />
                        <span className="tabular-nums text-slate-600">{formatMinutes(t.durationSeconds ?? t.elapsedSeconds)}</span>
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
            <DataTable title="Phát sinh khi kiểm phòng" badge={d.findings.length} testId="staff-findings" columns={FINDING_COLUMNS} rows={d.findings} rowKey={(f) => f.id} emptyTitle="Không có phát sinh" emptyMessage="" />
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Ca làm việc</h3>
              {d.shifts.length === 0 ? (
                <p className="text-sm text-slate-500">Không có ca trong khoảng này.</p>
              ) : (
                <ul className="divide-y divide-line-subtle rounded-lg border border-line text-sm">
                  {d.shifts.flatMap((s) =>
                    s.segments.map((seg) => (
                      <li key={seg.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                        <span className="font-medium text-slate-800">{branchLabel(seg.branch)}</span>
                        <span className="tabular-nums text-slate-600">
                          {formatDateTime(seg.startedAt)} – {seg.endedAt ? formatDateTime(seg.endedAt) : 'đang làm'}
                        </span>
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
  const { scope, bar, branch, context } = usePeriodScope();
  const [userId, setUserId] = useState<number | ''>('');
  const [status, setStatus] = useState<RoomCollectionStatus | ''>('');
  const [open, setOpen] = useState<KpiRow | null>(null);
  const staff = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff', 'period', scope?.branchId ?? null],
    queryFn: () => roomWorkApi.staff({ branchId: scope?.branchId }),
  });
  const params = scope ? { ...scope, userId: userId === '' ? undefined : userId, status: status || undefined } : null;
  const kpi = useQuery({ queryKey: [...ROOM_WORK_KEY, 'kpi', params], queryFn: () => roomWorkApi.kpi(params!), enabled: params !== null });
  const columns: DataColumn<KpiRow>[] = [
    {
      key: 'name',
      header: 'Nhân viên',
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-slate-900">{r.fullName}</span>
          <span className="text-xs tabular-nums text-slate-600 md:hidden">
            Kiểm phòng {r.inspections} · Phát sinh {r.findings} · Đã thu {r.collectedCount} ·{' '}
            <span className={r.pendingCount > 0 ? 'font-semibold text-red-700' : ''}>Chưa thu {r.pendingCount}</span>
          </span>
        </div>
      ),
    },
    { key: 'inspections', header: 'Lượt kiểm phòng', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.inspections}</span> },
    { key: 'findings', header: 'Phát sinh', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.findings}</span> },
    { key: 'collected', header: 'Đã thu', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.collectedCount}</span> },
    { key: 'pending', header: 'Chưa thu', align: 'right', className: WIDE, render: (r) => <span className={`tabular-nums ${r.pendingCount > 0 ? 'font-semibold text-red-700' : ''}`}>{r.pendingCount}</span> },
    { key: 'amount', header: 'Tổng tiền đã thu', align: 'right', render: (r) => <span className="font-semibold tabular-nums text-green-700">{formatVnd(r.collectedAmount)}</span> },
  ];
  const totals = kpi.data?.totals;
  return (
    <div>
      <HkHeader
        title="KPI & Thu tiền"
        description="Phát sinh mỗi nhân viên ghi nhận khi kiểm phòng, và số tiền lễ tân đã thu từ các phát sinh đó."
        branch={branch}
        period={context}
      />
      <section aria-label="Bộ lọc" className="mb-5">
        {bar}
        <div className="-mt-1 grid gap-3 rounded-xl border-section border-line bg-white px-4 py-3 shadow-sm sm:grid-cols-2">
          <label className={LABEL}>
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
          <label className={LABEL}>
            Trạng thái thu tiền
            <select className={FIELD} value={status} onChange={(e) => setStatus(e.target.value as RoomCollectionStatus | '')} data-testid="kpi-status">
              <option value="">Tất cả</option>
              <option value="COLLECTED">Đã thu</option>
              <option value="PENDING">Chưa thu</option>
              <option value="UNCOLLECTIBLE">Không thu được</option>
            </select>
          </label>
        </div>
      </section>
      {totals ? (
        <div className="mb-5 grid gap-5 lg:grid-cols-5" data-testid="kpi-totals">
          <HkSection title="KPI vận hành" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-2.5">
              <Metric label="Lượt kiểm phòng" value={totals.inspections} />
              <Metric label="Phát sinh" value={totals.findings} tone="amber" />
            </div>
          </HkSection>
          <HkSection title="Thu tiền" className="lg:col-span-3">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <div className="col-span-2 sm:col-span-1">
                <Metric label="Tổng tiền đã thu" value={formatVnd(totals.collectedAmount)} tone="green" hint={`${totals.collectedCount} khoản đã thu`} testId="kpi-collected" />
              </div>
              <Metric label="Chưa thu" value={formatVnd(totals.pendingAmount)} tone="red" hint={`${totals.pendingCount} khoản`} />
              <Metric label="Không thu được" value={totals.uncollectibleCount} tone="slate" hint="khoản" />
            </div>
          </HkSection>
        </div>
      ) : null}
      <DataTable
        title="KPI theo nhân viên"
        badge={kpi.data?.rows.length}
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
          <button type="button" onClick={() => setOpen(r)} data-testid={`kpi-open-${r.userId}`} className={ROW_BUTTON}>
            Chi tiết
          </button>
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
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <Metric label="Lượt kiểm phòng" value={row.inspections} />
          <Metric label="Phát sinh" value={row.findings} tone="amber" />
          <Metric label="Đã thu" value={formatVnd(row.collectedAmount)} tone="green" />
          <Metric label="Chưa thu" value={formatVnd(row.pendingAmount)} tone="red" />
        </div>
        <DataTable
          title="Phát sinh và thu tiền"
          badge={detail.data?.findings.length}
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
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Báo cáo
 * ------------------------------------------------------------------ */

export function HkReportPage() {
  const { scope, bar, branch, context } = usePeriodScope();
  const report = useQuery({ queryKey: [...ROOM_WORK_KEY, 'report', scope], queryFn: () => roomWorkApi.report(scope!), enabled: scope !== null });
  const rows = report.data?.rows ?? [];
  const sum = rows.reduce(
    (t, r) => ({
      assigned: t.assigned + r.assigned,
      completed: t.completed + r.completed,
      inspections: t.inspections + r.inspections,
      findings: t.findings + r.findings,
      collected: t.collected + r.collectedAmount,
      pending: t.pending + r.pendingAmount,
    }),
    { assigned: 0, completed: 0, inspections: 0, findings: 0, collected: 0, pending: 0 },
  );
  const columns = useMemo<DataColumn<OperationsRow>[]>(
    () => [
      { key: 'date', header: 'Ngày', className: `whitespace-nowrap ${WIDE}`, render: (r) => formatDate(r.workDate) },
      { key: 'branch', header: 'Chi nhánh', secondary: true, render: (r) => r.branchLabel },
      {
        key: 'employee',
        header: 'Nhân viên',
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-slate-900">{r.employee}</span>
            <span className="text-xs text-slate-500 md:hidden">{formatDate(r.workDate)}</span>
          </div>
        ),
      },
      { key: 'assigned', header: 'Được giao', align: 'right', secondary: true, render: (r) => r.assigned },
      { key: 'completed', header: 'Hoàn thành', align: 'right', render: (r) => `${r.completed} (${r.completionRate}%)` },
      { key: 'inspections', header: 'Kiểm phòng', align: 'right', secondary: true, render: (r) => r.inspections },
      { key: 'findings', header: 'Phát sinh', align: 'right', secondary: true, render: (r) => r.findings },
      { key: 'avg', header: 'TB dọn phòng', align: 'right', secondary: true, render: (r) => formatMinutes(r.avgCleaningSeconds) },
      { key: 'collected', header: 'Đã thu', align: 'right', render: (r) => formatVnd(r.collectedAmount) },
      { key: 'pending', header: 'Chưa thu', align: 'right', secondary: true, render: (r) => `${formatVnd(r.pendingAmount)} (${r.pendingCount})` },
      {
        key: 'notes',
        header: 'Ghi chú',
        secondary: true,
        render: (r) => [r.voided ? `${r.voided} phòng đã xóa` : '', r.notes ? `${r.notes} ghi chú` : ''].filter(Boolean).join(', ') || '—',
      },
    ],
    [],
  );
  const exportLink = (kind: 'pdf' | 'xlsx', text: string, Icon: LucideIcon) => (
    <a
      href={scope ? housekeepingReportUrl(kind, scope) : undefined}
      aria-disabled={scope ? undefined : true}
      data-testid={`hk-report-${kind}`}
      className={`inline-flex min-h-[2.75rem] w-full items-center justify-center gap-2 rounded-xl border border-line-strong bg-white px-4 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
        scope ? '' : 'pointer-events-none opacity-50'
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {text}
    </a>
  );
  return (
    <div>
      <HkHeader
        title="Báo cáo vận hành buồng phòng"
        description="Theo ngày và nhân viên: phòng được giao và hoàn thành, kiểm phòng, phát sinh, thời gian dọn, tiền đã thu và chưa thu."
        branch={branch}
        period={context}
      />
      <div className="mb-1 grid gap-x-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <section aria-label="Bộ lọc">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Bộ lọc</h2>
          {bar}
        </section>
        <section aria-label="Xuất báo cáo" data-testid="hk-report-export">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Xuất báo cáo</h2>
          <div className="mb-4 space-y-2 rounded-xl border-section border-line bg-white p-3 shadow-sm">
            {exportLink('pdf', 'Xuất PDF', Download)}
            {exportLink('xlsx', 'Xuất Excel', FileSpreadsheet)}
            <p className="text-center text-xs text-slate-500">Theo bộ lọc đang chọn</p>
          </div>
        </section>
      </div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Dữ liệu báo cáo</h2>
      <DataTable
        title="Vận hành buồng phòng"
        badge={rows.length}
        testId="hk-report"
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.branchLabel}|${r.workDate}|${r.employee}`}
        isLoading={report.isLoading}
        isError={report.isError}
        error={report.error}
        onRetry={() => void report.refetch()}
        emptyTitle="Chưa có dữ liệu"
        emptyMessage="Công việc buồng phòng trong khoảng này sẽ hiện ở đây."
        footer={
          rows.length > 0 ? (
            <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-700" data-testid="hk-report-totals">
              <span>
                Hoàn thành <strong className="tabular-nums">{sum.completed}/{sum.assigned}</strong> phòng
              </span>
              <span>
                Kiểm phòng <strong className="tabular-nums">{sum.inspections}</strong>
              </span>
              <span>
                Phát sinh <strong className="tabular-nums">{sum.findings}</strong>
              </span>
              <span>
                Đã thu <strong className="tabular-nums text-green-700">{formatVnd(sum.collected)}</strong>
              </span>
              <span>
                Chưa thu <strong className="tabular-nums text-red-700">{formatVnd(sum.pending)}</strong>
              </span>
            </p>
          ) : undefined
        }
      />
    </div>
  );
}
