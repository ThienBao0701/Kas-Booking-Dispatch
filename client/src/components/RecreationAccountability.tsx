/**
 * "Cần tạo lại" accountability, for the Admin.
 *
 * WHAT IT ANSWERS
 *
 * Which branch, which shift and which receptionist produced the orders that
 * later had to be created again — over a period the Admin chooses. It is an
 * AUDIT view: it counts and it lists, and it does not score anyone or rank
 * people against a threshold. Whether twelve is a lot is a judgement for whoever
 * reads it.
 *
 * WHY THE ORIGINAL CREATOR SURVIVES HERE
 *
 * Each row is one immutable creation ATTEMPT, so attempt 1 remains the original
 * creator for ever and a re-creation adds a row beside it rather than replacing
 * anything. Withdrawing and re-sending the order does not erase who first
 * created it, which is exactly what this view exists to preserve.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import {
  recreationReportPdfUrl,
  reportsApi,
  type RecreationRow,
} from '../api/reports';
import type { ShiftType } from '../api/shifts';
import { Card } from './Card';
import { DataTable, type DataColumn } from './DataTable';
import { Button } from './Button';
import { DateRangeField, type DateRangeValue } from './DateRangeField';
import { EmptyState } from './EmptyState';
import { QueryState } from './PageState';
import { formatDateTime, hcmToday } from '../lib/format';

/** The last 30 days, which is what an end-of-month review actually asks for. */
function defaultRange(): DateRangeValue {
  const today = hcmToday();
  const from = new Date(Date.parse(`${today}T00:00:00.000Z`) - 29 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to: today };
}

const SHIFTS: { value: ShiftType; label: string }[] = [
  { value: 'A', label: 'Ca A' },
  { value: 'B', label: 'Ca B' },
  { value: 'C', label: 'Ca C' },
  { value: 'A4', label: 'Ca A4' },
  { value: 'C4', label: 'Ca C4' },
];

const SOURCES = [
  { value: 'BOOKING_COM', label: 'Booking.com' },
  { value: 'AGODA', label: 'Agoda' },
  { value: 'CTRIP', label: 'CTrip' },
];

export function RecreationAccountability({ branchId }: { branchId?: number }) {
  const [range, setRange] = useState<DateRangeValue>(defaultRange);
  const [shiftType, setShiftType] = useState<ShiftType | ''>('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState(false);

  // An incomplete range is never sent: the server refuses it, and asking would
  // replace the panel with an error the operator did not cause.
  const ready = range.from !== '' && range.to !== '';
  const filter = {
    from: range.from,
    to: range.to,
    branchId,
    // Narrowing is optional, and an unset filter is omitted rather than sent
    // empty — the server treats a missing key as "every one of them".
    shiftType: shiftType || undefined,
    source: source || undefined,
  };

  const report = useQuery({
    queryKey: ['recreation-report', filter],
    queryFn: () => reportsApi.recreations(filter),
    enabled: open && ready,
  });

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-800">Thống kê đơn cần tạo lại</h2>
        </div>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)} data-testid="recreation-toggle">
          {open ? 'Ẩn thống kê' : 'Xem thống kê'}
        </Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <DateRangeField
              legend="Khoảng thời gian"
              value={range}
              onChange={setRange}
              testId="recreation-range"
            />
            <label className="text-sm font-medium text-slate-600">
              Ca làm việc
              <select
                value={shiftType}
                aria-label="Ca làm việc"
                onChange={(e) => setShiftType(e.target.value as ShiftType | '')}
                className="mt-1 block rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                <option value="">Tất cả ca</option>
                {SHIFTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-600">
              Nguồn
              <select
                value={source}
                aria-label="Nguồn"
                onChange={(e) => setSource(e.target.value)}
                className="mt-1 block rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                <option value="">Tất cả nguồn</option>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={!ready}
              data-testid="recreation-export"
              onClick={() => window.open(recreationReportPdfUrl(filter), '_blank', 'noopener')}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Xuất PDF
            </Button>
            <Button
              variant="secondary"
              disabled={!ready || report.isFetching}
              data-testid="recreation-refresh"
              onClick={() => void report.refetch()}
              aria-label="Làm mới thống kê"
              title="Làm mới thống kê"
            >
              <RefreshCw className={`h-4 w-4 ${report.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            </Button>
          </div>

          <QueryState isLoading={report.isLoading} isError={report.isError} error={report.error}>
            {report.data && report.data.totals.total === 0 ? (
              <EmptyState
                icon={<RotateCcw className="h-6 w-6" aria-hidden="true" />}
                title="Không có đơn cần tạo lại"
                message="Không có đơn nào bị từ chối trong khoảng thời gian này."
              />
            ) : report.data ? (
              <>
                {/*
                  ONE STRIP, NOT FOUR CARDS. The total is the headline; how many
                  branches, shifts and people it spreads across is context for it,
                  read in one line.
                */}
                <div
                  className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                  data-testid="recreation-summary"
                >
                  <p className="text-slate-700" data-testid="recreation-total">
                    Tổng số đơn cần tạo lại: <strong className="text-base text-slate-900">{report.data.totals.total}</strong>
                  </p>
                  <p className="text-xs text-slate-500">
                    {Object.keys(report.data.totals.byBranch).length} chi nhánh ·{' '}
                    {Object.keys(report.data.totals.byShift).length} ca ·{' '}
                    {Object.keys(report.data.totals.byReceptionist).length} lễ tân
                  </p>
                </div>

                {/*
                  THREE SMALL TABLES, SIDE BY SIDE on a wide screen, stacked on a
                  phone. The receptionist list is the one that grows without
                  limit, so it shows its top rows and opens the rest on request
                  instead of pushing the orders below off the screen.
                */}
                <div className="grid gap-3 lg:grid-cols-3">
                  <TotalsTable title="Theo chi nhánh" column="Chi nhánh" totals={report.data.totals.byBranch} />
                  <TotalsTable title="Theo ca làm việc" column="Ca" totals={report.data.totals.byShift} />
                  <TotalsTable title="Theo lễ tân" column="Lễ tân" totals={report.data.totals.byReceptionist} limit={8} />
                </div>

                <DataTable
                  testId="recreation-rows"
                  title="Danh sách đơn cần tạo lại"
                  badge={report.data.rows.length}
                  columns={ROW_COLUMNS}
                  rows={report.data.rows}
                  rowKey={(r) => r.proofId}
                  emptyTitle="Không có đơn"
                  emptyMessage="Không có đơn nào bị từ chối trong khoảng thời gian này."
                />
              </>
            ) : null}
          </QueryState>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A breakdown as a compact two-column table — label and count, biggest first.
 *
 * `limit` caps a list that grows with the staff (receptionists) so the
 * statistics never take over the page; the rest is one click away.
 */
function TotalsTable({
  title,
  column,
  totals,
  limit,
}: {
  title: string;
  column: string;
  totals: Record<string, number>;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  // Biggest first, ties broken by label so two renders never disagree.
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
  const shown = limit && !all ? entries.slice(0, limit) : entries;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {entries.length === 0 ? (
        <p className="px-3 py-2 text-sm text-slate-500">Không có dữ liệu.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">{column}</th>
              <th scope="col">Tổng</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(([label, count]) => (
              <tr key={label}>
                <td className="max-w-0 truncate px-3 py-1.5 text-slate-700" title={label}>
                  {label}
                </td>
                <td className="w-[1%] whitespace-nowrap px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900">
                  {count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {limit && entries.length > limit ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-t border-slate-100 px-3 py-1.5 text-left text-xs font-medium text-brand-700 hover:bg-slate-50"
        >
          {all ? 'Thu gọn' : `Xem tất cả (${entries.length})`}
        </button>
      ) : null}
    </section>
  );
}

const ROW_COLUMNS: DataColumn<RecreationRow>[] = [
  {
    key: 'branch',
    header: 'Chi nhánh',
    className: 'whitespace-nowrap text-slate-600',
    render: (r) => r.branch?.address ?? '—',
  },
  { key: 'code', header: 'Mã đơn', className: 'whitespace-nowrap font-medium text-slate-800', render: (r) => r.bookingCode },
  { key: 'source', header: 'Nguồn', secondary: true, className: 'whitespace-nowrap text-slate-600', render: (r) => r.source ?? '—' },
  {
    key: 'created',
    header: 'Ngày tạo đơn',
    secondary: true,
    className: 'whitespace-nowrap text-slate-500',
    render: (r) => formatDateTime(r.bookingCreatedAt),
  },
  { key: 'who', header: 'Lễ tân', className: 'whitespace-nowrap text-slate-800', render: (r) => r.receptionistName },
  { key: 'shift', header: 'Ca', className: 'whitespace-nowrap text-slate-600', render: (r) => r.shiftLabel },
  { key: 'attempt', header: 'Lần tạo', align: 'right', secondary: true, className: 'w-[1%]', render: (r) => r.attemptNumber },
  {
    key: 'rejected',
    header: 'Bị từ chối',
    className: 'whitespace-nowrap text-slate-500',
    render: (r) => (r.reviewedAt ? formatDateTime(r.reviewedAt) : '—'),
  },
];
