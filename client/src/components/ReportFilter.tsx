/**
 * THE REPORT FILTER — one model for every report screen (Admin, the two reception
 * managers, Reception's archive, the technical report):
 *
 *   Chọn nhanh                                   Chi nhánh
 *   [Hôm nay | Ngày cụ thể | Khoảng ngày]        [-Chọn chi nhánh-          (2)]
 *   Ca: the shifts that actually ran in the period
 *
 * THE DATES ARE BUSINESS DATES. The server resolves them to the shifts that ran
 * on them (`/reception/shifts/available`, `resolveReportPeriod`): Ca C of the
 * 2nd, ending at 06:00 on the 3rd, is the 2nd's — on every screen alike. The
 * shift choices are never a fixed list; a day worked A4/C4 offers only those.
 *
 * The branch list is the reader's scope from the server; the number beside each
 * branch is its unresolved incidents (the sidebar badge's source), red when any.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftsApi } from '../api/shifts';
import type { Branch } from '../auth/types';
import { branchOptionLabel } from '../lib/branchTone';
import { formatDate } from '../lib/format';
import type { DateRangeValue } from './DateRangeField';
import { reportBranchId, reportPeriod, type BranchChoice, type PeriodMode, type ReportFilterValue } from '../lib/reportFilter';

const MODES: { key: PeriodMode; label: string }[] = [
  { key: 'TODAY', label: 'Hôm nay' },
  { key: 'DAY', label: 'Ngày cụ thể' },
  { key: 'RANGE', label: 'Khoảng ngày' },
];

const CONTROL =
  'min-h-[2.75rem] rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-800 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function ReportFilterBar({
  value,
  onChange,
  today,
  branches,
  branchCounts,
  allowAll = true,
  showShifts = true,
  testId = 'report-filter',
}: {
  value: ReportFilterValue;
  onChange: (next: ReportFilterValue) => void;
  today: string;
  /** The reader's branches; omitted, there is no branch choice (Reception reads its own). */
  branches?: Branch[];
  /** Unresolved incidents per branch, beside each branch. */
  branchCounts?: Map<number, number>;
  /** Offer "Tất cả chi nhánh". */
  allowAll?: boolean;
  /** The "Ca" choices — off where the data has no reception shift (housekeeping). */
  showShifts?: boolean;
  testId?: string;
}) {
  const period = reportPeriod(value, today);
  const branchId = reportBranchId(value);
  const showBranch = branches !== undefined;
  const shifts = useQuery({
    queryKey: ['report-shifts', period?.from ?? null, period?.to ?? null, branchId ?? null],
    queryFn: () => shiftsApi.available({ ...period!, branchId }),
    enabled: showShifts && period !== null && (!showBranch || value.branch !== null),
    staleTime: 30_000,
  });
  const available = shifts.data?.shifts ?? [];

  // A shift the new period did not run is dropped rather than silently matching nothing.
  useEffect(() => {
    if (value.shiftType && shifts.data && !shifts.data.shifts.some((s) => s.code === value.shiftType)) {
      onChange({ ...value, shiftType: '' });
    }
  }, [shifts.data, value, onChange]);

  return (
    <section
      data-testid={testId}
      aria-label="Bộ lọc báo cáo"
      className="mb-4 rounded-xl border-section border-line bg-white px-4 py-3 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Chọn nhanh</p>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Chọn nhanh" className="inline-flex overflow-hidden rounded-xl border border-line-strong bg-white">
              {MODES.map((m, i) => (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={value.mode === m.key}
                  data-testid={`period-${m.key}`}
                  onClick={() => onChange({ ...value, mode: m.key, shiftType: '' })}
                  className={`min-h-[2.75rem] px-3.5 text-sm transition-colors focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                    i > 0 ? 'border-l border-line-strong' : ''
                  } ${value.mode === m.key ? 'bg-brand-50 font-semibold text-brand-700' : 'font-medium text-slate-600 hover:bg-slate-50'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {value.mode === 'DAY' ? (
              <input
                type="date"
                aria-label="Ngày cụ thể"
                data-testid="period-day"
                value={value.day}
                max={today}
                onChange={(e) => onChange({ ...value, day: e.target.value, shiftType: '' })}
                className={CONTROL}
              />
            ) : null}
            {value.mode === 'RANGE' ? (
              <DateRangePicker
                value={value.range}
                max={today}
                onChange={(range) => onChange({ ...value, range, shiftType: '' })}
              />
            ) : null}
          </div>
        </div>

        {showBranch ? (
          <div className="w-full min-w-[16rem] sm:w-auto sm:max-w-[26rem] sm:flex-1">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Chi nhánh</p>
            <BranchPicker
              value={value.branch}
              onChange={(branch) => onChange({ ...value, branch, shiftType: '' })}
              branches={branches}
              counts={branchCounts}
              allowAll={allowAll}
            />
          </div>
        ) : null}
      </div>

      {available.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3" data-testid="shift-filter">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ca</span>
          {[{ code: '', label: 'Tất cả ca' }, ...available.map((s) => ({ code: s.code, label: `${s.name} (${s.window})` }))].map((s) => (
            <button
              key={s.code || 'ALL'}
              type="button"
              aria-pressed={value.shiftType === s.code}
              data-testid={`shift-filter-${s.code || 'ALL'}`}
              onClick={() => onChange({ ...value, shiftType: s.code })}
              className={`rounded-lg border px-2.5 py-1.5 text-sm ${
                value.shiftType === s.code
                  ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Closes a popover on an outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * "-Chọn chi nhánh-" — a list rather than a native <select>, because the count
 * belongs at the far right of each row and in red when there is something
 * unresolved; a native option cannot place or colour part of its text.
 */
export function BranchPicker({
  value,
  onChange,
  branches,
  counts,
  allowAll = true,
  testId = 'branch-select',
}: {
  value: BranchChoice;
  onChange: (next: BranchChoice) => void;
  branches: Branch[];
  counts?: Map<number, number>;
  allowAll?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const countOf = (id: number) => counts?.get(id) ?? 0;
  const total = branches.reduce((n, b) => n + countOf(b.id), 0);
  const selected = typeof value === 'number' ? branches.find((b) => b.id === value) : undefined;
  const Count = ({ n }: { n: number }) =>
    counts ? (
      <span className={`shrink-0 tabular-nums ${n > 0 ? 'font-semibold text-red-600' : 'text-slate-500'}`}>({n})</span>
    ) : null;
  const choose = (next: BranchChoice) => {
    onChange(next);
    setOpen(false);
  };
  const row = (key: string, label: string, n: number, active: boolean, next: BranchChoice) => (
    <li
      key={key}
      role="option"
      aria-selected={active}
      data-testid={`branch-option-${key}`}
      tabIndex={-1}
      onClick={() => choose(next)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose(next);
        }
      }}
      className={`flex cursor-pointer items-center justify-between gap-4 px-3 py-2 text-sm ${
        active ? 'bg-brand-50 font-semibold text-brand-800' : 'text-slate-800 hover:bg-slate-50'
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <Count n={n} />
    </li>
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Chi nhánh"
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
        className={`${CONTROL} flex w-full items-center justify-between gap-3 text-left`}
      >
        <span className={`min-w-0 truncate ${value === null ? 'text-slate-500' : ''}`}>
          {value === null ? '-Chọn chi nhánh-' : value === 'ALL' ? 'Tất cả chi nhánh' : selected ? branchOptionLabel(selected) : '—'}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {value === 'ALL' ? <Count n={total} /> : selected ? <Count n={countOf(selected.id)} /> : null}
          <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <ul
          role="listbox"
          aria-label="Chi nhánh"
          className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line-strong bg-white py-1 shadow-lg"
        >
          {allowAll ? row('ALL', 'Tất cả chi nhánh', total, value === 'ALL', 'ALL') : null}
          {branches.map((b) => row(String(b.id), branchOptionLabel(b), countOf(b.id), value === b.id, b.id))}
        </ul>
      ) : null}
    </div>
  );
}

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** The days of a month as a Monday-first grid, '' for the padding cells. */
function monthGrid(month: string): string[] {
  const first = new Date(`${month}-01T00:00:00.000Z`);
  const pad = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return [
    ...Array<string>(pad).fill(''),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
}

/**
 * "KHOẢNG NGÀY" IN ONE CONTROL: one button, one calendar — the first press is the
 * start, the second the end (either order), and it closes. No second date box.
 */
export function DateRangePicker({
  value,
  onChange,
  max,
  testId = 'period-range',
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  max?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [month, setMonth] = useState(() => (value.from || max || new Date().toISOString()).slice(0, 7));
  const ref = useDismiss(open, () => {
    setOpen(false);
    setAnchor(null);
  });
  const label =
    value.from && value.to ? `${formatDate(value.from)} – ${formatDate(value.to)}` : value.from ? `${formatDate(value.from)} – …` : 'Chọn khoảng ngày';
  const pick = (day: string) => {
    if (!anchor) {
      setAnchor(day);
      onChange({ from: day, to: '' });
      return;
    }
    const [from, to] = anchor <= day ? [anchor, day] : [day, anchor];
    onChange({ from, to });
    setAnchor(null);
    setOpen(false);
  };
  const inRange = (day: string) => value.from !== '' && value.to !== '' && day >= value.from && day <= value.to;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Khoảng ngày"
        data-testid={testId}
        onClick={() => {
          // Opens on the month the range ends in (today's, usually), never a stale one.
          setMonth((value.to || value.from || max || new Date().toISOString()).slice(0, 7));
          setOpen((v) => !v);
        }}
        className={`${CONTROL} inline-flex items-center gap-2`}
      >
        <CalendarRange className="h-4 w-4 text-slate-500" aria-hidden="true" />
        <span className={value.from ? 'tabular-nums' : 'text-slate-500'}>{label}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Chọn khoảng ngày"
          className="absolute left-0 z-30 mt-1 w-[18.5rem] rounded-xl border border-line-strong bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="Tháng trước" onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg p-1.5 hover:bg-slate-100">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="text-sm font-semibold text-slate-800">
              Tháng {Number(month.slice(5, 7))}/{month.slice(0, 4)}
            </span>
            <button type="button" aria-label="Tháng sau" onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg p-1.5 hover:bg-slate-100">
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mb-2 text-xs text-slate-500">{anchor ? 'Chọn ngày kết thúc' : 'Chọn ngày bắt đầu'}</p>
          <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
            {WEEKDAYS.map((w) => (
              <span key={w} className="py-1 font-semibold text-slate-500">
                {w}
              </span>
            ))}
            {monthGrid(month).map((day, i) =>
              day ? (
                <button
                  key={day}
                  type="button"
                  disabled={max !== undefined && day > max}
                  data-testid={`${testId}-day-${day}`}
                  onClick={() => pick(day)}
                  className={`rounded-md py-1.5 text-sm tabular-nums disabled:cursor-not-allowed disabled:text-slate-300 ${
                    day === value.from || day === value.to || day === anchor
                      ? 'bg-brand-600 font-semibold text-white'
                      : inRange(day)
                        ? 'bg-brand-50 text-brand-800'
                        : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {Number(day.slice(8, 10))}
                </button>
              ) : (
                <span key={`pad-${i}`} />
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
