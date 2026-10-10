/**
 * "BÁO CÁO VẤN ĐỀ → KỸ THUẬT" — and the Quản lý kỹ thuật's own workspace
 * ("Quản lý sự cố kỹ thuật").
 *
 * Every incident of the reader's branches, grouped Branch → ROOM → incidents.
 * A room is one group however many faults it has (Phòng 206's four are one
 * block, with ONE "Giao kỹ thuật" that lets the assigner tick any subset); each
 * incident keeps its own state, holder, result, stages and history. The Admin
 * reads every branch, a Quản lý lễ tân / Quản lý kỹ thuật its ticked ones, the
 * Tổng quản lý lễ tân all — the SERVER scopes every row and every action.
 *
 * THE SHARED REPORT FILTER (business dates, branch, shift) plus the technical
 * filters — room, type, technician, "Mức độ" — all go to the server; the status
 * buckets are read from the loaded rows, because they are the server's own
 * assignment state and overlap on purpose ("Đã giao lại" is also "Đã giao").
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, Eye, Forward, HardHat, RefreshCw, Undo2, Trash2, UserPlus, Wrench } from 'lucide-react';
import { ISSUE_CATEGORIES, issueCategoryLabel, issuesApi, type Issue, type IssueCategory } from '../api/issues';
import { branchesApi } from '../api/bookings';
import { adminBranchesApi } from '../api/adminBranches';
import { operationalPdfUrl, operationalXlsxUrl } from '../api/receptionReports';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel, isTechnicalAssigner, isTechnicalManagerRole, type Branch, type UserRole } from '../auth/types';
import { can } from '../auth/capabilities';
import { CompleteExternalDialog, ExternalDispatchDialog, GiveWorkDialog } from '../components/TechnicalDispatchDialogs';
import { formatVnd } from '../lib/money';
import { useBranchRooms } from '../hooks/useBranchRooms';
import { useIssueSummary } from '../hooks/useIssueSummary';
import { EmptyState } from '../components/EmptyState';
import { IssueLifecycleDetail, IssueStageBadge, IssueStageTimeline } from '../components/IssueViews';
import { DeleteIssueDialog, UnassignIssueDialog } from '../components/IssueManageDialogs';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { ReportFilterBar } from '../components/ReportFilter';
import { RoomAssignDialog } from '../components/RoomAssignDialog';
import { Toast } from '../components/Toast';
import { groupIssuesByBranchRoom, type RoomGroup } from '../lib/issueGroups';
import { initialReportFilter, reportBranchId, reportPeriod, type ReportFilterValue } from '../lib/reportFilter';
import { formatDateTime, hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';
import { SeverityBadge } from '../components/Severity';
import { SEVERITY_OPTIONS } from '../lib/severity';
import type { Severity } from '../api/receptionReports';

const POLL_MS = 30_000;

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:bg-slate-50 disabled:text-slate-400';

/** "Tình trạng" at a glance — the server's assignment state, plus the two histories. */
const BUCKETS = [
  { key: 'UNASSIGNED', label: 'Chờ giao kỹ thuật' },
  { key: 'MANAGER_ASSIGNED', label: 'Đã giao quản lý kỹ thuật' },
  { key: 'ASSIGNED', label: 'Đã giao' },
  { key: 'IN_PROGRESS', label: 'Đang sửa' },
  { key: 'EXTERNAL', label: 'Kĩ thuật bên ngoài' },
  { key: 'COMPLETED', label: 'Đã hoàn thành' },
  { key: 'CANNOT_REPAIR', label: 'Không sửa được' },
  { key: 'REASSIGNED', label: 'Đã giao lại' },
  { key: 'REWORK', label: 'Cần sửa lại' },
] as const;
/**
 * "Giao cho tôi" — a Quản lý kỹ thuật's own work: what a Tổng quản lý kỹ thuật
 * handed to THIS manager and is not finished yet. Shown to that role only.
 */
const MINE_BUCKET = { key: 'MINE', label: 'Giao cho tôi' } as const;
type Bucket = (typeof BUCKETS)[number]['key'] | typeof MINE_BUCKET.key;

function inBucket(issue: Issue, bucket: Bucket, userId?: number): boolean {
  switch (bucket) {
    case 'MINE':
      return userId !== undefined && issue.assignedManager?.id === userId && issue.status !== 'COMPLETED';
    case 'UNASSIGNED':
      return issue.assignmentState === 'UNASSIGNED';
    case 'MANAGER_ASSIGNED':
      return issue.assignmentState === 'MANAGER_ASSIGNED';
    case 'ASSIGNED':
      return issue.assignmentState === 'ASSIGNED';
    case 'IN_PROGRESS':
      return issue.assignmentState === 'IN_PROGRESS';
    case 'EXTERNAL':
      return issue.assignmentState === 'EXTERNAL_IN_PROGRESS';
    case 'COMPLETED':
      return issue.status === 'COMPLETED';
    case 'CANNOT_REPAIR':
      return issue.assignmentState === 'AWAITING_REASSIGNMENT';
    case 'REASSIGNED':
      return issue.status !== 'COMPLETED' && (issue.assignments ?? []).some((a) => a.reassigned);
    case 'REWORK':
      return issue.stage === 'REWORK';
  }
}

export function TechnicalReportPage() {
  const { user } = useAuth();
  const canAssign = isTechnicalAssigner(user?.role);
  const isAdmin = user?.role === 'ADMIN';
  const today = hcmToday();

  /*
    THE LAST 30 DAYS BY DEFAULT: a technical workspace is about what is open,
    and a fault reported last week and still waiting must be on screen.
  */
  const [filter, setFilter] = useState<ReportFilterValue>(() =>
    initialReportFilter(today, { mode: 'RANGE', range: { from: daysBefore(today, 29), to: today }, branch: 'ALL' }),
  );
  const period = reportPeriod(filter, today);
  const branchId = reportBranchId(filter);
  const [room, setRoom] = useState('');
  const [category, setCategory] = useState<IssueCategory | ''>('');
  const [technicianId, setTechnicianId] = useState<number | ''>('');
  const [bucket, setBucket] = useState<Bucket | ''>('');
  /** "Mức độ" — one level, filtered by the server. */
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [assigning, setAssigning] = useState<{ group: RoomGroup; branch: Issue['branch'] } | null>(null);
  const [viewing, setViewing] = useState<Issue | null>(null);
  const [returning, setReturning] = useState<Issue | null>(null);
  const [deleting, setDeleting] = useState<Issue | null>(null);
  /** "Giao việc" (Tổng QLKT), "Thuê ngoài" and "Hoàn thành thuê ngoài" (QLKT). */
  const [giving, setGiving] = useState<Issue | null>(null);
  const [hiring, setHiring] = useState<Issue | null>(null);
  const [completing, setCompleting] = useState<Issue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branches = useQuery({
    queryKey: ['technical-report', 'branches', isAdmin],
    queryFn: async (): Promise<{ branches: Branch[] }> => (isAdmin ? adminBranchesApi.list() : branchesApi.list()),
  });
  const issueSummary = useIssueSummary();
  const unresolvedByBranch = new Map((issueSummary.data?.summary.byBranch ?? []).map((b) => [b.branchId, b.totalUnresolved]));
  const technicians = useQuery({
    queryKey: ['issues', 'technicians'],
    queryFn: () => issuesApi.technicians(),
    staleTime: 60_000,
  });
  const { rooms } = useBranchRooms(branchId ?? null);

  const filters = {
    branchId,
    roomNumber: branchId !== undefined && room ? room : undefined,
    category: category || undefined,
    technicianUserId: technicianId === '' ? undefined : technicianId,
    severity: severity || undefined,
    from: period?.from,
    to: period?.to,
    shiftType: filter.shiftType || undefined,
  };
  const list = useQuery({
    queryKey: ['issues', 'technical-report', filters],
    // ponytail: one page of 500; paginate when a scope outgrows it.
    queryFn: () => issuesApi.list({ ...filters, pageSize: 500 }),
    refetchInterval: POLL_MS,
    enabled: period !== null && filter.branch !== null,
  });
  const all = useMemo(() => list.data?.issues ?? [], [list.data]);
  const buckets: readonly { key: Bucket; label: string }[] =
    user?.role === 'TECHNICAL_MANAGER' ? [MINE_BUCKET, ...BUCKETS] : BUCKETS;
  const shown = useMemo(() => (bucket ? all.filter((i) => inBucket(i, bucket, user?.id)) : all), [all, bucket, user?.id]);
  const groups = useMemo(() => groupIssuesByBranchRoom(shown), [shown]);

  const exportScope = {
    from: period?.from ?? today,
    to: period?.to ?? today,
    branchId,
    shiftType: filter.shiftType || undefined,
    section: 'TECHNICAL' as const,
  };
  const exportLink = (href: string, text: string, testId: string) => (
    <a
      href={href}
      data-testid={testId}
      className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {text}
    </a>
  );

  return (
    <div>
      <PageHeader
        title={isTechnicalManagerRole(user?.role) ? 'Quản lý sự cố kỹ thuật' : 'Báo cáo kỹ thuật'}
        description="Sự cố theo chi nhánh và phòng: tình trạng, người sửa, kết quả và từng giai đoạn sửa chữa."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {exportLink(operationalPdfUrl(exportScope), 'Xuất PDF', 'technical-export-pdf')}
            {exportLink(operationalXlsxUrl(exportScope), 'Xuất Excel', 'technical-export-xlsx')}
            <button
              type="button"
              onClick={() => void list.refetch()}
              aria-label="Làm mới"
              className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        }
      />

      <ReportFilterBar
        value={filter}
        onChange={(next) => {
          if (next.branch !== filter.branch) setRoom('');
          setFilter(next);
        }}
        today={today}
        branches={branches.data?.branches ?? []}
        branchCounts={unresolvedByBranch}
        testId="tr-filter"
      />

      <section aria-label="Bộ lọc kỹ thuật" className="mb-4 grid gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-sm font-medium text-slate-700">
          Phòng
          <select className={FIELD} value={room} disabled={!rooms} data-testid="tr-room" onChange={(e) => setRoom(e.target.value)}>
            <option value="">{branchId ? 'Tất cả phòng' : 'Chọn một chi nhánh trước'}</option>
            {(rooms ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Loại sự cố
          <select className={FIELD} value={category} data-testid="tr-category" onChange={(e) => setCategory(e.target.value as IssueCategory | '')}>
            <option value="">Tất cả loại</option>
            {ISSUE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Kỹ thuật viên
          <select
            className={FIELD}
            value={technicianId}
            data-testid="tr-technician"
            onChange={(e) => setTechnicianId(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">Tất cả</option>
            {(technicians.data?.technicians ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Tình trạng
          <select className={FIELD} value={bucket} data-testid="tr-status" onChange={(e) => setBucket(e.target.value as Bucket | '')}>
            <option value="">Tất cả</option>
            {buckets.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Mức độ
          <select className={FIELD} value={severity} data-testid="tr-severity" onChange={(e) => setSeverity(e.target.value as Severity | '')}>
            <option value="">Tất cả mức độ</option>
            {SEVERITY_OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Status at a glance, over the loaded rows; a press filters by it. */}
      <div className="mb-5 flex flex-wrap gap-2" data-testid="tr-counts">
        {buckets.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setBucket(bucket === b.key ? '' : b.key)}
            aria-pressed={bucket === b.key}
            data-testid={`tr-count-${b.key}`}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${
              bucket === b.key ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {b.label}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-800">
              {all.filter((i) => inBucket(i, b.key, user?.id)).length}
            </span>
          </button>
        ))}
      </div>

      {period === null ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : filter.branch === null ? (
        <EmptyState icon={<Wrench className="h-6 w-6" aria-hidden="true" />} title="Chọn chi nhánh" message="Chọn một chi nhánh hoặc tất cả chi nhánh để xem sự cố." />
      ) : (
        <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error} onRetry={() => void list.refetch()}>
          {groups.length === 0 ? (
            <EmptyState
              icon={<Wrench className="h-6 w-6" aria-hidden="true" />}
              title="Không có sự cố"
              message="Không có sự cố kỹ thuật nào khớp bộ lọc."
            />
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.branchId} data-testid={`tr-branch-${g.branchId}`} className="space-y-3">
                  <h2 className="flex items-center gap-2 border-b-2 border-slate-800 pb-1.5 text-base font-bold text-slate-900">
                    {g.branch ? branchLabel(g.branch) : '—'}
                    <span className="text-sm font-medium text-slate-500">
                      · {g.rooms.reduce((n, r) => n + r.issues.length, 0)} sự cố
                    </span>
                  </h2>
                  {g.rooms.map((roomGroup) => {
                    // Waiting, and — for a Quản lý kỹ thuật — not held by another manager.
                    const waiting = roomGroup.issues.filter(
                      (i) =>
                        i.status === 'NEW' &&
                        !(user?.role === 'TECHNICAL_MANAGER' && i.assignedManager && i.assignedManager.id !== user.id),
                    );
                    return (
                      <article
                        key={roomGroup.key}
                        data-testid={`tr-room-${roomGroup.key}`}
                        className="overflow-hidden rounded-2xl border border-line-strong bg-white shadow-sm"
                      >
                        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-slate-50 px-4 py-2.5">
                          <h3 className="text-base font-bold text-slate-900">
                            {roomGroup.label}
                            <span className="ml-2 text-sm font-medium text-slate-600">{roomGroup.issues.length} vấn đề</span>
                          </h3>
                          {canAssign && waiting.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setAssigning({ group: { ...roomGroup, issues: waiting }, branch: g.branch })}
                              data-testid={`tr-room-assign-${roomGroup.key}`}
                              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                            >
                              <UserPlus className="h-4 w-4" aria-hidden="true" />
                              Giao kỹ thuật
                              {waiting.length > 1 ? <span className="rounded-full bg-white/20 px-1.5 text-xs">{waiting.length}</span> : null}
                            </button>
                          ) : null}
                        </header>
                        <ul className="divide-y divide-line">
                          {roomGroup.issues.map((issue) => (
                            <IssueRow
                              key={issue.id}
                              issue={issue}
                              canManage={canAssign}
                              role={user?.role}
                              userId={user?.id}
                              onView={() => setViewing(issue)}
                              onReturn={() => setReturning(issue)}
                              onDelete={() => setDeleting(issue)}
                              onGive={() => setGiving(issue)}
                              onHire={() => setHiring(issue)}
                              onCompleteExternal={() => setCompleting(issue)}
                            />
                          ))}
                        </ul>
                      </article>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </QueryState>
      )}

      {assigning ? (
        <RoomAssignDialog
          place={assigning.group.label}
          branchLabel={assigning.branch ? branchLabel(assigning.branch) : ''}
          issues={assigning.group.issues}
          onClose={() => setAssigning(null)}
          onAssigned={(count, name) => {
            setAssigning(null);
            void list.refetch();
            setToast(`Đã giao ${count} sự cố cho ${name}.`);
          }}
        />
      ) : null}
      {returning ? (
        <UnassignIssueDialog
          issue={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            void list.refetch();
            setToast('Đã chuyển sự cố về chờ giao kỹ thuật.');
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteIssueDialog
          issue={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            void list.refetch();
            setToast('Đã xóa sự cố.');
          }}
        />
      ) : null}
      {giving ? (
        <GiveWorkDialog
          issue={giving}
          onClose={() => setGiving(null)}
          onDone={(message) => {
            setGiving(null);
            void list.refetch();
            setToast(message);
          }}
        />
      ) : null}
      {hiring ? (
        <ExternalDispatchDialog
          issue={hiring}
          onClose={() => setHiring(null)}
          onDone={(message) => {
            setHiring(null);
            void list.refetch();
            setToast(message);
          }}
        />
      ) : null}
      {completing ? (
        <CompleteExternalDialog
          issue={completing}
          onClose={() => setCompleting(null)}
          onDone={(message) => {
            setCompleting(null);
            void list.refetch();
            setToast(message);
          }}
        />
      ) : null}
      {viewing ? (
        <Modal open size="4xl" title="Chi tiết sự cố" onClose={() => setViewing(null)}>
          <IssueLifecycleDetail issue={viewing} />
        </Modal>
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/**
 * One incident inside its room: WHAT (type, description, cause), WHERE IT STANDS
 * (stage badge, assignment state), WHO (reporter and time, technician), the
 * last result and the stages — readable at a glance, nothing dropped.
 */
function IssueRow({
  issue,
  canManage,
  role,
  userId,
  onView,
  onReturn,
  onDelete,
  onGive,
  onHire,
  onCompleteExternal,
}: {
  issue: Issue;
  canManage: boolean;
  role: UserRole | undefined;
  userId: number | undefined;
  onView: () => void;
  onReturn: () => void;
  onDelete: () => void;
  onGive: () => void;
  onHire: () => void;
  onCompleteExternal: () => void;
}) {
  const last = issue.attempts[issue.attempts.length - 1];
  const open = issue.status === 'NEW' || issue.status === 'IN_PROGRESS';
  // Waiting for someone to take it: NEW and not yet given to a technician.
  const waiting = issue.status === 'NEW' && !issue.assignedTechnician;
  const heldByOther = role === 'TECHNICAL_MANAGER' && !!issue.assignedManager && issue.assignedManager.id !== userId;
  const external = issue.externalWork ?? null;
  // The server decides who may complete it; the button follows the same rule.
  const mayCompleteExternal =
    !!external &&
    can(role, 'technical.completeExternal') &&
    (role === 'TECHNICAL_GENERAL_MANAGER' || external.assignedById === userId);
  const action =
    'inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50';
  return (
    <li className="px-4 py-3.5" data-testid={`tr-issue-${issue.id}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={issue.severity} label={issue.severityLabel} />
            <IssueStageBadge issue={issue} />
            {issue.category ? (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-800">{issueCategoryLabel(issue)}</span>
            ) : null}
            {issue.assignmentStateLabel ? <span className="text-sm text-slate-600">{issue.assignmentStateLabel}</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-[15px] font-medium leading-relaxed text-slate-900">{issue.description}</p>
          {issue.locationDetail ? <p className="text-sm text-slate-600">Vị trí: {issue.locationDetail}</p> : null}
          <dl className="grid gap-x-6 gap-y-1 text-sm leading-relaxed text-slate-700 sm:grid-cols-2">
            <div>
              <dt className="inline text-slate-500">Người báo: </dt>
              <dd className="inline">
                {issue.reporterName ?? '—'} · {formatDateTime(issue.createdAt)}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-500">Kỹ thuật: </dt>
              <dd className="inline font-medium">{issue.assignedTechnician?.name ?? last?.technicianName ?? 'Chưa giao'}</dd>
            </div>
            {issue.assignedManager ? (
              <div className="sm:col-span-2" data-testid={`tr-manager-${issue.id}`}>
                <dt className="inline text-slate-500">Quản lý kỹ thuật: </dt>
                <dd className="inline">
                  <span className="font-medium">{issue.assignedManager.name}</span>
                  {issue.assignedManager.assignedByName ? ` · giao bởi ${issue.assignedManager.assignedByName}` : ''}
                  {issue.assignedManager.assignedAt ? ` · ${formatDateTime(issue.assignedManager.assignedAt)}` : ''}
                  {issue.assignedManager.note ? <span className="block whitespace-pre-wrap text-slate-600">Hướng dẫn: {issue.assignedManager.note}</span> : null}
                </dd>
              </div>
            ) : null}
            {external ? (
              <div className="sm:col-span-2" data-testid={`tr-external-${issue.id}`}>
                <dt className="inline text-slate-500">Kĩ thuật bên ngoài: </dt>
                <dd className="inline">
                  <span className="font-medium">{external.contractor?.name}</span>
                  {external.contractor?.company ? ` — ${external.contractor.company}` : ` (${external.contractor?.typeLabel})`}
                  {external.contractor?.phone ? ` · ${external.contractor.phone}` : ''}
                </dd>
              </div>
            ) : null}
            {(issue.dispatches ?? []).some((d) => d.repairCost !== null) ? (
              <div>
                <dt className="inline text-slate-500">Chi phí sửa chữa: </dt>
                <dd className="inline font-medium">
                  {formatVnd((issue.dispatches ?? []).reduce((sum, d) => sum + (d.repairCost ?? 0), 0))}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="inline text-slate-500">Nguyên nhân: </dt>
              <dd className="inline">{issue.cause ?? 'Chưa xác định'}</dd>
            </div>
            {issue.status === 'COMPLETED' ? (
              <div>
                <dt className="inline text-slate-500">Người hoàn thành: </dt>
                <dd className="inline">{issue.completedByName ?? 'Hệ thống'}</dd>
              </div>
            ) : null}
            {last?.result ? (
              <div>
                <dt className="inline text-slate-500">Kết quả: </dt>
                <dd className="inline">{last.result}</dd>
              </div>
            ) : null}
            {issue.reportVerdict === 'INCORRECT' ? (
              <div className="sm:col-span-2">
                <dt className="inline text-slate-500">Báo cáo sai: </dt>
                <dd className="inline">{issue.incorrectReason ?? '—'}</dd>
              </div>
            ) : null}
          </dl>
          <IssueStageTimeline issue={issue} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:max-w-[14rem] lg:justify-end">
          <button type="button" onClick={onView} data-testid={`tr-detail-${issue.id}`} className={action}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            Chi tiết
          </button>
          {waiting && can(role, 'technical.dispatchToManager') ? (
            <button type="button" onClick={onGive} data-testid={`tr-give-${issue.id}`} className={action}>
              <Forward className="h-4 w-4" aria-hidden="true" />
              Giao việc
            </button>
          ) : null}
          {waiting && can(role, 'technical.dispatchExternal') && !heldByOther ? (
            <button type="button" onClick={onHire} data-testid={`tr-hire-${issue.id}`} className={action}>
              <HardHat className="h-4 w-4" aria-hidden="true" />
              Thuê ngoài
            </button>
          ) : null}
          {mayCompleteExternal ? (
            <button type="button" onClick={onCompleteExternal} data-testid={`tr-complete-external-${issue.id}`} className={action}>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Hoàn thành thuê ngoài
            </button>
          ) : null}
          {canManage && issue.status === 'NEW' && issue.assignedTechnician ? (
            <button type="button" onClick={onReturn} data-testid={`tr-unassign-${issue.id}`} className={action}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Chuyển về chờ giao
            </button>
          ) : null}
          {canManage && open ? (
            <button
              type="button"
              onClick={onDelete}
              data-testid={`tr-delete-${issue.id}`}
              className={`${action} !border-rose-300 !text-rose-700 hover:!bg-rose-50`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Xóa
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
