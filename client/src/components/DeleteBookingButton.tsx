import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { bookingsApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

/**
 * Removes a booking from the operational queues. ADMIN ONLY.
 *
 * The server is the real guard — every `/admin/bookings` route sits behind
 * `requireAdmin`, so a receptionist reaching this URL gets a 403 before any
 * handler runs. This component simply does not render for them, because
 * offering a button that always fails is its own kind of lie.
 *
 * It asks first. Deletion is not reversible from this screen, and the operator
 * is told plainly what survives: the booking leaves every queue, and the audit
 * record of what happened to it does not.
 */
export function DeleteBookingButton({
  bookingId,
  guestName,
  isAdmin,
}: {
  bookingId: string;
  guestName: string | null;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation({
    mutationFn: () => bookingsApi.remove(bookingId),
    onSuccess: async () => {
      // Every list that could still be showing it. Invalidated BEFORE
      // navigating, so the queue behind this screen is already correct rather
      // than briefly showing a row that no longer exists.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookings'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      ]);
      queryClient.removeQueries({ queryKey: ['booking', bookingId] });
      setConfirming(false);
      navigate('/app/history', { replace: true });
    },
  });

  if (!isAdmin) return null;

  return (
    <>
      <Button
        variant="danger"
        onClick={() => setConfirming(true)}
        data-testid="delete-booking"
        className="gap-2"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        Xoá đơn
      </Button>

      <Modal
        open={confirming}
        title="Xoá đơn đặt phòng"
        onClose={() => setConfirming(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Quay lại
            </Button>
            <Button
              variant="danger"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
              data-testid="delete-booking-confirm"
            >
              Xoá
            </Button>
          </div>
        }
      >
        {mutation.isError ? (
          <div className="mb-3">
            <ErrorAlert>{toUserMessage(mutation.error)}</ErrorAlert>
          </div>
        ) : null}
        <p className="text-sm text-slate-600">
          Đơn của khách <span className="font-medium">{guestName ?? 'chưa rõ'}</span> sẽ biến mất
          khỏi mọi danh sách vận hành và khỏi tìm kiếm. Lễ tân sẽ không còn nhìn thấy đơn này.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Lịch sử kiểm toán — ảnh chứng minh, lịch sử chỉnh sửa và nhật ký trạng thái —{' '}
          <span className="font-medium">vẫn được giữ lại</span>.
        </p>
      </Modal>
    </>
  );
}
