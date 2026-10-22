/**
 * ONE SMALL BAR CHART for the manager's reporting screens — no chart library.
 *
 *   stacked   one bar per bucket, its series stacked (KPI: phát sinh by their
 *             collection status — each finding counted once);
 *   grouped   the series side by side (Báo cáo: được giao beside hoàn thành).
 *
 * One y-axis, always counts. Thin bars rounded at the data end, a 2px gap between
 * stacked segments, recessive grid. Every bar is focusable and names its bucket
 * and values (hover or keyboard shows the same tooltip); the legend is always
 * there for two series or more, so no series is identified by colour alone.
 */
import { useState } from 'react';

export interface ChartSeries {
  key: string;
  label: string;
  /** A Tailwind background class — a validated status / series colour. */
  colorClass: string;
}

export interface ChartBucket {
  key: string;
  /** The axis label: "08:00", "15/10". */
  label: string;
  /** The tooltip's title: "08:00–09:00", "Thứ Năm 15/10/2026". */
  title: string;
  values: Record<string, number>;
}

/** A round axis maximum: 1, 2, 5 × 10ⁿ steps, four of them. */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 4) return { top: 4, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  return { top: step * 4, step };
}

export function BarChart({
  buckets,
  series,
  mode,
  unit,
  label,
  testId,
}: {
  buckets: ChartBucket[];
  series: ChartSeries[];
  mode: 'stacked' | 'grouped';
  /** "phát sinh", "phòng" — said in the tooltip after each value. */
  unit: string;
  /** What the chart shows, for screen readers. */
  label: string;
  testId?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const totals = buckets.map((b) => series.reduce((s, x) => s + (b.values[x.key] ?? 0), 0));
  const peak =
    mode === 'stacked' ? Math.max(0, ...totals) : Math.max(0, ...buckets.flatMap((b) => series.map((x) => b.values[x.key] ?? 0)));
  const { top, step } = niceMax(peak);
  const ticks = [4, 3, 2, 1, 0].map((i) => i * step);
  // Many buckets: label every n-th on the axis (all of them stay in the tooltips).
  const every = buckets.length > 16 ? Math.ceil(buckets.length / 12) : 1;
  const pct = (n: number) => `${(n / top) * 100}%`;

  return (
    <figure data-testid={testId} className="min-w-0">
      {series.length > 1 ? (
        <figcaption className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-sm ${s.colorClass}`} />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
      <div className="flex gap-2">
        {/* y-axis */}
        <div className="relative h-44 w-7 shrink-0 text-right text-[11px] tabular-nums text-slate-500" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative h-44" style={{ minWidth: `${Math.max(buckets.length * 1.75, 10)}rem` }}>
            {/* grid */}
            {ticks.map((t) => (
              <span
                key={t}
                aria-hidden="true"
                className={`absolute inset-x-0 border-t ${t === 0 ? 'border-slate-300' : 'border-dashed border-slate-200'}`}
                style={{ top: `${100 - (t / top) * 100}%` }}
              />
            ))}
            <ul className="absolute inset-0 flex items-end" role="list" aria-label={label}>
              {buckets.map((b, i) => {
                const sum = totals[i] ?? 0;
                const words = series.map((s) => `${s.label}: ${b.values[s.key] ?? 0} ${unit}`).join(', ');
                const open = hover === b.key;
                return (
                  <li
                    key={b.key}
                    tabIndex={0}
                    aria-label={`${b.title} — ${words}`}
                    data-testid={testId ? `${testId}-bucket-${b.key}` : undefined}
                    onMouseEnter={() => setHover(b.key)}
                    onMouseLeave={() => setHover((h) => (h === b.key ? null : h))}
                    onFocus={() => setHover(b.key)}
                    onBlur={() => setHover((h) => (h === b.key ? null : h))}
                    className="relative flex h-full min-w-0 flex-1 items-end justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    {open ? <span className="absolute inset-x-0.5 bottom-0 top-0 rounded bg-slate-100/70" aria-hidden="true" /> : null}
                    {mode === 'stacked' ? (
                      <span className="relative flex h-full w-[55%] max-w-[1.75rem] flex-col-reverse" aria-hidden="true">
                        {sum > 0
                          ? series.map((s, j) => {
                              const v = b.values[s.key] ?? 0;
                              if (v === 0) return null;
                              const lastShown = series.slice(j + 1).every((x) => (b.values[x.key] ?? 0) === 0);
                              return (
                                <span
                                  key={s.key}
                                  className={`${s.colorClass} ${lastShown ? 'rounded-t' : ''} [&:not(:first-child)]:mb-0.5`}
                                  style={{ height: pct(v) }}
                                />
                              );
                            })
                          : null}
                      </span>
                    ) : (
                      <span className="relative flex h-full w-[70%] max-w-[3rem] items-end justify-center gap-0.5" aria-hidden="true">
                        {series.map((s) => {
                          const v = b.values[s.key] ?? 0;
                          return <span key={s.key} className={`w-full max-w-[1rem] rounded-t ${v > 0 ? s.colorClass : ''}`} style={{ height: pct(v) }} />;
                        })}
                      </span>
                    )}
                    {open ? (
                      <span
                        role="tooltip"
                        className={`pointer-events-none absolute top-1 z-10 w-max max-w-[14rem] rounded-lg border border-line-subtle bg-white px-2.5 py-2 text-left text-xs shadow-lg ${
                          i > buckets.length / 2 ? 'right-full mr-1' : 'left-full ml-1'
                        }`}
                      >
                        <span className="mb-1 block font-semibold text-slate-900">{b.title}</span>
                        {series.map((s) => (
                          <span key={s.key} className="flex items-center justify-between gap-4 text-slate-700">
                            <span className="inline-flex items-center gap-1.5">
                              <span className={`h-2 w-2 rounded-sm ${s.colorClass}`} aria-hidden="true" />
                              {s.label}
                            </span>
                            <span className="font-semibold tabular-nums text-slate-900">{b.values[s.key] ?? 0}</span>
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="flex pt-1.5" style={{ minWidth: `${Math.max(buckets.length * 1.75, 10)}rem` }} aria-hidden="true">
            {buckets.map((b, i) => (
              <span key={b.key} className="min-w-0 flex-1 truncate text-center text-[11px] tabular-nums text-slate-500">
                {i % every === 0 ? b.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}
