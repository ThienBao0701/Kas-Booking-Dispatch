/**
 * THE WORKER'S ACTIONS ON A WORK GROUP — shared by the housekeeper's page and
 * the Quản lý buồng phòng's board (a manager may take a group and do the
 * work itself):
 *
 *   AcceptGroupDialog  "Nhận công việc" — always asks first, with every place.
 *   OwnAction          the next step on one's own room: Kiểm tra → Dọn phòng.
 *
 * The server decides who may (role, branch, shift) and keeps one owner per group.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Play, Sparkles } from 'lucide-react';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask, type WorkGroup } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { placeText } from '../lib/workPlaces';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';

/** "NHẬN CÔNG VIỆC" — always asks first: the group and every place in it. */
export function AcceptGroupDialog({
  group,
  onClose,
  onAccepted,
  onRefresh,
}: {
  group: WorkGroup;
  onClose: () => void;
  onAccepted: (group: WorkGroup) => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => roomWorkApi.acceptGroup(group.id),
    onSuccess: async ({ group: g }) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onAccepted(g);
    },
    // Somebody else was faster: the list is reloaded and shows who has it.
    onError: () => onRefresh(),
  });
  const places = group.items.filter((t) => !t.voided);
  return (
    <Modal
      open
      title="Nhận công việc"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={accept.isPending}>
            Hủy
          </Button>
          <Button onClick={() => accept.mutate()} loading={accept.isPending} disabled={accept.isError} data-testid="group-accept-confirm">
            Nhận {group.title}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="group-accept-dialog">
        <p className="text-sm text-slate-700">
          Bạn sắp nhận <span className="font-semibold">{group.title}</span>
          {group.name ? ` — ${group.name}` : ''} gồm {places.length} phòng / khu vực. Cả công việc sẽ do bạn thực hiện; nhận xong chưa bắt đầu kiểm tra hay dọn phòng.
        </p>
        <ul className="divide-y divide-line-subtle rounded-xl border border-line" data-testid="group-accept-list">
          {places.map((t) => (
            <li key={t.id} className="px-3 py-2 text-sm font-medium text-slate-900">
              {placeText(t)} · {(t.taskCodes ?? [t.statusCode]).map((c) => (c === 'OTHER' ? 'Khác' : c)).join(' + ')}
            </li>
          ))}
        </ul>
        {accept.isError ? <ErrorAlert>{toUserMessage(accept.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/** The next step of the housekeeper's own item — one button, the stage's own. */
export function OwnAction({ task: t, busy, onStep }: { task: RoomTask; busy: boolean; onStep: () => void }) {
  const [label, Icon] =
    t.phase === 'ACCEPTED'
      ? (['Kiểm tra', ClipboardCheck] as const)
      : t.phase === 'INSPECTING'
        ? (['Tiếp tục kiểm tra', ClipboardCheck] as const)
        : t.phase === 'AWAITING_CLEANING'
          ? (['Dọn phòng', Sparkles] as const)
          : (['Tiếp tục dọn phòng', Play] as const);
  return (
    <Button onClick={onStep} loading={busy} data-testid={`work-step-${t.id}`}>
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
