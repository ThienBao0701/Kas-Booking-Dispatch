/**
 * "BUỒNG PHÒNG" — the worker's home.
 *
 *   [Ca hiện tại · Chi nhánh: …]            Đổi chi nhánh · Kết thúc ca
 *   Tình trạng phòng ngày dd/mm/yyyy
 *   OUT   101  102 …                        (the rooms given to THIS account)
 *
 * THE PERSON IS THE ACCOUNT. Nobody types a name: "Vào ca" asks only where, and
 * offers first the branch the manager gave today's rooms in. A room opens its
 * work page (Kiểm phòng | Dọn phòng); the board shows where each stands — gray
 * not started, blue being cleaned, green underline done.
 *
 * NOTHING ABOUT MONEY HERE. The worker's own collections are on "KPI & Thu tiền".
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, BedDouble, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { HOUSEKEEPING_SHIFT_KEY, ROOM_ISSUES_KEY, housekeepingApi, type WorkShift } from '../api/housekeeping';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask } from '../api/roomWork';
import { branchesApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel } from '../auth/types';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { RoomBoard, RoomStateLegend } from '../components/RoomBoard';
import { formatDate, formatDateTime, hcmToday } from '../lib/format';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function HousekeepingInspectionPage() {
  const today = hcmToday();
  const navigate = useNavigate();
  const shift = useQuery({ queryKey: HOUSEKEEPING_SHIFT_KEY, queryFn: () => housekeepingApi.shift() });
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'mine', today],
    queryFn: () => roomWorkApi.myTasks(today),
    refetchInterval: 30_000,
  });
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const [ended, setEnded] = useState<WorkShift | null>(null);
  const current = shift.data?.shift?.current ?? null;

  /** Today's rooms, by branch — the branch of the open shift first. */
  const byBranch = useMemo(() => {
    const groups = new Map<number, { branch: RoomTask['branch']; tasks: RoomTask[] }>();
    for (const t of tasks.data?.tasks ?? []) {
      const g = groups.get(t.branchId) ?? { branch: t.branch, tasks: [] };
      g.tasks.push(t);
      groups.set(t.branchId, g);
    }
    return [...groups.values()].sort(
      (a, b) => Number(b.branch.id === current?.branch.id) - Number(a.branch.id === current?.branch.id) || a.branch.branchNumber - b.branch.branchNumber,
    );
  }, [tasks.data, current?.branch.id]);

  return (
    <div>
      <PageHeader
        title="Buồng phòng"
        description="Phòng được giao trong ngày. Chọn một phòng để kiểm phòng và dọn phòng."
        actions={
          <Button variant="secondary" onClick={() => void tasks.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${tasks.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />
      <QueryState isLoading={shift.isLoading} isError={shift.isError} error={shift.error} onRetry={() => void shift.refetch()}>
        {current && shift.data?.shift ? (
          <ShiftStrip shift={shift.data.shift} onEnded={setEnded} />
        ) : (
          <StartShift suggested={byBranch[0]?.branch.id} />
        )}
      </QueryState>

      <section className="mt-5 space-y-4" aria-labelledby="room-board-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="room-board-title" className="text-lg font-bold text-slate-900">
            Tình trạng phòng ngày {formatDate(today)}
          </h2>
          <RoomStateLegend />
        </div>
        <QueryState isLoading={tasks.isLoading} isError={tasks.isError} error={tasks.error} onRetry={() => void tasks.refetch()}>
          {byBranch.length === 0 ? (
            <EmptyState
              icon={<BedDouble className="h-6 w-6" aria-hidden="true" />}
              title="Chưa có phòng được giao"
              message="Quản lý buồng phòng sẽ giao phòng cho bạn trong ngày."
            />
          ) : (
            byBranch.map((g) => {
              const here = g.branch.id === current?.branch.id;
              return (
                <section
                  key={g.branch.id}
                  data-testid={`work-branch-${g.branch.id}`}
                  className={`rounded-2xl border p-4 ${here ? 'border-brand-200 bg-white' : 'border-line bg-slate-50'}`}
                >
                  <h3 className="mb-3 flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
                    {branchLabel(g.branch)}
                    <span className="text-sm font-normal text-slate-600">
                      · {g.tasks.filter((t) => t.state === 'COMPLETED').length}/{g.tasks.length} phòng xong
                    </span>
                    {!here ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        {current ? 'Khác chi nhánh đang làm — Đổi chi nhánh để làm' : 'Vào ca tại chi nhánh này để làm'}
                      </span>
                    ) : null}
                  </h3>
                  <RoomBoard
                    tasks={g.tasks}
                    codes={catalog.data?.statusCodes ?? []}
                    onSelect={(t) => navigate(`/app/inspections/room/${t.id}`)}
                    testId={`work-board-${g.branch.id}`}
                  />
                </section>
              );
            })
          )}
        </QueryState>
      </section>
      {ended ? <ShiftSummaryModal shift={ended} onClose={() => setEnded(null)} /> : null}
    </div>
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

/** The branch list for "Vào ca" / "Đổi chi nhánh" — every active branch. */
function BranchSelect({ value, onChange, exclude }: { value: number | ''; onChange: (v: number | '') => void; exclude?: number }) {
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });
  return (
    <label className="block text-sm font-medium text-slate-700">
      Chi nhánh
      <select
        className={FIELD}
        value={value}
        aria-label="Chi nhánh"
        data-testid="shift-branch"
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      >
        <option value="">— Chọn chi nhánh —</option>
        {(branches.data?.branches ?? [])
          .filter((b) => b.id !== exclude)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {branchLabel(b)}
            </option>
          ))}
      </select>
    </label>
  );
}

/** "VÀO CA" — where today's work is. The person is the account: no name to type. */
function StartShift({ suggested }: { suggested?: number }) {
  const changed = useShiftChanged();
  const [picked, setPicked] = useState<number | '' | null>(null);
  // The branch of today's assigned rooms, until the worker picks another.
  const branchId = picked ?? suggested ?? '';
  const start = useMutation({
    mutationFn: () => housekeepingApi.startShift({ branchId: Number(branchId) }),
    onSuccess: changed,
  });
  return (
    <form
      data-testid="shift-start"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
      className="max-w-md space-y-4 rounded-2xl border-section border-line bg-white p-4 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-900">Vào ca</h2>
      {suggested ? <p className="text-sm text-slate-600">Đã chọn sẵn chi nhánh của các phòng được giao hôm nay.</p> : null}
      <BranchSelect value={branchId} onChange={setPicked} />
      {start.isError ? <ErrorAlert>{toUserMessage(start.error)}</ErrorAlert> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={branchId === ''} loading={start.isPending} data-testid="shift-start-submit">
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Vào ca
        </Button>
      </div>
    </form>
  );
}

/** "CA HIỆN TẠI · CHI NHÁNH: …" — always in view, with the two shift actions. */
function ShiftStrip({ shift, onEnded }: { shift: WorkShift; onEnded: (shift: WorkShift) => void }) {
  const changed = useShiftChanged();
  const current = shift.current!;
  const [switching, setSwitching] = useState(false);
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
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setSwitching(true)} data-testid="shift-switch">
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            Đổi chi nhánh
          </Button>
          <Button variant="secondary" onClick={() => setConfirmEnd(true)} data-testid="shift-end">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Kết thúc ca
          </Button>
        </div>
      </section>
      {switching ? <SwitchBranchModal shift={shift} onClose={() => setSwitching(false)} /> : null}
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

/** "ĐỔI CHI NHÁNH" — a new segment elsewhere. */
function SwitchBranchModal({ shift, onClose }: { shift: WorkShift; onClose: () => void }) {
  const changed = useShiftChanged();
  const [branchId, setBranchId] = useState<number | ''>('');
  const move = useMutation({
    mutationFn: () => housekeepingApi.switchBranch({ branchId: Number(branchId) }),
    onSuccess: async () => {
      await changed();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Đổi chi nhánh"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => move.mutate()} disabled={branchId === ''} loading={move.isPending} data-testid="shift-switch-confirm">
            Đổi chi nhánh
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <BranchSelect value={branchId} onChange={setBranchId} exclude={shift.current?.branch.id} />
        {move.isError ? <ErrorAlert>{toUserMessage(move.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
