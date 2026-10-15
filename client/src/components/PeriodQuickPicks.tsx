/**
 * "Hôm nay · 7 ngày · 30 ngày" — the one quick-period control, for every screen
 * that filters by a range of days (the Admin's reports, Reception's "Hoàn thành
 * vấn đề"). Each choice ends TODAY; the pressed one is the range on screen.
 *
 * One control, not one per page, so a period is chosen the same way wherever
 * it is chosen.
 */
import type { DateRangeValue } from './DateRangeField';
import { daysBefore } from '../lib/shiftGroups';

const PICKS = [
  ['Hôm nay', 0],
  ['7 ngày', 6],
  ['30 ngày', 29],
] as const;

export function PeriodQuickPicks({
  value,
  onChange,
  today,
  testId,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** Today's business date (`hcmToday()`), passed in so every pick agrees with the page. */
  today: string;
  /** Each button is `${testId}-${daysBack}`: 0, 6 or 29. */
  testId: string;
}) {
  return (
    <div>
      <p aria-hidden="true" className="mb-1 text-xs font-medium text-slate-500">
        Chọn nhanh
      </p>
      <div
        className="inline-flex overflow-hidden rounded-xl border border-line-strong bg-white"
        role="group"
        aria-label="Chọn nhanh khoảng thời gian"
      >
        {PICKS.map(([text, back], i) => {
          const from = daysBefore(today, back);
          const active = value.from === from && value.to === today;
          return (
            <button
              key={text}
              type="button"
              onClick={() => onChange({ from, to: today })}
              aria-pressed={active}
              data-testid={`${testId}-${back}`}
              className={`min-h-[2.75rem] whitespace-nowrap px-3.5 text-sm transition-colors focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                i > 0 ? 'border-l border-line-strong' : ''
              } ${active ? 'bg-brand-50 font-semibold text-brand-700' : 'font-medium text-slate-600 hover:bg-slate-50'}`}
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
