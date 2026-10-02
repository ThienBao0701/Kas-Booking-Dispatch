/**
 * "BÁO CÁO VẤN ĐỀ → KỸ THUẬT" — and the Quản lý kỹ thuật's own workspace
 * ("Quản lý sự cố kỹ thuật").
 *
 * Every incident of the reader's branches, grouped Branch → Room → incidents,
 * with where each stands, who holds it, what was done (stage by stage) and the
 * history. The Admin reads every branch, a Quản lý lễ tân / Quản lý kỹ thuật its
 * ticked ones, the Tổng quản lý lễ tân all — the SERVER scopes every row and
 * refuses an assignment outside the reader's branches; this screen only names it.
 *
 * The filters that narrow the rows (branch, room, type, technician, date) go to
 * the server; the status buckets are read from the loaded rows, because they
 * are the server's own assignment state and overlap on purpose ("Đã giao lại"
 * is also "Đã giao").
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, RefreshCw, Wrench } from 'lucide-react';
import { ISSUE_CATEGORIES, issueCategoryLabel, issuesApi, type Issue, type IssueCategory } from '../api/issues';
import { branchesApi } from '../api/bookings';
import { operationalPdfUrl, operationalXlsxUrl } from '../api/receptionReports';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel, isTechnicalAssigner, type Branch } from '../auth/types';
import { useBranchRooms } from '../hooks/useBranchRooms';
import { AssignTechnicianDialog } from '../components/AssignTechnicianDialog';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { EmptyState } from '../components/EmptyState';
import { IssueLifecycleDetail, IssueStageBadge, IssueStageTimeline } from '../components/IssueViews';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime, hcmToday } from '../lib/format';

const POLL_MS = 30_000;

const FIELD =
  'mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** "Tình trạng" at a glance — the server's assignment state, plus the two histories. */
const BUCKETS = [
  { key: 'UNASSIGNED', label: 'Chờ giao kỹ thuật' },
  { key: 'ASSIGNED', label: 'Đã giao' },
  { key: 'IN_PROGRESS', label: 'Đang sửa' },
  { key: 'COMPLETED', label: 'Đã hoàn thành' },
  { key: 'CANNOT_REPAIR', label: 'Không sửa được' },
  { key: 'REASSIGNED', label: 'Đã giao lại' },
  { key: 'REWORK', label: 'Cần sửa lại' },
] as const;
type Bucket = (typeof BUCKETS)[number]['key'];

function inBucket(issue: Issue, bucket: Bucket): boolean {
  switch (bucket) {
    case 'UNASSIGNED':
      return issue.assignmentState === 'UNASSIGNED';
    case 'ASSIGNED':
      return issue.assignmentState === 'ASSIGNED';
    case 'IN_PROGRESS':
      return issue.assignmentState === 'IN_PROGRESS';
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

/** The first of this month — the export's period when none is picked. */
function monthStart(today: string): string {
  return `${today.slice(0, 8)}01`;
}

export function TechnicalReportPage() {
  const { user } = useAuth();
  const canAssign = isTechnicalAssigner(user?.role);
  const today = hcmToday();

  const [branchId, setBranchId] = useState<number | null>(null);
  const [room, setRoom] = useState('');
  const [category, setCategory] = useState<IssueCategory | ''>('');
  const [technicianId, setTechnicianId] = useState<number | ''>('');
  const [range, setRange] = useState<DateRangeValue>({ from: '', to: '' });
  const [bucket, setBucket] = useState<Bucket | ''>('');
  const [assigning, setAssigning] = useState<Issue | null>(null);
  const [viewing, setViewing] = useState<Issue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const dated = range.from !== '' && range.to !== '';
  const halfDated = !dated && (range.from !== '' || range.to !== '');

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });
  const technicians = useQuery({
    queryKey: ['issues', 'technicians'],
    queryFn: () => issuesApi.technicians(),
    staleTime: 60_000,
  });
  const { rooms } = useBranchRooms(branchId);

  const filters = {
    branchId: branchId ?? undefined,
    roomNumber: room || undefined,
    category: category || undefined,
    technicianUserId: technicianId === '' ? undefined : technicianId,
    from: dated ? range.from : undefined,
    to: dated ? range.to : undefined,
  };
  const list = useQuery({
    queryKey: ['issues', 'technical-report', filters],
    // ponytail: one page of 500; paginate when a scope outgrows it.
    queryFn: () => issuesApi.list({ ...filters, pageSize: 500 }),
    refetchInterval: POLL_MS,
    enabled: !halfDated,
  });
  const all = useMemo(() => list.data?.issues ?? [], [list.data]);
  const shown = bucket ? all.filter((i) => inBucket(i, bucket)) : all;

  /** Branch → room (the location line) → incidents, newest first within a room. */
  const groups = useMemo(() => {
    const byBranch = new Map<number, { branch: Issue['branch']; rooms: Map<string, Issue[]> }>();
    for (const issue of shown) {
      const id = issue.branch?.id ?? 0;
      const entry = byBranch.get(id) ?? { branch: issue.branch, rooms: new Map<string, Issue[]>() };
      const where = issue.locationLabel ?? '—';
      entry.rooms.set(where, [...(entry.rooms.get(where) ?? []), issue]);
      byBranch.set(id, entry);
    }
    return [...byBranch.values()]
      .sort((a, b) => (a.branch?.branchNumber ?? 99) - (b.branch?.branchNumber ?? 99))
      .map((g) => ({
        branch: g.branch,
        rooms: [...g.rooms.entries()].sort(([a], [b]) => a.localeCompare(b, 'vi', { numeric: true })),
      }));
  }, [shown]);

  const exportScope = {
    from: dated ? range.from : monthStart(today),
    to: dated ? range.to : today,
    branchId: branchId ?? undefined,
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
        title={user?.role === 'TECHNICAL_MANAGER' ? 'Quản lý sự cố kỹ thuật' : 'Báo cáo kỹ thuật'}
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

      <section
        aria-label="Bộ lọc"
        className="mb-4 grid gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="block text-sm font-medium text-slate-700">
          Chi nhánh
          <select
            className={FIELD}
            value={branchId ?? ''}
            data-testid="tr-branch"
            onChange={(e) => {
              setBranchId(e.target.value === '' ? null : Number(e.target.value));
              setRoom('');
            }}
          >
            <option value="">Tất cả chi nhánh</option>
            {(branches.data?.branches ?? []).map((b: Branch) => (
              <option key={b.id} value={b.id}>
                {branchLabel(b)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Phòng
          <select
            className={FIELD}
            value={room}
            disabled={!rooms}
            data-testid="tr-room"
            onChange={(e) => setRoom(e.target.value)}
          >
            <option value="">{branchId ? 'Tất cả phòng' : 'Chọn chi nhánh trước'}</option>
            {(rooms ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Loại sự cố
          <select
            className={FIELD}
            value={category}
            data-testid="tr-category"
            onChange={(e) => setCategory(e.target.value as IssueCategory | '')}
          >
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
        <div className="sm:col-span-2">
          <DateRangeField legend="Ngày báo cáo" value={range} onChange={setRange} max={today} testId="tr-range" />
        </div>
        <label className="block text-sm font-medium text-slate-700">
          Tình trạng
          <select
            className={FIELD}
            value={bucket}
            data-testid="tr-status"
            onChange={(e) => setBucket(e.target.value as Bucket | '')}
          >
            <option value="">Tất cả</option>
            {BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Status at a glance, over the loaded rows; a press filters by it. */}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="tr-counts">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setBucket(bucket === b.key ? '' : b.key)}
            data-testid={`tr-count-${b.key}`}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm ${
              bucket === b.key ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {b.label}
            <span className="rounded-full bg-slate-100 px-1.5 text-xs font-bold text-slate-700">
              {all.filter((i) => inBucket(i, b.key)).length}
            </span>
          </button>
        ))}
      </div>

      {halfDated ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : (
        <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error} onRetry={() => void list.refetch()}>
          {groups.length === 0 ? (
            <EmptyState
              icon={<Wrench className="h-6 w-6" aria-hidden="true" />}
              title="Không có sự cố"
              message="Không có sự cố kỹ thuật nào khớp bộ lọc."
            />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <section
                  key={g.branch?.id ?? 0}
                  className="rounded-2xl border border-line bg-white shadow-sm"
                  data-testid={`tr-branch-${g.branch?.id ?? 0}`}
                >
                  <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-slate-900">
                    {g.branch ? branchLabel(g.branch) : '—'}
                  </h2>
                  <div className="divide-y divide-line">
                    {g.rooms.map(([where, issues]) => (
                      <div key={where} className="px-4 py-3">
                        <h3 className="mb-2 text-sm font-semibold text-slate-800">{where}</h3>
                        <ul className="space-y-2">
                          {issues.map((issue) => (
                            <IssueRow
                              key={issue.id}
                              issue={issue}
                              canAssign={canAssign}
                              onAssign={() => setAssigning(issue)}
                              onView={() => setViewing(issue)}
                            />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </QueryState>
      )}

      {assigning ? (
        <AssignTechnicianDialog
          issue={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={(updated) => {
            setAssigning(null);
            void list.refetch();
            setToast(`Đã giao cho ${updated.assignedTechnician?.name ?? 'kỹ thuật viên'}.`);
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

/** One incident: what, where it stands, who has it, the last result — and the actions. */
function IssueRow({
  issue,
  canAssign,
  onAssign,
  onView,
}: {
  issue: Issue;
  canAssign: boolean;
  onAssign: () => void;
  onView: () => void;
}) {
  const last = issue.attempts[issue.attempts.length - 1];
  return (
    <li className="rounded-xl border border-line-subtle bg-slate-50/60 px-3 py-2.5" data-testid={`tr-issue-${issue.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <IssueStageBadge issue={issue} />
            {issue.category ? <span className="text-slate-700">{issueCategoryLabel(issue)}</span> : null}
            <span className="text-xs text-slate-600">{issue.assignmentStateLabel ?? ''}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-slate-800">{issue.description}</p>
          <p className="mt-0.5 text-xs text-slate-600">
            Người báo: {issue.reporterName ?? '—'} · {formatDateTime(issue.createdAt)}
            {issue.cause ? ` · Nguyên nhân: ${issue.cause}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            Kỹ thuật: {issue.assignedTechnician?.name ?? last?.technicianName ?? 'Chưa giao'}
            {last?.result ? ` · Kết quả: ${last.result}` : ''}
          </p>
          <IssueStageTimeline issue={issue} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-end">
          {canAssign && issue.status === 'NEW' ? (
            <button
              type="button"
              onClick={onAssign}
              data-testid={`tr-assign-${issue.id}`}
              className="rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              {issue.assignedTechnician ? 'Giao lại' : 'Giao kỹ thuật'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onView}
            data-testid={`tr-detail-${issue.id}`}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line-strong bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            Chi tiết
          </button>
        </div>
      </div>
    </li>
  );
}
