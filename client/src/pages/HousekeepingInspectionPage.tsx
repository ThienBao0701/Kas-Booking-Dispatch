/**
 * "BUỒNG PHÒNG" — the worker's home.
 *
 *   Vào ca → the hotel's ADDRESS, typed (no list, nothing prefilled) → the shift
 *   opens at the account's branch once the server has matched it.
 *   [Ca hiện tại · Chi nhánh: …]                          Kết thúc ca
 *   Công việc ngày dd/mm/yyyy — ONE ROW PER WORK ITEM
 *     ☐ Phòng - 502 · OC · Chưa tiếp nhận               [Nhận]
 *       Phòng - 502 · Khác — Thay rèm · Đã tiếp nhận    [Kiểm tra]
 *       Hành lang - Tầng 5 · Dọn lối đi · Chờ dọn phòng [Dọn phòng]
 *
 * NOTHING BEFORE "VÀO CA". Until the address has established where the account
 * works, no branch and no work item is shown. Then: the items of that branch
 * that are this account's, and the ones nobody has accepted yet.
 *
 * "NHẬN" ALWAYS ASKS FIRST — which items, by name and count — and takes exactly
 * the ones selected; two items of one room are taken one by one. The work then
 * goes Nhận → Kiểm tra (saved) → Dọn phòng, in that order; "Dọn phòng" opens the
 * room's own cleaning page. The server enforces every step.
 *
 * NOTHING ABOUT MONEY HERE. The worker's own collections are on "KPI & Thu tiền".
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, ClipboardCheck, Hand, LogIn, LogOut, Play, RefreshCw, Sparkles } from 'lucide-react';
import { HOUSEKEEPING_SHIFT_KEY, ROOM_ISSUES_KEY, housekeepingApi, type WorkShift } from '../api/housekeeping';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel } from '../auth/types';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { PhaseBadge } from '../components/HkWorkOrders';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { formatDate, formatDateTime, hcmToday } from '../lib/format';

export function HousekeepingInspectionPage() {
  const today = hcmToday();
  // An account with no Admin-assigned branch cannot work at all; which branch it is stays unsaid until "Vào ca".
  const me = useAuth().user;
  const hasBranch = (me?.branch ?? null) !== null;
  const shift = useQuery({ queryKey: HOUSEKEEPING_SHIFT_KEY, queryFn: () => housekeepingApi.shift() });
  const [ended, setEnded] = useState<WorkShift | null>(null);
  const current = shift.data?.shift?.current ?? null;
  const items = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'items', today],
    queryFn: () => roomWorkApi.workItems(today),
    refetchInterval: 30_000,
    enabled: current !== null,
  });

  return (
    <div>
      <PageHeader
        title="Buồng phòng"
        description="Vào ca, nhận công việc, kiểm tra rồi dọn phòng."
        actions={
          current ? (
            <Button variant="secondary" onClick={() => void items.refetch()} aria-label="Làm mới">
              <RefreshCw className={`h-4 w-4 ${items.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Làm mới
            </Button>
          ) : null
        }
      />
      <QueryState isLoading={shift.isLoading} isError={shift.isError} error={shift.error} onRetry={() => void shift.refetch()}>
        {current && shift.data?.shift ? (
          <ShiftStrip shift={shift.data.shift} onEnded={setEnded} />
        ) : hasBranch ? (
          <StartShift />
        ) : (
          <EmptyState
            icon={<BedDouble className="h-6 w-6" aria-hidden="true" />}
            title="Tài khoản chưa được gán chi nhánh"
            message="Vui lòng liên hệ Admin để được gán chi nhánh làm việc trước khi vào ca."
          />
        )}
      </QueryState>

      {current ? (
        <section className="mt-5 space-y-3" aria-labelledby="work-items-title">
          <h2 id="work-items-title" className="text-lg font-bold text-slate-900">
            Công việc ngày {formatDate(today)}
          </h2>
          <QueryState isLoading={items.isLoading} isError={items.isError} error={items.error} onRetry={() => void items.refetch()}>
            <WorkItemList tasks={items.data?.tasks ?? []} meId={me?.id} onChanged={() => void items.refetch()} />
          </QueryState>
        </section>
      ) : null}
      {ended ? <ShiftSummaryModal shift={ended} onClose={() => setEnded(null)} /> : null}
    </div>
  );
}

const itemName = (t: RoomTask) => `${t.areaLabel ?? `Phòng - ${t.roomNumber}`} · ${t.taskLabel ?? t.statusCode}`;

/**
 * ONE ROW PER ITEM. Unclaimed items carry a checkbox and "Nhận"; the
 * housekeeper's own carry the next step of their work.
 */
function WorkItemList({ tasks, meId, onChanged }: { tasks: RoomTask[]; meId?: number; onChanged: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<RoomTask[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const claimable = tasks.filter((t) => !t.assignee && t.phase === 'UNCLAIMED');
  // Only items still on screen and still free stay selected.
  const picked = claimable.filter((t) => selected.has(t.id));
  const mine = useMemo(() => tasks.filter((t) => t.assignee?.id === meId), [tasks, meId]);

  const step = useMutation({
    mutationFn: async (t: RoomTask) => {
      if (t.phase === 'ACCEPTED') await roomWorkApi.beginInspection(t.id);
      if (t.phase === 'AWAITING_CLEANING') await roomWorkApi.start(t.id);
      return t;
    },
    onSuccess: async (t) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      navigate(`/app/inspections/room/${t.id}`);
    },
    onError: () => onChanged(),
  });

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<BedDouble className="h-6 w-6" aria-hidden="true" />}
        title="Chưa có công việc"
        message="Quản lý buồng phòng sẽ tạo công việc trong ngày. Bấm “Làm mới” để xem công việc mới."
      />
    );
  }
  return (
    <div className="space-y-3">
      {message ? (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status" data-testid="claim-done">
          {message}
        </p>
      ) : null}
      {step.isError ? <ErrorAlert>{toUserMessage(step.error)}</ErrorAlert> : null}
      {claimable.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white px-3 py-2">
          <p className="text-sm text-slate-700">
            {picked.length > 0 ? `Đã chọn ${picked.length} công việc chưa tiếp nhận` : `${claimable.length} công việc chưa có người nhận`}
          </p>
          <Button onClick={() => setConfirming(picked)} disabled={picked.length === 0} data-testid="claim-selected">
            <Hand className="h-4 w-4" aria-hidden="true" />
            Nhận {picked.length > 0 ? `${picked.length} ` : ''}công việc đã chọn
          </Button>
        </div>
      ) : null}
      <ul className="space-y-2" data-testid="work-items">
        {tasks.map((t) => {
          const free = !t.assignee && t.phase === 'UNCLAIMED';
          const own = t.assignee?.id === meId;
          return (
            <li
              key={t.id}
              data-testid={`work-item-${t.id}`}
              className={`rounded-2xl border bg-white p-3 shadow-sm ${own ? 'border-brand-200' : 'border-line'}`}
            >
              <div className="flex flex-wrap items-start gap-3">
                {free ? (
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 accent-brand-600"
                    checked={selected.has(t.id)}
                    aria-label={`Chọn ${itemName(t)}`}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(t.id);
                        else next.delete(t.id);
                        return next;
                      })
                    }
                    data-testid={`work-select-${t.id}`}
                  />
                ) : null}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-bold text-slate-900">
                    {t.areaLabel ?? `Phòng - ${t.roomNumber}`}
                    <span className="rounded-md bg-slate-800 px-2 py-0.5 text-sm font-bold text-white">{t.taskLabel ?? t.statusCode}</span>
                    {t.priority ? <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">Ưu tiên</span> : null}
                    {t.reclean ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Cần dọn lại</span> : null}
                  </p>
                  {t.note ? (
                    <p className="whitespace-pre-wrap rounded-lg bg-amber-50 px-2.5 py-1.5 text-sm text-amber-950">
                      <span className="font-semibold">Hướng dẫn: </span>
                      {t.note}
                    </p>
                  ) : null}
                  <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <PhaseBadge task={t} />
                    <span>{t.assignee ? `Người thực hiện: ${own ? 'Bạn' : t.assignee.name}` : 'Chưa có người nhận'}</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {free ? (
                    <Button onClick={() => setConfirming([t])} data-testid={`work-claim-${t.id}`}>
                      <Hand className="h-4 w-4" aria-hidden="true" />
                      Nhận
                    </Button>
                  ) : own ? (
                    <OwnAction task={t} busy={step.isPending && step.variables?.id === t.id} onStep={() => step.mutate(t)} />
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {mine.length === 0 && claimable.length > 0 ? (
        <p className="text-sm text-slate-500">Chọn công việc rồi bấm “Nhận” để bắt đầu.</p>
      ) : null}
      {confirming && confirming.length > 0 ? (
        <ClaimDialog
          tasks={confirming}
          onClose={() => setConfirming(null)}
          onClaimed={(n) => {
            setConfirming(null);
            setSelected(new Set());
            setMessage(`Đã nhận ${n} công việc. Bấm “Kiểm tra” để bắt đầu kiểm tra.`);
          }}
          onRefresh={onChanged}
        />
      ) : null}
    </div>
  );
}

/** The next step of the housekeeper's own item — one button, the stage's own. */
function OwnAction({ task: t, busy, onStep }: { task: RoomTask; busy: boolean; onStep: () => void }) {
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

/** "NHẬN" — always confirmed first: exactly which items, by name and count. */
function ClaimDialog({
  tasks,
  onClose,
  onClaimed,
  onRefresh,
}: {
  tasks: RoomTask[];
  onClose: () => void;
  onClaimed: (count: number) => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const claim = useMutation({
    mutationFn: () => roomWorkApi.claim(tasks.map((t) => t.id)),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onClaimed(r.tasks.length);
    },
    // Somebody else was faster, or the item changed: the list is reloaded.
    onError: () => onRefresh(),
  });
  return (
    <Modal
      open
      title="Nhận công việc"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={claim.isPending}>
            Hủy
          </Button>
          <Button onClick={() => claim.mutate()} loading={claim.isPending} disabled={claim.isError} data-testid="claim-confirm">
            Nhận {tasks.length} công việc
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="claim-dialog">
        <p className="text-sm text-slate-700">
          Bạn sắp nhận <span className="font-semibold">{tasks.length} công việc</span>. Sau khi nhận, công việc chuyển sang “Đã tiếp nhận / Chờ
          kiểm tra” — chưa bắt đầu kiểm tra hay dọn phòng.
        </p>
        <ul className="divide-y divide-line-subtle rounded-xl border border-line" data-testid="claim-list">
          {tasks.map((t) => (
            <li key={t.id} className="px-3 py-2 text-sm font-medium text-slate-900">
              {itemName(t)}
            </li>
          ))}
        </ul>
        {claim.isError ? (
          <ErrorAlert>{toUserMessage(claim.error)}</ErrorAlert>
        ) : null}
      </div>
    </Modal>
  );
}

/** After any shift change: the shift, the header's branch and the lists follow. */
function useShiftChanged() {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: HOUSEKEEPING_SHIFT_KEY });
    await queryClient.invalidateQueries({ queryKey: ROOM_ISSUES_KEY });
    await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
    await refreshUser();
  };
}

/**
 * "VÀO CA" — the hotel named by its address, typed by the housekeeper. No list,
 * no suggestion and nothing prefilled: the server matches what was typed and
 * opens the shift only at the account's own branch; anything it cannot match
 * for certain comes back as a neutral message that names no hotel.
 */
function StartShift() {
  const changed = useShiftChanged();
  const [address, setAddress] = useState('');
  const start = useMutation({
    mutationFn: () => housekeepingApi.startShift(address.trim()),
    onSuccess: changed,
  });
  return (
    <form
      data-testid="shift-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim()) start.mutate();
      }}
      className="max-w-md space-y-4 rounded-2xl border-section border-line bg-white p-4 shadow-sm"
      autoComplete="off"
    >
      <h2 className="text-base font-semibold text-slate-900">Vào ca</h2>
      <label className="block text-sm font-medium text-slate-700" htmlFor="shift-address">
        Địa chỉ khách sạn nơi bạn làm việc
        <input
          id="shift-address"
          name="workplace"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          value={address}
          maxLength={200}
          onChange={(e) => {
            setAddress(e.target.value);
            if (start.isError) start.reset();
          }}
          placeholder="Nhập số nhà và tên đường"
          data-testid="shift-address"
        />
      </label>
      <p className="text-xs text-slate-500">Nhập địa chỉ khách sạn bạn đang làm việc để xác định ca làm.</p>
      {start.isError ? <ErrorAlert>{toUserMessage(start.error)}</ErrorAlert> : null}
      <div className="flex justify-end">
        <Button type="submit" loading={start.isPending} disabled={!address.trim()} data-testid="shift-start-submit">
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Vào ca
        </Button>
      </div>
    </form>
  );
}

/** "CA HIỆN TẠI · CHI NHÁNH: …" — always in view, with the two shift actions. */
function ShiftStrip({ shift, onEnded }: { shift: WorkShift; onEnded: (shift: WorkShift) => void }) {
  const homeId = useAuth().user?.branch?.id ?? null;
  const changed = useShiftChanged();
  const current = shift.current!;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const end = useMutation({
    mutationFn: () => housekeepingApi.endShift(),
    onSuccess: async ({ shift: day }) => {
      setConfirmEnd(false);
      onEnded(day);
      await changed();
    },
  });
  return (
    <>
      <section
        data-testid="shift-current"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Ca hiện tại</p>
          <p className="text-base font-bold text-brand-900">Chi nhánh: {branchLabel(current.branch)}</p>
          <p className="text-sm text-slate-700">
            Từ {formatDateTime(current.startedAt)} · {current.inspections} lượt kiểm phòng
          </p>
          {homeId !== null && current.branch.id !== homeId ? (
            // A shift opened before the Admin set the account's branch.
            <p className="mt-1 text-sm font-medium text-amber-800" data-testid="shift-other-branch">
              Ca đang mở không ở chi nhánh của tài khoản. Hãy “Kết thúc ca” rồi “Vào ca” lại.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setConfirmEnd(true)} data-testid="shift-end">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Kết thúc ca
          </Button>
        </div>
      </section>
      {confirmEnd ? (
        <Modal
          open
          title="Kết thúc ca"
          onClose={() => setConfirmEnd(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
                Hủy
              </Button>
              <Button onClick={() => end.mutate()} loading={end.isPending} data-testid="shift-end-confirm">
                Kết thúc ca
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">Kết thúc ca làm việc hôm nay? Sau khi kết thúc, cần “Vào ca” lại để làm phòng.</p>
          {end.isError ? <ErrorAlert>{toUserMessage(end.error)}</ErrorAlert> : null}
        </Modal>
      ) : null}
    </>
  );
}

/** One line per branch of the day: where, when, and what was found. */
function SegmentList({ shift }: { shift: WorkShift }) {
  return (
    <ul className="space-y-1.5" data-testid="shift-segments">
      {shift.segments.map((seg) => (
        <li key={seg.id} className="rounded-lg border border-line px-3 py-2 text-sm text-slate-700">
          <p className="font-medium text-slate-900">{branchLabel(seg.branch)}</p>
          <p className="text-xs text-slate-600">
            {formatDateTime(seg.startedAt)} – {seg.endedAt ? formatDateTime(seg.endedAt) : 'đang làm'} · {seg.rooms} phòng ·{' '}
            {seg.inspections} lượt kiểm tra · {seg.issues} vấn đề
          </p>
          {seg.byType.length > 0 ? (
            <p className="text-xs text-slate-500">{seg.byType.map((t) => `${t.label}: ${t.count}`).join(' · ')}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "KẾT THÚC CA" — the day's summary, branch by branch. */
function ShiftSummaryModal({ shift, onClose }: { shift: WorkShift; onClose: () => void }) {
  return (
    <Modal
      open
      title="Tổng kết ca"
      onClose={onClose}
      footer={
        <Button onClick={onClose} data-testid="shift-summary-close">
          Đóng
        </Button>
      }
    >
      <div className="space-y-3 text-sm" data-testid="shift-summary">
        <p className="text-slate-700">
          {formatDateTime(shift.startedAt)} – {shift.endedAt ? formatDateTime(shift.endedAt) : '—'} · {shift.segments.length} chi nhánh ·{' '}
          {shift.totals.rooms} phòng · {shift.totals.inspections} lượt kiểm tra · {shift.totals.issues} vấn đề
        </p>
        {shift.totals.byType.length > 0 ? (
          <p className="text-slate-600">{shift.totals.byType.map((t) => `${t.label}: ${t.count}`).join(' · ')}</p>
        ) : null}
        <SegmentList shift={shift} />
      </div>
    </Modal>
  );
}
