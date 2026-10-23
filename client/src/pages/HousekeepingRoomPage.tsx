/**
 * "PHÒNG 101" — one room's work, for the worker it was given to.
 *
 *   [ Kiểm phòng ]  [ Dọn phòng ]
 *   code · priority · manager's note · state · started · elapsed · finished
 *
 * INSPECTION AND CLEANING ARE SEPARATE. "Lưu kiểm tra" saves the inspection and
 * the room becomes "Đã kiểm tra" — nothing starts. "Bắt đầu dọn" is the one
 * action that starts the cleaning time (the manager may first give the room to
 * another housekeeper). Opening this page records only that it was opened.
 * "Hoàn thành dọn phòng" shows everything entered for a last check before it is
 * sent. The person is the account: no name is asked anywhere.
 *
 * A SHARED AREA ("Hành lang - Tầng 5") has no "Dọn phòng": its one step is
 * "Kiểm tra tình trạng" — what the housekeeper noted — and saving it completes
 * the item. ("Dọn phòng" shows only on an area already being cleaned from before.)
 *
 * "DỌN PHÒNG" counts the items of the branch's room-cleaning list — name, −, the
 * count, + — never above what is on hand; the stock moves only at "Hoàn thành".
 * "+ Báo cáo vấn đề" sits beside the special flags and the note (and on an
 * area's check): it reports, and changes nothing about the room or the stock.
 *
 * "KHÔNG CẦN DỌN" is asked HERE, beside the room's name (top right): the reason
 * is required, the Quản lý buồng phòng decides, and while it waits the room says
 * "Chờ Quản lý xác nhận" — nothing is inspected or cleaned meanwhile.
 *
 * The hotel is named by its address only — never a branch number.
 *
 * Phone first: every control is a large tap target, the sections stack, numbers
 * use the numeric keyboard, and the main action sits at the bottom of the screen.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Check, ClipboardCheck, Hourglass, Megaphone, Minus, Pencil, Play, Plus, Save, Sparkles, UserRoundPlus } from 'lucide-react';
import { HOUSEKEEPING_SHIFT_KEY, ROOM_ISSUE_TYPES, type RoomIssueType } from '../api/housekeeping';
import { ROOM_WORK_KEY, formatMinutes, roomWorkApi, type CleaningForm, type CleaningInput, type CleaningItem, type RoomTask, type RoomWorkCatalog } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { NoCleanRequestDialog, ReleaseRoomDialog } from '../components/HkWorkerActions';
import { QuickReportDialog } from '../components/HkQuickReport';
import { Modal } from '../components/Modal';
import { ErrorAlert } from '../components/ErrorAlert';
import { QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime } from '../lib/format';

export function HousekeepingRoomPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const key = [...ROOM_WORK_KEY, 'task', id];
  const task = useQuery({ queryKey: key, queryFn: () => roomWorkApi.task(id) });
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const [tab, setTab] = useState<'inspect' | 'clean' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askingNoClean, setAskingNoClean] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const navigate = useNavigate();

  // "Mở phòng" is recorded once (the server ignores a repeat); it starts nothing.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !task.data || task.data.task.state !== 'NOT_STARTED') return;
    opened.current = true;
    void roomWorkApi.open(id).catch(() => undefined);
  }, [id, task.data]);

  const refresh = (next: RoomTask) => {
    queryClient.setQueryData(key, { task: next });
    void queryClient.invalidateQueries({ queryKey: [...ROOM_WORK_KEY, 'mine'] });
  };

  const t = task.data?.task;
  const me = useAuth().user;
  // A Quản lý buồng phòng doing a room it accepted comes back to its board.
  const manager = me?.role === 'HOUSEKEEPING_MANAGER';
  // A shared area is checked, not cleaned — "Dọn phòng" only for one already being cleaned from before.
  const isArea = !!t?.areaKind && t.areaKind !== 'ROOM';
  const showClean = !isArea || t?.state === 'IN_PROGRESS';
  const active = showClean ? (tab ?? (t && t.state !== 'NOT_STARTED' ? 'clean' : 'inspect')) : 'inspect';
  // "Không cần dọn": the housekeeper's own room, not yet being cleaned, nothing pending
  // (the server holds the same rule). The manager decides such requests — it never asks.
  const waitingNoClean = t?.noClean?.status === 'PENDING' && !t.voided;
  const canAskNoClean =
    !!t && me?.role === 'HOUSEKEEPING' && t.assignee?.id === me.id && !t.voided && (t.state === 'NOT_STARTED' || t.state === 'INSPECTED') && !waitingNoClean;

  return (
    <div className="mx-auto max-w-3xl pb-24">
      <Link to={manager ? '/app/hk/daily?tab=clean' : '/app/inspections'} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {manager ? 'Dọn phòng' : 'Danh sách công việc'}
      </Link>
      <QueryState isLoading={task.isLoading || catalog.isLoading} isError={task.isError} error={task.error} onRetry={() => void task.refetch()}>
        {t && catalog.data ? (
          <>
            <RoomHeader
              task={t}
              action={
                canAskNoClean ? (
                  <Button variant="secondary" onClick={() => setAskingNoClean(true)} className="!border-amber-400 !text-amber-900 hover:!bg-amber-50" data-testid="room-no-clean-open">
                    <Ban className="h-4 w-4" aria-hidden="true" />
                    Không cần dọn
                  </Button>
                ) : waitingNoClean ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900" data-testid="room-no-clean-waiting">
                    <Hourglass className="h-4 w-4" aria-hidden="true" />
                    Chờ Quản lý xác nhận
                  </span>
                ) : null
              }
            />
            <div role="tablist" aria-label="Công việc phòng" className={`my-4 grid gap-2 ${showClean ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {(
                [
                  ['inspect', isArea ? 'Kiểm tra tình trạng' : 'Kiểm phòng', ClipboardCheck, false],
                  ...(showClean ? ([['clean', 'Dọn phòng', Sparkles, t.state === 'NOT_STARTED']] as const) : []),
                ] as const
              ).map(([value, label, Icon, locked]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={active === value}
                  disabled={locked}
                  data-testid={`room-tab-${value}`}
                  onClick={() => setTab(value)}
                  className={`flex min-h-[3.25rem] items-center justify-center gap-2 rounded-xl border-2 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    active === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            {t.state === 'NOT_STARTED' && active === 'inspect' && !waitingNoClean && !isArea ? (
              <p className="mb-3 text-sm text-slate-600">“Dọn phòng” mở sau khi lưu kiểm tra; thời gian dọn chỉ bắt đầu khi bấm “Bắt đầu dọn”.</p>
            ) : null}
            {waitingNoClean ? (
              <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-base text-amber-950" data-testid="room-no-clean-pending">
                Đã gửi yêu cầu “Không cần dọn” — lý do: <span className="font-semibold">{t.noClean?.reason}</span>. Chờ Quản lý buồng phòng xác nhận;
                trong lúc chờ, chưa kiểm tra hay dọn phòng này.
              </p>
            ) : active === 'inspect' && isArea ? (
              <AreaInspectPanel
                task={t}
                onReport={() => setReporting(true)}
                onSaved={(next) => {
                  refresh(next);
                  setToast('Đã kiểm tra xong khu vực.');
                }}
              />
            ) : active === 'inspect' ? (
              <InspectPanel
                task={t}
                onSaved={(next) => {
                  refresh(next);
                  setTab('clean');
                  setToast('Đã lưu kiểm tra. Bấm “Bắt đầu dọn” khi bắt đầu dọn phòng.');
                }}
              />
            ) : t.state === 'INSPECTED' ? (
              <StartPanel
                task={t}
                onStarted={(next) => {
                  refresh(next);
                  setToast('Đã bắt đầu dọn phòng.');
                }}
                // A housekeeper may leave the cleaning to a colleague; the manager gives rooms out on its board instead.
                onRelease={me?.role === 'HOUSEKEEPING' && !waitingNoClean ? () => setReleasing(true) : undefined}
              />
            ) : (
              <CleanPanel
                task={t}
                catalog={catalog.data}
                onReport={() => setReporting(true)}
                onSaved={(next, done) => {
                  refresh(next);
                  const ended = done && (next as RoomTask & { shiftEnded?: boolean }).shiftEnded === true;
                  // The server ended the shift (nothing left to do or take): the screens follow it.
                  if (ended) void queryClient.invalidateQueries({ queryKey: HOUSEKEEPING_SHIFT_KEY });
                  setToast(ended ? 'Đã hoàn thành dọn phòng. Bạn đã hết việc — ca làm việc được tự động kết thúc.' : done ? 'Đã hoàn thành dọn phòng.' : 'Đã lưu tạm.');
                }}
              />
            )}
          </>
        ) : null}
      </QueryState>
      {askingNoClean && t ? (
        <NoCleanRequestDialog
          task={t}
          onClose={() => setAskingNoClean(false)}
          onSent={(next) => {
            setAskingNoClean(false);
            refresh(next);
            setToast('Đã gửi yêu cầu “Không cần dọn”. Chờ Quản lý xác nhận.');
          }}
        />
      ) : null}
      {reporting && t ? (
        <QuickReportDialog
          task={t}
          onClose={() => setReporting(false)}
          onDone={(message) => {
            setReporting(false);
            setToast(message);
          }}
        />
      ) : null}
      {releasing && t ? (
        <ReleaseRoomDialog
          task={t}
          onClose={() => setReleasing(false)}
          // The room is no longer this housekeeper's: back to the list, where a colleague takes it.
          onReleased={() => navigate('/app/inspections')}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/** Ticks once a minute while the room is being cleaned. */
function useElapsed(task: RoomTask): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (task.state !== 'IN_PROGRESS') return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [task.state]);
  if (task.state === 'COMPLETED') return task.durationSeconds;
  if (task.state !== 'IN_PROGRESS' || !task.startedAt) return null;
  return Math.max(0, Math.round((now - Date.parse(task.startedAt)) / 1000));
}

function RoomHeader({ task, action }: { task: RoomTask; action?: React.ReactNode }) {
  const elapsed = useElapsed(task);
  const stateTone =
    task.state === 'COMPLETED'
      ? 'bg-green-100 text-green-800'
      : task.state === 'IN_PROGRESS'
        ? 'bg-blue-100 text-blue-800'
        : task.state === 'INSPECTED'
          ? 'bg-amber-100 text-amber-900'
          : 'bg-slate-100 text-slate-700';
  const fact = (label: string, value: string, testId?: string) => (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="text-base text-slate-900" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
  return (
    <section className="rounded-2xl border border-line-strong bg-white p-4 shadow-sm" data-testid="room-header">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900">
            {task.areaKind && task.areaKind !== 'ROOM' ? task.areaLabel : `PHÒNG ${task.roomNumber}`}
          </h1>
          <span className="rounded-lg bg-slate-800 px-2 py-0.5 text-sm font-bold text-white">{task.taskLabel ?? task.statusCode}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${stateTone}`} data-testid="room-state">
            {task.stateLabel}
          </span>
          {task.priority ? <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-sm font-semibold text-white">Ưu tiên</span> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <p className="mt-1 text-sm text-slate-600" data-testid="room-hotel">
        {task.workGroup ? `Công việc ${task.workGroup.number} · ` : ''}
        {task.branch.address}
      </p>
      {task.noClean?.status === 'REJECTED' ? (
        <p className="mt-3 rounded-xl border border-line-strong bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="room-no-clean-rejected">
          Quản lý không duyệt “Không cần dọn”{task.noClean.decisionNote ? ` — ${task.noClean.decisionNote}` : ''}. Tiếp tục kiểm tra và dọn phòng.
        </p>
      ) : null}
      {task.reclean && task.state !== 'COMPLETED' ? (
        <p className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900" data-testid="room-reclean">
          <span className="font-bold">CẦN DỌN LẠI</span>
          <span className="block">Lý do: {task.reclean.reason ?? '—'}</span>
        </p>
      ) : null}
      {task.note ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-base text-amber-900" data-testid="room-note">
          <span className="font-semibold">Ghi chú: </span>
          {task.note}
        </p>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {fact('Người được giao', task.assignee?.name ?? '—')}
        {fact('Bắt đầu', task.startedAt ? formatDateTime(task.startedAt) : '—', 'room-started')}
        {fact(task.state === 'COMPLETED' ? 'Thời gian dọn' : 'Đã làm', formatMinutes(elapsed), 'room-elapsed')}
        {fact('Hoàn thành', task.completedAt ? formatDateTime(task.completedAt) : '—', 'room-completed')}
      </dl>
    </section>
  );
}

/* -------------------------------- Bắt đầu dọn -------------------------------- */

/**
 * "Đã kiểm tra" — nothing is running. The cleaning starts only when the
 * housekeeper presses "Bắt đầu dọn"; a second press is refused by the server.
 */
function StartPanel({ task, onStarted, onRelease }: { task: RoomTask; onStarted: (task: RoomTask) => void; onRelease?: () => void }) {
  const start = useMutation({
    mutationFn: () => roomWorkApi.start(task.id),
    onSuccess: ({ task: next }) => onStarted(next),
  });
  return (
    <section className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4" data-testid="cleaning-start-panel">
      <p className="text-base text-amber-900">
        Phòng đã được kiểm tra
        {task.inspection ? ` lúc ${formatDateTime(task.inspection.createdAt)} bởi ${task.inspection.inspectorName}` : ''}. Thời gian dọn
        chưa bắt đầu.
      </p>
      {start.isError ? <ErrorAlert>{toUserMessage(start.error)}</ErrorAlert> : null}
      <Button className="min-h-[3rem] w-full text-base" onClick={() => start.mutate()} loading={start.isPending} disabled={start.isPending} data-testid="cleaning-start">
        <Play className="h-5 w-5" aria-hidden="true" />
        Bắt đầu dọn
      </Button>
      {onRelease ? (
        <Button variant="secondary" className="min-h-[3rem] w-full text-base" onClick={onRelease} disabled={start.isPending} data-testid="cleaning-release">
          <UserRoundPlus className="h-5 w-5" aria-hidden="true" />
          Chưa dọn — chuyển người khác dọn
        </Button>
      ) : null}
    </section>
  );
}

/* --------------------------------- Kiểm phòng -------------------------------- */

/** "+ Báo cáo vấn đề" — beside the flags and the note; it reports and changes nothing else. */
function ReportButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="secondary" className="min-h-[3rem] w-full text-base" onClick={onClick} data-testid="room-report-open">
      <Megaphone className="h-5 w-5" aria-hidden="true" />+ Báo cáo vấn đề
    </Button>
  );
}

/**
 * "KIỂM TRA TÌNH TRẠNG" OF A SHARED AREA — what the housekeeper saw, in words
 * (optional), then "Hoàn thành kiểm tra": the item is done. No cleaning step.
 */
function AreaInspectPanel({ task, onSaved, onReport }: { task: RoomTask; onSaved: (task: RoomTask) => void; onReport: () => void }) {
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => roomWorkApi.inspect(task.id, [], note.trim() || undefined),
    onSuccess: ({ task: next }) => onSaved(next),
  });
  // An area "Chờ dọn phòng" from before completes the same way.
  if (task.state !== 'NOT_STARTED' && task.state !== 'INSPECTED') {
    return (
      <div className="space-y-3">
        <section className="rounded-2xl border border-line bg-white p-4" data-testid="inspection-saved">
          <h2 className="text-base font-semibold text-slate-900">
            Đã kiểm tra{task.inspectedAt ? ` lúc ${formatDateTime(task.inspectedAt)}` : ''}
          </h2>
          <p className="mt-2 text-base text-slate-700">{task.inspectionNote ?? 'Không ghi nhận gì thêm.'}</p>
        </section>
        {task.voided ? null : <ReportButton onClick={onReport} />}
      </div>
    );
  }
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-4" data-testid="area-inspect">
      <label className="block text-sm font-medium text-slate-700" htmlFor="area-inspection-note">
        Ghi nhận khi kiểm tra (không bắt buộc)
        <textarea
          id="area-inspection-note"
          className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-slate-900"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ví dụ: Thảm hành lang bẩn, có rác ở chân cầu thang"
          data-testid="area-inspection-note"
        />
      </label>
      <ReportButton onClick={onReport} />
      {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      <Button className="min-h-[3rem] w-full text-base" onClick={() => save.mutate()} loading={save.isPending} disabled={save.isPending} data-testid="area-inspect-save">
        <Check className="h-5 w-5" aria-hidden="true" />
        Hoàn thành kiểm tra
      </Button>
    </section>
  );
}

function InspectPanel({ task, onSaved }: { task: RoomTask; onSaved: (task: RoomTask) => void }) {
  const [checked, setChecked] = useState<Partial<Record<RoomIssueType, string>>>({});
  const selected = ROOM_ISSUE_TYPES.filter((t) => checked[t.code] !== undefined);
  const otherMissing = checked.OTHER !== undefined && !checked.OTHER.trim();
  const save = useMutation({
    mutationFn: () =>
      roomWorkApi.inspect(
        task.id,
        selected.map((t) => ({ type: t.code, ...(checked[t.code]?.trim() ? { note: checked[t.code]!.trim() } : {}) })),
      ),
    onSuccess: ({ task: next }) => onSaved(next),
  });

  if (task.inspection) {
    return (
      <section className="rounded-2xl border border-line bg-white p-4" data-testid="inspection-saved">
        <h2 className="text-base font-semibold text-slate-900">Đã kiểm phòng lúc {formatDateTime(task.inspection.createdAt)}</h2>
        <p className="text-sm text-slate-600">Bởi {task.inspection.inspectorName}</p>
        {task.inspection.findings.length === 0 ? (
          <p className="mt-2 text-base text-slate-700">Không có vấn đề.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {task.inspection.findings.map((f) => (
              <li key={f.id} className="rounded-lg bg-amber-50 px-3 py-2 text-base text-amber-900">
                {f.typeLabel}
                {f.note ? ` — ${f.note}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!otherMissing) save.mutate();
      }}
      data-testid="inspection-form"
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-base font-semibold text-slate-900">Tình trạng phòng</legend>
        {ROOM_ISSUE_TYPES.map((t) => {
          const on = checked[t.code] !== undefined;
          return (
            <div key={t.code} className={`rounded-xl border-2 px-3 py-2.5 ${on ? 'border-amber-500 bg-amber-50' : 'border-line bg-white'}`}>
              <label className="flex min-h-[2.5rem] cursor-pointer items-center gap-3 text-base font-medium text-slate-900">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setChecked((prev) => {
                      const next = { ...prev };
                      if (e.target.checked) next[t.code] = '';
                      else delete next[t.code];
                      return next;
                    })
                  }
                  data-testid={`inspection-type-${t.code}`}
                  className="h-6 w-6 accent-amber-600"
                />
                {t.label}
              </label>
              {on ? (
                <input
                  value={checked[t.code] ?? ''}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [t.code]: e.target.value }))}
                  maxLength={2000}
                  placeholder={t.code === 'OTHER' ? 'Mô tả vấn đề (bắt buộc)' : 'Mô tả thêm (không bắt buộc)'}
                  aria-label={`Mô tả — ${t.label}`}
                  data-testid={`inspection-note-${t.code}`}
                  className="mt-2 min-h-[2.75rem] w-full rounded-lg border border-line-strong px-3 text-base"
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <p className="mt-3 text-sm text-slate-600">Không chọn mục nào nghĩa là phòng không có vấn đề.</p>
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
      <div className="sticky bottom-0 -mx-4 mt-4 border-t border-line bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button type="submit" className="w-full min-h-[3rem] text-base" loading={save.isPending} disabled={otherMissing} data-testid="inspection-save">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          Lưu kiểm tra
        </Button>
      </div>
    </form>
  );
}

/* --------------------------------- Dọn phòng --------------------------------- */

/** What a saved form recorded, in words: today's items, and an older save's fixed fields. */
function savedLines(cleaning: CleaningForm | null, catalog: RoomWorkCatalog): string[] {
  if (!cleaning) return [];
  const label = (code: string) => [...catalog.linen, ...catalog.quantities, ...catalog.replacements].find((i) => i.code === code)?.label ?? code;
  return [
    ...(cleaning.items ?? []).map((i) => `${i.label}: ${i.quantity}`),
    ...Object.entries(cleaning.linen ?? {}).map(([code, e]) => `${label(code)}: ${e.size} × ${e.quantity ?? 0}`),
    ...Object.entries(cleaning.quantities ?? {})
      .filter(([, n]) => n > 0)
      .map(([code, n]) => `${label(code)}: ${n}`),
    ...(cleaning.replaced ?? []).map((code) => `${label(code)} ✓`),
  ];
}

function CleanPanel({
  task,
  catalog,
  onSaved,
  onReport,
}: {
  task: RoomTask;
  catalog: RoomWorkCatalog;
  onSaved: (task: RoomTask, done: boolean) => void;
  onReport: () => void;
}) {
  const done = task.state === 'COMPLETED';
  // The branch's list, with what is on hand now — loaded while the room is being worked.
  const list = useQuery({ queryKey: [...ROOM_WORK_KEY, 'cleaning-items', task.id], queryFn: () => roomWorkApi.cleaningItems(task.id), enabled: !done });
  const items = list.data?.items ?? [];
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries((task.cleaning?.items ?? []).map((i) => [i.itemId, i.quantity])));
  const [special, setSpecial] = useState<string[]>(task.cleaning?.special ?? []);
  const [note, setNote] = useState(task.cleaning?.note ?? '');
  const [short, setShort] = useState<string | null>(null);
  // Only the items still on the list are sent; a count of 0 is left out.
  const payload: CleaningInput = {
    items: Object.fromEntries(items.filter((i) => (counts[i.id] ?? 0) > 0).map((i) => [i.id, counts[i.id]!])),
    special,
    note: note.trim() || null,
  };
  /** "Hoàn thành dọn phòng" opens the summary first; only its confirmation completes. */
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (complete: boolean) => (complete ? roomWorkApi.complete(task.id, payload) : roomWorkApi.saveCleaning(task.id, payload)),
    onSuccess: ({ task: next }, complete) => {
      if (complete) setConfirming(false);
      onSaved(next, complete);
    },
  });
  // Never below 0, never above what is on hand.
  const setCount = (item: CleaningItem, value: number) => {
    const wanted = Math.max(0, Math.round(value) || 0);
    if (wanted > item.available) setShort(`Không đủ tồn kho: ${item.label} chỉ còn ${item.available} ${item.unit}. Báo quản lý nhập kho.`);
    else setShort(null);
    setCounts((c) => ({ ...c, [item.id]: Math.min(wanted, item.available) }));
  };
  const toggleSpecial = (code: string) => setSpecial((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));

  const section = (title: string, children: React.ReactNode) => (
    <section className="rounded-2xl border border-line bg-white p-4">
      <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );

  if (done) {
    const lines = savedLines(task.cleaning, catalog);
    const flags = catalog.specialStatuses.filter((i) => task.cleaning?.special.includes(i.code)).map((i) => `${i.short} : ${i.label}`);
    return (
      <div className="space-y-4" data-testid="cleaning-form">
        <p className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-base text-green-900" data-testid="cleaning-done">
          Đã hoàn thành lúc {task.completedAt ? formatDateTime(task.completedAt) : '—'} · {formatMinutes(task.durationSeconds)}
          {task.cleanedBy ? ` · ${task.cleanedBy.name}` : ''}
        </p>
        {section('Mặt hàng đã dùng', lines.length ? <ul className="space-y-1 text-base text-slate-800">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-slate-500">Không có</p>)}
        {flags.length ? section('Ghi nhận đặc biệt', <ul className="space-y-1 text-base text-slate-800">{flags.map((l) => <li key={l}>{l}</li>)}</ul>) : null}
        {task.cleaning?.note ? section('Ghi chú', <p className="whitespace-pre-wrap text-base text-slate-800">{task.cleaning.note}</p>) : null}
        <ReportButton onClick={onReport} />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="cleaning-form">
      {section(
        'Mặt hàng sử dụng',
        <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error} onRetry={() => void list.refetch()}>
          {items.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="cleaning-items-empty">
              Chi nhánh chưa chọn mặt hàng dùng khi dọn phòng — báo Quản lý buồng phòng.
            </p>
          ) : (
            <ul className="divide-y divide-line-subtle" data-testid="cleaning-items">
              {items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <label htmlFor={`item-${item.id}`} className="min-w-0 text-base text-slate-800">
                    {item.label}
                    <span className="block text-xs text-slate-500">
                      Còn {item.available} {item.unit}
                    </span>
                  </label>
                  <Stepper id={`item-${item.id}`} label={item.label} value={counts[item.id] ?? 0} max={item.available} disabled={false} onChange={(v) => setCount(item, v)} />
                </li>
              ))}
            </ul>
          )}
          {short ? (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert" data-testid="cleaning-short">
              {short}
            </p>
          ) : null}
        </QueryState>,
      )}
      {section(
        'Ghi nhận đặc biệt',
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.specialStatuses.map((item) => (
            <CheckToggle key={item.code} on={special.includes(item.code)} disabled={false} onClick={() => toggleSpecial(item.code)} testId={`special-${item.code}`}>
              <span>
                <span className="font-bold">{item.short}</span> : {item.label}
              </span>
            </CheckToggle>
          ))}
        </div>,
      )}
      {section(
        'Ghi chú',
        <textarea
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Các lưu ý-Hỏng hóc-Vấn đề khác..."
          data-testid="cleaning-note"
          className="w-full rounded-xl border border-line-strong px-3 py-2 text-base"
        />,
      )}
      <ReportButton onClick={onReport} />
      {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button variant="secondary" className="min-h-[3rem] flex-1 text-base" onClick={() => save.mutate(false)} loading={save.isPending && save.variables === false} disabled={save.isPending || !list.isSuccess} data-testid="cleaning-save">
          <Save className="h-5 w-5" aria-hidden="true" />
          Lưu tạm
        </Button>
        <Button
          className="min-h-[3rem] flex-[2] text-base"
          onClick={() => {
            save.reset();
            setConfirming(true);
          }}
          disabled={save.isPending || !list.isSuccess}
          data-testid="cleaning-complete"
        >
          <Check className="h-5 w-5" aria-hidden="true" />
          Hoàn thành dọn phòng
        </Button>
      </div>
      {confirming ? (
        <Modal
          open
          size="xl"
          title="Xác nhận hoàn thành dọn phòng"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={save.isPending} data-testid="cleaning-confirm-back">
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Quay lại sửa
              </Button>
              <Button onClick={() => save.mutate(true)} loading={save.isPending && save.variables === true} disabled={save.isPending} data-testid="cleaning-confirm-submit">
                <Check className="h-4 w-4" aria-hidden="true" />
                Xác nhận hoàn thành
              </Button>
            </>
          }
        >
          <CleaningSummary task={task} catalog={catalog} items={items} payload={payload} />
          {save.isError ? (
            <div className="mt-3">
              <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * EVERYTHING ENTERED, AS IT WILL BE SENT — read from the payload itself, so the
 * summary can never disagree with what is saved.
 */
function CleaningSummary({ task, catalog, items, payload }: { task: RoomTask; catalog: RoomWorkCatalog; items: CleaningItem[]; payload: CleaningInput }) {
  // The manager's own cleaning is recorded "Đạt" as it completes (the server's rule).
  const selfReviewed = useAuth().user?.role === 'HOUSEKEEPING_MANAGER';
  const used = items.filter((i) => payload.items[i.id]).map((i) => `${i.label}: ${payload.items[i.id]} ${i.unit}`);
  const special = catalog.specialStatuses.filter((item) => payload.special.includes(item.code)).map((item) => `${item.short} : ${item.label}`);
  const row = (title: string, values: string[], testId: string) => (
    <div className="border-b border-line-subtle py-2 last:border-0" data-testid={testId}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</dt>
      <dd className="mt-0.5 text-base text-slate-900">
        {values.length ? (
          <ul className="space-y-0.5">
            {values.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        ) : (
          <span className="text-slate-400">Không có</span>
        )}
      </dd>
    </div>
  );
  return (
    <div data-testid="cleaning-summary">
      <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <span className="font-semibold">Phòng {task.roomNumber}</span> · {task.branch.address}
        {task.assignee ? ` · ${task.assignee.name}` : ''}
        {task.startedAt ? ` · bắt đầu ${formatDateTime(task.startedAt)}` : ''}
      </p>
      <dl>
        {row('Mặt hàng sử dụng', used, 'summary-items')}
        {row('Ghi nhận đặc biệt', special, 'summary-special')}
        {row('Ghi chú', payload.note ? [payload.note] : [], 'summary-note')}
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Kiểm tra lại trước khi xác nhận. Số mặt hàng được trừ khỏi kho khi xác nhận.{' '}
        {selfReviewed ? 'Bạn tự dọn phòng này: phòng được ghi “Đạt” ngay, không cần đánh giá.' : 'Sau khi hoàn thành, phòng chờ quản lý đánh giá.'}
      </p>
    </div>
  );
}

/** − [n] + : a count, from 0 to `max` — "+" past it still reports, so the shortage can be said. */
function Stepper({ id, label, value, max, disabled, onChange }: { id: string; label: string; value: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Bớt ${label}`}
        disabled={disabled || value === 0}
        onClick={() => onChange(value - 1)}
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-white disabled:opacity-40"
      >
        <Minus className="h-5 w-5" aria-hidden="true" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={id}
        className="h-11 w-16 rounded-xl border border-line-strong text-center text-lg font-semibold tabular-nums"
      />
      <button
        type="button"
        aria-label={`Thêm ${label}`}
        disabled={disabled}
        aria-disabled={value >= max || undefined}
        onClick={() => onChange(value + 1)}
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-white disabled:opacity-40"
      >
        <Plus className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** A checkbox as a large tap target: a ✓ when ticked — never the word "Đúng". */
function CheckToggle({ on, disabled, onClick, testId, children }: { on: boolean; disabled: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      data-testid={testId}
      className={`flex min-h-[3rem] items-center gap-2.5 rounded-xl border-2 px-3 text-left text-base ${
        on ? 'border-green-600 bg-green-50 text-green-900' : 'border-line bg-white text-slate-700'
      } disabled:opacity-70`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${on ? 'border-green-600 bg-green-600 text-white' : 'border-slate-400'}`}
        aria-hidden="true"
      >
        {on ? <Check className="h-4 w-4" /> : null}
      </span>
      {children}
    </button>
  );
}
