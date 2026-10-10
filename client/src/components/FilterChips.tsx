import { X } from 'lucide-react';

export interface ActiveFilter {
  /** Stable id, used as the removal key. */
  id: string;
  /** What the operator sees, e.g. "Nguồn: Agoda". */
  label: string;
}

/**
 * The filters currently in force, each removable.
 *
 * A filter bar with a dozen collapsed controls hides its own state: an operator
 * wonders why a booking they can see in another tab is missing here, and the
 * answer is a date range set four screens ago. Every active filter gets a chip,
 * so what is being excluded is always legible and always one click from gone.
 */
export function FilterChips({
  filters,
  onRemove,
  onClearAll,
}: {
  filters: ActiveFilter[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
}) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filter-chips">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Đang lọc</span>
      {filters.map((f) => (
        <span
          key={f.id}
          className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-3 pr-1 text-sm text-brand-700 ring-1 ring-inset ring-brand-200"
          data-testid="filter-chip"
        >
          {f.label}
          <button
            type="button"
            onClick={() => onRemove(f.id)}
            aria-label={`Bỏ lọc ${f.label}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="rounded-lg px-2 py-1 text-sm font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        data-testid="filter-clear-all"
      >
        Xoá tất cả
      </button>
    </div>
  );
}

/**
 * A multi-select rendered as toggle buttons rather than a `<select multiple>`.
 *
 * The native control needs ctrl-click to select a second value, which is not
 * discoverable and does not exist on a touch screen — and reception works on
 * tablets. These are ordinary buttons with `aria-pressed`, so they are
 * keyboard-reachable and announced correctly.
 */
export function MultiSelect<T extends string>({
  legend,
  options,
  selected,
  onChange,
  testId,
  orientation = 'wrap',
}: {
  legend: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  testId?: string;
  /**
   * `wrap` packs options onto as few rows as fit — the default, and right for
   * short labels. `stack` gives each option its own row.
   *
   * Stacking is opt-in rather than the new default because wrapping is the
   * correct behaviour for most option sets; it matters where labels are long
   * enough that a wrapped row reads as two unrelated columns, which is how "Đã
   * huỷ" ended up sitting beside a neighbour.
   */
  orientation?: 'wrap' | 'stack';
}) {
  function toggle(value: T) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <fieldset data-testid={testId}>
      <legend className="mb-1 text-xs font-medium text-slate-500">{legend}</legend>
      <div
        className={
          orientation === 'stack'
            // `items-start` so each button is only as wide as its label rather
            // than stretching across the column.
            ? 'flex flex-col items-start gap-1.5'
            : 'flex flex-wrap gap-1.5'
        }
      >
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.value)}
              data-testid={testId ? `${testId}-${o.value}` : undefined}
              className={`min-h-[2.25rem] rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                on
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
