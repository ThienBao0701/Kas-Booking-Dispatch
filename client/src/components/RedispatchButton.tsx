/**
 * "Gửi lại" for an order the Admin WITHDREW.
 *
 * NOT the claim resend on the "Gửi lại đơn" screen — that one returns an order
 * whose three-minute claim lapsed. This one revives an order the Admin deleted,
 * and it lives beside the delete control because that is the action it undoes.
 *
 * The button is shown only when the server says `canRedispatch`, and the server
 * re-checks the same two conditions on the write. Hiding it is a courtesy; the
 * endpoint is what decides.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SendHorizonal } from 'lucide-react';
import { bookingsApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

export function RedispatchButton({
  bookingId,
  guestName,
  onDone,
}: {
  bookingId: string;
  guestName: string | null;
  onDone?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const send = useMutation({
    mutationFn: () => bookingsApi.redispatch(bookingId),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['booking', bookingId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-booking', bookingId] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['nav-badges'] });
      onDone?.('Đã gửi lại đơn cho chi nhánh.');
    },
  });

  return (
    <>
      <Button variant="primary" onClick={() => setConfirming(true)} data-testid="redispatch-open">
        <SendHorizonal className="h-4 w-4" aria-hidden="true" />
        Gửi lại
      </Button>

      <Modal
        open={confirming}
        title="Gửi lại đơn đã xoá"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Huỷ</Button>
            <Button onClick={() => send.mutate()} loading={send.isPending} data-testid="redispatch-confirm">
              Gửi lại
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          Đơn của <strong>{guestName ?? 'khách chưa rõ'}</strong> sẽ xuất hiện lại trong danh sách
          của chi nhánh. Lễ tân sẽ phải bấm CẮT và gửi ảnh lại từ đầu.
        </p>
        {send.isError ? (
          <div className="mt-3">
            <ErrorAlert>{toUserMessage(send.error)}</ErrorAlert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
