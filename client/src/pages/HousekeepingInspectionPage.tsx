/**
 * "BUỒNG PHÒNG" — the worker's home.
 *
 *   Vào ca → the hotel's ADDRESS, typed; only the one hotel it identifies is
 *   shown (no list, nothing prefilled) → the shift opens there. Bộ phận buồng
 *   phòng has no permanent branch: the shift's hotel scopes all its work.
 *   [Ca hiện tại · Chi nhánh: …]                          Kết thúc ca
 *   Công việc ngày dd/mm/yyyy — the day's WORK GROUPS, numbered:
 *     Công việc 1 — Người thực hiện: Chưa giao       [Nhận công việc]
 *       Tầng 1 · Phòng 101 · OUT
 *     Công việc 2 — Người thực hiện: Bạn
 *       Tầng 1 · Phòng 102 · OC          [Kiểm tra] [Không cần dọn]
 *   Công việc đã làm ngày dd/mm/yyyy — rooms finished, "Không cần dọn" answered.
 *
 * NOTHING BEFORE "VÀO CA" but the history. A group is accepted WHOLE, always
 * confirmed; a colleague's group shows who works it. Each room then goes Kiểm
 * tra (saved) → Dọn phòng, in that order; "Không cần dọn" waits for the
 * manager. The server enforces every step.
 *
 * NOTHING ABOUT MONEY HERE. The worker's own collections are on "KPI & Thu tiền".
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, BedDouble, Hand, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { HOUSEKEEPING_SHIFT_KEY, ROOM_ISSUES_KEY, housekeepingApi, type WorkShift } from '../api/housekeeping';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask, type WorkGroup } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { branchLabel } from '../auth/types';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { PhaseBadge } from '../components/HkWorkOrders';
import { WorkGroupCard } from '../components/HkWorkGroups';
import { AcceptGroupDialog, OwnAction } from '../components/HkWorkerActions';
import { useWorkStep } from '../api/useWorkStep';
import { placeText } from '../lib/workPlaces';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { formatDate, formatDateTime, hcmToday } from '../lib/format';

export function HousekeepingInspectionPage() {
  const today = hcmToday();
  const me = useAuth().user;
  const shift = useQuery({ queryKey: HOUSEKEEPING_SHIFT_KEY, queryFn: () => housekeepingApi.shift() });
  const [ended, setEnded] = useState<WorkShift | null>(null);
  const current = shift.data?.shift?.current ?? null;
  const groups = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'worker-groups', today],
    queryFn: () => roomWorkApi.workerGroups(today),
    refetchInterval: 30_000,
    enabled: current !== null,
  });
  // Rooms set up before work groups existed: still worked one by one.
  const items = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'items', today],
    queryFn: () => roomWorkApi.workItems(today),
    refetchInterval: 30_000,
    enabled: current !== null,
  });
  const olderItems = items.data?.tasks ?? [];
  const refresh = () => {
    void groups.refetch();
    void items.refetch();
  };

  return (
    <div>
      <PageHeader
        title="Buồng phòng"
        description="Vào ca, nhận công việc, kiểm tra rồi dọn phòng."
        actions={
          current ? (
            <Button variant="secondary" onClick={refresh} aria-label="Làm mới">
              <RefreshCw className={`h-4 w-4 ${groups.isFetching || items.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Làm mới
            </Button>
          ) : null
        }
      />
      <QueryState isLoading={shift.isLoading} isError={shift.isError} error={shift.error} onRetry={() => void shift.refetch()}>
        {current && shift.data?.shift ? <ShiftStrip shift={shift.data.shift} onEnded={setEnded} /> : <StartShift />}
      </QueryState>

      {current ? (
        <section className="mt-5 space-y-3" aria-labelledby="work-groups-title">
          <h2 id="work-groups-title" className="text-lg font-bold text-slate-900">
            Công việc ngày {formatDate(today)}
          </h2>
          <QueryState isLoading={groups.isLoading} isError={groups.isError} error={groups.error} onRetry={() => void groups.refetch()}>
            <WorkGroupList groups={groups.data?.groups ?? []} meId={me?.id} onChanged={refresh} hasOlder={olderItems.length > 0} />
          </QueryState>
          {olderItems.length > 0 ? (
            <div className="space-y-2" data-testid="older-items">
              <h3 className="text-sm font-semibold text-slate-700">Phòng giao trước khi có nhóm công việc</h3>
              <WorkItemList tasks={olderItems} meId={me?.id} onChanged={refresh} />
            </div>
          ) : null}
        </section>
      ) : null}
      <WorkHistory meId={me?.id} />
      {ended ? <ShiftSummaryModal shift={ended} onClose={() => setEnded(null)} /> : null}
    </div>
  );
}

/**
 * THE DAY'S WORK GROUPS at the shift's hotel — every one, and who holds it. A
 * free group is accepted WHOLE ("Nhận công việc", always confirmed); a
 * colleague's shows who works it and cannot be taken. On one's own group, each
 * room carries its next step and "Không cần dọn".
 */
function WorkGroupList({ groups, meId, onChanged, hasOlder }: { groups: WorkGroup[]; meId?: number; onChanged: () => void; hasOlder: boolean }) {
  const [accepting, setAccepting] = useState<WorkGroup | null>(null);
  const [noClean, setNoClean] = useState<RoomTask | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const step = useWorkStep(onChanged);

  if (groups.length === 0) {
    return hasOlder ? null : (
      <EmptyState
        icon={<BedDouble className="h-6 w-6" aria-hidden="true" />}
        title="Chưa có công việc"
        message="Quản lý buồng phòng sẽ tạo công việc trong ngày. Bấm “Làm mới” để xem công việc mới."
      />
    );
  }
  return (
    <div className="space-y-3" data-testid="worker-groups">
      {message ? (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status" data-testid="accept-done">
          {message}
        </p>
      ) : null}
      {step.isError ? <ErrorAlert>{toUserMessage(step.error)}</ErrorAlert> : null}
      {groups.map((g) => {
        const mine = g.assignee?.id === meId;
        return (
          <WorkGroupCard
            key={g.id}
            group={g}
            headerAction={
              !g.assignee ? (
                <Button onClick={() => setAccepting(g)} data-testid={`group-accept-${g.number}`}>
                  <Hand className="h-4 w-4" aria-hidden="true" />
                  Nhận công việc
                </Button>
              ) : mine ? (
                <span className="rounded-full bg-brand-100 px-3 py-1 text-sm font-semibold text-brand-800" data-testid={`group-mine-${g.number}`}>
                  Công việc của bạn
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700" data-testid={`group-taken-${g.number}`}>
                  {g.assignee.name} đang làm
                </span>
              )
            }
            itemAction={(t) =>
              t.assignee?.id === meId ? (
                <OwnGroupItemActions
                  task={t}
                  busy={step.isPending && step.variables?.id === t.id}
                  onStep={() => step.mutate(t)}
                  onNoClean={() => setNoClean(t)}
                />
              ) : null
            }
          />
        );
      })}
      {accepting ? (
        <AcceptGroupDialog
          group={accepting}
          onClose={() => setAccepting(null)}
          onAccepted={(g) => {
            setAccepting(null);
            setMessage(`Đã nhận ${g.title}. Bấm “Kiểm tra” ở từng phòng để bắt đầu.`);
          }}
          onRefresh={onChanged}
        />
      ) : null}
      {noClean ? (
        <NoCleanDialog
          task={noClean}
          onClose={() => setNoClean(null)}
          onSent={() => {
            setNoClean(null);
            setMessage('Đã gửi yêu cầu “Không cần dọn”. Chờ quản lý duyệt.');
          }}
        />
      ) : null}
    </div>
  );
}

/** One's own room in a group: its next step, and "Không cần dọn" while that can still be asked. */
function OwnGroupItemActions({ task: t, busy, onStep, onNoClean }: { task: RoomTask; busy: boolean; onStep: () => void; onNoClean: () => void }) {
  if (t.voided || t.phase === 'COMPLETED') return null;
  if (t.phase === 'NO_CLEAN_PENDING') {
    return <span className="text-xs font-medium text-amber-800">Chờ quản lý duyệt</span>;
  }
  const canAskNoClean = t.state === 'NOT_STARTED' || t.state === 'INSPECTED';
  return (
    <>
      <OwnAction task={t} busy={busy} onStep={onStep} />
      {canAskNoClean ? (
        <Button variant="secondary" onClick={onNoClean} data-testid={`no-clean-open-${t.id}`}>
          <Ban className="h-4 w-4" aria-hidden="true" />
          Không cần dọn
        </Button>
      ) : null}
    </>
  );
}

/** "KHÔNG CẦN DỌN" — the reason is required; the manager decides. */
function NoCleanDialog({ task: t, onClose, onSent }: { task: RoomTask; onClose: () => void; onSent: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => roomWorkApi.requestNoClean(t.id, reason.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onSent();
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
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!reason.trim()} data-testid="no-clean-send">
            Gửi quản lý duyệt
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="no-clean-dialog">
        <p className="text-sm text-slate-700">
          <span className="font-semibold">{placeText(t)}</span> — phòng chỉ được bỏ khỏi công việc sau khi quản lý buồng phòng duyệt.
        </p>
        <label className="block text-sm font-medium text-slate-700" htmlFor="no-clean-reason">
          Lý do *
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

/**
 * "CÔNG VIỆC ĐÃ LÀM" — this housekeeper's own finished rooms and answered
 * "Không cần dọn" of a day, with the times, and that day's shifts.
 */
function WorkHistory({ meId }: { meId?: number }) {
  const today = hcmToday();
  const [date, setDate] = useState(today);
  const history = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'worker-history', date, meId ?? null],
    queryFn: () => roomWorkApi.workerHistory(date),
    enabled: meId !== undefined,
  });
  const data = history.data;
  return (
    <section className="mt-6 space-y-3" aria-labelledby="work-history-title" data-testid="work-history">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="work-history-title" className="text-lg font-bold text-slate-900">
          Công việc đã làm ngày {formatDate(date)}
        </h2>
        <label className="text-sm font-medium text-slate-700">
          Ngày
          <input
            type="date"
            className="ml-2 min-h-[2.5rem] rounded-xl border border-line-strong bg-white px-3 py-1.5 text-sm"
            value={date}
            max={today}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            data-testid="work-history-date"
          />
        </label>
      </div>
      <QueryState isLoading={history.isLoading} isError={history.isError} error={history.error} onRetry={() => void history.refetch()}>
        {data ? (
          <>
            <p className="text-sm text-slate-700" data-testid="work-history-totals">
              Đã dọn xong: <span className="font-semibold">{data.totals.completed}</span> · Không cần dọn (đã duyệt):{' '}
              <span className="font-semibold">{data.totals.noClean}</span>
            </p>
            {data.shifts.length > 0 ? (
              <ul className="space-y-1 text-xs text-slate-600" data-testid="work-history-shifts">
                {data.shifts.map((s) => (
                  <li key={s.id}>
                    Ca: {formatDateTime(s.startedAt)} – {s.endedAt ? formatDateTime(s.endedAt) : 'đang làm'} ·{' '}
                    {s.segments.map((seg) => branchLabel(seg.branch)).join(', ')}
                  </li>
                ))}
              </ul>
            ) : null}
            {data.items.length === 0 ? (
              <p className="text-sm text-slate-500">Chưa có phòng nào hoàn thành trong ngày này.</p>
            ) : (
              <ul className="divide-y divide-line-subtle rounded-2xl border border-line bg-white" data-testid="work-history-items">
                {data.items.map((t) => (
                  <li key={t.id} className="px-4 py-2.5 text-sm" data-testid={`history-item-${t.id}`}>
                    <p className="font-semibold text-slate-900">
                      {t.workGroup ? `Công việc ${t.workGroup.number} · ` : ''}
                      {placeText(t)} <PhaseBadge task={t} />
                    </p>
                    <p className="text-xs text-slate-600">
                      {t.state === 'COMPLETED' && t.cleanedBy?.id === meId
                        ? `Bắt đầu ${t.startedAt ? formatDateTime(t.startedAt) : '—'} · Hoàn thành ${t.completedAt ? formatDateTime(t.completedAt) : '—'}${
                            t.durationSeconds !== null ? ` · ${Math.round(t.durationSeconds / 60)} phút` : ''
                          }${t.review ? ` · ${t.review.label}` : ''}`
                        : t.noClean
                          ? `Không cần dọn — ${t.noClean.status === 'APPROVED' ? 'đã duyệt' : 'bị từ chối'}${t.noClean.decidedByName ? ` bởi ${t.noClean.decidedByName}` : ''} · Lý do: ${t.noClean.reason}`
                          : t.stateLabel}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </QueryState>
    </section>
  );
}

const itemName = (t: RoomTask) => `${t.areaLabel ?? `Phòng - ${t.roomNumber}`} · ${t.taskLabel ?? t.statusCode}`;

/**
 * ONE ROW PER ITEM. Unclaimed items carry a checkbox and "Nhận"; the
 * housekeeper's own carry the next step of their work.
 */
function WorkItemList({ tasks, meId, onChanged }: { tasks: RoomTask[]; meId?: number; onChanged: () => void }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<RoomTask[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const claimable = tasks.filter((t) => !t.assignee && t.phase === 'UNCLAIMED');
  // Only items still on screen and still free stay selected.
  const picked = claimable.filter((t) => selected.has(t.id));
  const mine = useMemo(() => tasks.filter((t) => t.assignee?.id === meId), [tasks, meId]);

  const step = useWorkStep(onChanged);

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
 * no suggestion and nothing prefilled: as the housekeeper types, the server is
 * asked what the text identifies, and ONLY the one hotel it fits uniquely is
 * shown ("17" → "170-172-174 Nguyễn Thái Bình"); too little or several fits is
 * one generic "nhập thêm". "Vào ca" sends the typed address again and the
 * server resolves it itself — nothing here picks the branch.
 */
function StartShift() {
  const changed = useShiftChanged();
  const [address, setAddress] = useState('');
  const [lookup, setLookup] = useState<{ input: string; result: Awaited<ReturnType<typeof housekeepingApi.lookupWorkplace>> } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const typed = address.trim();
  useEffect(() => {
    setLookupError(null);
    if (!typed) {
      setLookup(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      housekeepingApi
        .lookupWorkplace(typed)
        .then((result) => {
          if (!stale) setLookup({ input: typed, result });
        })
        .catch((error: unknown) => {
          if (!stale) setLookupError(toUserMessage(error));
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [typed]);
  const current = lookup && lookup.input === typed ? lookup.result : null;
  const start = useMutation({
    mutationFn: () => housekeepingApi.startShift(typed),
    onSuccess: changed,
  });
  return (
    <form
      data-testid="shift-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (current?.status === 'RESOLVED') start.mutate();
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
          placeholder="Nhập số nhà, ví dụ 170"
          aria-describedby="shift-lookup-status"
          data-testid="shift-address"
        />
      </label>
      <div id="shift-lookup-status" aria-live="polite">
        {current?.status === 'RESOLVED' ? (
          <p className="rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900" data-testid="shift-lookup-match">
            Khách sạn: <span className="font-semibold">Chi nhánh {current.branch.branchNumber} — {current.branch.address}</span>
          </p>
        ) : current ? (
          <p className="text-sm text-slate-600" data-testid="shift-lookup-hint">
            {current.message}
          </p>
        ) : (
          <p className="text-xs text-slate-500">Nhập số nhà / tên đường của khách sạn bạn đang làm việc để vào ca.</p>
        )}
      </div>
      {lookupError ? <ErrorAlert>{lookupError}</ErrorAlert> : null}
      {start.isError ? <ErrorAlert>{toUserMessage(start.error)}</ErrorAlert> : null}
      <div className="flex justify-end">
        <Button type="submit" loading={start.isPending} disabled={current?.status !== 'RESOLVED'} data-testid="shift-start-submit">
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
