/**
 * THE ONE TABLE the reception operational module uses.
 *
 * WHY A SHARED COMPONENT AND NOT FIVE TABLES
 *
 * Five categories each grew their own markup, and they drifted: different row
 * heights, different empty states, money left-aligned in one and right in
 * another. A receptionist reads these all shift; the cost of that drift is paid
 * every time they look away and back. One component means one set of decisions.
 *
 * WHAT IT DECIDES, SO CALLERS DO NOT HAVE TO
 *
 *   money right, text left      a column of amounts is read by running down it,
 *                               and left-aligned digits cannot be compared
 *   one row height              set by padding, not by content, so the eye can
 *                               track across a wide row
 *   empty / loading / error     all three, always, because a table that renders
 *                               nothing on failure looks like a table with no data
 *
 * HOW IT HANDLES A NARROW SCREEN
 *
 * NOT by shrinking the type. Columns marked `secondary` drop out below `md` and
 * reappear inside a per-row detail panel behind a chevron, so the columns that
 * identify a row — who, what, how much — stay visible on a phone and the rest is
 * one tap away. Horizontal scrolling is the last resort, not the first.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { toUserMessage } from '../api/errors';
import { ErrorAlert } from './ErrorAlert';

export interface DataColumn<T> {
  /** Stable key — also the label used in the mobile detail panel. */
  key: string;
  header: string;
  /** RIGHT for money and counts. Everything else reads better left. */
  align?: 'left' | 'right';
  /**
   * Hidden below `md`, shown in the row's detail panel instead.
   *
   * Mark everything that is not needed to RECOGNISE the row. Amounts and names
   * are primary; a note, an internal code or a second timestamp is not.
   */
  secondary?: boolean;
  /** e.g. `w-[1%] whitespace-nowrap` to keep a narrow column narrow. */
  className?: string;
  render: (row: T, index: number) => ReactNode;
}

interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** The section heading above the table. */
  title: string;
  /** Shown beside the title — usually the row count. */
  badge?: ReactNode;
  /** Right-hand side of the header bar, e.g. a totals chip or an action. */
  headerAction?: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle: string;
  emptyMessage: string;
  /** Row-level actions. Rendered in a trailing column when present. */
  actions?: (row: T) => ReactNode;
  /** Extra classes on the `<tr>` — used to grey a voided row. */
  rowClassName?: (row: T) => string;
  /** Rendered under the row when its detail panel is open, on every width. */
  renderDetail?: (row: T) => ReactNode;
  /**
   * Where the expander is offered. `mobile` (the default) is reception's:
   * the chevron exists only below `md`, because above it the secondary columns
   * are already on screen and there is nothing left to reveal.
   *
   * `always` is for a READING screen — the Admin's — where a row is a summary
   * of a record that has more to it than fits a row at any width. Opt-in, so
   * reception's tables keep the behaviour they were built with.
   */
  detailToggle?: 'mobile' | 'always';
  /**
   * Whether more than one row may be open at once.
   *
   * Reception opens a row to check the one it just typed, so one at a time
   * keeps the list short. An Admin opens two BECAUSE they are comparing them —
   * reconciling a disputed payment against the one before it — and a table that
   * closes the first when you open the second cannot answer that question.
   */
  multiExpand?: boolean;
  testId?: string;
  /** A footer strip under the table, e.g. category totals. */
  footer?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  title,
  badge,
  headerAction,
  isLoading,
  isError,
  error,
  onRetry,
  emptyTitle,
  emptyMessage,
  actions,
  rowClassName,
  renderDetail,
  detailToggle = 'mobile',
  multiExpand = false,
  testId,
  footer,
}: DataTableProps<T>) {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleRow = (key: string) =>
    setOpenRows((prev) => {
      // Starting from an empty set when single-open is what closes the other one.
      const next = new Set(multiExpand ? prev : []);
      if (prev.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const secondary = columns.filter((c) => c.secondary);
  // A chevron column is pointless when nothing is ever hidden behind it.
  const expandable = secondary.length > 0 || renderDetail !== undefined;
  /* Hidden above `md` unless the caller asked for it at every width. */
  const toggleHidden = detailToggle === 'always' ? '' : 'md:hidden';
  // The Admin detail panel is the full record, so the mobile-only <dl> of
  // hidden columns underneath it would be the same fields a second time.
  const detailReplacesSecondary = detailToggle === 'always' && renderDetail !== undefined;

  return (
    <section
      data-testid={testId}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-800">
          {title}
          {badge !== undefined ? (
            <span className="ml-2 rounded bg-slate-200/80 px-1.5 py-0.5 text-xs font-medium tabular-nums text-slate-600">
              {badge}
            </span>
          ) : null}
        </h3>
        {headerAction}
      </header>

      {isLoading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Đang tải…
        </p>
      ) : isError ? (
        <div className="px-4 py-6">
          <ErrorAlert>{toUserMessage(error)}</ErrorAlert>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              data-testid={testId ? `${testId}-retry` : undefined}
              className="mt-3 inline-flex min-h-[2.5rem] items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Thử lại
            </button>
          ) : null}
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid={testId ? `${testId}-empty` : undefined}
          className="px-4 py-10 text-center"
        >
          <p className="text-sm font-medium text-slate-700">{emptyTitle}</p>
          <p className="mt-1 text-sm text-slate-500">{emptyMessage}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                {expandable ? <th className={`w-[1%] px-2 py-2 ${toggleHidden}`} /> : null}
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`px-3 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'} ${
                      c.secondary ? 'hidden md:table-cell' : ''
                    } ${c.className ?? ''}`}
                  >
                    {c.header}
                  </th>
                ))}
                {actions ? (
                  <th scope="col" className="w-[1%] whitespace-nowrap px-3 py-2 text-right font-medium">
                    Thao tác
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => {
                const key = rowKey(row);
                return (
                  <FragmentRow
                    key={key}
                    rowId={key}
                    open={openRows.has(key)}
                    expandable={expandable}
                    toggleHidden={toggleHidden}
                    onToggle={() => toggleRow(key)}
                    columns={columns}
                    secondary={secondary}
                    detailReplacesSecondary={detailReplacesSecondary}
                    row={row}
                    index={index}
                    actions={actions}
                    rowClassName={rowClassName}
                    renderDetail={renderDetail}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {footer && !isLoading && !isError ? (
        <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-2.5">{footer}</div>
      ) : null}
    </section>
  );
}

function FragmentRow<T>({
  rowId,
  open,
  expandable,
  toggleHidden,
  onToggle,
  columns,
  secondary,
  detailReplacesSecondary,
  row,
  index,
  actions,
  rowClassName,
  renderDetail,
}: {
  rowId: string;
  open: boolean;
  expandable: boolean;
  toggleHidden: string;
  detailReplacesSecondary: boolean;
  onToggle: () => void;
  columns: DataColumn<T>[];
  secondary: DataColumn<T>[];
  row: T;
  index: number;
  actions?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string;
  renderDetail?: (row: T) => ReactNode;
}) {
  const span = columns.length + (actions ? 1 : 0) + (expandable ? 1 : 0);
  return (
    <>
      <tr
        data-testid={`row-${rowId}`}
        className={`transition-colors hover:bg-slate-50 ${rowClassName?.(row) ?? ''}`}
      >
        {expandable ? (
          <td className={`px-2 py-2 align-top ${toggleHidden}`}>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={open ? 'Thu gọn' : 'Xem thêm'}
              data-testid={`row-toggle-${rowId}`}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              {open ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </td>
        ) : null}
        {columns.map((c) => (
          <td
            key={c.key}
            className={`px-3 py-2.5 align-top ${c.align === 'right' ? 'text-right tabular-nums' : 'text-left'} ${
              c.secondary ? 'hidden md:table-cell' : ''
            } ${c.className ?? ''}`}
          >
            {c.render(row, index)}
          </td>
        ))}
        {actions ? (
          <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{actions(row)}</td>
        ) : null}
      </tr>

      {/*
        The detail panel. On a phone it carries the columns that dropped out; on
        a wide screen those columns are already visible, so only an explicit
        `renderDetail` has anything left to show.
      */}
      {open ? (
        <tr data-testid={`row-detail-${rowId}`} className="bg-slate-50/60">
          <td colSpan={span} className="px-4 py-3">
            {/*
              A caller whose detail IS the whole record (detailToggle 'always')
              would otherwise print every hidden column twice on a phone: once
              here and once inside its own panel below.
            */}
            {secondary.length > 0 && !detailReplacesSecondary ? (
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 md:hidden">
                {secondary.map((c) => (
                  <div key={c.key}>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">{c.header}</dt>
                    <dd className="text-sm text-slate-800">{c.render(row, index)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {renderDetail?.(row)}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The two row actions this module uses, so they look the same everywhere. */
export function RowAction({
  onClick,
  children,
  tone = 'default',
  testId,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  /** `danger` for a void — destructive, but never the loudest thing on screen. */
  tone?: 'default' | 'danger';
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`ml-1 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        tone === 'danger'
          ? 'border-rose-200 text-rose-600 hover:bg-rose-50'
          : 'border-slate-300 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}
