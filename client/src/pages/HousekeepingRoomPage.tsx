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
 * Phone first: every control is a large tap target, the sections stack, numbers
 * use the numeric keyboard, and the main action sits at the bottom of the screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ClipboardCheck, Minus, Pencil, Play, Plus, Save, Sparkles } from 'lucide-react';
import { ROOM_ISSUE_TYPES, type RoomIssueType } from '../api/housekeeping';
import { ROOM_WORK_KEY, formatMinutes, roomWorkApi, type CleaningForm, type RoomTask, type RoomWorkCatalog } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { branchLabel } from '../auth/types';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { ErrorAlert } from '../components/ErrorAlert';
import { QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime } from '../lib/format';

const EMPTY_FORM: CleaningForm = { linen: {}, quantities: {}, replaced: [], special: [], note: null };

export function HousekeepingRoomPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const key = [...ROOM_WORK_KEY, 'task', id];
  const task = useQuery({ queryKey: key, queryFn: () => roomWorkApi.task(id) });
  const catalog = useQuery({ queryKey: [...ROOM_WORK_KEY, 'catalog'], queryFn: () => roomWorkApi.catalog(), staleTime: Infinity });
  const [tab, setTab] = useState<'inspect' | 'clean' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
  const active = tab ?? (t && t.state !== 'NOT_STARTED' ? 'clean' : 'inspect');

  return (
    <div className="mx-auto max-w-3xl pb-24">
      <Link to="/app/inspections" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Danh sách phòng
      </Link>
      <QueryState isLoading={task.isLoading || catalog.isLoading} isError={task.isError} error={task.error} onRetry={() => void task.refetch()}>
        {t && catalog.data ? (
          <>
            <RoomHeader task={t} />
            <div role="tablist" aria-label="Công việc phòng" className="my-4 grid grid-cols-2 gap-2">
              {(
                [
                  ['inspect', 'Kiểm phòng', ClipboardCheck, false],
                  ['clean', 'Dọn phòng', Sparkles, t.state === 'NOT_STARTED'],
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
            {t.state === 'NOT_STARTED' && active === 'inspect' ? (
              <p className="mb-3 text-sm text-slate-600">“Dọn phòng” mở sau khi lưu kiểm tra; thời gian dọn chỉ bắt đầu khi bấm “Bắt đầu dọn”.</p>
            ) : null}
            {active === 'inspect' ? (
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
              />
            ) : (
              <CleanPanel
                task={t}
                catalog={catalog.data}
                onSaved={(next, done) => {
                  refresh(next);
                  setToast(done ? 'Đã hoàn thành dọn phòng.' : 'Đã lưu tạm.');
                }}
              />
            )}
          </>
        ) : null}
      </QueryState>
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

function RoomHeader({ task }: { task: RoomTask }) {
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
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-slate-900">PHÒNG {task.roomNumber}</h1>
        <span className="rounded-lg bg-slate-800 px-2 py-0.5 text-sm font-bold text-white">{task.statusCode}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${stateTone}`} data-testid="room-state">
          {task.stateLabel}
        </span>
        {task.priority ? <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-sm font-semibold text-white">Ưu tiên</span> : null}
      </div>
      <p className="mt-1 text-sm text-slate-600">{branchLabel(task.branch)}</p>
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
function StartPanel({ task, onStarted }: { task: RoomTask; onStarted: (task: RoomTask) => void }) {
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
    </section>
  );
}

/* --------------------------------- Kiểm phòng -------------------------------- */

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

function CleanPanel({
  task,
  catalog,
  onSaved,
}: {
  task: RoomTask;
  catalog: RoomWorkCatalog;
  onSaved: (task: RoomTask, done: boolean) => void;
}) {
  const [form, setForm] = useState<CleaningForm>(() => ({ ...EMPTY_FORM, ...(task.cleaning ?? {}) }));
  const done = task.state === 'COMPLETED';
  const payload = useMemo(
    () => ({
      linen: Object.fromEntries(Object.entries(form.linen).map(([item, e]) => [item, { size: e.size, quantity: e.quantity ?? 0 }])),
      quantities: form.quantities,
      replaced: form.replaced,
      special: form.special,
      note: form.note?.trim() || null,
    }),
    [form],
  );
  /** "Hoàn thành dọn phòng" opens the summary first; only its confirmation completes. */
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: (complete: boolean) => (complete ? roomWorkApi.complete(task.id, payload) : roomWorkApi.saveCleaning(task.id, payload)),
    onSuccess: ({ task: next }, complete) => {
      if (complete) setConfirming(false);
      onSaved(next, complete);
    },
  });

  const clamp = (value: number) => Math.max(0, Math.min(catalog.maxQuantity, Math.round(value) || 0));
  // ONE type per linen item: choosing another replaces it; choosing it again clears it.
  const pickSize = (item: string, size: string) =>
    setForm((f) => {
      const { [item]: current, ...rest } = f.linen;
      return { ...f, linen: current?.size === size ? rest : { ...rest, [item]: { size, quantity: current?.quantity ?? 1 } } };
    });
  const setLinenQty = (item: string, value: number) =>
    setForm((f) => (f.linen[item] ? { ...f, linen: { ...f.linen, [item]: { ...f.linen[item]!, quantity: clamp(value) } } } : f));
  const setQty = (item: string, value: number) => setForm((f) => ({ ...f, quantities: { ...f.quantities, [item]: clamp(value) } }));
  const toggleIn = (list: string[], item: string) => (list.includes(item) ? list.filter((c) => c !== item) : [...list, item]);
  const toggleReplaced = (item: string) => setForm((f) => ({ ...f, replaced: toggleIn(f.replaced, item) }));
  const toggleSpecial = (item: string) => setForm((f) => ({ ...f, special: toggleIn(f.special, item) }));

  const section = (title: string, children: React.ReactNode) => (
    <section className="rounded-2xl border border-line bg-white p-4">
      <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );

  return (
    <div className="space-y-4" data-testid="cleaning-form">
      {done ? (
        <p className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-base text-green-900" data-testid="cleaning-done">
          Đã hoàn thành lúc {task.completedAt ? formatDateTime(task.completedAt) : '—'} · {formatMinutes(task.durationSeconds)}
          {task.cleanedBy ? ` · ${task.cleanedBy.name}` : ''}
        </p>
      ) : null}
      {section(
        'Đồ vải giường',
        <div className="space-y-3">
          {catalog.linen.map((item) => {
            const entry = form.linen[item.code];
            return (
              <div key={item.code} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-medium text-slate-800">{item.label}</span>
                  <div className="flex gap-2" role="group" aria-label={`Loại ${item.label}`}>
                    {catalog.linenSizes.map((size) => {
                      const on = entry?.size === size.code;
                      return (
                        <button
                          key={size.code}
                          type="button"
                          disabled={done}
                          aria-pressed={on}
                          onClick={() => pickSize(item.code, size.code)}
                          data-testid={`linen-${item.code}-${size.code}`}
                          className={`h-12 min-w-[4.75rem] rounded-xl border-2 px-3 text-base font-bold ${
                            on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-white text-slate-700'
                          } disabled:opacity-70`}
                        >
                          {size.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {entry ? (
                  <div className="flex items-center justify-end gap-2">
                    <label htmlFor={`linen-qty-${item.code}`} className="text-base text-slate-700">
                      Số lượng
                    </label>
                    <Stepper
                      id={`linen-qty-${item.code}`}
                      label={`số lượng ${item.label}`}
                      value={entry.quantity ?? 0}
                      max={catalog.maxQuantity}
                      disabled={done}
                      onChange={(v) => setLinenQty(item.code, v)}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>,
      )}
      {section(
        'Số lượng',
        <div className="grid gap-3 sm:grid-cols-2">
          {catalog.quantities.map((item) => {
            const value = form.quantities[item.code] ?? 0;
            return (
              <div key={item.code} className="flex items-center justify-between gap-2">
                <label htmlFor={`qty-${item.code}`} className="text-base text-slate-800">
                  {item.label}
                </label>
                <Stepper
                  id={`qty-${item.code}`}
                  label={item.label}
                  value={value}
                  max={catalog.maxQuantity}
                  disabled={done}
                  onChange={(v) => setQty(item.code, v)}
                />
              </div>
            );
          })}
        </div>,
      )}
      {section(
        'Đánh dấu nếu đồ được thay thế',
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {catalog.replacements.map((item) => (
            <CheckToggle
              key={item.code}
              on={form.replaced.includes(item.code)}
              disabled={done}
              onClick={() => toggleReplaced(item.code)}
              testId={`replaced-${item.code}`}
            >
              {item.label}
            </CheckToggle>
          ))}
        </div>,
      )}
      {section(
        'Ghi nhận đặc biệt',
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.specialStatuses.map((item) => (
            <CheckToggle
              key={item.code}
              on={form.special.includes(item.code)}
              disabled={done}
              onClick={() => toggleSpecial(item.code)}
              testId={`special-${item.code}`}
            >
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
          disabled={done}
          value={form.note ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          placeholder="Các lưu ý-Hỏng hóc-Vấn đề khác..."
          data-testid="cleaning-note"
          className="w-full rounded-xl border border-line-strong px-3 py-2 text-base"
        />,
      )}
      {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      {!done ? (
        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
          <Button variant="secondary" className="min-h-[3rem] flex-1 text-base" onClick={() => save.mutate(false)} loading={save.isPending && save.variables === false} disabled={save.isPending} data-testid="cleaning-save">
            <Save className="h-5 w-5" aria-hidden="true" />
            Lưu tạm
          </Button>
          <Button
            className="min-h-[3rem] flex-[2] text-base"
            onClick={() => {
              save.reset();
              setConfirming(true);
            }}
            disabled={save.isPending}
            data-testid="cleaning-complete"
          >
            <Check className="h-5 w-5" aria-hidden="true" />
            Hoàn thành dọn phòng
          </Button>
        </div>
      ) : null}
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
              <Button
                onClick={() => save.mutate(true)}
                loading={save.isPending && save.variables === true}
                disabled={save.isPending}
                data-testid="cleaning-confirm-submit"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                Xác nhận hoàn thành
              </Button>
            </>
          }
        >
          <CleaningSummary task={task} catalog={catalog} form={form} />
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
 * EVERYTHING ENTERED, AS IT WILL BE SENT — read from the live form state with
 * the catalog's own labels, so the summary can never disagree with the form.
 */
function CleaningSummary({ task, catalog, form }: { task: RoomTask; catalog: RoomWorkCatalog; form: CleaningForm }) {
  const label = (items: { code: string; label: string }[], code: string) => items.find((i) => i.code === code)?.label ?? code;
  const linen = catalog.linen
    .filter((item) => form.linen[item.code])
    .map((item) => {
      const e = form.linen[item.code]!;
      return `${item.label}: ${label(catalog.linenSizes, e.size)} × ${e.quantity ?? 0}`;
    });
  const quantities = catalog.quantities
    .filter((item) => (form.quantities[item.code] ?? 0) > 0)
    .map((item) => `${item.label}: ${form.quantities[item.code]}`);
  const replaced = catalog.replacements.filter((item) => form.replaced.includes(item.code)).map((item) => item.label);
  const special = catalog.specialStatuses.filter((item) => form.special.includes(item.code)).map((item) => `${item.short} : ${item.label}`);
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
        <span className="font-semibold">Phòng {task.roomNumber}</span> · {branchLabel(task.branch)}
        {task.assignee ? ` · ${task.assignee.name}` : ''}
        {task.startedAt ? ` · bắt đầu ${formatDateTime(task.startedAt)}` : ''}
      </p>
      <dl>
        {row('Đồ vải giường', linen, 'summary-linen')}
        {row('Số lượng', quantities, 'summary-quantities')}
        {row('Đồ được thay thế', replaced, 'summary-replaced')}
        {row('Ghi nhận đặc biệt', special, 'summary-special')}
        {row('Ghi chú', form.note?.trim() ? [form.note.trim()] : [], 'summary-note')}
      </dl>
      <p className="mt-2 text-xs text-slate-500">Kiểm tra lại trước khi xác nhận. Sau khi hoàn thành, phòng chờ quản lý đánh giá.</p>
    </div>
  );
}

/** − [n] + : a count, from 0 to the catalog's maximum. */
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
