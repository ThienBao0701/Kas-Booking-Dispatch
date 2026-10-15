import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { isReceptionSupervisor } from '../auth/types';
import { bookingsApi, branchesApi, type BookingDetail, type NewListItem } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { ConnectionWarning } from '../components/ConnectionWarning';
import { SkeletonList } from '../components/Skeleton';
import { LastMinuteBadge, StatusBadge, WorkflowBadge } from '../components/Badges';
import { Pagination } from '../components/Pagination';
import { PageHeader, InlineSpinner, QueryState } from '../components/PageState';
import { BookingDetailView } from '../components/BookingDetailView';
import { ResponseSla } from '../components/ResponseSla';
import { Toast } from '../components/Toast';
import { useCut } from '../hooks/useCut';
import { formatDate, formatDateTime } from '../lib/format';

const POLL_MS = 20_000;

export function NewBookingsPage() {
  const { user } = useAuth();
  if (user?.role === 'ADMIN') return <AdminWaitingList />;
  // A reception manager reads the same orders over its branches — the Admin's
  // table, whose branch list and rows the server scopes. It takes no order.
  if (user && isReceptionSupervisor(user.role)) return <AdminWaitingList manager />;
  return <ReceptionistInbox />;
}

/* -------------------------------------------------------------------------- */
/* Receptionist: master-detail inbox                                          */
/* -------------------------------------------------------------------------- */

function ReceptionistInbox() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Remembers where the selected booking sits, so when it disappears (confirmed
  // here or by another user) we can advance to the booking that took its place.
  const lastIndexRef = useRef(0);

  const list = useQuery({
    queryKey: ['bookings', 'new', { branchId: undefined }],
    queryFn: () => bookingsApi.listNew({ pageSize: 100 }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const bookings = useMemo(() => list.data?.bookings ?? [], [list.data]);

  // Keep a valid selection across polling refreshes:
  // - first load auto-selects the first booking;
  // - a still-present selection is preserved (and its position remembered);
  // - a vanished selection advances to the next available booking;
  // - an emptied list clears the selection so the empty state can show.
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

  const lastRefresh = list.dataUpdatedAt
    ? new Date(list.dataUpdatedAt).toLocaleTimeString('vi-VN')
    : null;
  // A background refresh failed but we still have the last good data on screen.
  const staleWarning = list.failureReason != null && list.data != null;

  // First-ever load failed with nothing to show.
  if (list.isError && !list.data) {
    return (
      <div>
        <PageHeader title="Đơn mới" description="Đơn được gửi đến chi nhánh của bạn." />
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
        title="Đơn mới"
        description="Mở đơn, sao chép thông tin, tạo trên hệ thống khách sạn, rồi tải ảnh chụp màn hình gửi Admin kiểm tra."
        actions={
          <button
            type="button"
            onClick={() => void list.refetch()}
            aria-label="Làm mới danh sách"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </button>
        }
      />

      <p className="mb-3 text-xs text-slate-500">
        Dữ liệu tự động cập nhật mỗi 20 giây.
        {lastRefresh ? ` Cập nhật gần nhất: ${lastRefresh}.` : ''}
      </p>

      {staleWarning ? (
        <div className="mb-3">
          <ConnectionWarning onRetry={() => void list.refetch()} />
        </div>
      ) : null}

      {list.isLoading ? (
        <SkeletonList rows={6} />
      ) : bookings.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
          title="Chưa có đơn mới"
          message="Chưa có đơn mới được gửi đến. Màn hình sẽ tự cập nhật khi có đơn."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[38%_1fr] lg:items-start">
          {/* Left: compact list (~38% width), independently scrollable */}
          <Card className="overflow-hidden lg:sticky lg:top-4">
            <ul className="max-h-[calc(100vh-14rem)] divide-y divide-slate-100 overflow-y-auto" aria-label="Danh sách đơn mới">
              {bookings.map((b) => (
                <li key={b.id}>
                  <BookingListRow
                    booking={b}
                    selected={b.id === selectedId}
                    serverNow={list.data?.serverNow ?? null}
                    onSelect={() => {
                      setSelectedId(b.id);
                      lastIndexRef.current = bookings.findIndex((x) => x.id === b.id);
                    }}
                  />
                </li>
              ))}
            </ul>
          </Card>

          {/* Right: full detail (~62% width) */}
          <div>
            {selectedId ? (
              <SelectedBookingPanel
                id={selectedId}
                onChanged={(m) => setToast(m ?? 'Đã gửi ảnh cho Admin kiểm tra.')}
              />
            ) : null}
          </div>
        </div>
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function BookingListRow({
  booking: b,
  selected,
  onSelect,
  serverNow,
}: {
  booking: NewListItem;
  selected: boolean;
  onSelect: () => void;
  /** The server's clock from the list payload, so the SLA is not PC-clock based. */
  serverNow?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`block w-full px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
        selected ? 'bg-brand-50' : 'hover:bg-slate-50'
      } ${b.isLastMinute ? 'border-l-4 border-l-red-500' : 'border-l-4 border-l-transparent'}`}
    >
      {/*
        Guest, one workflow state, and the last-minute flag. Nothing else:
        branch is where the receptionist already is, and the code, dates,
        rooms and payment are all on the detail panel beside this list.
      */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-slate-900">{b.customerName ?? 'Khách chưa rõ'}</span>
        {b.isLastMinute ? <LastMinuteBadge /> : null}
      </div>
      {/*
        The response SLA sits beside the workflow state, which is where a
        receptionist already looks to decide what to pick up next. It is an
        indicator only — nothing about the order changes when it runs out, and
        the CẮT controls and claim countdown on the detail panel are untouched.
      */}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <WorkflowBadge status={b.verificationStatus} />
        <ResponseSla
          slaStartedAt={b.slaStartedAt ?? b.sentAt}
          claimedAt={b.claimedAt}
          serverNow={serverNow}
        />
      </div>
    </button>
  );
}

function SelectedBookingPanel({ id, onChanged }: { id: string; onChanged: (m?: string) => void }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['booking', id],
    queryFn: () => bookingsApi.detail(id),
    enabled: id.length > 0,
  });

  if (query.isLoading) return <InlineSpinner />;
  if (query.isError) return <ErrorAlert>{toUserMessage(query.error)}</ErrorAlert>;
  if (!query.data) return null;
  const booking = query.data.booking;
  const isAdmin = user?.role === 'ADMIN';

  /*
    THERE IS NO SEPARATE "TAKE THIS ORDER" STEP ANY MORE.

    The card that used to sit above this detail — "Nhận đơn để tạo trên hệ
    thống", with its own CUT button — is gone. Taking the order is not a
    decision a receptionist makes in the abstract; it is what happens the first
    time they take a value off it. So the claim now starts from the CẮT controls
    on the fields themselves, and there is no global CUT anywhere.
  */
  return (
    <SelectedBookingBody booking={booking} isAdmin={isAdmin} serverNow={query.data.serverNow ?? null} onChanged={onChanged} />
  );
}

/**
 * Split out so the CẮT hook is called unconditionally.
 *
 * `SelectedBookingPanel` returns early while the query is loading, and a hook
 * after those returns would break the rules of hooks the first time a booking
 * is selected.
 */
function SelectedBookingBody({
  booking,
  isAdmin,
  serverNow,
  onChanged,
}: {
  booking: BookingDetail;
  isAdmin: boolean;
  serverNow: string | null;
  onChanged: (m?: string) => void;
}) {
  const cut = useCut(booking.id, booking.cutFields, booking);
  return (
    <BookingDetailView
      booking={booking}
      isAdmin={isAdmin}
      onCompleted={onChanged}
      suppressInternalToast
      serverNow={serverNow}
      {...(isAdmin ? {} : { cut })}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Admin: waiting list (dispatched, awaiting a branch to confirm creation)     */
/* -------------------------------------------------------------------------- */

function AdminWaitingList({ manager = false }: { manager?: boolean }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialBranch = searchParams.get('branchId');
  const [page, setPage] = useState(1);
  const [branchId, setBranchId] = useState<number | undefined>(
    initialBranch ? Number(initialBranch) : undefined,
  );

  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    queryKey: ['bookings', 'new', { branchId, page }],
    queryFn: () => bookingsApi.listNew({ branchId, page, pageSize: 20 }),
    refetchInterval: POLL_MS,
  });

  const bookings = query.data?.bookings ?? [];

  return (
    <div>
      <PageHeader
        title={manager ? 'Đơn mới' : 'Chờ chi nhánh tạo'}
        description={
          manager
            ? 'Đơn mới gửi đến các chi nhánh bạn quản lý, đúng như lễ tân đang thấy. Chỉ xem — lễ tân nhận và tạo đơn.'
            : 'Đơn đã gửi xuống chi nhánh, đang chờ lễ tân xác nhận đã tạo trên hệ thống khách sạn.'
        }
        actions={
          <select
            value={branchId ?? ''}
            onChange={(e) => {
              setBranchId(e.target.value ? Number(e.target.value) : undefined);
              setPage(1);
            }}
            aria-label="Lọc theo chi nhánh"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <option value="">{manager ? 'Tất cả chi nhánh được giao' : 'Tất cả chi nhánh'}</option>
            {branches.data?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.address} — {b.hotelName}
              </option>
            ))}
          </select>
        }
      />

      <QueryState isLoading={query.isLoading} isError={query.isError} error={query.error}>
        {bookings.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
            title="Chưa có đơn nào"
            message="Không có đơn nào đang chờ chi nhánh tạo."
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Mã Booking</th>
                    <th className="px-4 py-3">Khách</th>
                    <th className="px-4 py-3">Chi nhánh</th>
                    <th className="px-4 py-3">Nhận phòng</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-4 py-3">Thời gian gửi</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => navigate(`/app/booking/${b.id}`)}
                      className="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {b.isLastMinute ? <LastMinuteBadge /> : null}
                          <span className="font-mono text-slate-900">{b.bookingCode ?? '—'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-800">{b.customerName ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{b.branch?.address ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(b.checkInDate)}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="px-4 py-3 text-slate-500">{formatDateTime(b.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {query.data ? (
              <div className="border-t border-slate-100 px-3">
                <Pagination meta={query.data.pagination} onChange={setPage} />
              </div>
            ) : null}
          </Card>
        )}
      </QueryState>
    </div>
  );
}
