/**
 * THE MANAGER CONSOLE'S OWN PIECES — "Quản lý buồng phòng" only.
 *
 * One design system for the five screens (Tổng quan, Tình trạng phòng, Theo dõi
 * nhân viên, KPI & Thu tiền, Báo cáo):
 *
 *   HkHeader         the page title and its actions, then one compact context
 *                    strip: Chi nhánh · Ngày nghiệp vụ (or the report period) · pickers
 *   HkSection        one white card with a titled header row
 *   Metric           a compact figure: icon, label, value, one line under it
 *   Badge / StateBadge / PriorityBadge / CodeTag
 *   ProgressBar      the three work states as one bar
 *   Meter            one share of a whole, with its value
 *   RateBar          "65%" with a thin bar
 *   Avatar           initials, for a person's row
 *   Segmented        a small set of exclusive choices (views, quick periods)
 *   ReviewCard       a finished room waiting for "Đạt" / "Không đạt"
 *
 * Surfaces stay white on a light grey page with thin borders. Colour carries
 * meaning only — status, a primary action, a genuine alert — and every colour
 * travels with a word or an icon, never alone.
 */
import type { ReactNode } from 'react';
import { Building2, CalendarDays, Flag, type LucideIcon } from 'lucide-react';
import type { RoomTask, RoomWorkState } from '../api/roomWork';
import { initialsOf } from '../lib/hkDisplay';

/* ------------------------------------------------------------------ *
 * Shared class strings
 * ------------------------------------------------------------------ */

/** The one card surface of these screens. */
export const CARD = 'rounded-xl border border-line-subtle bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)]';

/** A compact form control — selects and search boxes in filter rows. */
export const CONTROL =
  'min-h-[2.5rem] w-full min-w-0 rounded-lg border border-line-strong bg-white px-3 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** A row's or a header's secondary action: small, but a real tap target. */
export const ROW_BUTTON =
  'inline-flex min-h-[2.25rem] items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-line-strong bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** "Xem chi tiết →" in a section header. */
export const SECTION_LINK =
  'inline-flex items-center gap-1 rounded text-sm font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** The uppercase caption above a filter or a group of controls. */
export const CAPTION = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500';

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
  /** "Chi nhánh 1 — 05 Trương Định", or the Admin's choice. With `period`: no strip without both. */
  branch?: ReactNode;
  /** "Ngày nghiệp vụ: 04/10/2026" (with its weekday), or a report period. */
  period?: { label: string; value: string; weekday?: string };
  /** The date and (for the Admin) the branch picker. */
  controls?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 md:flex-nowrap">
        <div className="min-w-0 md:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {period ? (
      <section
        data-testid="hk-context"
        aria-label="Phạm vi đang xem"
        className={`${CARD} flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between`}
      >
        <dl className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:divide-x sm:divide-line-subtle">
          <div className="flex min-w-0 items-center gap-3 sm:pr-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700" aria-hidden="true">
              <Building2 className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Quản lý buồng phòng</dt>
              <dd className="truncate text-sm font-semibold text-slate-900" data-testid="manager-branch">
                {branch}
              </dd>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-3 sm:pl-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700" aria-hidden="true">
              <CalendarDays className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{period.label}</dt>
              <dd className="text-sm text-slate-900">
                <span className="font-semibold tabular-nums" data-testid="hk-period-value">
                  {period.value}
                </span>
                {period.weekday ? <span className="text-slate-500"> ({period.weekday})</span> : null}
              </dd>
            </div>
          </div>
        </dl>
        {/*
          `min-w-0` + full width on phones: without them this flex column keeps
          its children's intrinsic width (a native date input has one), and the
          date field ran past the right edge at 320–390px.
        */}
        {controls ? (
          <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end lg:w-auto" data-testid="hk-controls">
            {controls}
          </div>
        ) : null}
      </section>
      ) : null}
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Section shell
 * ------------------------------------------------------------------ */

export function HkSection({
  title,
  icon: Icon,
  aside,
  children,
  testId,
  className = '',
  bodyClassName = 'p-4',
  accent = false,
}: {
  title: string;
  icon?: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
  bodyClassName?: string;
  /** An amber edge — a queue waiting for the manager's decision. */
  accent?: boolean;
}) {
  return (
    <section
      data-testid={testId}
      className={`min-w-0 overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] ${accent ? 'border-amber-300' : 'border-line-subtle'} ${className}`}
    >
      <header className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 ${accent ? 'border-amber-200 bg-amber-50/70' : 'border-line-subtle'}`}>
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-slate-900">
          {Icon ? <Icon className={`h-[18px] w-[18px] shrink-0 ${accent ? 'text-amber-700' : 'text-brand-600'}`} aria-hidden="true" /> : null}
          <span className="truncate">{title}</span>
        </h2>
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
  gray: 'text-slate-900',
  blue: 'text-blue-700',
  green: 'text-green-700',
  red: 'text-red-700',
  amber: 'text-amber-700',
};

const CHIP: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-600',
  gray: 'bg-slate-100 text-slate-600',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-green-50 text-green-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-700',
};

/**
 * A compact figure: a small icon, the label, the value, one line under it. The
 * card stays white whatever the tone — the value and the icon carry it.
 */
export function Metric({
  label,
  value,
  tone = 'slate',
  hint,
  icon: Icon,
  testId,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  icon?: LucideIcon;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={`${CARD} flex min-w-0 items-start gap-3 px-3.5 py-3`}>
      {Icon ? (
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHIP[tone]}`} aria-hidden="true">
          <Icon className="h-[18px] w-[18px]" />
        </span>
      ) : null}
      <div className="min-w-0">
        <p className="flex items-start gap-1.5 text-xs font-medium leading-snug text-slate-600">
          {Icon ? null : <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />}
          <span className="min-w-0 break-words">{label}</span>
        </p>
        <p className={`mt-0.5 text-2xl font-semibold leading-tight tabular-nums ${VALUE[tone]}`}>{value}</p>
        {hint ? <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

const BADGE: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
  gray: 'bg-slate-100 text-slate-700 ring-slate-300',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200',
  green: 'bg-green-50 text-green-800 ring-green-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
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
  // "Đã kiểm tra": inspected, cleaning not started.
  INSPECTED: 'amber',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
};

export function StateBadge({ state, label }: { state: RoomWorkState; label: string }) {
  return <Badge tone={STATE_TONE[state]}>{label}</Badge>;
}

export function PriorityBadge() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-200">
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
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-200"
    >
      {completed > 0 ? <span className="rounded-full bg-green-600" style={{ width: `${pct(completed)}%` }} /> : null}
      {inProgress > 0 ? <span className="rounded-full bg-blue-500" style={{ width: `${pct(inProgress)}%` }} /> : null}
    </div>
  );
}

/** One share of a whole: "Đã thu  1.200.000 ₫  ▮▮▮▯▯ 67%". The share is omitted when the whole is 0. */
export function Meter({
  label,
  value,
  share,
  total,
  barClass,
  testId,
}: {
  label: string;
  value: ReactNode;
  share: number;
  total: number;
  /** The bar's colour — a status colour. */
  barClass: string;
  testId?: string;
}) {
  const pct = total > 0 ? Math.round((share / total) * 100) : null;
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold tabular-nums text-slate-900">{value}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <span className={`block h-full rounded-full ${barClass}`} style={{ width: `${pct ?? 0}%` }} />
        </span>
        <span className="w-10 text-right text-xs tabular-nums text-slate-500">{pct === null ? '—' : `${pct}%`}</span>
      </div>
    </div>
  );
}

/** "65%", with a thin bar beside it. */
export function RateBar({ rate, tone = 'green' }: { rate: number | null; tone?: 'green' | 'amber' }) {
  if (rate === null) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-slate-200 sm:inline-block" aria-hidden="true">
        <span className={`block h-full rounded-full ${tone === 'amber' ? 'bg-amber-500' : 'bg-green-600'}`} style={{ width: `${Math.min(100, Math.max(0, rate))}%` }} />
      </span>
      <span className="w-10 text-right tabular-nums">{rate}%</span>
    </span>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-brand-50 font-semibold text-brand-700 ring-1 ring-inset ring-brand-100 ${
        size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-9 w-9 text-xs'
      }`}
    >
      {initialsOf(name)}
    </span>
  );
}

/** A small set of exclusive choices, as one pressed-button group. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: { value: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (next: T) => void;
  testId?: string;
}) {
  return (
    <div role="group" aria-label={label} data-testid={testId} className="flex w-full overflow-hidden rounded-lg border border-line-strong bg-white sm:inline-flex sm:w-auto">
      {options.map((o, i) => {
        const Icon = o.icon;
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            className={`inline-flex min-h-[2.5rem] flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2 text-sm focus-visible:relative sm:flex-none sm:px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
              i > 0 ? 'border-l border-line-subtle' : ''
            } ${on ? 'bg-brand-600 font-semibold text-white' : 'font-medium text-slate-700 hover:bg-slate-50'}`}
          >
            {Icon ? <Icon className="hidden h-4 w-4 sm:block" aria-hidden="true" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

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
    <article data-testid={`review-card-${task.roomNumber}`} className="flex flex-col rounded-lg border border-amber-300 bg-white p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex items-start justify-between gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        aria-label={`Xem chi tiết phòng ${task.roomNumber}`}
      >
        <span>
          <span className="block text-base font-bold leading-tight tabular-nums text-slate-900">Phòng {task.roomNumber}</span>
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
          className="min-h-[2.5rem] rounded-lg border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1"
        >
          Không đạt
        </button>
      </div>
    </article>
  );
}
