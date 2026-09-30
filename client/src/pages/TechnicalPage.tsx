/**
 * Bộ phận kỹ thuật and Quản lý kỹ thuật — the incident workflow queues.
 *
 * ONE SCREEN, TWO ROLES. The technician works the queues (Tiếp nhận → sửa →
 * Hoàn thành); Quản lý kỹ thuật reads the very same queues and judges finished
 * repairs ("Nghiệm thu"). Which buttons a card offers depends on the role — and
 * the SERVER refuses the other role's actions anyway, so hiding them here is
 * convenience, not the control.
 *
 * INSPECTION IS DORMANT until the server's `TECHNICAL_INSPECTION_ENABLED` is
 * switched on. Until then the technician's workflow is the operational one —
 * Tiếp nhận → sửa → a direct "Hoàn thành", or "Không sửa được" — there is no
 * "Chờ nghiệm thu" queue, and Quản lý kỹ thuật sees that the feature is not yet
 * active instead of a queue to judge.
 *
 * WHY ONE ROUTE PER QUEUE AND NOT ONE PAGE WITH A FILTER
 *
 * "Sự cố khách sạn", "Cần sửa lại", "Đang sửa", "Chờ nghiệm thu" and "Đã hoàn
 * thành" are the stages of the incident lifecycle, not saved searches. Giving
 * each its own URL means a technician can keep "Đang sửa" open on a second
 * screen, and it makes the tab they are on part of the address rather than
 * hidden component state.
 *
 * A TECHNICIAN SEES ONLY WHAT WAS GIVEN TO THEM. "Được giao", "Cần sửa lại" and
 * "Đang sửa" are their own assignments; "Lịch sử" is everything they were ever
 * given, took or finished. The server enforces it — this screen only names it.
 *
 * THE COUNTS COME FROM THE SERVER
 *
 * Each tab's number is counted in the database over every branch, not derived
 * from the loaded list — the lists are paginated, so a count taken from one
 * would show the size of the page and would change as somebody scrolled.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { CheckCircle2, ClipboardCheck, Eye, NotebookPen, RefreshCw, Wrench, XCircle } from 'lucide-react';
import {
  inspectionIsRelevant,
  issueCategoryLabel,
  issuesApi,
  type InspectionResult,
  type Issue,
  type IssueStage,
  type TechnicalCounts,
} from '../api/issues';
// The plain branches endpoint, not the admin one: Bộ phận kỹ thuật is not an
// admin, and the server returns all eight branches to it because one
// maintenance team serves all eight properties.
import { branchesApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { PeriodQuickPicks } from '../components/PeriodQuickPicks';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader, QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import {
  IssueEditHistory,
  IssueEditedFlag,
  IssueInspectionBadge,
  IssueLifecycleDetail,
  IssueStageBadge,
  IssueRepeatNote,
  IssueThumb,
  IssueWorkTrail,
} from '../components/IssueViews';
import { formatDateTime, hcmToday } from '../lib/format';

const POLL_MS = 20_000;

/** A form control's frame — the shared \`line-strong\` token. */
const FIELD =
  'mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** The URL segment for each queue, the stage it shows, and its counter. */
const QUEUES = {
  new: {
    stage: 'WAITING' as IssueStage,
    title: 'Được giao',
    description: 'Sự cố được giao cho bạn, chưa tiếp nhận.',
    count: 'newCount' as keyof TechnicalCounts,
  },
  rework: {
    stage: 'REWORK' as IssueStage,
    title: 'Cần sửa lại',
    description: 'Sự cố được giao lại sau lần nghiệm thu không đạt hoặc chưa sửa được.',
    dormantDescription: 'Sự cố được giao lại sau lần chưa sửa được.',
    count: 'reworkCount' as keyof TechnicalCounts,
  },
  'in-progress': {
    stage: 'IN_PROGRESS' as IssueStage,
    title: 'Đang sửa',
    description: 'Sự cố đã tiếp nhận và đang được xử lý.',
    count: 'inProgressCount' as keyof TechnicalCounts,
  },
  'awaiting-inspection': {
    stage: 'AWAITING_INSPECTION' as IssueStage,
    title: 'Chờ nghiệm thu',
    description: 'Kỹ thuật đã sửa xong, chờ quản lý kỹ thuật nghiệm thu.',
    count: 'awaitingInspectionCount' as keyof TechnicalCounts,
  },
  completed: {
    stage: 'COMPLETED' as IssueStage,
    title: 'Đã hoàn thành',
    description: 'Sự cố đã nghiệm thu đạt, và lịch sử sự cố đã xử lý xong.',
    dormantDescription: 'Sự cố kỹ thuật đã sửa xong, và lịch sử sự cố đã xử lý.',
    count: 'completedCount' as keyof TechnicalCounts,
  },
  history: {
    // Every stage: the server narrows it to this technician's own history.
    stage: undefined,
    title: 'Lịch sử',
    description: 'Mọi sự cố bạn từng được giao, đã tiếp nhận hoặc đã sửa.',
    count: undefined,
  },
} as const;

/** Quản lý kỹ thuật reads every waiting incident, not an assignment of their own. */
function queueTitle(key: QueueKey, isManager: boolean): string {
  return isManager && key === 'new' ? 'Sự cố khách sạn' : QUEUES[key].title;
}

type QueueKey = keyof typeof QUEUES;

/** A queue's one-line description — worded for the workflow that is actually running. */
function queueDescription(key: QueueKey, inspectionOn: boolean): string {
  const queue: { description: string; dormantDescription?: string } = QUEUES[key];
  return inspectionOn ? queue.description : (queue.dormantDescription ?? queue.description);
}

function isQueueKey(value: string | undefined): value is QueueKey {
  return value !== undefined && Object.prototype.hasOwnProperty.call(QUEUES, value);
}

export function TechnicalPage() {
  const { queue } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isManager = user?.role === 'TECHNICAL_MANAGER';
  const isTechnician = user?.role === 'TECHNICAL';
  const key: QueueKey = isQueueKey(queue) ? queue : isManager ? 'awaiting-inspection' : 'new';
  const config = QUEUES[key];

  const [branchFilter, setBranchFilter] = useState<number | null>(null);
  /*
    "Đã hoàn thành" by the day the TECHNICIAN FINISHED (`completedAt`), on the
    server. Empty by default: the queue keeps showing its whole history until a
    period is asked for. Both ends or nothing — a half range is never sent.
  */
  const [doneRange, setDoneRange] = useState<DateRangeValue>({ from: '', to: '' });
  const today = hcmToday();
  const onCompleted = key === 'completed';
  const doneFiltered = onCompleted && doneRange.from !== '' && doneRange.to !== '';
  const doneHalf = onCompleted && !doneFiltered && (doneRange.from !== '' || doneRange.to !== '');
  const [accepting, setAccepting] = useState<Issue | null>(null);
  const [failing, setFailing] = useState<Issue | null>(null);
  const [completing, setCompleting] = useState<Issue | null>(null);
  const [causing, setCausing] = useState<Issue | null>(null);
  const [inspecting, setInspecting] = useState<Issue | null>(null);
  const [viewing, setViewing] = useState<Issue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });

  const counts = useQuery({
    queryKey: ['issues', 'counts', branchFilter],
    queryFn: () => issuesApi.counts({ branchId: branchFilter ?? undefined }),
    refetchInterval: POLL_MS,
  });

  /*
    INSPECTION IS DORMANT unless the server says otherwise. While it is, the
    workflow is the operational one — Tiếp nhận → sửa → Hoàn thành or Không sửa
    được — with no "Chờ nghiệm thu" queue, and Quản lý kỹ thuật has nothing to
    act on. The server enforces the same; this only keeps the screen honest.
  */
  const inspectionOn = counts.data?.counts.inspectionEnabled ?? false;
  const managerIdle = isManager && !inspectionOn;

  const list = useQuery({
    queryKey: ['issues', { technical: key, branchId: branchFilter, done: doneFiltered ? doneRange : null }],
    queryFn: () =>
      issuesApi.list({
        stage: config.stage,
        branchId: branchFilter ?? undefined,
        completedFrom: doneFiltered ? doneRange.from : undefined,
        completedTo: doneFiltered ? doneRange.to : undefined,
        pageSize: 100,
      }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    enabled: !managerIdle && !doneHalf,
  });
  const issues = list.data?.issues ?? [];

  /*
    The dormant "Hoàn thành" is the DIRECT action it was before inspection: it
    needs nothing from the technician beyond the press, and a confirmation
    dialog on the happy path is friction on the case that happens most. The
    server stamps the time.
  */
  const completeNow = useMutation({
    mutationFn: (id: string) => issuesApi.complete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      setToast('Đã hoàn thành sự cố.');
    },
    onError: (e: unknown) => setToast(toUserMessage(e)),
  });

  if (managerIdle) {
    return (
      <QueryState isLoading={counts.isLoading} isError={counts.isError} error={counts.error}>
        <InspectionInactive />
      </QueryState>
    );
  }
  // An old link to the inspection queue lands on the technician's first queue.
  if (!inspectionOn && counts.data && key === 'awaiting-inspection') {
    return <Navigate to="/app/technical/new" replace />;
  }

  // The manager's own queue leads their tab row, as it leads their menu.
  const order: QueueKey[] = isManager
    ? ['awaiting-inspection', 'new', 'rework', 'in-progress', 'completed']
    : inspectionOn
      ? ['new', 'rework', 'in-progress', 'awaiting-inspection', 'completed']
      : ['new', 'rework', 'in-progress', 'completed'];
  if (isTechnician) order.push('history');

  return (
    <div>
      <PageHeader
        title={queueTitle(key, isManager)}
        description={isManager && key === 'new' ? 'Sự cố lễ tân vừa báo, chưa có ai tiếp nhận.' : queueDescription(key, inspectionOn)}
        actions={
          <div className="flex items-center gap-2">
            <select
              value={branchFilter ?? ''}
              onChange={(e) => setBranchFilter(e.target.value === '' ? null : Number(e.target.value))}
              aria-label="Lọc theo chi nhánh"
              className="max-w-[12rem] rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-700 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 sm:max-w-none"
            >
              <option value="">Tất cả chi nhánh</option>
              {(branches.data?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.address}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void list.refetch()}
              aria-label="Làm mới"
              className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span className="hidden sm:inline">Làm mới</span>
            </button>
          </div>
        }
      />

      <nav aria-label="Trạng thái sự cố" className="mb-4 flex flex-wrap gap-2">
        {order.map((k) => (
          <NavLink
            key={k}
            to={`/app/technical/${k}`}
            data-testid={`technical-tab-${k}`}
            className={({ isActive }) =>
              `inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-slate-700 hover:border-line-strong hover:bg-slate-50'
              }`
            }
          >
            {queueTitle(k, isManager)}
            {QUEUES[k].count ? (
              <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-bold leading-none text-slate-700">
                {counts.data?.counts[QUEUES[k].count] ?? 0}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      {onCompleted ? (
        <section
          data-testid="done-filters"
          aria-label="Lọc theo ngày hoàn thành"
          className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border-section border-line bg-white px-4 py-3 shadow-sm"
        >
          <div className="min-w-[17rem] max-w-full">
            <DateRangeField legend="Ngày hoàn thành" value={doneRange} onChange={setDoneRange} max={today} testId="done-range" />
          </div>
          <PeriodQuickPicks value={doneRange} onChange={setDoneRange} today={today} testId="done-range" />
          {doneRange.from !== '' || doneRange.to !== '' ? (
            <Button
              variant="secondary"
              onClick={() => setDoneRange({ from: '', to: '' })}
              className="min-h-[2.75rem]"
              data-testid="done-range-clear"
            >
              Bỏ lọc
            </Button>
          ) : null}
        </section>
      ) : null}

      {doneHalf ? (
        <p
          data-testid="done-range-invalid"
          className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900"
        >
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : (
      <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error}>
        {issues.length === 0 ? (
          <EmptyState
            icon={<Wrench className="h-6 w-6" aria-hidden="true" />}
            title="Không có sự cố"
            message={
              doneFiltered
                ? 'Không có sự cố hoàn thành trong khoảng thời gian này.'
                : key === 'history'
                  ? 'Bạn chưa được giao sự cố nào.'
                  : `Không có sự cố nào ở trạng thái “${queueTitle(key, isManager)}”.`
            }
          />
        ) : (
          <ul className="space-y-3" aria-label={queueTitle(key, isManager)}>
            {issues.map((issue) => (
              <li key={issue.id}>
                <article className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                  {/*
                    Side by side from `sm` up. Below it the actions move UNDER the
                    content: beside it they kept their width and squeezed the
                    description and the repair history into a third of a phone.
                  */}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      {/* WHERE — branch, place, state. The first question. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {issue.branch?.address ?? '—'}
                        </span>
                        <span className="font-medium text-slate-900">{issue.locationLabel}</span>
                        {issue.category ? (
                          <span className="text-sm text-slate-600">{issueCategoryLabel(issue)}</span>
                        ) : null}
                        <IssueStageBadge issue={issue} />
                        {inspectionIsRelevant(issue) ? <IssueInspectionBadge issue={issue} /> : null}
                        {/* The desk corrected this report after it was filed — see the history below. */}
                        <IssueEditedFlag issue={issue} />
                      </div>

                      {/* WHAT — the fault, and why it happened when anybody knows. */}
                      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">
                        {issue.description}
                      </p>
                      <p className="mt-1 text-sm text-slate-700" data-testid={`cause-${issue.id}`}>
                        <span className="text-slate-500">Nguyên nhân: </span>
                        {issue.cause ?? <span className="italic text-slate-500">Chưa xác định</span>}
                      </p>

                      {/* REPORTED — the employee's name, composed by the server. */}
                      <p className="mt-1.5 text-xs text-slate-600">
                        Người báo: {issue.reporterName ?? '—'} · {formatDateTime(issue.createdAt)}
                      </p>
                      {/* ASSIGNMENT — who gave it, to whom, when; the server's own state label. */}
                      <p className="mt-0.5 text-xs text-slate-600" data-testid={`assignment-${issue.id}`}>
                        {issue.assignmentStateLabel ?? '—'}
                        {issue.assignedTechnician ? ` · ${issue.assignedTechnician.name}` : ''}
                        {issue.assignedByName ? ` · giao bởi ${issue.assignedByName}` : ''}
                        {issue.assignedAt ? ` · ${formatDateTime(issue.assignedAt)}` : ''}
                      </p>
                      {issue.repeatOf ? (
                        <div className="mt-2">
                          <IssueRepeatNote issue={issue} />
                        </div>
                      ) : null}

                      {/* ASSIGNED + OUTCOME + the attempt history. */}
                      <IssueWorkTrail issue={issue} />
                      {(issue.edits ?? []).length > 0 ? (
                        <div className="mt-3">
                          <IssueEditHistory edits={issue.edits} />
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:flex-nowrap sm:items-end">
                      {isTechnician && issue.status === 'NEW' && issue.assignedTechnician?.id === user?.id ? (
                        <Button onClick={() => setAccepting(issue)} data-testid={`accept-${issue.id}`}>
                          Tiếp nhận
                        </Button>
                      ) : null}
                      {isTechnician && issue.status === 'IN_PROGRESS' ? (
                        <>
                          {/*
                            With inspection on, "Hoàn thành" opens a short form:
                            the result is what Quản lý kỹ thuật inspects, so it
                            cannot be skipped. Dormant, it is direct. "Không sửa
                            được" always needs its reason.
                          */}
                          {issue.inspectionEnabled ? (
                            <Button onClick={() => setCompleting(issue)} data-testid={`complete-${issue.id}`}>
                              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              Hoàn thành
                            </Button>
                          ) : (
                            <Button
                              onClick={() => completeNow.mutate(issue.id)}
                              loading={completeNow.isPending && completeNow.variables === issue.id}
                              disabled={completeNow.isPending}
                              data-testid={`complete-${issue.id}`}
                            >
                              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              Hoàn thành
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            onClick={() => setCausing(issue)}
                            data-testid={`cause-edit-${issue.id}`}
                          >
                            <NotebookPen className="h-4 w-4" aria-hidden="true" />
                            Nguyên nhân
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setFailing(issue)}
                            data-testid={`cannot-repair-${issue.id}`}
                          >
                            <XCircle className="h-4 w-4" aria-hidden="true" />
                            Không sửa được
                          </Button>
                        </>
                      ) : null}
                      {isManager && issue.status === 'AWAITING_INSPECTION' ? (
                        <Button onClick={() => setInspecting(issue)} data-testid={`inspect-${issue.id}`}>
                          <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
                          Nghiệm thu
                        </Button>
                      ) : null}
                      {isManager && issue.status !== 'AWAITING_INSPECTION' ? (
                        <Button
                          variant="secondary"
                          onClick={() => setViewing(issue)}
                          data-testid={`detail-${issue.id}`}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                          Chi tiết
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {issue.photoUrl ? <IssueThumb url={issue.photoUrl} /> : null}
                </article>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      )}

      {accepting ? (
        <AcceptModal
          issue={accepting}
          defaultName={user?.fullName ?? ''}
          onClose={() => setAccepting(null)}
          onAccepted={() => {
            setAccepting(null);
            setToast('Đã tiếp nhận sự cố.');
          }}
        />
      ) : null}
      {failing ? (
        <CannotRepairModal
          issue={failing}
          onClose={() => setFailing(null)}
          onDone={() => {
            setFailing(null);
            setToast('Đã trả sự cố để giao lại.');
          }}
        />
      ) : null}
      {causing ? (
        <CauseModal
          issue={causing}
          onClose={() => setCausing(null)}
          onDone={() => {
            setCausing(null);
            setToast('Đã cập nhật nguyên nhân.');
          }}
        />
      ) : null}
      {completing ? (
        <CompleteModal
          issue={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null);
            setToast('Đã hoàn thành — chờ quản lý kỹ thuật nghiệm thu.');
          }}
        />
      ) : null}
      {inspecting ? (
        <InspectModal
          issue={inspecting}
          onClose={() => setInspecting(null)}
          onDone={(result) => {
            setInspecting(null);
            setToast(result === 'PASSED' ? 'Đã nghiệm thu đạt.' : 'Đã yêu cầu sửa lại.');
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
 * Quản lý kỹ thuật's screen while inspection is DORMANT — said plainly, with
 * the workflow that is running instead, and no queue to act on. The inspection
 * code, data and routes are all still there; the server refuses a verdict
 * until the feature is switched on.
 */
function InspectionInactive() {
  return (
    <div>
      <PageHeader title="Nghiệm thu" description="Nghiệm thu sửa chữa của quản lý kỹ thuật." />
      <section
        data-testid="inspection-inactive"
        aria-labelledby="inspection-inactive-heading"
        className="rounded-2xl border border-line bg-white p-5 shadow-sm"
      >
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-slate-100 p-2 text-slate-500">
            <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-2">
            <h2 id="inspection-inactive-heading" className="text-base font-semibold text-slate-900">
              Chức năng nghiệm thu chưa được kích hoạt
            </h2>
            <p className="text-sm text-slate-600">
              Sự cố hiện được xử lý theo quy trình: Lễ tân báo sự cố → Kỹ thuật tiếp nhận → sửa → Hoàn
              thành hoặc Không sửa được. Sự cố hoàn thành không cần chờ nghiệm thu.
            </p>
            <p className="text-sm text-slate-500">Chức năng này sẽ được bật khi có yêu cầu vận hành.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

/** The incident a dialog is about, in one bordered line. */
function IssueSummary({ issue }: { issue: Issue }) {
  return (
    <div className="rounded-xl border border-line bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <div className="font-medium text-slate-900">
        {issue.branch?.address ?? '—'} · {issue.locationLabel}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{issue.description}</p>
    </div>
  );
}

/**
 * "Nguyên nhân" found during the repair — before it is finished.
 *
 * Written to the technician's OPEN attempt on the server; what Reception
 * reported stays on the incident, untouched, and both remain visible.
 */
function CauseModal({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [cause, setCause] = useState(issue.cause ?? '');
  const save = useMutation({
    mutationFn: () => issuesApi.updateCause(issue.id, { cause: cause.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone();
    },
  });
  return (
    <Modal
      open
      title="Cập nhật nguyên nhân"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!cause.trim()}
            loading={save.isPending}
            data-testid="cause-confirm"
          >
            Lưu nguyên nhân
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueSummary issue={issue} />
        {issue.reportedCause ? (
          <p className="text-sm text-slate-600">
            Lễ tân báo: <span className="text-slate-800">{issue.reportedCause}</span>
          </p>
        ) : null}
        <label className="block text-sm font-medium text-slate-700">
          Nguyên nhân
          <textarea
            className={FIELD}
            rows={2}
            maxLength={1000}
            value={cause}
            onChange={(e) => setCause(e.target.value)}
            placeholder="Ví dụ: Thiếu gas"
            data-testid="cause-input"
          />
        </label>
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * "Hoàn thành" — the technician's finish, NOT the incident's.
 *
 * The result is required: it is what Quản lý kỹ thuật inspects. The cause is
 * pre-filled with the one on file and may be corrected; left empty, the cause
 * already recorded stands. The server stamps the time — the timer stops here.
 */
function CompleteModal({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [cause, setCause] = useState(issue.cause ?? '');
  const [result, setResult] = useState('');
  const complete = useMutation({
    mutationFn: () =>
      issuesApi.complete(issue.id, {
        result: result.trim(),
        // Sent only when the technician CHANGED it: the prefill is the cause on
        // file (Reception's, or an earlier attempt's), and echoing it back would
        // record it as this technician's own finding.
        ...(cause.trim() && cause.trim() !== (issue.cause ?? '') ? { cause: cause.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone();
    },
  });
  return (
    <Modal
      open
      title="Hoàn thành sửa chữa"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => complete.mutate()}
            disabled={!result.trim()}
            loading={complete.isPending}
            data-testid="complete-confirm"
          >
            Xác nhận hoàn thành
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueSummary issue={issue} />
        <p className="text-sm text-slate-600">
          Sau khi xác nhận, sự cố chuyển sang “Chờ nghiệm thu” để quản lý kỹ thuật kiểm tra. Thời
          gian hoàn thành do hệ thống ghi nhận.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          Nguyên nhân{' '}
          <span className="font-normal text-slate-500">(để trống nếu giữ nguyên)</span>
          <textarea
            className={FIELD}
            rows={2}
            maxLength={1000}
            value={cause}
            onChange={(e) => setCause(e.target.value)}
            placeholder="Ví dụ: Thiếu gas"
            data-testid="complete-cause"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Kết quả sửa chữa <span className="text-rose-600">*</span>
          <textarea
            className={FIELD}
            rows={3}
            maxLength={2000}
            value={result}
            onChange={(e) => setResult(e.target.value)}
            placeholder="Ví dụ: Đã nạp gas, máy lạnh chạy ổn định"
            data-testid="complete-result"
          />
        </label>
        {complete.isError ? <ErrorAlert>{toUserMessage(complete.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * "Nghiệm thu" — Quản lý kỹ thuật judges the finished repair.
 *
 * The WHOLE lifecycle is shown first (report, repair, every earlier attempt and
 * verdict), because that is what the judgement is made on. A pass may carry a
 * note; a fail must carry its reason — the technician who picks the rework up
 * reads it to know what was still wrong. Refused here and on the server.
 */
function InspectModal({
  issue,
  onClose,
  onDone,
}: {
  issue: Issue;
  onClose: () => void;
  onDone: (result: InspectionResult) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const inspect = useMutation({
    mutationFn: (result: InspectionResult) =>
      issuesApi.inspect(issue.id, { result, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async (_data, result) => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone(result);
    },
  });

  const fail = () => {
    if (!note.trim()) {
      setMissingReason(true);
      return;
    }
    inspect.mutate('FAILED');
  };

  return (
    <Modal
      open
      size="4xl"
      title="Nghiệm thu sửa chữa"
      onClose={onClose}
      footer={
        // Stacked full-width on a phone — the verdict first — because three
        // buttons in one row squeezed "Không đạt / Yêu cầu sửa lại" onto three
        // lines. One row again from `sm` up.
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            variant="secondary"
            onClick={fail}
            disabled={inspect.isPending}
            className="!border-rose-300 !text-rose-700 hover:!bg-rose-50"
            data-testid="inspect-fail"
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
            Không đạt / Yêu cầu sửa lại
          </Button>
          <Button
            onClick={() => inspect.mutate('PASSED')}
            loading={inspect.isPending && inspect.variables === 'PASSED'}
            disabled={inspect.isPending}
            data-testid="inspect-pass"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Nghiệm thu đạt
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <IssueLifecycleDetail issue={issue} />
        <label className="block text-sm font-medium text-slate-700">
          Ghi chú nghiệm thu / Lý do không đạt{' '}
          <span className="font-normal text-slate-500">(bắt buộc khi không đạt)</span>
          <textarea
            className={`${FIELD} ${missingReason && !note.trim() ? 'border-rose-500 ring-1 ring-rose-500' : ''}`}
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (e.target.value.trim()) setMissingReason(false);
            }}
            placeholder="Ví dụ: Máy lạnh vẫn chưa đủ lạnh sau 15 phút"
            aria-invalid={missingReason && !note.trim() ? true : undefined}
            data-testid="inspect-note"
          />
        </label>
        {missingReason && !note.trim() ? (
          <p className="text-sm font-medium text-rose-700" role="alert">
            Vui lòng nhập lý do nghiệm thu không đạt.
          </p>
        ) : null}
        {inspect.isError ? <ErrorAlert>{toUserMessage(inspect.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** The reasons a repair usually cannot be finished, as technicians say them. */
const CANNOT_REPAIR_REASONS = [
  'Không có linh kiện',
  'Không đủ thiết bị',
  'Cần đơn vị bên ngoài',
  'Hư hỏng vượt khả năng xử lý',
];

/**
 * "Không sửa được" — the incident goes back to the queue, with a reason.
 *
 * THE PRESET REASONS ARE A SHORTCUT, NOT A CLOSED LIST. Four of the five cases
 * are the same four every time, and typing them out is friction that leads to
 * "khong sua duoc" being typed instead. "Khác" exists because the fifth case
 * always turns up, and every preset can still be extended with details — so the
 * field is never reduced to a category when it needs to be a sentence.
 *
 * NOTHING IS DELETED BY THIS ACTION. The attempt keeps the technician's name,
 * phone, acceptance time, failure time and this reason, permanently.
 */
function CannotRepairModal({
  issue,
  onClose,
  onDone,
}: {
  issue: Issue;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<string>(CANNOT_REPAIR_REASONS[0]!);
  const [detail, setDetail] = useState('');

  const custom = preset === 'Khác';
  // "Khác" carries only what was typed; a preset carries the preset, with any
  // detail appended — so the stored reason always reads as one sentence.
  const reason = custom ? detail.trim() : [preset, detail.trim()].filter(Boolean).join(' — ');

  const fail = useMutation({
    mutationFn: () => issuesApi.cannotRepair(issue.id, { reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onDone();
    },
  });

  const ready = reason.length > 0;

  return (
    <Modal
      open
      title="Không sửa được"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => fail.mutate()}
            disabled={!ready}
            loading={fail.isPending}
            data-testid="cannot-repair-confirm"
          >
            Xác nhận
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueSummary issue={issue} />

        <p className="text-sm text-slate-600">
          Sự cố được trả về để quản lý giao lại cho kỹ thuật viên khác. Thông tin người sửa, thời
          gian đã xử lý và lịch sử giao việc vẫn được lưu lại.
        </p>

        <label className="block text-sm font-medium text-slate-600">
          Lý do không sửa được
          <select
            className={FIELD}
            value={preset}
            aria-label="Lý do không sửa được"
            onChange={(e) => setPreset(e.target.value)}
            data-testid="cannot-repair-reason"
          >
            {CANNOT_REPAIR_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="Khác">Khác</option>
          </select>
        </label>

        <label className="block text-sm font-medium text-slate-600">
          Chi tiết{' '}
          {custom ? null : <span className="font-normal text-slate-400">(không bắt buộc)</span>}
          <textarea
            className={FIELD}
            rows={2}
            maxLength={900}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Ví dụ: thiếu bơm áp lực, cần đặt hàng"
            data-testid="cannot-repair-detail"
          />
        </label>

        {fail.isError ? <ErrorAlert>{toUserMessage(fail.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * Accepting an incident names the person who will do the work.
 *
 * Both fields are required, here and on the server: an IN_PROGRESS incident that
 * cannot say who is fixing it — or how to reach them — is exactly the gap this
 * whole department exists to close.
 */
function AcceptModal({
  issue,
  defaultName,
  onClose,
  onAccepted,
}: {
  issue: Issue;
  /** The signed-in technician's full name — editable, since a colleague may do the job. */
  defaultName: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  const [technicianName, setTechnicianName] = useState(defaultName);
  const [technicianPhone, setTechnicianPhone] = useState('');

  const accept = useMutation({
    mutationFn: () =>
      issuesApi.accept(issue.id, {
        technicianName: technicianName.trim(),
        technicianPhone: technicianPhone.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
      onAccepted();
    },
  });

  const ready = technicianName.trim().length > 0 && technicianPhone.trim().length > 0;

  return (
    <Modal
      open
      title="Tiếp nhận sự cố"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => accept.mutate()}
            disabled={!ready}
            loading={accept.isPending}
            data-testid="accept-confirm"
          >
            Xác nhận tiếp nhận
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueSummary issue={issue} />

        <Input
          label="Họ và tên người sửa"
          value={technicianName}
          onChange={(e) => setTechnicianName(e.target.value)}
          placeholder="Ví dụ: Trần Văn B"
          maxLength={200}
          data-testid="technician-name"
        />
        <Input
          label="Số điện thoại"
          value={technicianPhone}
          onChange={(e) => setTechnicianPhone(e.target.value)}
          placeholder="Ví dụ: 0901234567"
          maxLength={30}
          inputMode="tel"
          data-testid="technician-phone"
        />

        {accept.isError ? <ErrorAlert>{toUserMessage(accept.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
