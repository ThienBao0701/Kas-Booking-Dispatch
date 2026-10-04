/**
 * THE MANAGER CONSOLE'S OWN PIECES — "Quản lý buồng phòng" only.
 *
 * The worker's screens keep `RoomBoard` / `RoomChip` exactly as accepted; the
 * manager reads the same data at a desk, so it gets its own presentation:
 *
 *   HkHeader         module · Chi nhánh · Ngày nghiệp vụ, then the page title
 *   HkSection        one framed block, in the KAS table shell's weights
 *   Metric           a compact figure with its semantic colour
 *   StateBadge       chưa bắt đầu (gray) · đang dọn (blue) · hoàn thành (green)
 *   PriorityBadge    ưu tiên (red)
 *   ProgressBar      the three states as one bar
 *   ManagerRoomBoard the day's rooms, one group per code (OUT / OC / VC)
 *   ReviewCard       a finished room waiting for "Đạt" / "Không đạt"
 *
 * Colour carries meaning only: status, priority, action.
 */
import type { ReactNode } from 'react';
import { Flag } from 'lucide-react';
import type { RoomTask, RoomWorkState } from '../api/roomWork';

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

export function HkHeader({
  title,
  description,
  branch,
  period,
  controls,
  actions,
}: {
  title: string;
  description?: string;
  /** "Chi nhánh 1 — 05 Trương Định", or the Admin's choice. */
  branch: ReactNode;
  /** "Ngày nghiệp vụ: 04/10/2026", or a report period. */
  period: { label: string; value: string };
  /** The date and (for the Admin) the branch picker. */
  controls?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 space-y-4">
      <section
        data-testid="hk-context"
        className="flex flex-col gap-3 rounded-xl border border-line bg-white px-4 py-3 shadow-sm md:flex-row md:items-center md:justify-between"
      >
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-700">Quản lý buồng phòng</p>
          <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-0.5 text-sm">
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-slate-500">Chi nhánh:</dt>
              <dd className="min-w-0 font-semibold text-slate-900" data-testid="manager-branch">
                {branch}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-slate-500">{period.label}:</dt>
              <dd className="font-semibold tabular-nums text-slate-900" data-testid="hk-period-value">
                {period.value}
              </dd>
            </div>
          </dl>
        </div>
        {controls ? <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">{controls}</div> : null}
      </section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Section shell
 * ------------------------------------------------------------------ */

export function HkSection({
  title,
  aside,
  children,
  testId,
  className = '',
  bodyClassName = 'p-4',
  accent = false,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
  bodyClassName?: string;
  /** Amber frame and header — the review area, apart from the rooms being cleaned. */
  accent?: boolean;
}) {
  return (
    <section
      data-testid={testId}
      className={`overflow-hidden rounded-xl border-section bg-white ${accent ? 'border-amber-400' : 'border-line'} ${className}`}
    >
      <header
        className={`flex flex-wrap items-center justify-between gap-2 border-b-rule px-4 py-2.5 ${accent ? 'border-amber-300 bg-amber-50' : 'border-line bg-slate-50/70'}`}
      >
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {aside}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Figures and badges
 * ------------------------------------------------------------------ */

export type Tone = 'slate' | 'gray' | 'blue' | 'green' | 'red' | 'amber';

const DOT: Record<Tone, string> = {
  slate: 'bg-slate-700',
  gray: 'bg-slate-400',
  blue: 'bg-blue-600',
  green: 'bg-green-600',
  red: 'bg-red-600',
  amber: 'bg-amber-500',
};

const VALUE: Record<Tone, string> = {
  slate: 'text-slate-900',
  gray: 'text-slate-700',
  blue: 'text-blue-700',
  green: 'text-green-700',
  red: 'text-red-700',
  amber: 'text-amber-700',
};

/** A compact figure: label, value, an optional line under it. */
export function Metric({ label, value, tone = 'slate', hint, testId }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-line-subtle bg-white px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className={`mt-0.5 text-2xl font-semibold leading-tight tabular-nums ${VALUE[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

const BADGE: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
  gray: 'bg-slate-100 text-slate-700 ring-slate-300',
  blue: 'bg-blue-50 text-blue-800 ring-blue-300',
  green: 'bg-green-50 text-green-800 ring-green-300',
  red: 'bg-red-50 text-red-700 ring-red-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-300',
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

const STATE_TONE: Record<RoomWorkState, Tone> = {
  NOT_STARTED: 'gray',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
};

export function StateBadge({ state, label }: { state: RoomWorkState; label: string }) {
  return <Badge tone={STATE_TONE[state]}>{label}</Badge>;
}

export function PriorityBadge() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-300">
      <Flag className="h-3 w-3" aria-hidden="true" />
      Ưu tiên
    </span>
  );
}

/** The room's code, as the operation writes it. */
export function CodeTag({ code }: { code: string }) {
  return <span className="inline-flex rounded-md bg-slate-800 px-2 py-0.5 text-xs font-bold tracking-wider text-white">{code}</span>;
}

/** Chưa bắt đầu · đang dọn · hoàn thành, as one bar. */
export function ProgressBar({ notStarted, inProgress, completed, testId }: { notStarted: number; inProgress: number; completed: number; testId?: string }) {
  const total = notStarted + inProgress + completed;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={`Hoàn thành ${completed}/${total} phòng, đang dọn ${inProgress}, chưa bắt đầu ${notStarted}`}
      className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
    >
      <span className="bg-green-600" style={{ width: `${pct(completed)}%` }} />
      <span className="bg-blue-500" style={{ width: `${pct(inProgress)}%` }} />
      <span className="bg-slate-300" style={{ width: `${pct(notStarted)}%` }} />
    </div>
  );
}

/** "65%", with a thin bar beside it. */
export function RateBar({ rate }: { rate: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 sm:inline-block" aria-hidden="true">
        <span className="block h-full bg-green-600" style={{ width: `${Math.min(100, Math.max(0, rate))}%` }} />
      </span>
      <span className="tabular-nums">{rate}%</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The manager's room board
 * ------------------------------------------------------------------ */

const TILE: Record<RoomWorkState, string> = {
  NOT_STARTED: 'border-slate-300 bg-slate-50 hover:bg-slate-100',
  IN_PROGRESS: 'border-blue-400 bg-blue-50 hover:bg-blue-100',
  COMPLETED: 'border-green-500 bg-green-50/60 hover:bg-green-50',
};

const STATE_TEXT: Record<RoomWorkState, string> = {
  NOT_STARTED: 'text-slate-600',
  IN_PROGRESS: 'text-blue-700',
  COMPLETED: 'text-green-700',
};

export function ManagerLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600" data-testid="room-legend">
      <Badge tone="gray">Chưa bắt đầu</Badge>
      <Badge tone="blue">Đang dọn</Badge>
      <Badge tone="red">Cần dọn lại</Badge>
      <PriorityBadge />
    </p>
  );
}

function RoomTile({ task, onClick }: { task: RoomTask; onClick?: () => void }) {
  const who = task.assignee?.name ?? null;
  // "Cần dọn lại": a re-clean cycle — red until its cleaning starts.
  const reclean = task.reclean !== null && task.state !== 'COMPLETED';
  const stateLabel = reclean && task.state === 'NOT_STARTED' ? 'Cần dọn lại' : task.stateLabel;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`room-chip-${task.roomNumber}`}
      data-state={task.state}
      data-reclean={reclean || undefined}
      aria-label={`Phòng ${task.roomNumber} · ${stateLabel} · ${who ?? 'Chưa giao'}${task.priority ? ' · Ưu tiên' : ''}`}
      className={`relative flex min-h-[5.5rem] flex-col items-start justify-between rounded-lg border-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1 ${
        reclean && task.state === 'NOT_STARTED' ? 'border-red-400 bg-red-50 hover:bg-red-100' : TILE[task.state]
      }`}
    >
      <span className="flex w-full items-start justify-between gap-1">
        <span
          className={`text-xl font-bold leading-tight tabular-nums text-slate-900 ${
            task.state === 'COMPLETED' ? 'border-b-[3px] border-green-600' : 'border-b-[3px] border-transparent'
          }`}
        >
          {task.roomNumber}
        </span>
        {task.priority ? (
          <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white" aria-hidden="true">
            <Flag className="h-3 w-3" />
          </span>
        ) : null}
      </span>
      <span className={`w-full truncate text-xs ${who ? 'font-medium text-slate-700' : 'italic text-amber-700'}`}>{who ?? 'Chưa giao'}</span>
      <span className="flex flex-wrap items-center gap-1">
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${reclean && task.state === 'NOT_STARTED' ? 'text-red-700' : STATE_TEXT[task.state]}`}>
          {stateLabel}
        </span>
        {reclean && task.state === 'IN_PROGRESS' ? (
          <span className="rounded bg-red-600 px-1 text-[10px] font-bold uppercase text-white">Dọn lại</span>
        ) : null}
      </span>
    </button>
  );
}

/** One group per code, in the catalog's order (an unknown code keeps a group of its own). */
export function ManagerRoomBoard({ tasks, codes, onSelect }: { tasks: RoomTask[]; codes: readonly string[]; onSelect?: (task: RoomTask) => void }) {
  const order = [...codes, ...[...new Set(tasks.map((t) => t.statusCode))].filter((c) => !codes.includes(c))];
  const groups = order
    .map((code) => ({
      code,
      tasks: tasks
        .filter((t) => t.statusCode === code)
        .sort((a, b) => Number(b.priority) - Number(a.priority) || a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true })),
    }))
    .filter((g) => g.tasks.length > 0);
  return (
    <div className="space-y-4" data-testid="room-board">
      {groups.map((g) => {
        const count = (s: RoomWorkState) => g.tasks.filter((t) => t.state === s).length;
        return (
          <section key={g.code} data-testid={`room-row-${g.code}`} className="rounded-lg border border-line-subtle p-3">
            <header className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <CodeTag code={g.code} />
              <span className="text-sm font-semibold text-slate-800">{g.tasks.length} phòng</span>
              <span className="text-xs text-slate-500">
                {count('NOT_STARTED')} chưa bắt đầu · {count('IN_PROGRESS')} đang dọn · {count('COMPLETED')} hoàn thành
              </span>
            </header>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
              {g.tasks.map((task) => (
                <RoomTile key={task.id} task={task} onClick={onSelect ? () => onSelect(task) : undefined} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A room not yet on the board, to pick for "Thêm phòng". */
export function PickChip({ room, selected, onToggle }: { room: string; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      data-testid={`room-chip-${room}`}
      className={`min-h-[2.5rem] min-w-[3.5rem] rounded-lg border px-2.5 text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
        selected ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-white text-slate-800 hover:bg-slate-50'
      }`}
    >
      {room}
    </button>
  );
}

/**
 * "PHÒNG CHỜ ĐÁNH GIÁ" — one finished room: who cleaned it, when it finished,
 * how long it took, and the two outcomes. Opening the room shows its history.
 */
export function ReviewCard({
  task,
  finishedAt,
  duration,
  onOpen,
  onPass,
  onFail,
}: {
  task: RoomTask;
  /** "10:42". */
  finishedAt: string;
  /** "32 phút". */
  duration: string;
  onOpen: () => void;
  onPass: () => void;
  onFail: () => void;
}) {
  return (
    <article data-testid={`review-card-${task.roomNumber}`} className="flex flex-col rounded-lg border-2 border-amber-300 bg-white p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex items-start justify-between gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        aria-label={`Xem chi tiết phòng ${task.roomNumber}`}
      >
        <span>
          <span className="block text-lg font-bold leading-tight tabular-nums text-slate-900">PHÒNG {task.roomNumber}</span>
          {task.cycleNumber > 1 ? <span className="text-xs font-semibold text-amber-800">Lần dọn {task.cycleNumber}</span> : null}
        </span>
        <span className="flex items-center gap-1">
          {task.priority ? <Flag className="h-4 w-4 text-red-600" aria-label="Ưu tiên" /> : null}
          <CodeTag code={task.statusCode} />
        </span>
      </button>
      <dl className="mt-2 space-y-0.5 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-slate-500">Nhân viên:</dt>
          <dd className="min-w-0 truncate font-medium text-slate-900">{task.cleanedBy?.name ?? task.assignee?.name ?? '—'}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">Hoàn thành:</dt>
          <dd className="tabular-nums text-slate-900">{finishedAt}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">Thời gian dọn:</dt>
          <dd className="tabular-nums text-slate-900">{duration}</dd>
        </div>
      </dl>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onPass}
          data-testid={`review-pass-${task.roomNumber}`}
          className="min-h-[2.5rem] rounded-lg bg-green-600 px-3 text-sm font-semibold text-white hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-1"
        >
          Đạt
        </button>
        <button
          type="button"
          onClick={onFail}
          data-testid={`review-fail-${task.roomNumber}`}
          className="min-h-[2.5rem] rounded-lg border-2 border-red-300 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1"
        >
          Không đạt
        </button>
      </div>
    </article>
  );
}
