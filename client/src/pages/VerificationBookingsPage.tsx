import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, RefreshCw, RotateCcw, ScanSearch } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import {
  bookingsApi,
  branchesApi,
  REVIEW_REASON_LABEL,
  type BookingDetail,
  type NewListItem,
} from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { ConnectionWarning } from '../components/ConnectionWarning';
import { SkeletonList } from '../components/Skeleton';
import { LastMinuteBadge, SourceBadge } from '../components/Badges';
import { InlineSpinner, PageHeader } from '../components/PageState';
import { RecreationAccountability } from '../components/RecreationAccountability';
import { BookingDetailView } from '../components/BookingDetailView';
import { Toast } from '../components/Toast';
import { useCut } from '../hooks/useCut';
import { formatDate, formatDateTime } from '../lib/format';
import { branchOptionLabel, branchTone } from '../lib/branchTone';

const POLL_MS = 20_000;

type Variant = 'pending-review' | 'rejected';

const COPY: Record<Variant, { adminTitle: string; recTitle: string; description: string; empty: string; icon: typeof ScanSearch }> = {
  'pending-review': {
    adminTitle: 'Chờ kiểm tra',
    recTitle: 'Chờ Admin kiểm tra',
    description: 'Đơn đã có ảnh chứng minh, đang chờ Admin đối chiếu và xác nhận.',
    empty: 'Không có đơn nào đang chờ kiểm tra.',
    icon: ScanSearch,
  },
  rejected: {
    adminTitle: 'Cần tạo lại',
    recTitle: 'Cần tạo lại',
    description: 'Đơn bị Admin từ chối, cần chi nhánh kiểm tra và tạo lại rồi gửi ảnh mới.',
    empty: 'Không có đơn nào cần tạo lại.',
    icon: RotateCcw,
  },
};

export function PendingReviewPage() {
  return <VerificationInbox variant="pending-review" />;
}
export function RejectedPage() {
  return <VerificationInbox variant="rejected" />;
}

function VerificationInbox({ variant }: { variant: Variant }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const copy = COPY[variant];
  const Icon = copy.icon;

  const [searchParams] = useSearchParams();
  const [branchId, setBranchId] = useState<number | undefined>(() => {
    const p = searchParams.get('branchId');
    return p ? Number(p) : undefined;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastIndexRef = useRef(0);

  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
    enabled: isAdmin,
  });

  const listFn = variant === 'pending-review' ? bookingsApi.listPendingReview : bookingsApi.listRejected;
  const list = useQuery({
    queryKey: ['bookings', variant, { branchId }],
    queryFn: () => listFn({ branchId, pageSize: 100 }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const bookings = useMemo(() => list.data?.bookings ?? [], [list.data]);
  const groups = useMemo(() => groupByBranch(bookings), [bookings]);

  useEffect(() => {
    if (bookings.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const idx = bookings.findIndex((b) => b.id === selectedId);
    if (idx >= 0) {
      lastIndexRef.current = idx;
      return;
    }
    const nextIdx = Math.min(lastIndexRef.current, bookings.length - 1);
    lastIndexRef.current = nextIdx;
    setSelectedId(bookings[nextIdx]!.id);
  }, [bookings, selectedId]);

  const staleWarning = list.failureReason != null && list.data != null;

  if (list.isError && !list.data) {
    return (
      <div>
        <PageHeader title={isAdmin ? copy.adminTitle : copy.recTitle} description={copy.description} />
        <ErrorAlert>{toUserMessage(list.error)}</ErrorAlert>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void list.refetch()}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Thử lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={isAdmin ? copy.adminTitle : copy.recTitle}
        description={copy.description}
        actions={
          <div className="flex items-center gap-2">
            {isAdmin ? (
              <select
                value={branchId ?? ''}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : undefined)}
                aria-label="Lọc theo chi nhánh"
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                <option value="">Tất cả chi nhánh</option>
                {branches.data?.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {branchOptionLabel(b)}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={() => void list.refetch()}
              aria-label="Làm mới danh sách"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Làm mới
            </button>
          </div>
        }
      />

      {staleWarning ? (
        <div className="mb-3">
          <ConnectionWarning onRetry={() => void list.refetch()} />
        </div>
      ) : null}

      {/*
        Accountability, on the "Cần tạo lại" screen and for the Admin only.
        It sits beside the queue rather than on a page of its own because the
        question "who keeps having to redo these?" is asked while looking at
        them. Collapsed by default: the queue is the daily work, the statistics
        are the periodic review.
      */}
      {isAdmin && variant === 'rejected' ? <RecreationAccountability branchId={branchId} /> : null}

      {list.isLoading ? (
        <SkeletonList rows={6} />
      ) : bookings.length === 0 ? (
        <EmptyState icon={<Icon className="h-6 w-6" aria-hidden="true" />} title="Không có đơn nào" message={copy.empty} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[38%_1fr] lg:items-start">
          <Card className="overflow-hidden lg:sticky lg:top-4">
            <p
              data-testid="verification-total"
              className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              {bookings.length} đơn
              {groups.length > 1 ? ` · ${groups.length} chi nhánh` : ''}
            </p>
            {/*
              GROUPED BY BRANCH whenever more than one is on screen — which is the
              Admin's view of every hotel. Each group has its own header (the
              branch's number and address, and how many are waiting there) and
              every row carries the branch's colour on its edge, so a branch is
              recognised by sight before its name is read. A receptionist sees
              one branch, where headers would only repeat what the page says.
            */}
            <div className="max-h-[calc(100vh-14rem)] overflow-y-auto" aria-label="Danh sách đơn" role="list">
              {groups.map((group) => (
                <section key={group.key} role="listitem" aria-label={group.name} data-testid={`branch-group-${group.key}`}>
                  {groups.length > 1 ? <BranchGroupHeader group={group} /> : null}
                  <ul className="divide-y divide-slate-100">
                    {group.bookings.map((b) => (
                      <li key={b.id}>
                        <Row
                          booking={b}
                          variant={variant}
                          selected={b.id === selectedId}
                          showBranch={groups.length <= 1 && isAdmin}
                          onSelect={() => {
                            setSelectedId(b.id);
                            lastIndexRef.current = bookings.findIndex((x) => x.id === b.id);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </Card>

          <div>{selectedId ? <SelectedPanel id={selectedId} isAdmin={isAdmin} onChanged={setToast} /> : null}</div>
        </div>
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

interface BranchGroup {
  key: string;
  name: string;
  branchId: number | null;
  branchNumber: number | null;
  address: string;
  bookings: NewListItem[];
}

/** The bookings of each branch together, branches in their own numbering, order within kept. */
function groupByBranch(bookings: NewListItem[]): BranchGroup[] {
  const groups = new Map<string, BranchGroup>();
  for (const b of bookings) {
    const key = b.branch ? String(b.branch.id) : 'none';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: b.branch ? branchOptionLabel(b.branch) : 'Chưa rõ chi nhánh',
        branchId: b.branch?.id ?? null,
        branchNumber: b.branch?.branchNumber ?? null,
        address: b.branch?.address ?? 'Chưa rõ chi nhánh',
        bookings: [],
      };
      groups.set(key, group);
    }
    group.bookings.push(b);
  }
  return [...groups.values()].sort(
    (a, b) => (a.branchNumber ?? Number.MAX_SAFE_INTEGER) - (b.branchNumber ?? Number.MAX_SAFE_INTEGER),
  );
}

function BranchGroupHeader({ group }: { group: BranchGroup }) {
  const tone = branchTone({ id: group.branchId ?? 0, branchNumber: group.branchNumber });
  return (
    <div
      className={`sticky top-0 z-[1] flex items-center gap-2.5 border-y border-slate-200 bg-slate-100 px-4 py-2 first:border-t-0`}
    >
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${tone.solid}`}
      >
        {group.branchNumber ? String(group.branchNumber).padStart(2, '0') : <Building2 className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-slate-900">{group.address}</p>
        {group.branchNumber ? (
          <p className="text-[11px] text-slate-500">Chi nhánh {String(group.branchNumber).padStart(2, '0')}</p>
        ) : null}
      </div>
      <span className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ring-1 ring-inset ${tone.soft}`}>
        {group.bookings.length}
      </span>
    </div>
  );
}

function Row({
  booking: b,
  variant,
  selected,
  showBranch,
  onSelect,
}: {
  booking: NewListItem;
  variant: Variant;
  selected: boolean;
  /** Only when the list is not already grouped under branch headers. */
  showBranch: boolean;
  onSelect: () => void;
}) {
  const tone = branchTone({ id: b.branch?.id ?? 0, branchNumber: b.branch?.branchNumber });
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full border-l-4 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
        selected ? 'bg-brand-50' : 'hover:bg-slate-50'
      } ${b.isLastMinute ? 'border-l-red-500' : b.branch ? tone.rail : 'border-l-transparent'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-semibold text-slate-900">{b.customerName ?? 'Khách chưa rõ'}</span>
        {b.isLastMinute ? <LastMinuteBadge /> : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-mono text-slate-600">{b.bookingCode ?? '—'}</span>
        <SourceBadge source={b.sourcePlatform} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>
          Nhận phòng: <span className="font-medium text-slate-700">{formatDate(b.checkInDate)}</span>
        </span>
        {showBranch && b.branch ? (
          <span className={`rounded px-1.5 py-0.5 font-medium ring-1 ring-inset ${tone.soft}`}>{b.branch.address}</span>
        ) : null}
      </div>
      {variant === 'pending-review' && b.submittedAt ? (
        <p className="mt-1.5 inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
          Gửi ảnh {formatDateTime(b.submittedAt)} · lần {b.latestAttemptNumber}
        </p>
      ) : null}
      {variant === 'rejected' && b.latestRejectionReason ? (
        <p className="mt-1.5 inline-flex rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">
          Lý do: {REVIEW_REASON_LABEL[b.latestRejectionReason]}
          {b.latestAttemptNumber > 1 ? ` · lần ${b.latestAttemptNumber}` : ''}
        </p>
      ) : null}
    </button>
  );
}

function SelectedPanel({ id, isAdmin, onChanged }: { id: string; isAdmin: boolean; onChanged: (m: string) => void }) {
  const query = useQuery({
    queryKey: ['booking', id],
    queryFn: () => bookingsApi.detail(id),
    enabled: id.length > 0,
  });

  if (query.isLoading) return <InlineSpinner />;
  if (query.isError) return <ErrorAlert>{toUserMessage(query.error)}</ErrorAlert>;
  if (!query.data) return null;
  const booking = query.data.booking;
  return (
    <VerificationBookingBody
      booking={booking}
      isAdmin={isAdmin}
      serverNow={query.data.serverNow ?? null}
      onChanged={onChanged}
    />
  );
}

/**
 * Separate component so the CẮT hook runs unconditionally, above the query's
 * early returns.
 *
 * "Cần tạo lại" is the same creation work as a fresh dispatch — the receptionist
 * recreates the reservation — so it carries the same duplicate risk and the same
 * claim. "Chờ kiểm tra" carries neither: the work is already done and there is
 * nothing left to take, so the CẮT controls are absent there and the fields keep
 * their ordinary copy buttons.
 */
function VerificationBookingBody({
  booking,
  isAdmin,
  serverNow,
  onChanged,
}: {
  booking: BookingDetail;
  isAdmin: boolean;
  serverNow: string | null;
  onChanged: (m: string) => void;
}) {
  const cut = useCut(booking.id, booking.cutFields, booking);
  const claimable = !isAdmin && booking.verificationStatus === 'REJECTED';
  return (
    <BookingDetailView
      booking={booking}
      isAdmin={isAdmin}
      onCompleted={(m) => onChanged(m ?? 'Đã cập nhật đơn.')}
      suppressInternalToast
      serverNow={serverNow}
      {...(claimable ? { cut } : {})}
    />
  );
}
