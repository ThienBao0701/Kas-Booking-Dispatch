/**
 * THE WORKER'S ACTIONS ON A WORK GROUP — shared by the housekeeper's page and
 * the Quản lý buồng phòng's board (a manager may take a group and do the
 * work itself):
 *
 *   AcceptGroupDialog  "Nhận công việc" — always asks first, with every place.
 *   OwnAction          the next step on one's own room: Kiểm tra → Dọn phòng.
 *   NoCleanRequestDialog  "Không cần dọn" for one's own room: a reason, then
 *                      the Quản lý buồng phòng decides (the existing approval).
 *
 * The server decides who may (role, branch, shift) and keeps one owner per group.
 */
import { useState } from 'react';
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

/**
 * "KHÔNG CẦN DỌN" — asked from the room itself. The room and its work group are
 * named, the reason is required, and the request goes to the Quản lý buồng
 * phòng's queue: the room stays in the work ("Chờ Quản lý xác nhận") until the
 * manager approves it — only then is it taken out. Nothing here decides.
 */
/**
 * "CHƯA DỌN — CHUYỂN NGƯỜI KHÁC DỌN" — the inspection stays, the cleaning goes
 * to whichever colleague of the branch takes the room ("Nhận"). Not "Không cần
 * dọn": the room still has to be cleaned.
 */
export function ReleaseRoomDialog({ task: t, onClose, onReleased }: { task: RoomTask; onClose: () => void; onReleased: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => roomWorkApi.release(t.id, reason.trim() || undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onReleased();
    },
  });
  return (
    <Modal
      open
      title="Chưa dọn — chuyển người khác dọn"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={send.isPending}>
            Hủy
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={send.isPending} data-testid="release-send">
            Chuyển người khác dọn
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="release-dialog">
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">{placeText(t)}</p>
        <p className="text-sm text-slate-600">
          Kết quả kiểm tra của bạn được giữ lại. Phòng chưa dọn — nhân viên buồng phòng khác của chi nhánh sẽ nhận và dọn.
        </p>
        <label className="block text-sm font-medium text-slate-700" htmlFor="release-reason">
          Lý do (nếu có)
          <textarea
            id="release-reason"
            className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Hết ca, nhờ người khác dọn"
            data-testid="release-reason"
          />
        </label>
        {send.isError ? <ErrorAlert>{toUserMessage(send.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

export function NoCleanRequestDialog({ task: t, onClose, onSent }: { task: RoomTask; onClose: () => void; onSent: (task: RoomTask) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => roomWorkApi.requestNoClean(t.id, reason.trim()),
    onSuccess: async ({ task: next }) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onSent(next);
    },
  });
  return (
    <Modal
      open
      title="Không cần dọn"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={send.isPending}>
            Hủy
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!reason.trim() || send.isPending} data-testid="no-clean-send">
            Gửi yêu cầu
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="no-clean-dialog">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <dt className="text-slate-500">Phòng / khu vực</dt>
          <dd className="font-semibold text-slate-900" data-testid="no-clean-place">
            {placeText(t)}
          </dd>
          <dt className="text-slate-500">Công việc</dt>
          <dd className="text-slate-900">{t.workGroup ? `Công việc ${t.workGroup.number}${t.workGroup.name ? ` — ${t.workGroup.name}` : ''}` : '—'}</dd>
        </dl>
        <p className="text-sm text-slate-600">Phòng chỉ được bỏ khỏi công việc sau khi Quản lý buồng phòng duyệt.</p>
        <label className="block text-sm font-medium text-slate-700" htmlFor="no-clean-reason">
          Lý do <span className="text-red-600">*</span>
          <textarea
            id="no-clean-reason"
            className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: Khách không muốn dọn phòng hôm nay"
            data-testid="no-clean-reason"
          />
        </label>
        {send.isError ? <ErrorAlert>{toUserMessage(send.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
