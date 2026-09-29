/**
 * Bộ phận kỹ thuật — the three workflow queues.
 *
 * WHY THREE ROUTES AND NOT ONE PAGE WITH A FILTER
 *
 * "Sự cố khách sạn", "Đang sửa" and "Đã hoàn thành" are the three states of the
 * incident lifecycle, not three saved searches. Giving each its own URL means a
 * technician can keep "Đang sửa" open on a second screen, and it makes the tab
 * they are on part of the address rather than hidden component state.
 *
 * THE COUNTS COME FROM THE SERVER
 *
 * Each tab's number is counted in the database over every branch, not derived
 * from the loaded list — the lists are paginated, so a count taken from one
 * would show the size of the page and would change as somebody scrolled.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useParams } from 'react-router-dom';
import { CheckCircle2, RefreshCw, Wrench, XCircle } from 'lucide-react';
import { issueCategoryLabel, issuesApi, type Issue, type IssueStatus } from '../api/issues';
// The plain branches endpoint, not the admin one: Bộ phận kỹ thuật is not an
// admin, and the server returns all eight branches to it because one
// maintenance team serves all eight properties.
import { branchesApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader, QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import {
  IssueEditHistory,
  IssueEditedFlag,
  IssueStatusBadge,
  IssueThumb,
  IssueWorkTrail,
} from '../components/IssueViews';
import { formatDateTime } from '../lib/format';

const POLL_MS = 20_000;

/** The URL segment for each queue, and the status it shows. */
const QUEUES = {
  new: { status: 'NEW' as IssueStatus, title: 'Sự cố khách sạn', description: 'Sự cố lễ tân vừa báo, chưa có ai tiếp nhận.' },
  'in-progress': { status: 'IN_PROGRESS' as IssueStatus, title: 'Đang sửa', description: 'Sự cố đã tiếp nhận và đang được xử lý.' },
  completed: { status: 'COMPLETED' as IssueStatus, title: 'Đã hoàn thành', description: 'Lịch sử sự cố đã xử lý xong.' },
} as const;

type QueueKey = keyof typeof QUEUES;

function isQueueKey(value: string | undefined): value is QueueKey {
  return value === 'new' || value === 'in-progress' || value === 'completed';
}

export function TechnicalPage() {
  const { queue } = useParams();
  const key: QueueKey = isQueueKey(queue) ? queue : 'new';
  const config = QUEUES[key];

  const queryClient = useQueryClient();
  const [branchFilter, setBranchFilter] = useState<number | null>(null);
  const [accepting, setAccepting] = useState<Issue | null>(null);
  const [failing, setFailing] = useState<Issue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });

  const counts = useQuery({
    queryKey: ['issues', 'counts', branchFilter],
    queryFn: () => issuesApi.counts({ branchId: branchFilter ?? undefined }),
    refetchInterval: POLL_MS,
  });

  const list = useQuery({
    queryKey: ['issues', { technical: key, branchId: branchFilter }],
    queryFn: () =>
      issuesApi.list({ status: config.status, branchId: branchFilter ?? undefined, pageSize: 100 }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
  const issues = list.data?.issues ?? [];

  const complete = useMutation({
    mutationFn: (id: string) => issuesApi.complete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      setToast('Đã hoàn thành sự cố.');
    },
    onError: (e: unknown) => setToast(toUserMessage(e)),
  });

  const tabCount: Record<QueueKey, number> = {
    new: counts.data?.counts.newCount ?? 0,
    'in-progress': counts.data?.counts.inProgressCount ?? 0,
    completed: counts.data?.counts.completedCount ?? 0,
  };

  return (
    <div>
      <PageHeader
        title={config.title}
        description={config.description}
        actions={
          <div className="flex items-center gap-2">
            <select
              value={branchFilter ?? ''}
              onChange={(e) => setBranchFilter(e.target.value === '' ? null : Number(e.target.value))}
              aria-label="Lọc theo chi nhánh"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Làm mới
            </button>
          </div>
        }
      />

      <nav aria-label="Trạng thái sự cố" className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(QUEUES) as QueueKey[]).map((k) => (
          <NavLink
            key={k}
            to={`/app/technical/${k}`}
            data-testid={`technical-tab-${k}`}
            className={({ isActive }) =>
              `inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`
            }
          >
            {QUEUES[k].title}
            <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-bold leading-none text-slate-600">
              {tabCount[k]}
            </span>
          </NavLink>
        ))}
      </nav>

      <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error}>
        {issues.length === 0 ? (
          <EmptyState
            icon={<Wrench className="h-6 w-6" aria-hidden="true" />}
            title="Không có sự cố"
            message={`Không có sự cố nào ở trạng thái “${config.title}”.`}
          />
        ) : (
          <ul className="space-y-3" aria-label={config.title}>
            {issues.map((issue) => (
              <li key={issue.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {/* WHERE — branch, place, state. The first question. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {issue.branch?.address ?? '—'}
                        </span>
                        <span className="font-medium text-slate-900">{issue.locationLabel}</span>
                        {issue.category ? (
                          <span className="text-sm text-slate-500">{issueCategoryLabel(issue)}</span>
                        ) : null}
                        <IssueStatusBadge status={issue.status} needsRework={issue.needsRework} />
                        {/* The desk corrected this report after it was filed — see the history below. */}
                        <IssueEditedFlag issue={issue} />
                      </div>

                      {/* WHAT */}
                      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-700">
                        {issue.description}
                      </p>

                      {/* REPORTED */}
                      <p className="mt-1.5 text-xs text-slate-500">
                        Người báo: {issue.reportedByName ?? '—'}
                        {issue.shiftReceptionistName ? ` (${issue.shiftReceptionistName})` : ''} ·{' '}
                        {formatDateTime(issue.createdAt)}
                      </p>

                      {/* ASSIGNED + OUTCOME + the attempt history. */}
                      <IssueWorkTrail issue={issue} />
                      {(issue.edits ?? []).length > 0 ? (
                        <div className="mt-3">
                          <IssueEditHistory edits={issue.edits} />
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {issue.status === 'NEW' ? (
                        <Button onClick={() => setAccepting(issue)} data-testid={`accept-${issue.id}`}>
                          Tiếp nhận
                        </Button>
                      ) : null}
                      {issue.status === 'IN_PROGRESS' ? (
                        <>
                          {/*
                            "Hoàn thành" stays a DIRECT action — it needs nothing
                            from the technician beyond the press, and a
                            confirmation dialog on the happy path is friction on
                            the case that happens most.

                            "Không sửa được" opens one, because it cannot be
                            recorded without a reason: the next person to pick
                            this up reads that line to decide whether they can
                            succeed where this attempt did not.
                          */}
                          <Button
                            onClick={() => complete.mutate(issue.id)}
                            loading={complete.isPending && complete.variables === issue.id}
                            disabled={complete.isPending}
                            data-testid={`complete-${issue.id}`}
                          >
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            Hoàn thành
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
                    </div>
                  </div>
                  {issue.photoUrl ? <IssueThumb url={issue.photoUrl} /> : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>

      {accepting ? (
        <AcceptModal
          issue={accepting}
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
            setToast('Đã trả sự cố về hàng đợi.');
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
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
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <div className="font-medium text-slate-800">
            {issue.branch?.address ?? '—'} · {issue.locationLabel}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{issue.description}</p>
        </div>

        <p className="text-sm text-slate-600">
          Sự cố sẽ quay lại “Sự cố khách sạn” để người khác tiếp nhận. Thông tin người sửa và thời
          gian đã xử lý vẫn được lưu lại.
        </p>

        <label className="block text-sm font-medium text-slate-600">
          Lý do không sửa được
          <select
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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
  onClose,
  onAccepted,
}: {
  issue: Issue;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  const [technicianName, setTechnicianName] = useState('');
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
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <div className="font-medium text-slate-800">
            {issue.branch?.address ?? '—'} · {issue.locationLabel}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{issue.description}</p>
        </div>

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
