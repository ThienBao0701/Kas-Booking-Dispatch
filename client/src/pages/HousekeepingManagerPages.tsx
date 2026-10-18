/**
 * "QUẢN LÝ BUỒNG PHÒNG" — six focused screens over one branch's housekeeping
 * (the Admin: any branch, with a branch picker):
 *
 *   Tổng quan            the day at a glance, and the way into the rest (read-only)
 *   Tình trạng phòng     the board: rooms by floor, the day's work groups, every
 *                        item — creating, assigning, accepting, reassigning, reviewing
 *   Theo dõi nhân viên   per worker: shifts, rooms and progress — every detail one click down
 *   KPI & Thu tiền       findings and collections credited to each worker
 *   Báo cáo              the operations report, PDF and Excel
 *
 * Every screen opens with the same context — "Quản lý buồng phòng · Chi nhánh ·
 * Ngày nghiệp vụ" — then its own title. The SERVER scopes every read and write
 * to the manager's branch (and offers only that branch's own workers); these
 * screens only ask. Every action is recorded in the room's history.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BarChart3,
  BedDouble,
  Boxes,
  Brush,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Hand,
  Hourglass,
  Info,
  LayoutGrid,
  List,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
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
  type ReportQuery,
  type ReportType,
  type WorkGroup,
  REPORT_TYPE_OPTIONS,
} from '../api/roomWork';
import { branchesApi } from '../api/bookings';
import { HOUSEKEEPING_SHIFT_KEY, housekeepingApi, type RoomCollectionStatus, type WorkShift } from '../api/housekeeping';
import { useWorkStep } from '../api/useWorkStep';
import { AcceptGroupDialog, OwnAction } from '../components/HkWorkerActions';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel, type Branch } from '../auth/types';
import { Button } from '../components/Button';
import { DataTable, type DataColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { QueryState } from '../components/PageState';
import { BranchPicker, ReportFilterBar } from '../components/ReportFilter';
import { RoomTaskDetail } from '../components/RoomTaskDetail';
import { PhaseBadge, ReassignDialog, WorkOrderTable } from '../components/HkWorkOrders';
import { CodeChips, CreateWorkDialog, NoCleanReviewList, WorkGroupCard, WorkGroupEditor } from '../components/HkWorkGroups';
import { placeName, placeText, placesByFloor } from '../lib/workPlaces';
import { buildFloors, roomStatus, STATUS_FILTERS, STATUS_ICON_CLASS, type RoomStatusGroup } from '../lib/roomStatus';
import { hotelName, weekdayOf } from '../lib/hkDisplay';
import { BarChart, type ChartBucket, type ChartSeries } from '../components/HkCharts';
import { FloorGrid, StatusLegend } from '../components/HkRoomGrid';
import { can } from '../auth/capabilities';
import { Toast } from '../components/Toast';
import {
  Avatar,
  Badge,
  CAPTION,
  CARD,
  CONTROL,
  CodeTag,
  HkHeader,
  HkSection,
  Meter,
  Metric,
  RateBar,
  ReviewCard,
  ROW_BUTTON,
  SECTION_LINK,
  Segmented,
  StateBadge,
  type Tone,
} from '../components/HkManagerUi';
import { initialReportFilter, reportBranchId, reportPeriod, type BranchChoice, type ReportFilterValue } from '../lib/reportFilter';
import { formatVnd } from '../lib/money';
import { formatDate, formatDateTime, hcmTimeOfDay, hcmToday } from '../lib/format';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

const LABEL = 'block text-sm font-medium text-slate-700';

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
      ? hotelName(user.branch as Branch, false)
      : '—'
    : choice === 'ALL'
      ? 'Tất cả chi nhánh'
      : chosen
        ? branchLabel(chosen)
        : 'Chưa chọn';
  const picker: ReactNode = isAdmin ? (
    <div className="w-full min-w-0 sm:w-72">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Chi nhánh</p>
      <BranchPicker value={choice} onChange={setChoice} branches={list} allowAll={allowAll} />
    </div>
  ) : null;
  return { isAdmin, branchId, ready, picker, label };
}

function DateField({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  return (
    // The label on its own line, a modest gap, then the field — the KAS form rhythm.
    // `min-w-0 max-w-full appearance-none`: a native date input otherwise keeps
    // its intrinsic width (iOS Safari especially) and overflows a phone screen.
    <label className="block w-full min-w-0 sm:w-auto">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Ngày</span>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onDate(e.target.value)}
        data-testid="hk-date"
        className={`${FIELD} !mt-0 min-w-0 max-w-full appearance-none sm:w-44`}
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
    // "Đã kiểm tra": inspected, waiting for "Bắt đầu dọn" (and free to be given to another housekeeper).
    inspected: active.filter((t) => t.state === 'INSPECTED').length,
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
  // One cycle: the room's own details say it all — no second copy of the same record.
  if (history.isSuccess && cycles.length <= 1) return null;
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
                {/* A removed item and the one that replaced it are two records — said so, not merged. */}
                {c.voided ? <Badge tone="slate">đã xóa khỏi ngày</Badge> : null}
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
 * Công việc chung — monitoring only: nothing here creates, assigns or edits work
 * ------------------------------------------------------------------ */

const GROUP_TONE: Record<WorkGroup['status']['code'], Tone> = {
  UNASSIGNED: 'amber',
  ACCEPTED: 'blue',
  IN_PROGRESS: 'blue',
  DONE: 'green',
};

/**
 * One "Công việc N", read-only: who has it, its floors, and each place's status
 * as a tile — rooms of a floor side by side, each floor under its own heading.
 */
function GroupSummary({ group }: { group: WorkGroup }) {
  const live = group.items.filter((t) => !t.voided);
  const done = live.filter((t) => {
    const g = roomStatus(t).group;
    return g === 'done' || g === 'noclean';
  }).length;
  return (
    <article className="rounded-lg border border-line-subtle bg-white" data-testid={`overview-group-${group.number}`} aria-labelledby={`overview-group-title-${group.id}`}>
      <header className="flex flex-wrap items-start gap-3 border-b border-line-subtle px-3.5 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700" aria-hidden="true">
          {group.number}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`overview-group-title-${group.id}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
            <span>
              {group.title}
              {group.name ? <span className="font-medium text-slate-600"> — {group.name}</span> : null}
            </span>
            <Badge tone={GROUP_TONE[group.status.code]}>{group.status.label}</Badge>
          </h3>
          <p className="mt-0.5 text-xs text-slate-600">
            Người thực hiện: <span className="font-medium text-slate-800">{group.assignee?.name ?? 'Chưa giao'}</span>
            {group.floors.length > 0 ? <span className="text-slate-500"> · {group.floors.join(', ')}</span> : null}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-slate-600">
          {done}/{live.length} đã xong
        </span>
      </header>
      <div className="space-y-2.5 px-3.5 py-3">
        {placesByFloor(live).map((floor) => (
          <section key={floor.heading} aria-label={`${group.title} — ${floor.heading}`}>
            <h4 className="mb-1.5 text-xs font-semibold text-slate-500">{floor.heading}</h4>
            <ul className="flex flex-wrap gap-2">
              {floor.tasks.map((t) => {
                const s = roomStatus(t);
                const Icon = s.icon;
                return (
                  <li key={t.id} className="flex min-w-[7.5rem] items-center gap-2 rounded-md border border-line-subtle bg-slate-50/70 px-2.5 py-1.5">
                    <Icon className={`h-4 w-4 shrink-0 ${STATUS_ICON_CLASS[s.tone]}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{placeName(t)}</span>
                      <span className="block truncate text-xs text-slate-600">{s.label}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

/** How many groups the overview shows before "Xem tất cả". */
const OVERVIEW_GROUPS = 4;

export function HkOverviewPage() {
  const scope = useScope(true);
  const isAdmin = scope.isAdmin;
  const date = hcmToday();
  // The manager watches its own branch. The Admin keeps its branch filter: one
  // branch, or "Tất cả chi nhánh" — then every branch, one block each.
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const everyBranch = isAdmin && scope.branchId === undefined;
  const targets: { branchId?: number; label?: string }[] = everyBranch
    ? (branches.data?.branches ?? []).map((b) => ({ branchId: b.id, label: branchLabel(b) }))
    : [{ branchId: scope.branchId }];
  const days = useQueries({
    queries: targets.map((t) => ({
      queryKey: [...ROOM_WORK_KEY, 'groups', date, t.branchId ?? null],
      queryFn: () => roomWorkApi.workGroups({ date, branchId: t.branchId }),
      refetchInterval: 30_000,
    })),
  });
  const loading = branches.isLoading || days.some((d) => d.isLoading);
  const failed = branches.error ?? days.find((d) => d.isError)?.error;
  const blocks = targets
    .map((t, i) => ({ ...t, groups: (days[i]?.data?.groups ?? []).filter((g) => g.counts.items > 0) }))
    .filter((b) => b.groups.length > 0);
  return (
    <div>
      <HkHeader
        title="Công việc chung"
        description={`Tiến độ công việc buồng phòng hôm nay, ${formatDate(date)} (${weekdayOf(date)})${everyBranch ? ' — mọi chi nhánh' : ''}.`}
        actions={scope.picker}
      />
      <HkSection
        title="Tiến độ công việc hôm nay"
        icon={ClipboardList}
        testId="hk-overview-groups"
        aside={
          <Link to="/app/hk/rooms?view=groups" className={SECTION_LINK}>
            Công việc cá nhân <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        }
      >
        {loading ? (
          <p className="text-sm text-slate-500">Đang tải công việc…</p>
        ) : failed ? (
          <ErrorAlert>{toUserMessage(failed)}</ErrorAlert>
        ) : blocks.length === 0 ? (
          <p className="text-sm text-slate-500">
            Chưa có công việc nào trong ngày{everyBranch ? ' ở các chi nhánh' : ''}. Công việc được tạo ở “Công việc cá nhân”.
          </p>
        ) : (
          <div className="space-y-5">
            {blocks.map((b) => (
              <div key={b.branchId ?? 'own'} className="space-y-3" data-testid={b.branchId ? `overview-branch-${b.branchId}` : undefined}>
                {b.label ? <h3 className="text-sm font-semibold text-slate-700">{b.label}</h3> : null}
                {b.groups.slice(0, OVERVIEW_GROUPS).map((g) => (
                  <GroupSummary key={g.id} group={g} />
                ))}
                {b.groups.length > OVERVIEW_GROUPS ? (
                  <Link to="/app/hk/rooms?view=groups" className={SECTION_LINK}>
                    Xem tất cả {b.groups.length} công việc <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </HkSection>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The stores — pages being prepared, nothing pretended
 * ------------------------------------------------------------------ */

const STORES = {
  linens: { title: 'Kho Linens', what: 'đồ vải (ga, gối, khăn…)' },
  amenities: { title: 'Kho Amenities', what: 'đồ dùng cho khách (amenities)' },
  equipment: { title: 'Kho đồ dùng, thiết bị', what: 'đồ dùng và thiết bị buồng phòng' },
} as const;

/** A store's place in the menu, said honestly: no stock is kept here yet. */
export function HkStorePage({ store }: { store: keyof typeof STORES }) {
  const { title, what } = STORES[store];
  return (
    <div>
      <HkHeader title={title} description={`Quản lý kho ${what}.`} />
      <EmptyState
        icon={<Boxes className="h-6 w-6" aria-hidden="true" />}
        title="Đang được chuẩn bị"
        message="Chức năng kho chưa được xây dựng: chưa có số lượng tồn, nhập hay xuất kho nào được ghi nhận ở đây."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The one room's dialog: everything, plus the manager's actions
 * ------------------------------------------------------------------ */

/**
 * ONE ROOM'S DETAIL — read, not edited: what is to be done, where it stands, who
 * has it, the inspection and the cleaning, every cycle and the history. Assigning
 * and editing belong to the work group ("Chỉnh sửa") and to "Giao lại" in
 * "Danh sách"; the one action here is taking the room out of the day ("Xóa"),
 * always confirmed — its inspection, findings, money and history are kept.
 */
function TaskDialog({ task, onClose, onChanged }: { task: RoomTask; onClose: () => void; onChanged: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () => roomWorkApi.voidTask(task.id, reason.trim() || undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onChanged('Đã xóa công việc phòng.');
    },
  });
  // A reviewed cycle is history: nothing on it can change.
  const locked = task.voided || (task.review !== null && task.review.status !== 'PENDING');
  return (
    <Modal
      open
      size="2xl"
      anchor="top"
      title={`${placeName(task)} · ${formatDate(task.workDate)}`}
      onClose={onClose}
      footer={
        <>
          {locked ? null : (
            <Button variant="secondary" onClick={() => setVoiding(true)} className="mr-auto !border-rose-300 !text-rose-700 hover:!bg-rose-50" data-testid="task-void-open">
              Xóa
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-slate-50 px-3 py-2 text-sm" data-testid="task-facts">
          <CodeChips task={task} />
          <CycleBadge task={task} />
          {task.cycleNumber > 1 ? <span className="font-semibold text-slate-700">Lần dọn {task.cycleNumber}</span> : null}
          {task.workGroup ? <span className="text-slate-600">Công việc {task.workGroup.number}</span> : null}
          <span className="text-slate-700">{task.assignee ? <>Người làm: <span className="font-semibold">{task.assignee.name}</span></> : 'Chưa giao'}</span>
        </div>
        <CycleHistory task={task} />
        <RoomTaskDetail task={task} catalog={catalog.data} compact />
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
            <p>{placeText(task)} sẽ rời khỏi bảng ngày {formatDate(task.workDate)}. Kiểm phòng, phát sinh, thu tiền và lịch sử vẫn được giữ.</p>
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

/**
 * "CA LÀM VIỆC CỦA BẠN" — the Quản lý buồng phòng doing the room work itself,
 * end to end, in every view of the board:
 *
 *   off shift   "Vào ca làm việc" (at its OWN branch — no address to type)
 *   on shift    the groups nobody has taken, each with "Nhận"; then its OWN
 *               rooms, each with its next step (Kiểm tra → Dọn phòng → Tiếp tục),
 *               which opens the room page the housekeeper uses; "Kết thúc ca"
 *
 * The same lifecycle as a housekeeper's — the server checks the role, the
 * branch, the shift and the owner at every step, and a group is taken whole by
 * one person only. "Không cần dọn" stays the housekeeper's to ask: the manager
 * takes a room out of a group in "Chỉnh sửa" instead.
 */
function ManagerWorkPanel({
  shift,
  loading,
  groups,
  ownItems,
  onAccept,
  onStep,
  stepping,
  onChanged,
}: {
  shift: WorkShift | null;
  loading: boolean;
  /** The day's groups with places. */
  groups: WorkGroup[];
  /** This manager's own rooms still to work. */
  ownItems: RoomTask[];
  onAccept: (group: WorkGroup) => void;
  onStep: (task: RoomTask) => void;
  /** The room whose step is on its way, if any. */
  stepping: string | null;
  onChanged: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: HOUSEKEEPING_SHIFT_KEY });
    await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
  };
  const start = useMutation({ mutationFn: () => housekeepingApi.startShift(), onSuccess: async () => { await refresh(); onChanged('Đã vào ca làm việc.'); } });
  const end = useMutation({ mutationFn: () => housekeepingApi.endShift(), onSuccess: async () => { await refresh(); onChanged('Đã kết thúc ca làm việc.'); } });
  const current = shift?.current ?? null;
  const free = groups.filter((g) => !g.assignee);
  return (
    <section className={`${CARD} overflow-hidden`} aria-labelledby="manager-shift-title" data-testid="manager-shift">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-4 py-3">
        <div className="min-w-0">
          <h2 id="manager-shift-title" className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
            <Hand className="h-[18px] w-[18px] text-brand-600" aria-hidden="true" />
            Ca làm việc của bạn
            {current ? <Badge tone="green">Đang trong ca</Badge> : <Badge tone="gray">Chưa vào ca</Badge>}
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {loading
              ? 'Đang tải ca làm việc…'
              : current
                ? `Từ ${formatDateTime(current.startedAt)} — nhận công việc rồi kiểm tra, dọn phòng như nhân viên.`
                : free.length > 0
                  ? `Có ${free.length} công việc chưa có người nhận. Vào ca để tự nhận và làm.`
                  : 'Vào ca làm việc tại chi nhánh của bạn để tự nhận và làm công việc.'}
          </p>
        </div>
        {current ? (
          <Button variant="secondary" onClick={() => end.mutate()} loading={end.isPending} data-testid="manager-shift-end">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Kết thúc ca
          </Button>
        ) : (
          <Button onClick={() => start.mutate()} loading={start.isPending} disabled={loading} data-testid="manager-shift-start">
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Vào ca làm việc
          </Button>
        )}
      </header>
      {start.isError || end.isError ? (
        <div className="px-4 pt-3">
          <ErrorAlert>{toUserMessage(start.error ?? end.error)}</ErrorAlert>
        </div>
      ) : null}
      {current ? (
        <div className="grid gap-4 px-4 py-3 lg:grid-cols-2">
          <div className="min-w-0" data-testid="manager-free-groups">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Công việc chưa có người nhận</h3>
            {free.length === 0 ? (
              <p className="text-sm text-slate-500">Không có công việc nào đang chờ người nhận.</p>
            ) : (
              <ul className="space-y-1.5">
                {free.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-line-subtle px-3 py-2">
                    <span className="min-w-0 text-sm">
                      <span className="font-semibold text-slate-900">{g.title}</span>
                      <span className="text-slate-600">
                        {' '}
                        · {g.counts.items} phòng / khu vực{g.floors.length > 0 ? ` · ${g.floors.join(', ')}` : ''}
                      </span>
                    </span>
                    <Button onClick={() => onAccept(g)} data-testid={`panel-accept-${g.number}`}>
                      Nhận
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0" data-testid="manager-own-items">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Phòng bạn đang làm</h3>
            {ownItems.length === 0 ? (
              <p className="text-sm text-slate-500">Bạn chưa nhận công việc nào. Bấm “Nhận” ở một công việc để bắt đầu.</p>
            ) : (
              <ul className="space-y-1.5">
                {ownItems.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-2" data-testid={`panel-own-${t.id}`}>
                    <span className="min-w-0 text-sm">
                      <span className="font-semibold text-slate-900">{placeText(t)}</span>
                      {t.workGroup ? <span className="text-slate-600"> · Công việc {t.workGroup.number}</span> : null}
                      <span className="mt-0.5 block">
                        <PhaseBadge task={t} />
                      </span>
                    </span>
                    <OwnAction task={t} busy={stepping === t.id} onStep={() => onStep(t)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A room set up before work groups existed — shown as its own small card in
 * "Phòng đang thực hiện", worked exactly as before.
 */
function OlderTaskCard({ task: t, onOpen }: { task: RoomTask; onOpen: () => void }) {
  return (
    <article className="rounded-2xl border border-dashed border-line-strong bg-white px-4 py-3" data-testid={`older-task-${t.roomNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-bold text-slate-900">
            {placeText(t)} <span className="text-xs font-medium text-slate-500">(giao trước khi có nhóm công việc)</span>
            {t.reclean ? <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Cần dọn lại</span> : null}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>{t.assignee ? `Người làm: ${t.assignee.name}` : 'Chưa giao'}</span>
            <PhaseBadge task={t} />
          </p>
          <CodeChips task={t} />
        </div>
        <Button variant="secondary" onClick={onOpen} aria-label={`Xem chi tiết phòng ${t.roomNumber}`} data-testid={`older-task-open-${t.roomNumber}`}>
          Chi tiết
        </Button>
      </div>
    </article>
  );
}

type BoardView = 'floors' | 'groups' | 'list';
const BOARD_VIEWS: BoardView[] = ['floors', 'groups', 'list'];

export function HkRoomBoardPage() {
  const [date, setDate] = useState(hcmToday());
  const scope = useScope(false);
  const [params, setParams] = useSearchParams();
  const view: BoardView = BOARD_VIEWS.includes(params.get('view') as BoardView) ? (params.get('view') as BoardView) : 'floors';
  const setView = (next: BoardView) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (next === 'floors') n.delete('view');
        else n.set('view', next);
        return n;
      },
      { replace: true },
    );
  const [search, setSearch] = useState('');
  const [floorFilter, setFloorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<RoomStatusGroup | ''>('');
  const [open, setOpen] = useState<RoomTask | null>(null);
  const [passing, setPassing] = useState<RoomTask | null>(null);
  const [failing, setFailing] = useState<RoomTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [reassigning, setReassigning] = useState<RoomTask | null>(null);
  const [editing, setEditing] = useState<WorkGroup | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { user } = useAuth();
  const staff = useBranchStaff(scope.branchId);
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.tasks({ date, branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    refetchInterval: 30_000,
  });
  // "Công việc 1, 2, …" in creation order.
  const groups = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'groups', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.workGroups({ date, branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    refetchInterval: 30_000,
  });
  // The branch's floors and rooms — the same list "+ Tạo công việc" offers.
  const areas = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'areas', scope.branchId ?? null],
    queryFn: () => roomWorkApi.areas({ branchId: scope.branchId }),
    enabled: scope.branchId !== undefined,
    staleTime: 5 * 60_000,
  });
  const live = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const b = splitBoard(live);
  const dayGroups = (groups.data?.groups ?? []).filter((g) => g.counts.items > 0);
  // Rooms set up before work groups existed are shown on their own, as before.
  const olderActive = b.active.filter((t) => !t.workGroup);
  const noCleanPending = [...dayGroups.flatMap((g) => g.items), ...olderActive].filter((t) => t.noClean?.status === 'PENDING' && !t.voided);
  const floors = useMemo(() => buildFloors(areas.data?.areas, live), [areas.data, live]);
  // The summary counts each room / area once, by its latest cycle of the day.
  const tiles = floors.flatMap((f) => f.tiles);
  const count = (g: RoomStatusGroup) => tiles.filter((t) => t.status.group === g).length;
  const roomTotal = tiles.filter((t) => t.isRoom).length;
  const withWork = tiles.filter((t) => t.task).length;
  // Approved "Không cần dọn" only — a pending request has its own queue above.
  const noCleanDone = tiles.filter((t) => t.task?.phase === 'NO_CLEAN').length;
  // A Quản lý buồng phòng may also take a group and do the work itself — on a
  // shift at its own branch (the server checks the role, branch, shift and owner).
  const worksToo = user?.role === 'HOUSEKEEPING_MANAGER';
  const myShift = useQuery({ queryKey: HOUSEKEEPING_SHIFT_KEY, queryFn: () => housekeepingApi.shift(), enabled: worksToo });
  const onShift = Boolean(myShift.data?.shift?.current);
  const [accepting, setAccepting] = useState<WorkGroup | null>(null);
  const step = useWorkStep(() => void groups.refetch());
  const mine = (t: RoomTask) => worksToo && t.assignee?.id === user?.id && !t.voided && t.phase !== 'COMPLETED' && t.phase !== 'NO_CLEAN_PENDING';
  const refreshing = tasks.isFetching || groups.isFetching;
  const refresh = () => {
    void tasks.refetch();
    void groups.refetch();
    void areas.refetch();
  };

  const groupCards = (
    <QueryState
      isLoading={tasks.isLoading || groups.isLoading}
      isError={tasks.isError || groups.isError}
      error={tasks.error ?? groups.error}
      onRetry={() => {
        void tasks.refetch();
        void groups.refetch();
      }}
    >
      {dayGroups.length === 0 && olderActive.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Chưa có công việc nào ngày này — bấm “+ Tạo công việc dọn phòng”.</p>
      ) : (
        <div className="space-y-3" data-testid="work-groups">
          {dayGroups.map((g) => (
            <WorkGroupCard
              key={g.id}
              group={g}
              onEdit={() => setEditing(g)}
              headerAction={
                !worksToo ? null : !g.assignee ? (
                  <Button
                    onClick={() => setAccepting(g)}
                    disabled={!onShift}
                    title={onShift ? undefined : 'Vào ca làm việc để nhận công việc'}
                    data-testid={`group-accept-${g.number}`}
                  >
                    <Hand className="h-4 w-4" aria-hidden="true" />
                    Nhận công việc
                  </Button>
                ) : g.assignee.id === user?.id ? (
                  <span className="self-center rounded-full bg-brand-100 px-3 py-1 text-sm font-semibold text-brand-800" data-testid={`group-mine-${g.number}`}>
                    Công việc của bạn
                  </span>
                ) : null
              }
              itemAction={(t) => (
                <>
                  {mine(t) ? <OwnAction task={t} busy={step.isPending && step.variables?.id === t.id} onStep={() => step.mutate(t)} /> : null}
                  <Button variant="ghost" onClick={() => setOpen(t)} aria-label={`Chi tiết ${placeText(t)}`} data-testid={`group-item-open-${t.id}`}>
                    Chi tiết
                  </Button>
                </>
              )}
            />
          ))}
          {olderActive.map((t) => (
            <OlderTaskCard key={t.id} task={t} onOpen={() => setOpen(t)} />
          ))}
        </div>
      )}
    </QueryState>
  );

  return (
    <div>
      <HkHeader
        title="Công việc cá nhân"
        description="Tình trạng dọn phòng theo tầng và điều phối công việc buồng phòng trong ngày. Chọn một phòng để xem chi tiết và lịch sử."
        branch={scope.label}
        period={{ label: 'Ngày nghiệp vụ', value: formatDate(date), weekday: weekdayOf(date) }}
        controls={
          <>
            <DateField date={date} onDate={setDate} />
            {scope.picker}
          </>
        }
        actions={
          scope.branchId !== undefined ? (
            <>
              <Button onClick={() => setCreating(true)} data-testid="work-create-open">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Tạo công việc dọn phòng
              </Button>
              <Button variant="secondary" onClick={refresh} loading={refreshing} data-testid="board-refresh">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Làm mới
              </Button>
            </>
          ) : undefined
        }
      />
      {scope.branchId === undefined ? (
        <PickBranchFirst />
      ) : (
        <div className="space-y-5">
          {worksToo ? (
            <ManagerWorkPanel
              shift={myShift.data?.shift ?? null}
              loading={myShift.isLoading}
              groups={dayGroups}
              ownItems={[...dayGroups.flatMap((g) => g.items), ...olderActive].filter(mine)}
              onAccept={setAccepting}
              onStep={(t) => step.mutate(t)}
              stepping={step.isPending ? (step.variables?.id ?? null) : null}
              onChanged={setToast}
            />
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="board-summary">
            <Metric
              icon={BedDouble}
              label="Tổng phòng"
              value={roomTotal}
              hint={`${withWork} phòng / khu vực có công việc`}
              testId="metric-rooms"
            />
            <Metric icon={Clock} label="Chưa dọn" value={count('todo')} tone="gray" hint={b.inspected > 0 ? `${b.inspected} đã kiểm tra` : undefined} testId="metric-todo" />
            <Metric icon={Brush} label="Đang dọn" value={count('cleaning')} tone="blue" testId="metric-cleaning" />
            <Metric
              icon={CircleCheck}
              label="Đã dọn"
              value={count('done')}
              tone="green"
              hint={noCleanDone > 0 ? `${noCleanDone} không cần dọn (đã duyệt)` : undefined}
              testId="metric-done"
            />
            <Metric
              icon={CircleAlert}
              label="Chờ đánh giá"
              value={count('review')}
              tone={count('review') > 0 ? 'amber' : 'gray'}
              hint={count('reclean') > 0 ? `${count('reclean')} cần dọn lại / không đạt` : undefined}
              testId="metric-review"
            />
          </div>


          {/*
            Wide screens: the room grid right under the figures, the manager's two
            queues ("Không cần dọn", "Chờ đánh giá") at the top of the side column.
            Narrow screens: one column, the queues first — they wait for a decision.
          */}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
            {noCleanPending.length > 0 || b.awaiting.length > 0 ? (
              <div className="min-w-0 space-y-5 xl:col-start-2 xl:row-start-1" data-testid="board-queues">
              {noCleanPending.length > 0 ? (
                <HkSection title="Chờ duyệt “Không cần dọn”" icon={Hourglass} testId="board-no-clean" accent aside={<Badge tone="amber">{noCleanPending.length} phòng</Badge>}>
                  <NoCleanReviewList items={noCleanPending} onDecided={setToast} />
                </HkSection>
              ) : null}
              {b.awaiting.length > 0 ? (
                <HkSection title="Phòng chờ đánh giá" icon={Hourglass} testId="board-review" accent aside={<Badge tone="amber">{b.awaiting.length} phòng</Badge>}>
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
                </HkSection>
              ) : null}
              </div>
            ) : null}
            <div className="min-w-0 space-y-3 xl:col-start-1 xl:row-span-2 xl:row-start-1">
              <div className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
                <div className="w-full shrink-0 sm:w-auto">
                  <Segmented
                    label="Cách xem"
                    testId="board-view"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: 'floors', label: 'Theo tầng', icon: LayoutGrid },
                      { value: 'groups', label: `Công việc (${dayGroups.length})`, icon: ClipboardList },
                      { value: 'list', label: 'Danh sách', icon: List },
                    ]}
                  />
                </div>
                {view === 'floors' ? (
                  <div className="grid w-full gap-2 sm:grid-cols-3 xl:flex xl:w-auto xl:flex-1 xl:flex-wrap xl:items-center xl:justify-end">
                    <label className="relative block min-w-0 xl:w-44">
                      <span className="sr-only">Tìm phòng hoặc nhân viên</span>
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                      <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Tìm số phòng…"
                        className={`${CONTROL} pl-9`}
                        data-testid="room-search"
                      />
                    </label>
                    <label className="block min-w-0 xl:w-40">
                      <span className="sr-only">Tầng</span>
                      <select className={CONTROL} value={floorFilter} onChange={(e) => setFloorFilter(e.target.value)} data-testid="room-floor-filter">
                        <option value="">Tất cả tầng</option>
                        {floors.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0 xl:w-48">
                      <span className="sr-only">Trạng thái</span>
                      <select
                        className={CONTROL}
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as RoomStatusGroup | '')}
                        data-testid="room-status-filter"
                      >
                        {STATUS_FILTERS.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>

              {view === 'floors' ? (
                <section className={`${CARD} overflow-hidden`} aria-label="Phòng theo tầng">
                  <QueryState
                    isLoading={tasks.isLoading || areas.isLoading}
                    isError={tasks.isError}
                    error={tasks.error}
                    onRetry={() => void tasks.refetch()}
                  >
                    <FloorGrid
                      blocks={floors}
                      search={search}
                      floor={floorFilter}
                      status={statusFilter}
                      onOpen={setOpen}
                      empty={
                        <p className="px-4 py-8 text-center text-sm text-slate-500">
                          Chưa có danh sách phòng của chi nhánh và chưa có công việc ngày này — bấm “+ Tạo công việc dọn phòng”.
                        </p>
                      }
                    />
                  </QueryState>
                </section>
              ) : null}
              {view === 'groups' ? (
                <HkSection title="Phòng đang thực hiện" icon={ClipboardList} testId="board-active">
                  {groupCards}
                </HkSection>
              ) : null}
              {view === 'list' ? (
                <div data-testid="board-work-orders">
                  <WorkOrderTable
                    frame="light"
                    tasks={live}
                    isLoading={tasks.isLoading}
                    isError={tasks.isError}
                    error={tasks.error}
                    onRetry={() => void tasks.refetch()}
                    onOpen={setOpen}
                    onReassign={setReassigning}
                    canReassign={can(user?.role, 'housekeeping.reassignAwaitingCleaning')}
                  />
                </div>
              ) : null}
            </div>

            <aside className="min-w-0 space-y-5 xl:col-start-2" aria-label="Thông tin phụ">
              <HkSection title="Chú thích trạng thái" icon={Info}>
                <StatusLegend />
              </HkSection>
              <HkSection title="Liên quan" icon={ArrowRight} bodyClassName="p-2">
                <ul className="space-y-1">
                  {[
                    { to: '/app/hk/staff', label: 'Tiến độ theo nhân viên', icon: Users },
                    { to: '/app/hk/report', label: 'Báo cáo dọn phòng', icon: FileText },
                  ].map(({ to, label, icon: Icon }) => (
                    <li key={to}>
                      <Link
                        to={to}
                        className="flex min-h-[2.5rem] items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                      >
                        <Icon className="h-4 w-4 text-brand-600" aria-hidden="true" />
                        {label}
                        <ChevronRight className="ml-auto h-4 w-4 text-slate-400" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </HkSection>
            </aside>
          </div>
        </div>
      )}
      {open ? (
        <TaskDialog
          task={open}
          onClose={() => setOpen(null)}
          onChanged={(msg) => {
            setOpen(null);
            setToast(msg);
          }}
        />
      ) : null}
      {creating && scope.branchId !== undefined ? (
        <CreateWorkDialog
          branchId={scope.branchId}
          date={date}
          onClose={() => setCreating(false)}
          onCreated={(msg) => {
            setCreating(false);
            setToast(msg);
          }}
        />
      ) : null}
      {accepting ? (
        <AcceptGroupDialog
          group={accepting}
          onClose={() => setAccepting(null)}
          onAccepted={(g) => {
            setAccepting(null);
            setToast(`Đã nhận ${g.title}. Bấm “Kiểm tra” ở từng phòng để bắt đầu.`);
          }}
          onRefresh={() => void groups.refetch()}
        />
      ) : null}
      {step.isError ? <Toast message={toUserMessage(step.error)} onDone={() => step.reset()} /> : null}
      {editing ? <WorkGroupEditor group={editing} staff={staff.data?.staff ?? []} onClose={() => setEditing(null)} onChanged={setToast} /> : null}
      {reassigning ? (
        <ReassignDialog
          task={reassigning}
          staff={staff.data?.staff ?? []}
          onClose={() => setReassigning(null)}
          onDone={(msg) => {
            setReassigning(null);
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
      ? hotelName(user.branch as Branch, false)
      : '—'
    : filter.branch === 'ALL'
      ? 'Tất cả chi nhánh'
      : chosen
        ? branchLabel(chosen)
        : 'Chưa chọn';
  const oneDay = period !== null && period.from === period.to;
  const context = !period
    ? { label: 'Kỳ báo cáo', value: 'Chưa chọn đủ khoảng ngày' }
    : oneDay
      ? { label: 'Ngày nghiệp vụ', value: formatDate(period.from), weekday: weekdayOf(period.from) }
      : { label: 'Kỳ báo cáo', value: `${formatDate(period.from)} – ${formatDate(period.to)}` };
  const bar = (
    <ReportFilterBar
      value={filter}
      onChange={setFilter}
      today={today}
      branches={isAdmin ? list : undefined}
      showShifts={false}
      framed={false}
      testId="hk-period"
    />
  );
  return {
    scope,
    bar,
    branch,
    context,
    isAdmin,
    /** The period is one day — hours mean something. */
    oneDay,
    /** The period is today — "đang trong ca" means something. */
    isToday: oneDay && period?.from === today,
  };
}

/** Every calendar day from → to, "YYYY-MM-DD". */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** "15/10" — a day on a chart's axis. */
const dayLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Longer than this, a chart counts by month instead of by day. */
const MAX_DAILY_BUCKETS = 62;

/** One page of a long table: 25 rows, with "Trước / Sau". */
const PAGE_SIZE = 25;

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Phân trang" className="flex flex-wrap items-center justify-between gap-2 px-1 pt-3 text-sm text-slate-600" data-testid="hk-pager">
      <span className="tabular-nums">
        {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} / {total} dòng
      </span>
      <span className="flex gap-2">
        <button type="button" className={ROW_BUTTON} onClick={() => onPage(page - 1)} disabled={page === 0}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Trước
        </button>
        <button type="button" className={ROW_BUTTON} onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          Sau
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </span>
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Theo dõi nhân viên
 * ------------------------------------------------------------------ */

/** A person's shifts in the period: their times, and whether one is open now. */
interface ShiftFacts {
  shifts: WorkShift[];
  open: WorkShift | null;
  /** Where the latest one worked — "CN 1". */
  branchNumber: number | null;
}

function shiftFactsByUser(shifts: WorkShift[]): Map<number, ShiftFacts> {
  const map = new Map<number, ShiftFacts>();
  // Newest first (the server's order): the first is the latest.
  for (const s of shifts) {
    const f = map.get(s.user.id) ?? { shifts: [], open: null, branchNumber: s.segments[0]?.branch.branchNumber ?? null };
    f.shifts.push(s);
    if (!s.endedAt && !f.open) f.open = s;
    map.set(s.user.id, f);
  }
  return map;
}

type StaffState = 'ON_SHIFT' | 'ENDED' | 'NO_SHIFT';

interface StaffLine extends StaffProgressRow {
  facts: ShiftFacts | undefined;
  state: StaffState;
}

const STAFF_STATE: Record<StaffState, { tone: Tone; today: string; period: string }> = {
  ON_SHIFT: { tone: 'green', today: 'Đang trong ca', period: 'Đang trong ca' },
  ENDED: { tone: 'gray', today: 'Đã kết thúc ca', period: 'Có ca trong kỳ' },
  NO_SHIFT: { tone: 'slate', today: 'Chưa vào ca', period: 'Không có ca' },
};

/** "07:10 – đang mở", "07:30 – 15:30", or for a longer period "3 ca". */
function shiftText(f: ShiftFacts | undefined, oneDay: boolean): string {
  if (!f || f.shifts.length === 0) return '—';
  if (!oneDay && f.shifts.length > 1) return `${f.shifts.length} ca`;
  const s = f.shifts[0]!;
  return `${hhmm(s.startedAt)} – ${s.endedAt ? hhmm(s.endedAt) : 'đang mở'}`;
}

/**
 * "THEO DÕI CA LÀM" — the day's real shifts on one time axis (06:00–22:00,
 * widened to whatever was worked). An open shift runs to now; a person with no
 * shift that day is said so, never drawn.
 */
function ShiftTimeline({ lines, day }: { lines: StaffLine[]; day: string }) {
  const now = Date.now();
  const dayStart = new Date(`${day}T00:00:00+07:00`).getTime();
  const hourOf = (ms: number) => (ms - dayStart) / 3_600_000;
  const spans = lines.map((l) => ({
    line: l,
    spans: (l.facts?.shifts ?? []).map((s) => {
      const from = new Date(s.startedAt).getTime();
      const to = s.endedAt ? new Date(s.endedAt).getTime() : Math.min(now, dayStart + 24 * 3_600_000);
      return { id: s.id, from: hourOf(from), to: hourOf(to), open: !s.endedAt, text: `${hhmm(s.startedAt)} – ${s.endedAt ? hhmm(s.endedAt) : 'đang mở'}` };
    }),
  }));
  const all = spans.flatMap((x) => x.spans);
  const start = Math.max(0, Math.min(6, ...all.map((s) => Math.floor(s.from))));
  const end = Math.min(24, Math.max(22, ...all.map((s) => Math.ceil(s.to))));
  const width = end - start;
  const pos = (h: number) => `${((Math.min(end, Math.max(start, h)) - start) / width) * 100}%`;
  const marks = Array.from({ length: Math.floor(width / 2) + 1 }, (_, i) => start + i * 2).filter((h) => h <= end);
  return (
    <div className="overflow-x-auto" data-testid="staff-timeline">
      <div className="min-w-[30rem]">
        <div className="relative ml-36 h-5 text-[11px] tabular-nums text-slate-500" aria-hidden="true">
          {marks.map((h) => (
            <span key={h} className={`absolute ${h === end ? "-translate-x-full" : h === start ? "" : "-translate-x-1/2"}`} style={{ left: pos(h) }}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        <ul className="space-y-1.5">
          {spans.map(({ line, spans: s }) => (
            <li key={line.userId} className="flex items-center gap-2">
              <span className="flex w-34 min-w-0 shrink-0 items-center gap-2" style={{ width: '8.5rem' }}>
                <Avatar name={line.fullName} size="sm" />
                <span className="truncate text-sm text-slate-800">{line.fullName}</span>
              </span>
              <span className="relative h-6 flex-1 rounded bg-slate-100">
                {marks.slice(1, -1).map((h) => (
                  <span key={h} className="absolute inset-y-0 border-l border-white" style={{ left: pos(h) }} aria-hidden="true" />
                ))}
                {s.length === 0 ? (
                  <span className="absolute inset-y-0 left-2 flex items-center text-xs text-slate-500">Chưa vào ca</span>
                ) : (
                  s.map((x) => (
                    <span
                      key={x.id}
                      className={`absolute inset-y-0.5 flex items-center overflow-hidden rounded px-1.5 text-[11px] font-medium text-white ${x.open ? 'bg-green-600' : 'bg-slate-400'}`}
                      style={{ left: pos(x.from), width: `calc(${pos(x.to)} - ${pos(x.from)})`, minWidth: '0.375rem' }}
                      title={`${line.fullName}: ${x.text}`}
                    >
                      <span className="truncate">{x.text}</span>
                    </span>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-green-600" /> Đang mở
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-slate-400" /> Đã kết thúc
          </span>
        </p>
      </div>
    </div>
  );
}

export function HkStaffPage() {
  const { scope, bar, branch, context, isAdmin, oneDay, isToday } = usePeriodScope();
  const [open, setOpen] = useState<StaffProgressRow | null>(null);
  const [state, setState] = useState<StaffState | ''>('');
  const [search, setSearch] = useState('');
  const progress = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff-progress', scope],
    queryFn: () => roomWorkApi.staffProgress(scope!),
    enabled: scope !== null,
  });
  // The period's shifts on record — the same branch scope the server applies everywhere.
  const shifts = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'shifts', scope],
    queryFn: () => housekeepingApi.shifts(scope!),
    enabled: scope !== null,
  });
  // Groups nobody has taken yet — the one day, the one branch.
  const groups = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'groups', scope?.from ?? null, scope?.branchId ?? null],
    queryFn: () => roomWorkApi.workGroups({ date: scope!.from, branchId: scope!.branchId }),
    enabled: scope !== null && oneDay && (!isAdmin || scope.branchId !== undefined),
  });
  const facts = useMemo(() => shiftFactsByUser(shifts.data?.shifts ?? []), [shifts.data]);
  const lines: StaffLine[] = useMemo(() => {
    const rows = progress.data?.rows ?? [];
    const byId = new Map(rows.map((r) => [r.userId, r]));
    // Whoever worked a shift is a line too, even with no room given yet.
    for (const [userId, f] of facts) {
      if (!byId.has(userId)) {
        byId.set(userId, {
          userId,
          fullName: f.shifts[0]!.user.fullName,
          inspections: 0,
          findings: 0,
          collectedCount: 0,
          pendingCount: 0,
          uncollectibleCount: 0,
          collectedAmount: 0,
          pendingAmount: 0,
          assigned: 0,
          notStarted: 0,
          inspected: 0,
          inProgress: 0,
          completed: 0,
          completionRate: 0,
        });
      }
    }
    return [...byId.values()]
      .map((r) => {
        const f = facts.get(r.userId);
        const s: StaffState = f?.open ? 'ON_SHIFT' : f && f.shifts.length > 0 ? 'ENDED' : 'NO_SHIFT';
        return { ...r, facts: f, state: s };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi'));
  }, [progress.data, facts]);
  const needle = search.trim().toLocaleLowerCase('vi');
  const shown = lines.filter((l) => (!state || l.state === state) && (!needle || l.fullName.toLocaleLowerCase('vi').includes(needle)));
  const team = lines.reduce(
    (t, r) => ({ assigned: t.assigned + r.assigned, inProgress: t.inProgress + r.inProgress, completed: t.completed + r.completed }),
    { assigned: 0, inProgress: 0, completed: 0 },
  );
  const teamRate = team.assigned === 0 ? null : Math.round((team.completed / team.assigned) * 100);
  const onShiftNow = lines.filter((l) => l.state === 'ON_SHIFT').length;
  const withShift = lines.filter((l) => l.state !== 'NO_SHIFT').length;
  // Real conditions only — nothing here is inferred from a deadline the data does not hold.
  const idleWork = isToday ? lines.filter((l) => l.state !== 'ON_SHIFT' && l.assigned - l.completed > 0) : [];
  const waiting = (groups.data?.groups ?? []).filter((g) => g.counts.items > 0 && !g.assignee);
  const label = (s: StaffState) => (isToday ? STAFF_STATE[s].today : STAFF_STATE[s].period);
  const columns: DataColumn<StaffLine>[] = [
    {
      key: 'name',
      header: 'Nhân viên',
      render: (r) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={r.fullName} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{r.fullName}</p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 md:hidden">
              <Badge tone={STAFF_STATE[r.state].tone}>{label(r.state)}</Badge>
              <span className="tabular-nums">
                Giao {r.assigned} · Đang dọn {r.inProgress} · Xong {r.completed}
              </span>
              {r.facts ? <span className="w-full tabular-nums">Ca: {shiftText(r.facts, oneDay)}</span> : null}
            </p>
          </div>
        </div>
      ),
    },
    ...(isAdmin
      ? [{ key: 'branch', header: 'Chi nhánh', className: `whitespace-nowrap ${WIDE}`, render: (r: StaffLine) => (r.facts?.branchNumber ? `CN ${r.facts.branchNumber}` : '—') }]
      : []),
    { key: 'shift', header: 'Ca làm', className: `whitespace-nowrap ${WIDE}`, render: (r) => <span className="tabular-nums text-slate-700">{shiftText(r.facts, oneDay)}</span> },
    { key: 'assigned', header: 'Được giao', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.assigned}</span> },
    { key: 'inProgress', header: 'Đang dọn', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.inProgress}</span> },
    { key: 'completed', header: 'Hoàn thành', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.completed}</span> },
    {
      key: 'rate',
      header: 'Tiến độ',
      align: 'right',
      className: WIDE,
      render: (r) => <RateBar rate={r.assigned === 0 ? null : r.completionRate} tone={r.completionRate < 50 ? 'amber' : 'green'} />,
    },
    { key: 'status', header: 'Trạng thái', className: `whitespace-nowrap ${WIDE}`, render: (r) => <Badge tone={STAFF_STATE[r.state].tone}>{label(r.state)}</Badge> },
  ];
  return (
    <div>
      <HkHeader
        title="Theo dõi nhân viên"
        description="Ca làm, khối lượng công việc và tiến độ hoàn thành của đội buồng phòng."
        branch={branch}
        period={context}
      />
      <section aria-label="Bộ lọc" className={`${CARD} mb-5 space-y-3 px-4 py-3`}>
        {bar}
        <div className="grid gap-3 border-t border-line-subtle pt-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto] sm:items-end" data-testid="staff-filters">
        <label className="block min-w-0">
          <span className={CAPTION}>Trạng thái ca</span>
          <select className={CONTROL} value={state} onChange={(e) => setState(e.target.value as StaffState | '')} data-testid="staff-state">
            <option value="">Tất cả trạng thái</option>
            {(Object.keys(STAFF_STATE) as StaffState[]).map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="relative block min-w-0">
          <span className={CAPTION}>Tìm nhân viên</span>
          <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" aria-hidden="true" />
          <input type="search" className={`${CONTROL} pl-9`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tên nhân viên…" data-testid="staff-search" />
        </label>
        <Button
          variant="secondary"
          onClick={() => {
            void progress.refetch();
            void shifts.refetch();
            void groups.refetch();
          }}
          loading={progress.isFetching || shifts.isFetching}
          data-testid="staff-refresh"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Làm mới
        </Button>
        </div>
      </section>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="staff-summary">
        {isToday ? (
          <Metric icon={Users} label="Nhân viên trong ca" value={onShiftNow} tone="green" hint={`${withShift} người có ca hôm nay`} />
        ) : (
          <Metric icon={Users} label="Nhân viên có ca" value={withShift} hint="trong kỳ đã chọn" />
        )}
        <Metric icon={ClipboardList} label="Công việc được giao" value={team.assigned} hint="phòng / khu vực" />
        <Metric icon={Brush} label="Đang dọn" value={team.inProgress} tone="blue" />
        <Metric icon={CircleCheck} label="Đã hoàn thành" value={team.completed} tone="green" />
        <Metric icon={BarChart3} label="Tỷ lệ hoàn thành" value={teamRate === null ? '—' : `${teamRate}%`} hint={`${team.completed}/${team.assigned} công việc`} />
      </div>
      <DataTable
        frame="light"
        title="Nhân viên"
        badge={shown.length}
        testId="staff-table"
        columns={columns}
        rows={shown}
        rowKey={(r) => String(r.userId)}
        isLoading={progress.isLoading}
        isError={progress.isError}
        error={progress.error}
        onRetry={() => void progress.refetch()}
        emptyTitle={lines.length === 0 ? 'Chưa có dữ liệu' : 'Không có nhân viên khớp bộ lọc'}
        emptyMessage={lines.length === 0 ? 'Nhân viên có ca, được giao phòng hoặc kiểm phòng trong khoảng này sẽ hiện ở đây.' : 'Đổi trạng thái hoặc từ khóa tìm kiếm.'}
        actions={(r) => (
          <button type="button" onClick={() => setOpen(r)} data-testid={`staff-open-${r.userId}`} className={ROW_BUTTON}>
            Chi tiết
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      />
      {oneDay && scope ? (
        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <HkSection title="Theo dõi ca làm" icon={CalendarClock} testId="staff-shifts">
            {shifts.isError ? (
              <ErrorAlert>{toUserMessage(shifts.error)}</ErrorAlert>
            ) : lines.length === 0 ? (
              <p className="text-sm text-slate-500">Chưa có ca làm nào trong ngày.</p>
            ) : (
              <ShiftTimeline lines={lines} day={scope.from} />
            )}
          </HkSection>
          <HkSection title="Cần chú ý" icon={CircleAlert} testId="staff-attention">
            {idleWork.length === 0 && waiting.length === 0 ? (
              <p className="text-sm text-slate-500">Không có việc cần xử lý.</p>
            ) : (
              <ul className="space-y-2.5">
                {idleWork.length > 0 ? (
                  <li className="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2.5">
                    <p className="text-sm font-semibold text-red-800">
                      {idleWork.length} nhân viên còn việc nhưng không trong ca
                    </p>
                    <p className="mt-0.5 text-xs text-slate-700">
                      {idleWork.map((l) => `${l.fullName} (${l.assigned - l.completed} việc chưa xong)`).join(', ')}
                    </p>
                  </li>
                ) : null}
                {waiting.length > 0 ? (
                  <li className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                    <p className="text-sm font-semibold text-amber-900">{waiting.length} công việc chưa có người nhận</p>
                    <p className="mt-0.5 text-xs text-slate-700">{waiting.map((g) => g.title).join(', ')}</p>
                    <Link to="/app/hk/rooms?view=groups" className={`${SECTION_LINK} mt-1.5 text-xs`}>
                      Mở Công việc cá nhân <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </li>
                ) : null}
              </ul>
            )}
          </HkSection>
        </div>
      ) : null}
      {open && scope ? <StaffDetailModal userId={open.userId} name={open.fullName} scope={scope} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** The findings table — the branch number for the Admin only (the manager has one hotel). */
const findingColumns = (withBranch: boolean): DataColumn<FindingLine>[] => [
  { key: 'when', header: 'Thời gian', render: (f) => formatDateTime(f.createdAt) },
  { key: 'room', header: 'Phòng', render: (f) => (withBranch ? `${f.roomNumber} · CN ${f.branch.branchNumber}` : f.roomNumber) },
  { key: 'type', header: 'Phát sinh', render: (f) => (f.note ? `${f.typeLabel} — ${f.note}` : f.typeLabel) },
  { key: 'inspector', header: 'Người kiểm phòng', secondary: true, render: (f) => f.inspectorName },
  { key: 'status', header: 'Thu tiền', render: (f) => <Badge tone={f.collectionStatus === 'COLLECTED' ? 'green' : f.collectionStatus === 'PENDING' ? 'amber' : 'red'}>{f.collectionStatusLabel}</Badge> },
  { key: 'amount', header: 'Số tiền', align: 'right', render: (f) => (f.amount === null ? '—' : formatVnd(f.amount)) },
  { key: 'by', header: 'Lễ tân xác nhận', secondary: true, render: (f) => (f.collectedByName ? `${f.collectedByName}${f.collectedAt ? ` · ${formatDateTime(f.collectedAt)}` : ''}` : '—') },
];

function StaffDetailModal({ userId, name, scope, onClose }: { userId: number; name: string; scope: { from: string; to: string; branchId?: number }; onClose: () => void }) {
  const isAdmin = useAuth().user?.role === 'ADMIN';
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
                  <li key={t.id} className="overflow-hidden rounded-lg border border-line-subtle">
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
                      <div className="border-t border-line-subtle px-3 py-3">
                        <RoomTaskDetail task={t} catalog={catalog.data} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <DataTable frame="light" title="Phát sinh khi kiểm phòng" badge={d.findings.length} testId="staff-findings" columns={findingColumns(isAdmin)} rows={d.findings} rowKey={(f) => f.id} emptyTitle="Không có phát sinh" emptyMessage="" />
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Ca làm việc</h3>
              {d.shifts.length === 0 ? (
                <p className="text-sm text-slate-500">Không có ca trong khoảng này.</p>
              ) : (
                <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle text-sm">
                  {d.shifts.flatMap((s) =>
                    s.segments.map((seg) => (
                      <li key={seg.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                        <span className="font-medium text-slate-800">{hotelName(seg.branch, isAdmin)}</span>
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

/** Each finding once, stacked by where its collection stands now: green → amber → red. */
const COLLECTION_SERIES: ChartSeries[] = [
  { key: 'COLLECTED', label: 'Đã thu', colorClass: 'bg-[#15803d]' },
  { key: 'PENDING', label: 'Chưa thu', colorClass: 'bg-[#d97706]' },
  { key: 'UNCOLLECTIBLE', label: 'Không thu được', colorClass: 'bg-[#be123c]' },
];

/**
 * The findings of the period over time: by hour for one day, by day up to two
 * months, by month beyond — counted at the moment each was recorded.
 */
function findingBuckets(findings: FindingLine[], from: string, to: string): { buckets: ChartBucket[]; unit: 'hour' | 'day' | 'month' } {
  const zero = () => ({ COLLECTED: 0, PENDING: 0, UNCOLLECTIBLE: 0 }) as Record<string, number>;
  if (from === to) {
    const hours = findings.map((f) => Number(hcmTimeOfDay(new Date(f.createdAt)).slice(0, 2)));
    const lo = Math.min(6, ...hours);
    const hi = Math.max(22, ...hours);
    const buckets: ChartBucket[] = [];
    for (let h = lo; h <= hi; h += 1) {
      const hh = String(h).padStart(2, '0');
      buckets.push({ key: hh, label: `${hh}:00`, title: `${hh}:00–${String(h + 1).padStart(2, '0')}:00`, values: zero() });
    }
    findings.forEach((f, i) => {
      const b = buckets.find((x) => Number(x.key) === hours[i]);
      if (b) b.values[f.collectionStatus] = (b.values[f.collectionStatus] ?? 0) + 1;
    });
    return { buckets, unit: 'hour' };
  }
  const days = daysOf(from, to);
  const monthly = days.length > MAX_DAILY_BUCKETS;
  const keyOf = (iso: string) => (monthly ? iso.slice(0, 7) : iso);
  const keys = [...new Set(days.map(keyOf))];
  const buckets: ChartBucket[] = keys.map((k) => ({
    key: k,
    label: monthly ? `${k.slice(5, 7)}/${k.slice(0, 4)}` : dayLabel(k),
    title: monthly ? `Tháng ${k.slice(5, 7)}/${k.slice(0, 4)}` : `${weekdayOf(k)} ${formatDate(k)}`,
    values: zero(),
  }));
  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const f of findings) {
    const b = index.get(keyOf(hcmToday(new Date(f.createdAt))));
    if (b) b.values[f.collectionStatus] = (b.values[f.collectionStatus] ?? 0) + 1;
  }
  return { buckets, unit: monthly ? 'month' : 'day' };
}

/** The collection rate of a row, by count: đã thu / (đã thu + chưa thu + không thu được). */
function collectionRate(r: Pick<KpiRow, 'collectedCount' | 'pendingCount' | 'uncollectibleCount'>): number | null {
  const base = r.collectedCount + r.pendingCount + r.uncollectibleCount;
  return base === 0 ? null : Math.round((r.collectedCount / base) * 100);
}

export function HkKpiPage() {
  const { scope, bar, branch, context } = usePeriodScope();
  const [userId, setUserId] = useState<number | ''>('');
  const [status, setStatus] = useState<RoomCollectionStatus | ''>('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<KpiRow | null>(null);
  const staff = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff', 'period', scope?.branchId ?? null],
    queryFn: () => roomWorkApi.staff({ branchId: scope?.branchId }),
  });
  const params = scope ? { ...scope, userId: userId === '' ? undefined : userId, status: status || undefined } : null;
  const kpi = useQuery({ queryKey: [...ROOM_WORK_KEY, 'kpi', params], queryFn: () => roomWorkApi.kpi(params!), enabled: params !== null });
  const totals = kpi.data?.totals;
  const needle = search.trim().toLocaleLowerCase('vi');
  const rows = (kpi.data?.rows ?? []).filter((r) => !needle || r.fullName.toLocaleLowerCase('vi').includes(needle));
  const chart = scope && kpi.data ? findingBuckets(kpi.data.findings, scope.from, scope.to) : null;
  const counted = totals ? totals.collectedCount + totals.pendingCount + totals.uncollectibleCount : 0;
  const columns: DataColumn<KpiRow>[] = [
    {
      key: 'name',
      header: 'Nhân viên',
      render: (r) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={r.fullName} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{r.fullName}</p>
            <p className="text-xs tabular-nums text-slate-600 md:hidden">
              Kiểm phòng {r.inspections} · Phát sinh {r.findings} · Đã thu {formatVnd(r.collectedAmount)} ·{' '}
              <span className={r.pendingCount > 0 ? 'font-semibold text-red-700' : ''}>Chưa thu {formatVnd(r.pendingAmount)}</span>
            </p>
          </div>
        </div>
      ),
    },
    { key: 'inspections', header: 'Lượt kiểm phòng', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.inspections}</span> },
    { key: 'findings', header: 'Phát sinh', align: 'right', className: WIDE, render: (r) => <span className="tabular-nums">{r.findings}</span> },
    { key: 'amount', header: 'Đã thu', align: 'right', className: WIDE, render: (r) => <span className="font-semibold tabular-nums text-green-700">{formatVnd(r.collectedAmount)}</span> },
    {
      key: 'pending',
      header: 'Chưa thu',
      align: 'right',
      className: WIDE,
      render: (r) => (
        <span className={`tabular-nums ${r.pendingCount > 0 ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
          {formatVnd(r.pendingAmount)}
          <span className="block text-xs font-normal text-slate-500">{r.pendingCount} khoản</span>
        </span>
      ),
    },
    { key: 'rate', header: 'Tỷ lệ thu (khoản)', align: 'right', className: WIDE, render: (r) => <RateBar rate={collectionRate(r)} tone={(collectionRate(r) ?? 100) < 50 ? 'amber' : 'green'} /> },
  ];
  return (
    <div>
      <HkHeader
        title="KPI"
        description="Lượt kiểm phòng, phát sinh mỗi nhân viên ghi nhận, và kết quả thu tiền của các phát sinh đó."
        branch={branch}
        period={context}
      />
      <section aria-label="Bộ lọc" className={`${CARD} mb-5 space-y-3 px-4 py-3`}>
        {bar}
        <div className="grid gap-3 border-t border-line-subtle pt-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block min-w-0">
            <span className={CAPTION}>Nhân viên</span>
            <select className={CONTROL} value={userId} onChange={(e) => setUserId(e.target.value === '' ? '' : Number(e.target.value))} data-testid="kpi-employee">
              <option value="">Tất cả nhân viên</option>
              {(staff.data?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={CAPTION}>Trạng thái thu tiền</span>
            <select className={CONTROL} value={status} onChange={(e) => setStatus(e.target.value as RoomCollectionStatus | '')} data-testid="kpi-status">
              <option value="">Tất cả trạng thái</option>
              <option value="COLLECTED">Đã thu</option>
              <option value="PENDING">Chưa thu</option>
              <option value="UNCOLLECTIBLE">Không thu được</option>
            </select>
          </label>
          <label className="relative block min-w-0 sm:col-span-2 lg:col-span-1">
            <span className={CAPTION}>Tìm nhân viên</span>
            <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input type="search" className={`${CONTROL} pl-9`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tên nhân viên…" data-testid="kpi-search" />
          </label>
        </div>
      </section>
      {kpi.isError ? <ErrorAlert>{toUserMessage(kpi.error)}</ErrorAlert> : null}
      {totals ? (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="kpi-totals">
            <Metric icon={ClipboardCheck} label="Lượt kiểm phòng" value={totals.inspections} />
            <Metric icon={CircleAlert} label="Phát sinh" value={totals.findings} tone="amber" />
            <Metric icon={Wallet} label="Tổng tiền đã thu" value={formatVnd(totals.collectedAmount)} tone="green" hint={`${totals.collectedCount} khoản đã thu`} testId="kpi-collected" />
            <Metric icon={Clock} label="Chưa thu" value={formatVnd(totals.pendingAmount)} tone="red" hint={`${totals.pendingCount} khoản`} />
            <Metric icon={CircleMinus} label="Không thu được" value={`${totals.uncollectibleCount} khoản`} tone="slate" />
          </div>
          <div className="mb-5 grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
            <HkSection title="Tổng quan thu tiền" icon={Wallet} testId="kpi-collection">
              <div className="space-y-4">
                <Meter label="Đã thu" value={formatVnd(totals.collectedAmount)} share={totals.collectedCount} total={counted} barClass="bg-[#15803d]" />
                <Meter label="Chưa thu" value={formatVnd(totals.pendingAmount)} share={totals.pendingCount} total={counted} barClass="bg-[#d97706]" />
                <Meter label="Không thu được" value={`${totals.uncollectibleCount} khoản`} share={totals.uncollectibleCount} total={counted} barClass="bg-[#be123c]" />
                <p className="text-xs text-slate-500">Tỷ lệ tính theo số khoản phát sinh ({counted} khoản), không theo số tiền.</p>
              </div>
            </HkSection>
            <HkSection
              title={chart?.unit === 'hour' ? 'Phát sinh theo giờ' : chart?.unit === 'month' ? 'Phát sinh theo tháng' : 'Phát sinh theo ngày'}
              icon={BarChart3}
              testId="kpi-chart"
            >
              {chart && kpi.data && kpi.data.findings.length > 0 ? (
                <>
                  <BarChart
                    buckets={chart.buckets}
                    series={COLLECTION_SERIES}
                    mode="stacked"
                    unit="khoản"
                    label="Số phát sinh theo thời gian, chia theo trạng thái thu tiền"
                    testId="kpi-chart-bars"
                  />
                  <p className="mt-2 text-xs text-slate-500">Mỗi phát sinh tính một lần, tại thời điểm ghi nhận; màu là trạng thái thu tiền hiện tại.</p>
                </>
              ) : (
                <p className="py-8 text-center text-sm text-slate-500">Chưa có phát sinh trong khoảng này.</p>
              )}
            </HkSection>
          </div>
        </>
      ) : null}
      <DataTable
        frame="light"
        title="KPI theo nhân viên"
        badge={rows.length}
        testId="kpi-table"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.userId)}
        isLoading={kpi.isLoading}
        isError={kpi.isError}
        error={kpi.error}
        onRetry={() => void kpi.refetch()}
        emptyTitle={needle ? 'Không có nhân viên khớp tìm kiếm' : 'Chưa có dữ liệu'}
        emptyMessage={needle ? 'Đổi từ khóa tìm kiếm.' : 'Lượt kiểm phòng trong khoảng này sẽ hiện ở đây.'}
        actions={(r) => (
          <button type="button" onClick={() => setOpen(r)} data-testid={`kpi-open-${r.userId}`} className={ROW_BUTTON}>
            Chi tiết
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      />
      {open && scope ? <KpiDetailModal row={open} scope={scope} status={status || undefined} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function KpiDetailModal({ row, scope, status, onClose }: { row: KpiRow; scope: { from: string; to: string; branchId?: number }; status?: RoomCollectionStatus; onClose: () => void }) {
  const isAdmin = useAuth().user?.role === 'ADMIN';
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
        frame="light"
          title="Phát sinh và thu tiền"
          badge={detail.data?.findings.length}
          testId="kpi-findings"
          columns={findingColumns(isAdmin)}
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

const PROGRESS_SERIES: ChartSeries[] = [
  { key: 'assigned', label: 'Được giao', colorClass: 'bg-[#2563eb]' },
  { key: 'completed', label: 'Hoàn thành', colorClass: 'bg-[#16a34a]' },
];

const INSPECTION_SERIES: ChartSeries[] = [
  { key: 'inspections', label: 'Lượt kiểm phòng', colorClass: 'bg-[#2563eb]' },
  { key: 'findings', label: 'Phát sinh', colorClass: 'bg-[#d97706]' },
];

/** The value a moment after the last keystroke — one request per pause, not one per letter. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * "BÁO CÁO VẬN HÀNH BUỒNG PHÒNG". Every filter — the period, the branch, the
 * worker, the report type, the search — goes to the SERVER, which applies it
 * and checks it (a worker outside the reader's branches is refused). The
 * figures, the chart, the collection summary, the table and both exported files
 * are all made from that one filtered answer; nothing is filtered here alone.
 */
export function HkReportPage() {
  const { scope, bar, branch, context } = usePeriodScope();
  const [userId, setUserId] = useState<number | ''>('');
  const [type, setType] = useState<ReportType>('ALL');
  const [search, setSearch] = useState('');
  const q = useSettled(search.trim(), 350);
  const staff = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'staff', 'period', scope?.branchId ?? null],
    queryFn: () => roomWorkApi.staff({ branchId: scope?.branchId }),
  });
  const params: ReportQuery | null = scope ? { ...scope, userId: userId === '' ? undefined : userId, type, q: q || undefined } : null;
  const report = useQuery({ queryKey: [...ROOM_WORK_KEY, 'report', params], queryFn: () => roomWorkApi.report(params!), enabled: params !== null });
  // The page goes back to the first whenever the filters change.
  const filterKey = JSON.stringify(params);
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const cleaning = type !== 'INSPECTION';
  const inspecting = type !== 'CLEANING';
  const filtered = userId !== '' || type !== 'ALL' || search.trim() !== '';
  const rows = useMemo(() => report.data?.rows ?? [], [report.data]);
  const sum = rows.reduce(
    (t, r) => ({
      assigned: t.assigned + r.assigned,
      completed: t.completed + r.completed,
      inspections: t.inspections + r.inspections,
      findings: t.findings + r.findings,
      collected: t.collected + r.collectedAmount,
      pending: t.pending + r.pendingAmount,
      pendingCount: t.pendingCount + r.pendingCount,
      uncollectible: t.uncollectible + (r.uncollectibleCount ?? 0),
    }),
    { assigned: 0, completed: 0, inspections: 0, findings: 0, collected: 0, pending: 0, pendingCount: 0, uncollectible: 0 },
  );
  const rate = sum.assigned === 0 ? null : Math.round((sum.completed / sum.assigned) * 100);
  const chart = useMemo<ChartBucket[]>(() => {
    if (!scope) return [];
    const days = daysOf(scope.from, scope.to);
    const monthly = days.length > MAX_DAILY_BUCKETS;
    const keyOf = (iso: string) => (monthly ? iso.slice(0, 7) : iso);
    const buckets = [...new Set(days.map(keyOf))].map((k) => ({
      key: k,
      label: monthly ? `${k.slice(5, 7)}/${k.slice(0, 4)}` : dayLabel(k),
      title: monthly ? `Tháng ${k.slice(5, 7)}/${k.slice(0, 4)}` : `${weekdayOf(k)} ${formatDate(k)}`,
      values: { assigned: 0, completed: 0, inspections: 0, findings: 0 } as Record<string, number>,
    }));
    const index = new Map(buckets.map((b) => [b.key, b]));
    for (const r of rows) {
      const b = index.get(keyOf(r.workDate));
      if (!b) continue;
      b.values.assigned = (b.values.assigned ?? 0) + r.assigned;
      b.values.completed = (b.values.completed ?? 0) + r.completed;
      b.values.inspections = (b.values.inspections ?? 0) + r.inspections;
      b.values.findings = (b.values.findings ?? 0) + r.findings;
    }
    return buckets;
  }, [rows, scope]);
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const current = Math.min(page, Math.max(0, pages - 1));
  const columns = useMemo<DataColumn<OperationsRow>[]>(() => {
    const base: DataColumn<OperationsRow>[] = [
      { key: 'date', header: 'Ngày', className: `whitespace-nowrap ${WIDE}`, render: (r) => formatDate(r.workDate) },
      { key: 'branch', header: 'Chi nhánh', secondary: true, render: (r) => r.branchLabel },
      {
        key: 'employee',
        header: 'Nhân viên',
        render: (r) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={r.employee} size="sm" />
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900">{r.employee}</p>
              <p className="text-xs text-slate-500 md:hidden">{formatDate(r.workDate)}</p>
            </div>
          </div>
        ),
      },
    ];
    const work: DataColumn<OperationsRow>[] = [
      { key: 'assigned', header: 'Được giao', align: 'right', secondary: true, render: (r) => r.assigned },
      { key: 'completed', header: 'Hoàn thành', align: 'right', render: (r) => `${r.completed} (${r.completionRate}%)` },
      { key: 'avg', header: 'TB dọn phòng', align: 'right', secondary: true, render: (r) => formatMinutes(r.avgCleaningSeconds) },
    ];
    const checks: DataColumn<OperationsRow>[] = [
      { key: 'inspections', header: 'Kiểm phòng', align: 'right', secondary: true, render: (r) => r.inspections },
      { key: 'findings', header: 'Phát sinh', align: 'right', secondary: true, render: (r) => r.findings },
      { key: 'collected', header: 'Đã thu', align: 'right', render: (r) => formatVnd(r.collectedAmount) },
      { key: 'pending', header: 'Chưa thu', align: 'right', secondary: true, render: (r) => `${formatVnd(r.pendingAmount)} (${r.pendingCount})` },
      { key: 'uncollectible', header: 'Không thu được', align: 'right', secondary: true, render: (r) => `${r.uncollectibleCount ?? 0} khoản` },
    ];
    const notes: DataColumn<OperationsRow> = {
      key: 'notes',
      header: 'Ghi chú',
      secondary: true,
      render: (r) => [r.voided ? `${r.voided} phòng đã xóa` : '', r.notes ? `${r.notes} ghi chú` : ''].filter(Boolean).join(', ') || '—',
    };
    return [...base, ...(cleaning ? work : []), ...(inspecting ? checks : []), ...(cleaning ? [notes] : [])];
  }, [cleaning, inspecting]);
  const exportLink = (kind: 'pdf' | 'xlsx', text: string, Icon: LucideIcon, primary: boolean) => (
    <a
      href={params ? housekeepingReportUrl(kind, params) : undefined}
      aria-disabled={params ? undefined : true}
      data-testid={`hk-report-${kind}`}
      className={`inline-flex min-h-[2.5rem] items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1 ${
        primary ? 'bg-brand-600 text-white hover:bg-brand-700' : 'border border-line-strong bg-white text-slate-800 hover:bg-slate-50'
      } ${params ? '' : 'pointer-events-none opacity-50'}`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {text}
    </a>
  );
  const metrics = [
    ...(cleaning
      ? [
          <Metric key="assigned" icon={ClipboardList} label="Công việc được giao" value={sum.assigned} />,
          <Metric key="completed" icon={CircleCheck} label="Đã hoàn thành" value={sum.completed} tone="green" hint={rate === null ? undefined : `${rate}% công việc được giao`} />,
        ]
      : []),
    ...(inspecting
      ? [
          <Metric key="inspections" icon={ClipboardCheck} label="Lượt kiểm phòng" value={sum.inspections} />,
          <Metric key="findings" icon={CircleAlert} label="Phát sinh" value={sum.findings} tone="amber" />,
          <Metric key="collected" icon={Wallet} label="Tiền đã thu" value={formatVnd(sum.collected)} tone="green" />,
        ]
      : []),
  ];
  return (
    <div>
      <HkHeader
        title="Báo cáo vận hành buồng phòng"
        description="Theo ngày và nhân viên: công việc được giao và hoàn thành, kiểm phòng, phát sinh, thời gian dọn, tiền đã thu và chưa thu. File xuất theo đúng bộ lọc đang chọn."
        branch={branch}
        period={context}
        actions={
          <div className="flex flex-wrap gap-2" data-testid="hk-report-export">
            {exportLink('xlsx', 'Xuất Excel', FileSpreadsheet, true)}
            {exportLink('pdf', 'Xuất PDF', Download, false)}
          </div>
        }
      />
      <section aria-label="Bộ lọc" className={`${CARD} mb-5 space-y-3 px-4 py-3`}>
        {bar}
        <div className="grid gap-3 border-t border-line-subtle pt-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,14rem)_minmax(0,14rem)_minmax(0,1fr)_auto] lg:items-end" data-testid="hk-report-filters">
          <label className="block min-w-0">
            <span className={CAPTION}>Nhân viên</span>
            <select className={CONTROL} value={userId} onChange={(e) => setUserId(e.target.value === '' ? '' : Number(e.target.value))} data-testid="report-employee">
              <option value="">Tất cả nhân viên</option>
              {(staff.data?.staff ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className={CAPTION}>Loại báo cáo</span>
            <select className={CONTROL} value={type} onChange={(e) => setType(e.target.value as ReportType)} data-testid="report-type">
              {REPORT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="relative block min-w-0 sm:col-span-2 lg:col-span-1">
            <span className={CAPTION}>Tìm kiếm</span>
            <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              className={`${CONTROL} pl-9`}
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Số phòng / khu vực, tên nhân viên, mã phát sinh…"
              data-testid="report-search"
            />
          </label>
          <button
            type="button"
            className={`${ROW_BUTTON} min-h-[2.5rem]`}
            disabled={!filtered}
            onClick={() => {
              setUserId('');
              setType('ALL');
              setSearch('');
            }}
            data-testid="report-clear"
          >
            Xóa bộ lọc
          </button>
        </div>
      </section>
      {report.isError ? (
        <div className="mb-5">
          <ErrorAlert>{toUserMessage(report.error)}</ErrorAlert>
        </div>
      ) : null}
      <div className={`mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 ${metrics.length >= 5 ? 'xl:grid-cols-5' : metrics.length === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-2'}`} data-testid="hk-report-summary">
        {metrics}
      </div>
      <div className={`mb-5 grid gap-5 ${inspecting ? 'xl:grid-cols-[minmax(0,1fr)_22rem]' : ''}`}>
        <HkSection title={cleaning ? 'Tiến độ công việc theo ngày' : 'Kiểm phòng và phát sinh theo ngày'} icon={BarChart3} testId="hk-report-chart">
          {report.isLoading ? (
            <p className="py-8 text-center text-sm text-slate-500">Đang tải…</p>
          ) : (cleaning ? sum.assigned : sum.inspections) === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">{cleaning ? 'Chưa có công việc được giao khớp bộ lọc này.' : 'Chưa có lượt kiểm phòng khớp bộ lọc này.'}</p>
          ) : cleaning ? (
            <BarChart buckets={chart} series={PROGRESS_SERIES} mode="grouped" unit="công việc" label="Công việc được giao và hoàn thành theo ngày" testId="hk-report-bars" />
          ) : (
            <BarChart buckets={chart} series={INSPECTION_SERIES} mode="grouped" unit="lượt" label="Lượt kiểm phòng và phát sinh theo ngày" testId="hk-report-bars" />
          )}
        </HkSection>
        {inspecting ? (
          <HkSection title="Tổng hợp thu tiền" icon={Wallet} testId="hk-report-collection">
            <dl className="space-y-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-slate-600">
                  <span className="h-2.5 w-2.5 rounded-sm bg-[#15803d]" aria-hidden="true" />
                  Đã thu
                </dt>
                <dd className="font-semibold tabular-nums text-slate-900">{formatVnd(sum.collected)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-slate-600">
                  <span className="h-2.5 w-2.5 rounded-sm bg-[#d97706]" aria-hidden="true" />
                  Chưa thu
                </dt>
                <dd className="text-right font-semibold tabular-nums text-slate-900">
                  {formatVnd(sum.pending)}
                  <span className="block text-xs font-normal text-slate-500">{sum.pendingCount} khoản</span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="inline-flex items-center gap-2 text-slate-600">
                  <span className="h-2.5 w-2.5 rounded-sm bg-[#be123c]" aria-hidden="true" />
                  Không thu được
                </dt>
                <dd className="font-semibold tabular-nums text-slate-900">{sum.uncollectible} khoản</dd>
              </div>
            </dl>
            {sum.collected + sum.pending > 0 ? (
              <div className="mt-4">
                <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`Đã thu ${formatVnd(sum.collected)}, chưa thu ${formatVnd(sum.pending)}`}>
                  {sum.collected > 0 ? <span className="rounded-full bg-[#15803d]" style={{ width: `${(sum.collected / (sum.collected + sum.pending)) * 100}%` }} /> : null}
                  {sum.pending > 0 ? <span className="rounded-full bg-[#d97706]" style={{ width: `${(sum.pending / (sum.collected + sum.pending)) * 100}%` }} /> : null}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">Tỷ lệ theo số tiền giữa đã thu và chưa thu. “Không thu được” không có số tiền nên chỉ tính số khoản.</p>
              </div>
            ) : null}
          </HkSection>
        ) : null}
      </div>
      <DataTable
        frame="light"
        title="Chi tiết báo cáo"
        badge={rows.length}
        testId="hk-report"
        columns={columns}
        rows={rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)}
        rowKey={(r) => `${r.branchLabel}|${r.workDate}|${r.employee}`}
        isLoading={report.isLoading}
        isError={report.isError}
        error={report.error}
        onRetry={() => void report.refetch()}
        emptyTitle={filtered ? 'Không có dữ liệu khớp bộ lọc' : 'Chưa có dữ liệu'}
        emptyMessage={filtered ? 'Đổi nhân viên, loại báo cáo hoặc từ khóa tìm kiếm.' : 'Công việc buồng phòng trong khoảng này sẽ hiện ở đây.'}
        footer={
          rows.length > 0 ? (
            <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-700" data-testid="hk-report-totals">
              {cleaning ? (
                <span>
                  Hoàn thành <strong className="tabular-nums">{sum.completed}/{sum.assigned}</strong> phòng
                </span>
              ) : null}
              {inspecting ? (
                <>
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
                </>
              ) : null}
            </p>
          ) : undefined
        }
      />
      <Pager page={current} pages={pages} total={rows.length} onPage={(p) => setPaging({ key: filterKey, page: p })} />
    </div>
  );
}
