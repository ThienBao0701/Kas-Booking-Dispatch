/**
 * ONE CATEGORY of the reception overview, framed the same way for all five.
 *
 * A clearly bounded block — a stronger outline than an ordinary card, a header
 * bar that is visibly not part of the table — so five categories stacked on one
 * page read as five sections rather than one long list of rows.
 *
 * THE MARKER IS THE CATEGORY'S NUMBER IN THE OFFICIAL REPORT (I–V). It is the
 * only accent, in the brand colour, and it means the same thing on screen as it
 * does in the exported PDF — nothing here is decoration for its own sake.
 */
import type { ReactNode } from 'react';

/** What turns a table into a report section. */
export interface SectionFrame {
  /**
   * The short mark beside the title: a category's numeral in the official
   * report ("I"–"V") on reception's overview, a shift's code ("A", "C4") on the
   * Admin's. Omitted where nothing short identifies the section.
   */
  marker?: string;
}

/** The one count badge beside a section title. */
export function SectionCount({ value }: { value: ReactNode }) {
  return (
    <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700">
      {value}
    </span>
  );
}

export function ReportSection({
  marker,
  title,
  count,
  aside,
  testId,
  children,
}: {
  marker?: string;
  title: string;
  /** The records the section actually holds — omitted where a count means nothing. */
  count?: ReactNode;
  /** Right-hand side of the header; drops to its own line on a phone. */
  aside?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      {/*
        The marker stays beside the title and the count flows right after the
        title's last word, so a long title on a phone wraps as text instead of
        leaving the marker and the count stranded on lines of their own.

        The title keeps its natural width against the aside: when the two do not
        fit on one line it is the aside that moves down, never the title that is
        squeezed into a column one word wide.
      */}
      <header className="flex flex-wrap items-start gap-x-4 gap-y-1.5 border-b border-slate-300 bg-slate-50 px-4 py-2.5">
        <div className="flex min-w-0 flex-auto items-start gap-2.5">
          {marker ? (
            <span
              aria-hidden="true"
              className="inline-flex h-6 min-w-[1.5rem] shrink-0 items-center justify-center rounded-md bg-brand-600 px-1 text-[11px] font-bold text-white"
            >
              {marker}
            </span>
          ) : null}
          <h3 className="min-w-0 flex-auto text-[15px] font-semibold leading-6 text-slate-900">
            {title}
            {count !== undefined ? (
              <span className="ml-2 inline-block align-[1px]">
                <SectionCount value={count} />
              </span>
            ) : null}
          </h3>
        </div>
        {aside ? <div className="basis-full sm:ml-auto sm:basis-auto sm:self-center">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}
