/**
 * THE ADMIN'S "BÁO CÁO VẤN ĐỀ": khoảng thời gian · chi nhánh · danh mục → bản ghi.
 *
 * THE QUESTION IS "WHO RECORDED WHAT, ON WHICH SHIFT, ON WHICH DAY" — so the
 * records are laid out CHI NHÁNH → NGÀY NGHIỆP VỤ → CA → NHÂN VIÊN, each shift a
 * compact table of its own. The day is the SHIFT's business date, applied by the
 * server: Ca C of the 23rd, ending at 06:00 on the 24th, is the 23rd's.
 *
 * OPEN SHIFTS ARE SHOWN, FLAGGED, AND LEFT OUT OF THE EXPORT. The official report
 * for a day contains only shifts that have pressed "Kết thúc ca"; until then the
 * screen says "Ca chưa kết thúc chưa được đưa vào báo cáo chính thức."
 *
 * "Sự cố vật chất đang xử lý" here is the incident monitor that used to be the
 * separate "Sự cố khách sạn" screen: the HotelIssue rows themselves.
 *
 * THREE FILTERS, NO MORE: a period, a branch, a category. All three are applied
 * by the SERVER — this page never filters rows itself — and the export uses the
 * same three, so a PDF always contains exactly what the screen was showing.
 * There is still no employee filter, no status filter and no query builder:
 * every filter added between the branch and the rows is one more way to be
 * looking at a subset while believing you are looking at everything.
 *
 * THE COUNTS NEVER REPLACE THE ROWS. They sit ON the category buttons and are
 * computed by the server for the chosen period and branch; choosing one shows
 * every record.
 *
 * A TABLE, NOT A STACK OF CARDS. The full record, correction history and all,
 * is one click down inside the row.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, Download, FileSpreadsheet } from 'lucide-react';
import {
  adminReportsApi,
  operationalPdfUrl,
  operationalXlsxUrl,
  reportsApi,
  type CashSummary,
  type OpenShiftNotice,
  type OperationalReport,
  type ReportCategory,
  type RoomServiceType,
} from '../api/receptionReports';
import { adminBranchesApi } from '../api/adminBranches';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { QueryState } from '../components/PageState';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import {
  AdminAllCategoriesTable,
  AdminGuestRequestTable,
  AdminPaymentTable,
  AdminRoomServiceTable,
  AdminServiceQualityTable,
} from '../components/AdminOperationalTables';
import { RoomServiceTotals } from '../components/OperationalTables';
import { formatVnd } from '../lib/money';
import { formatDate, formatViWeekdayDate, hcmToday } from '../lib/format';
import { ROOM_SERVICE_FALLBACK_LABELS, ROOM_SERVICE_ORDER } from '../lib/roomServiceFields';
import { CATEGORY_FALLBACK_LABELS, CATEGORY_ORDER } from '../lib/reportCategories';
import { daysBefore, groupByBranch, type ShiftGroup } from '../lib/shiftGroups';
import { issuesApi } from '../api/issues';
import { IncidentExportModal, IncidentRangeSummary, IncidentTable } from '../components/IncidentReporting';
import { useIssueSummary } from '../hooks/useIssueSummary';

/** Not chosen yet · every branch · one branch. */
type BranchChoice = number | 'ALL' | null;

type TableState = { isLoading: boolean; isError: boolean; error: unknown; onRetry: () => void };

export function AdminOperationalReportsPage() {
  const today = hcmToday();
  const [searchParams] = useSearchParams();
  // A deep link (the old "Sự cố khách sạn" address redirects here) opens its
  // category directly — and an incident monitor starts on every branch.
  const linked = CATEGORY_ORDER.find((c) => c === searchParams.get('category')) ?? null;
  const [branch, setBranch] = useState<BranchChoice>(linked === 'FACILITY_ISSUE' ? 'ALL' : null);
  const [category, setCategory] = useState<ReportCategory | null>(linked);
  /*
    TODAY BY DEFAULT. An unbounded default read a branch's entire history —
    capped at 500 rows, so the screen quietly showed a fraction of it — beside a
    cash strip that covered one day. The period is now the first thing chosen
    and both the rows and the drawer follow it.
  */
  const [range, setRange] = useState<DateRangeValue>({ from: today, to: today });
  const [exportOpen, setExportOpen] = useState(false);

  const rangeValid = range.from !== '' && range.to !== '' && range.from <= range.to;

  const options = useQuery({
    queryKey: ['reception', 'reports', 'options'],
    queryFn: () => reportsApi.options(),
    staleTime: 60 * 60 * 1000,
  });

  /*
    THE BRANCHES COME FROM THE DATABASE. Not a hardcoded list of eight names and
    certainly not of eight ids: a ninth property opening, or one being renamed,
    must not need a code change here.
  */
  const branches = useQuery({
    queryKey: ['admin', 'branches'],
    queryFn: () => adminBranchesApi.list(),
  });

  const filters = {
    branchId: branch === 'ALL' || branch === null ? undefined : branch,
    category: category ?? undefined,
    from: range.from,
    to: range.to,
  };

  const data = useQuery({
    queryKey: ['admin', 'operational-reports', branch, category, range.from, range.to],
    queryFn: () => adminReportsApi.operational(filters),
    enabled: branch !== null && rangeValid,
  });

  const label = (c: ReportCategory) =>
    options.data?.categories.find((x) => x.code === c)?.label ?? CATEGORY_FALLBACK_LABELS[c];
  const serviceLabel = (t: RoomServiceType) =>
    options.data?.roomServiceTypes.find((x) => x.code === t)?.label ?? ROOM_SERVICE_FALLBACK_LABELS[t];

  const rows = data.data?.reports ?? [];
  const tableState: TableState = {
    isLoading: data.isLoading,
    isError: data.isError,
    error: data.error,
    onRetry: () => void data.refetch(),
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 max-w-[40rem]">
          <h1 className="text-xl font-bold leading-snug tracking-tight text-slate-900">Báo cáo vấn đề</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Chọn khoảng thời gian, chi nhánh và danh mục. Bản ghi được xếp theo ngày, ca và nhân viên.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setExportOpen(true)}
          disabled={branch === null || !rangeValid}
          data-testid="operational-export-open"
          className="ml-auto shadow-sm"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Xuất báo cáo
        </Button>
      </div>

      <QueryState
        isLoading={branches.isLoading}
        isError={branches.isError}
        error={branches.error}
        onRetry={() => void branches.refetch()}
      >
        {/*
          THE THREE FILTERS, as one block. Each is one decision, made once; every
          control is the same 44px tall so the row reads as one line of choices.
        */}
        <section
          data-testid="admin-filters"
          aria-label="Bộ lọc báo cáo"
          className="mb-4 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
        >
          <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            Bộ lọc báo cáo
          </p>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3">
            <div className="min-w-[17rem]">
              <DateRangeField
                legend="Khoảng thời gian"
                value={range}
                onChange={setRange}
                max={today}
                testId="admin-range"
              />
            </div>
            <div>
              <p aria-hidden="true" className="mb-1 text-xs font-medium text-slate-500">
                Chọn nhanh
              </p>
              <div
                className="inline-flex overflow-hidden rounded-xl border border-slate-300 bg-white"
                role="group"
                aria-label="Chọn nhanh khoảng thời gian"
              >
                {(
                  [
                    ['Hôm nay', 0],
                    ['7 ngày', 6],
                    ['30 ngày', 29],
                  ] as const
                ).map(([text, back], i) => {
                  const from = daysBefore(today, back);
                  const active = range.from === from && range.to === today;
                  return (
                    <button
                      key={text}
                      type="button"
                      onClick={() => setRange({ from, to: today })}
                      aria-pressed={active}
                      data-testid={`admin-range-${back}`}
                      className={`min-h-[2.75rem] whitespace-nowrap px-3.5 text-sm transition-colors focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                        i > 0 ? 'border-l border-slate-300' : ''
                      } ${
                        active
                          ? 'bg-brand-50 font-semibold text-brand-700'
                          : 'font-medium text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {text}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="min-w-[16rem] flex-1">
              <label htmlFor="admin-branch" className="mb-1 block text-xs font-medium text-slate-500">
                Chi nhánh
              </label>
              <select
                id="admin-branch"
                data-testid="branch-select"
                value={branch === null ? '' : String(branch)}
                onChange={(e) => {
                  const v = e.target.value;
                  setBranch(v === '' ? null : v === 'ALL' ? 'ALL' : Number(v));
                  setCategory(null);
                }}
                className="min-h-[2.75rem] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              >
                <option value="">— Chọn chi nhánh —</option>
                <option value="ALL">Tất cả chi nhánh</option>
                {(branches.data?.branches ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.address} · Chi nhánh {b.branchNumber}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </QueryState>

      {branch === null ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" aria-hidden="true" />}
          title="Chọn một chi nhánh"
          message="Sau khi chọn chi nhánh, bạn sẽ thấy năm danh mục và toàn bộ bản ghi, xếp theo ngày và ca."
        />
      ) : !rangeValid ? (
        <p data-testid="admin-range-invalid" className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : (
        <div className="space-y-4">
          {/*
            ONE SEGMENTED STRIP. On a phone it scrolls sideways inside itself
            rather than stacking six buttons into a wall; wider, it wraps within
            the same track so no category is ever hidden off the edge.
          */}
          <nav aria-label="Danh mục báo cáo" className="overflow-x-auto" data-testid="admin-category-menu">
            <div className="flex w-max gap-1 rounded-xl border border-slate-300 bg-slate-100 p-1 sm:w-auto sm:flex-wrap">
              <CategoryTab testId="admin-category-ALL" active={category === null} onClick={() => setCategory(null)}>
                Tất cả
              </CategoryTab>
              {CATEGORY_ORDER.map((c) => (
                <CategoryTab
                  key={c}
                  testId={`admin-category-${c}`}
                  active={category === c}
                  onClick={() => setCategory(c)}
                  // The incident tab lists HotelIssue rows, not journal entries, so a
                  // journal count on it would describe something else.
                  count={c === 'FACILITY_ISSUE' ? undefined : (data.data?.counts[c] ?? 0)}
                >
                  {label(c)}
                </CategoryTab>
              ))}
            </div>
          </nav>

          {/*
            AN UNFINISHED DAY SAYS SO. Shifts of this period that have not pressed
            "Kết thúc ca" are on screen, flagged, but not in the official export.
          */}
          {category !== 'FACILITY_ISSUE' && data.data && data.data.openShifts.length > 0 ? (
            <OpenShiftWarning notices={data.data.openShifts} warning={data.data.openShiftWarning} />
          ) : null}

          {/* Cash belongs to one drawer, so it is shown for a single branch only. */}
          {data.data?.cash && (category === null || category === 'PAYMENT') ? (
            <CashStrip cash={data.data.cash} period={data.data.cashPeriod} />
          ) : null}

          {/*
            THE CAP IS SAID OUT LOUD. A screen whose purpose is that the Admin
            sees full records must never quietly show a third of them — and the
            export is uncapped, so there is somewhere to send them.
          */}
          {data.data?.truncated ? (
            <p
              data-testid="operational-truncated"
              className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900"
            >
              Chỉ hiển thị {rows.length} bản ghi mới nhất trong tổng số {data.data.total}. Hãy chọn
              khoảng thời gian hoặc danh mục hẹp hơn, hoặc xuất báo cáo để xem đầy đủ.
            </p>
          ) : null}

          {category === 'FACILITY_ISSUE' ? (
            <AdminIncidentView branchId={filters.branchId} range={range} onPickBranch={setBranch} />
          ) : (
            <CategoryView
              category={category}
              rows={rows}
              label={label}
              serviceLabel={serviceLabel}
              tableState={tableState}
              showBranch={branch === 'ALL'}
            />
          )}
        </div>
      )}

      {exportOpen && branch !== null && rangeValid && category === 'FACILITY_ISSUE' ? (
        // The incident tab exports the incident report — the one the old
        // "Sự cố khách sạn" screen offered — for the same branch and period.
        <IncidentExportModal
          onClose={() => setExportOpen(false)}
          branchId={filters.branchId ?? null}
          initialRange={range}
        />
      ) : exportOpen && branch !== null && rangeValid ? (
        <ExportDialog
          openShifts={data.data?.openShifts ?? []}
          openShiftWarning={data.data?.openShiftWarning ?? ''}
          filters={filters}
          branchName={
            branch === 'ALL'
              ? 'Tất cả chi nhánh'
              : (branches.data?.branches.find((b) => b.id === branch)?.address ?? '')
          }
          categoryName={category ? label(category) : 'Tất cả danh mục'}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
    </div>
  );
}

function CategoryTab({
  children,
  count,
  active,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  count?: number;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  /*
    On a phone the strip scrolls sideways, so a category opened from a link
    (the old "Sự cố khách sạn" address) could be chosen yet out of sight. The
    strip — never the page — scrolls just far enough to show it.
  */
  useEffect(() => {
    const tab = ref.current;
    const strip = tab?.closest('nav');
    if (!active || !tab || !strip) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < s.left) strip.scrollLeft -= s.left - t.left + 8;
    else if (t.right > s.right) strip.scrollLeft += t.right - s.right + 8;
  }, [active]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={`inline-flex min-h-[2.5rem] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 sm:flex-auto ${
        active
          ? 'bg-white font-semibold text-brand-700 shadow-sm ring-1 ring-slate-300'
          : 'font-medium text-slate-600 hover:bg-white/70 hover:text-slate-900'
      }`}
    >
      {children}
      {/* A convenience for choosing; never a substitute for the rows. */}
      {count !== undefined ? (
        <span
          className={`inline-flex min-w-[1.5rem] justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
            active ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600'
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The category's own table for one set of rows — used once per shift group.
 *
 * Room service answers with one table per subtype present, because the columns
 * differ by subtype.
 */
function CategoryTable({
  category,
  rows,
  title,
  headerAction,
  grouped,
  marker,
  label,
  serviceLabel,
  tableState,
}: {
  category: ReportCategory | null;
  rows: OperationalReport[];
  title: string;
  headerAction?: ReactNode;
  /** Under a shift heading: leave out the columns it already states. */
  grouped?: boolean;
  /** The shift's code ("A", "C4") beside the title, when there is a shift. */
  marker?: string;
  label: (c: ReportCategory) => string;
  serviceLabel: (t: RoomServiceType) => string;
  tableState: TableState;
}) {
  // Every table is a report section: the same bounded frame as reception's
  // overview, so a day of shifts reads as a stack of distinct blocks.
  const props = { rows, title, headerAction, grouped, section: { marker }, ...tableState };
  if (category === 'PAYMENT') return <AdminPaymentTable {...props} />;
  if (category === 'GUEST_REQUEST') return <AdminGuestRequestTable {...props} />;
  if (category === 'CUSTOMER_COMPLAINT') return <AdminServiceQualityTable {...props} />;
  if (category === 'ROOM_SERVICE') {
    const present = ROOM_SERVICE_ORDER.filter((t) => rows.some((r) => r.roomService?.serviceType === t));
    if (present.length === 0) {
      /*
        Nothing at all. One empty table named for the CATEGORY — "Không có bán
        phòng" would say the branch sold no rooms, when what it recorded is no
        services of any kind.
      */
      return <AdminRoomServiceTable {...props} serviceType="ROOM_SALE" title={label('ROOM_SERVICE')} rows={[]} />;
    }
    return (
      <div className="space-y-3">
        {present.map((type) => (
          <AdminRoomServiceTable
            key={type}
            {...props}
            serviceType={type}
            title={`${title} · ${serviceLabel(type)}`}
            rows={rows.filter((r) => r.roomService?.serviceType === type)}
          />
        ))}
      </div>
    );
  }
  return <AdminAllCategoriesTable {...props} labelOf={label} />;
}
/**
 * CHI NHÁNH → NGÀY NGHIỆP VỤ → CA → NHÂN VIÊN → the records.
 *
 * Each shift is its own compact table, and the table's heading IS the shift and
 * the person — "Ca A · 06:00 – 14:00 · Nguyễn Văn A" — with what they recorded,
 * counted by category, on the right. The day sits above its shifts as one line,
 * and the branch above its days when several branches are on screen.
 */
function CategoryView({
  category,
  rows,
  label,
  serviceLabel,
  tableState,
  showBranch,
}: {
  category: ReportCategory | null;
  rows: OperationalReport[];
  label: (c: ReportCategory) => string;
  serviceLabel: (t: RoomServiceType) => string;
  tableState: TableState;
  showBranch: boolean;
}) {
  const totals =
    category === 'ROOM_SERVICE' && !tableState.isLoading && !tableState.isError ? (
      /*
        SCOPED TO WHAT IT ACTUALLY ADDS UP: the rows on this page, which the
        server caps at 500. "Của chi nhánh" would be a claim about a branch's
        whole takings the figure cannot back once a branch crosses the cap.
      */
      <RoomServiceTotals rows={rows} order={ROOM_SERVICE_ORDER} labelOf={serviceLabel} scope="trong danh sách đang xem" />
    ) : null;

  // Loading, failed or empty: one table carries the state, with nothing to group.
  if (tableState.isLoading || tableState.isError || rows.length === 0) {
    return (
      <div className="space-y-3">
        {totals}
        <CategoryTable
          category={category}
          rows={rows}
          title={category ? label(category) : 'Tất cả danh mục'}
          label={label}
          serviceLabel={serviceLabel}
          tableState={tableState}
        />
      </div>
    );
  }

  return (
    <div className={showBranch ? 'space-y-6' : 'space-y-5'} data-testid="admin-shift-groups">
      {totals}
      {groupByBranch(rows).map((branch) => (
        <section key={branch.branchId} data-testid={`branch-group-${branch.branchId}`} className="space-y-4">
          {showBranch ? (
            <h2 className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">
              <Building2 className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              <span className="min-w-0">
                {branch.branchNumber !== null ? `Chi nhánh ${branch.branchNumber} · ` : ''}
                {branch.branchAddress ?? '—'}
              </span>
            </h2>
          ) : null}
          {branch.days.map((day) => (
            <section key={day.date} data-testid={`date-group-${day.date}`} className="space-y-3">
              {/* The day is the landmark of the list: a solid chip, a rule, its count. */}
              <h3 className="flex items-center gap-2.5">
                <span className="inline-flex shrink-0 items-center rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold tracking-wide text-white">
                  {formatViWeekdayDate(day.date)}
                </span>
                <span className="h-px flex-1 bg-slate-300" aria-hidden="true" />
                <span className="shrink-0 text-xs font-medium tabular-nums text-slate-600">
                  {day.shifts.reduce((n, s) => n + s.rows.length, 0)} bản ghi
                </span>
              </h3>
              {day.shifts.map((group) => (
                <div key={group.key} data-testid={`shift-group-${group.key}`}>
                  <CategoryTable
                    category={category}
                    rows={group.rows}
                    title={shiftTitle(group)}
                    headerAction={<ShiftSummary group={group} label={label} />}
                    marker={shiftCode(group)}
                    grouped
                    label={label}
                    serviceLabel={serviceLabel}
                    tableState={tableState}
                  />
                </div>
              ))}
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

/** "Ca A · 06:00 – 14:00 · Nguyễn Văn A". */
function shiftTitle(group: ShiftGroup): string {
  const shift = group.shiftName ? `${group.shiftName} · ${group.shiftWindow}` : 'Không gắn ca';
  return group.employee ? `${shift} · ${group.employee}` : shift;
}

/** "Ca A" → "A": the shift's code, for the section marker. Nothing for a shiftless group. */
function shiftCode(group: ShiftGroup): string | undefined {
  const code = group.shiftName?.replace(/^Ca\s+/i, '').trim();
  return code && code.length <= 3 ? code : undefined;
}

/**
 * What the person on this shift recorded, by category — and whether the shift
 * has ended. An open shift is on screen but not yet in the official report.
 */
function ShiftSummary({ group, label }: { group: ShiftGroup; label: (c: ReportCategory) => string }) {
  const parts = CATEGORY_ORDER.filter((c) => (group.counts[c] ?? 0) > 0).map(
    (c) => `${label(c)}: ${group.counts[c]}`,
  );
  return (
    <span className="flex flex-wrap items-center justify-start gap-x-2 gap-y-1 text-xs text-slate-600 sm:justify-end">
      <span data-testid={`shift-counts-${group.key}`}>{parts.join(' · ')}</span>
      {group.closed ? null : (
        <span
          data-testid={`shift-open-${group.key}`}
          className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800 ring-1 ring-inset ring-amber-300"
        >
          Chưa kết thúc
        </span>
      )}
    </span>
  );
}

/**
 * The period's unfinished shifts, named.
 *
 * The server's own sentence, so the screen, the PDF and the workbook say the
 * same thing: a day with a shift still running is not the official report yet.
 */
function OpenShiftWarning({ notices, warning }: { notices: OpenShiftNotice[]; warning: string }) {
  return (
    <div
      role="status"
      data-testid="open-shift-warning"
      className="flex gap-2.5 rounded-xl border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900"
    >
      <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-5">{warning}</p>
        <ul className="mt-1 space-y-0.5 leading-5 text-amber-800">
          {notices.map((n) => (
            <li key={n.sessionId} className="tabular-nums">
              {formatDate(n.businessDate)} · {n.shiftName} ({n.shiftWindow}) · {n.receptionistName} · {n.branchAddress}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * "SỰ CỐ VẬT CHẤT ĐANG XỬ LÝ", for the Admin: the incidents themselves.
 *
 * This is where the old "Sự cố khách sạn" screen went. It reads the SAME
 * `HotelIssue` rows through the SAME `/api/issues` the technical department
 * works from — scoped to the page's branch and period, by the incident's own
 * report date — plus the period's counts and, when asked, every incident still
 * open whatever day it was reported. Nothing here is a second incident system.
 */
function AdminIncidentView({
  branchId,
  range,
  onPickBranch,
}: {
  branchId?: number;
  range: DateRangeValue;
  /** A branch's count is also the way into that branch. */
  onPickBranch: (branchId: number) => void;
}) {
  const [outstanding, setOutstanding] = useState(false);
  const list = useQuery({
    queryKey: ['issues', { admin: true, branchId, range, outstanding }],
    queryFn: () =>
      issuesApi.list({
        branchId,
        // "Tồn đọng" is a status set with no date: the server refuses both at once.
        from: outstanding ? undefined : range.from,
        to: outstanding ? undefined : range.to,
        outstanding: outstanding || undefined,
        pageSize: 100,
      }),
    refetchInterval: 20_000,
  });
  const issues = list.data?.issues ?? [];
  const total = list.data?.pagination.total ?? 0;

  return (
    <div className="space-y-3" data-testid="admin-incident-view">
      {branchId === undefined ? <BranchIncidentCounts onPick={onPickBranch} /> : null}
      {outstanding ? null : <IncidentRangeSummary from={range.from} to={range.to} branchId={branchId ?? null} />}
      <label
        className={`inline-flex min-h-[2.75rem] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
          outstanding
            ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
        }`}
      >
        <input
          type="checkbox"
          checked={outstanding}
          data-testid="admin-incident-outstanding"
          onChange={(e) => setOutstanding(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
        />
        Chỉ xem sự cố còn tồn đọng (mọi ngày báo)
      </label>
      <IncidentTable
        testId="admin-incident-table"
        title={outstanding ? 'Sự cố còn tồn đọng' : 'Sự cố báo trong kỳ'}
        rows={issues}
        showBranch={branchId === undefined}
        section={{}}
        readingMode
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyTitle="Không có sự cố"
        emptyMessage={outstanding ? 'Không còn sự cố nào chưa xử lý.' : 'Không có sự cố nào được báo trong kỳ đang xem.'}
      />
      {issues.length > 0 && total > issues.length ? (
        <p className="text-xs text-slate-500" data-testid="admin-incident-truncated">
          Đang hiển thị {issues.length} trên tổng số {total} sự cố. Thu hẹp khoảng thời gian hoặc xuất báo cáo
          để xem đầy đủ.
        </p>
      ) : null}
    </div>
  );
}

/**
 * EVERY BRANCH'S UNRESOLVED INCIDENTS, AT A GLANCE — what the old "Sự cố
 * khách sạn" screen opened on, kept so the merge loses nothing. Counted by the
 * server (`/api/issues/summary`), whatever the period: an unresolved incident
 * matters whichever day it was reported. Choosing one narrows the page to that
 * branch through the page's own branch filter — there is only one.
 */
function BranchIncidentCounts({ onPick }: { onPick: (branchId: number) => void }) {
  const summary = useIssueSummary();
  const branches = summary.data?.summary.byBranch ?? [];
  if (branches.length === 0) return null;
  return (
    <div data-testid="branch-incident-counts">
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Sự cố chưa xử lý theo chi nhánh
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {branches.map((b) => {
          const open = b.totalUnresolved > 0;
          return (
            <button
              key={b.branchId}
              type="button"
              onClick={() => onPick(b.branchId)}
              aria-label={`${b.totalUnresolved} sự cố chưa xử lý tại ${b.address}`}
              className={`inline-flex items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                open ? 'border-red-200 hover:border-red-300' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <span className="font-medium text-slate-800">{b.address}</span>
              <span
                className={`inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 font-bold leading-none ${
                  open ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {b.totalUnresolved}
              </span>
              <span className="text-slate-500">
                Mới: {b.newCount} · Đang sửa: {b.inProgressCount}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The drawer, in one strip.
 *
 * A sibling of reception's own summary strip (PaymentLedger.tsx) on purpose:
 * the Admin checking a branch's cash and the receptionist who counted it should
 * be reading the same seven figures in the same order, in the same shape.
 *
 * THE PERIOD IS NAMED. An unlabelled cash figure beside a record list reads as
 * "the cash position", and there is no such number.
 */
function CashStrip({
  cash,
  period,
}: {
  cash: CashSummary;
  period: { from: string; to: string } | null;
}) {
  const chips: { label: string; value: string; pending?: boolean }[] = [
    {
      label: 'Tiền đầu ca',
      value: cash.openingCash === null ? 'Chưa kiểm đếm' : formatVnd(cash.openingCash),
      pending: cash.openingCash === null,
    },
    { label: 'Thu tiền mặt', value: formatVnd(cash.cashCollected) },
    { label: 'Chuyển khoản', value: formatVnd(cash.transferCollected) },
    { label: 'Cà thẻ', value: formatVnd(cash.cardCollected) },
    { label: 'Công nợ', value: formatVnd(cash.receivable) },
    { label: 'Chi tiền mặt', value: formatVnd(cash.cashExpense) },
  ];

  return (
    <div data-testid="admin-cash-panel" className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      {/* Figures right-aligned, as on a ledger, so the digits line up down each column. */}
      <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4 xl:grid-cols-7">
        {chips.map((c) => (
          <div key={c.label} className="bg-white px-3 py-2.5 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.label}</p>
            <p
              className={`mt-0.5 tabular-nums ${
                c.pending ? 'text-sm font-medium text-slate-500' : 'text-[15px] font-semibold text-slate-900'
              }`}
            >
              {c.value}
            </p>
          </div>
        ))}
        {/* Two cells wide until one row holds all seven, so no row has a gap. */}
        <div className="col-span-2 border-l-[3px] border-l-brand-600 bg-brand-50 px-3 py-2.5 text-right xl:col-span-1">
          <p className="text-[11px] font-bold uppercase tracking-wide text-brand-700">Tiền cuối ca</p>
          <p
            className={`mt-0.5 tabular-nums ${
              cash.endingCash === null ? 'text-sm font-medium text-brand-700' : 'text-lg font-bold leading-6 text-brand-800'
            }`}
          >
            {cash.endingCash === null ? 'Chưa xác định' : formatVnd(cash.endingCash)}
          </p>
        </div>
      </div>
      <p
        className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500"
        data-testid="admin-cash-period"
      >
        Tiền mặt{' '}
        {period
          ? period.from === period.to
            ? `ngày ${formatDate(period.from)}`
            : `kỳ ${formatDate(period.from)} – ${formatDate(period.to)}`
          : ''}
        {cash.voidedCount > 0 ? (
          <span className="ml-1 text-rose-600">· {cash.voidedCount} bản ghi đã hủy, không tính vào tổng.</span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * THE EXPORT IS WHAT IS ON SCREEN.
 *
 * It used to carry its own period picker and its own "all branches" box, so a
 * file could be produced for a range and a branch different from the ones being
 * looked at — and nothing on the page said so. It now takes the page's three
 * filters and only confirms them: the file an Admin downloads is the screen they
 * were reading, with nothing capped.
 */
function ExportDialog({
  filters,
  branchName,
  categoryName,
  openShifts,
  openShiftWarning,
  onClose,
}: {
  filters: { from: string; to: string; branchId?: number; category?: ReportCategory };
  branchName: string;
  categoryName: string;
  /** Shifts of the period still running — left out of the file, and named. */
  openShifts: OpenShiftNotice[];
  openShiftWarning: string;
  onClose: () => void;
}) {
  const period =
    filters.from === filters.to
      ? formatDate(filters.from)
      : `${formatDate(filters.from)} – ${formatDate(filters.to)}`;
  return (
    <Modal
      open
      title="Xuất báo cáo vấn đề"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          <a
            href={operationalXlsxUrl(filters)}
            data-testid="operational-export-xlsx"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Xuất Excel
          </a>
          <a
            href={operationalPdfUrl(filters)}
            data-testid="operational-export-pdf"
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Xuất PDF
          </a>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid="operational-export-scope">
        <dt className="text-slate-500">Khoảng thời gian</dt>
        <dd className="font-medium text-slate-800">{period}</dd>
        <dt className="text-slate-500">Chi nhánh</dt>
        <dd className="font-medium text-slate-800">{branchName}</dd>
        <dt className="text-slate-500">Danh mục</dt>
        <dd className="font-medium text-slate-800">{categoryName}</dd>
      </dl>
      {/* An unfinished day is never exported as though it were finished. */}
      {openShifts.length > 0 ? (
        <div className="mt-3">
          <OpenShiftWarning notices={openShifts} warning={openShiftWarning} />
        </div>
      ) : null}
      <p className="mt-3 text-xs text-slate-500">
        Báo cáo chính thức theo ngày nghiệp vụ của ca, chỉ gồm các ca đã kết thúc. In đầy đủ từng bản
        ghi, xếp theo chi nhánh, ngày, ca và nhân viên — không chỉ số lượng. Để xuất phạm vi khác, hãy
        đổi bộ lọc trên trang.
      </p>
    </Modal>
  );
}
