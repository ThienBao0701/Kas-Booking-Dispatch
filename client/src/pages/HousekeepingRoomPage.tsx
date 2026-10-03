/**
 * "PHÒNG 101" — one room's work, for the worker it was given to.
 *
 *   [ Kiểm phòng ]  [ Dọn phòng ]
 *   code · priority · manager's note · state · started · elapsed · finished
 *
 * "LƯU KIỂM TRA" STARTS THE TIMER — on the server, at the inspection's own time;
 * opening this page records only that it was opened. "Dọn phòng" is locked until
 * the inspection is saved. The person is the account: no name is asked anywhere.
 *
 * Phone first: every control is a large tap target, the sections stack, numbers
 * use the numeric keyboard, and the main action sits at the bottom of the screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ClipboardCheck, Minus, Plus, Save, Sparkles } from 'lucide-react';
import { ROOM_ISSUE_TYPES, type RoomIssueType } from '../api/housekeeping';
import { ROOM_WORK_KEY, formatMinutes, roomWorkApi, type CleaningForm, type RoomTask, type RoomWorkCatalog } from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { branchLabel } from '../auth/types';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime } from '../lib/format';

const EMPTY_FORM: CleaningForm = { linen: {}, quantities: {}, replaced: [], note: null };

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
              <p className="mb-3 text-sm text-slate-600">“Dọn phòng” mở sau khi lưu kiểm tra; thời gian dọn bắt đầu từ lúc lưu.</p>
            ) : null}
            {active === 'inspect' ? (
              <InspectPanel
                task={t}
                onSaved={(next) => {
                  refresh(next);
                  setTab('clean');
                  setToast('Đã lưu kiểm tra — bắt đầu dọn phòng.');
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
    task.state === 'COMPLETED' ? 'bg-green-100 text-green-800' : task.state === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700';
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
  const payload = useMemo(() => ({ linen: form.linen, quantities: form.quantities, replaced: form.replaced, note: form.note?.trim() || null }), [form]);
  const save = useMutation({
    mutationFn: (complete: boolean) => (complete ? roomWorkApi.complete(task.id, payload) : roomWorkApi.saveCleaning(task.id, payload)),
    onSuccess: ({ task: next }, complete) => onSaved(next, complete),
  });

  const toggleSize = (item: string, size: string) =>
    setForm((f) => {
      const sizes = f.linen[item] ?? [];
      const next = sizes.includes(size) ? sizes.filter((s) => s !== size) : [...sizes, size];
      return { ...f, linen: { ...f.linen, [item]: next } };
    });
  const setQty = (item: string, value: number) =>
    setForm((f) => ({ ...f, quantities: { ...f.quantities, [item]: Math.max(0, Math.min(catalog.maxQuantity, Math.round(value) || 0)) } }));
  const toggleReplaced = (item: string) =>
    setForm((f) => ({ ...f, replaced: f.replaced.includes(item) ? f.replaced.filter((c) => c !== item) : [...f.replaced, item] }));

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
          {catalog.linen.map((item) => (
            <div key={item.code} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-base font-medium text-slate-800">{item.label}</span>
              <div className="flex gap-2">
                {catalog.linenSizes.map((size) => {
                  const on = (form.linen[item.code] ?? []).includes(size);
                  return (
                    <button
                      key={size}
                      type="button"
                      disabled={done}
                      aria-pressed={on}
                      onClick={() => toggleSize(item.code, size)}
                      data-testid={`linen-${item.code}-${size}`}
                      className={`h-12 w-12 rounded-xl border-2 text-lg font-bold ${
                        on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-white text-slate-700'
                      } disabled:opacity-70`}
                    >
                      {size}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
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
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`Bớt ${item.label}`}
                    disabled={done || value === 0}
                    onClick={() => setQty(item.code, value - 1)}
                    className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-white disabled:opacity-40"
                  >
                    <Minus className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <input
                    id={`qty-${item.code}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={catalog.maxQuantity}
                    disabled={done}
                    value={value}
                    onChange={(e) => setQty(item.code, Number(e.target.value))}
                    data-testid={`qty-${item.code}`}
                    className="h-11 w-16 rounded-xl border border-line-strong text-center text-lg font-semibold tabular-nums"
                  />
                  <button
                    type="button"
                    aria-label={`Thêm ${item.label}`}
                    disabled={done}
                    onClick={() => setQty(item.code, value + 1)}
                    className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-strong bg-white disabled:opacity-40"
                  >
                    <Plus className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>,
      )}
      {section(
        'Đánh dấu nếu đồ được thay thế',
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {catalog.replacements.map((item) => {
            const on = form.replaced.includes(item.code);
            return (
              <button
                key={item.code}
                type="button"
                disabled={done}
                aria-pressed={on}
                onClick={() => toggleReplaced(item.code)}
                data-testid={`replaced-${item.code}`}
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
                {item.label}
              </button>
            );
          })}
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
          placeholder="Tình trạng bất thường, thiếu thông tin, ngoại lệ…"
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
          <Button className="min-h-[3rem] flex-[2] text-base" onClick={() => save.mutate(true)} loading={save.isPending && save.variables === true} disabled={save.isPending} data-testid="cleaning-complete">
            <Check className="h-5 w-5" aria-hidden="true" />
            Hoàn thành dọn phòng
          </Button>
        </div>
      ) : null}
    </div>
  );
}
