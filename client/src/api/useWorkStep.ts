/**
 * The next step on one's own room, and then the room's page: "Kiểm tra" begins
 * the inspection, "Dọn phòng" begins the cleaning; any other stage just opens
 * it. The same for a housekeeper and for a Quản lý buồng phòng doing the work.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask } from './roomWork';

export function useWorkStep(onError: () => void) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (t: RoomTask) => {
      if (t.phase === 'ACCEPTED') await roomWorkApi.beginInspection(t.id);
      if (t.phase === 'AWAITING_CLEANING') await roomWorkApi.start(t.id);
      return t;
    },
    onSuccess: async (t) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      navigate(`/app/inspections/room/${t.id}`);
    },
    onError,
  });
}
