/**
 * "Gửi lại đơn" — the Admin recovery screen.
 *
 * An order lands here when a receptionist took it and did not finish inside the
 * three-minute window. Nothing was lost and nothing was deleted: the same
 * business order is simply unowned again, and "Gửi lại" hands it back to the
 * branch. The Booking row is never duplicated — `claimCycle` counts how many
 * times it has been round.
 *
 * Expiry is DERIVED from the stored deadline, so this list is accurate the
 * moment it is fetched without any background job having marked anything.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Send } from 'lucide-react';
import { bookingsApi, type NewListItem } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { SkeletonList } from '../components/Skeleton';
import { PageHeader } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDate, formatDateTime } from '../lib/format';

const POLL_MS = 20_000;

function ExpiredRow({
  booking: b,
  onResent,
  onError,
}: {
  booking: NewListItem;
  onResent: () => void;
  onError: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const resend = useMutation({
    mutationFn: () => bookingsApi.resend(b.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      onResent();
    },
    onError: (e) => onError(toUserMessage(e)),
  });

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">
            {b.bookingCode ?? '(chưa có mã)'} — {b.customerName ?? 'Khách chưa rõ'}
          </p>
          <p className="mt-0.5 text-sm text-slate-600">
            {b.branch ? `${b.branch.address} · ` : ''}
            {b.checkInDate ? `Nhận phòng ${formatDate(b.checkInDate)}` : 'Chưa rõ ngày'}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Lý do: <strong className="text-slate-700">Hết thời gian 3 phút</strong>
            {b.claimedBy ? ` · Lễ tân: ${b.claimedBy.fullName}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {b.claimedAt ? `Nhận lúc ${formatDateTime(b.claimedAt)}` : ''}
            {b.claimExpiresAt ? ` · Hết hạn ${formatDateTime(b.claimExpiresAt)}` : ''}
            {` · Lần gửi thứ ${b.claimCycle + 1}`}
          </p>
        </div>
        <Button
          onClick={() => resend.mutate()}
          disabled={resend.isPending}
          data-testid={`resend-${b.id}`}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {resend.isPending ? 'Đang gửi…' : 'Gửi lại'}
        </Button>
      </div>
    </li>
  );
}

export function ResendOrdersPage() {
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['bookings', 'expired-claims'],
    queryFn: () => bookingsApi.listExpiredClaims({ pageSize: 100 }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const bookings = list.data?.bookings ?? [];

  return (
    <div>
      <PageHeader
        title="Gửi lại đơn"
        description="Đơn đã được lễ tân nhận nhưng quá 3 phút chưa gửi ảnh. Gửi lại để chi nhánh nhận lại đơn."
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

      {error ? (
        <div className="mb-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      ) : null}

      {list.isLoading ? (
        <SkeletonList rows={4} />
      ) : list.isError ? (
        <ErrorAlert>{toUserMessage(list.error)}</ErrorAlert>
      ) : bookings.length === 0 ? (
        <EmptyState
          icon={<RotateCcw className="h-6 w-6" aria-hidden="true" />}
          title="Không có đơn nào cần gửi lại"
          message="Khi một lễ tân nhận đơn nhưng quá 3 phút chưa gửi ảnh, đơn sẽ xuất hiện ở đây."
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100" data-testid="expired-claims">
            {bookings.map((b) => (
              <ExpiredRow
                key={b.id}
                booking={b}
                onResent={() => {
                  setError(null);
                  setToast('Đã gửi lại đơn cho chi nhánh.');
                }}
                onError={setError}
              />
            ))}
          </ul>
        </Card>
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
