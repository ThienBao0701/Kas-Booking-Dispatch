/**
 * "HOÀN THÀNH VẤN ĐỀ" — the 12-hour completion archive, in two views:
 *
 *   › Vấn đề báo cáo đúng   (?verdict=CORRECT — and the completions recorded
 *                            before the question existed)
 *   › Vấn đề báo cáo sai    (?verdict=INCORRECT — with the reason)
 *
 * A QUERY, NOT A PLACE. Requests (II), facility incidents (III) and
 * service-quality reports (IV) appear here once they are completed AND their
 * original Reception report is at least 12 hours old, by the server's clock.
 * Nothing is moved, copied or deleted to put them here: "Báo cáo vấn đề" simply
 * stops matching them and this screen starts. The two views are a filter over the
 * same records by the verdict given at "Hoàn thành"; nothing moves between them.
 *
 * THE SHARED REPORT FILTER: Hôm nay / Ngày cụ thể / Khoảng ngày over BUSINESS
 * dates (the day of the shift that received the record — Ca C after midnight is
 * the day before), the branch for a supervisor, and the shifts that ran. A date
 * can only narrow the archive; it never admits a record the 12-hour rule still
 * keeps on "Báo cáo vấn đề".
 *
 * THE DEFAULT IS THE LAST 7 DAYS, not today: a record reaches this screen at
 * least 12 hours after it was received, so "Hôm nay" is empty for most of the
 * morning and would read as "nothing was finished".
 *
 * Deliveries (VI) follow the same 12-hour rule but are never "reported wrong":
 * they are in the "đúng" view only. Payments (I) and room services (V) are not
 * part of this rule and never appear here.
 *
 * THE ADMIN reads every branch; A RECEPTION MANAGER its branches (all eight for
 * the general manager); Reception its own. The server scopes every read.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { isReceptionSupervisor } from '../auth/types';
import { branchesApi } from '../api/bookings';
import { operationalPdfUrl, operationalXlsxUrl, reportsApi } from '../api/receptionReports';
import { issuesApi, type ReportVerdict } from '../api/issues';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageState';
import { ReportFilterBar } from '../components/ReportFilter';
import { GuestRequestTable, ServiceQualityTable } from '../components/OperationalTables';
import { IncidentTable } from '../components/IncidentReporting';
import { MoreNote } from '../components/MoreNote';
import { DeliveryTable } from '../components/HotelDelivery';
import { useDeliveries } from '../hooks/useDeliveries';
import { useIssueSummary } from '../hooks/useIssueSummary';
import { ARCHIVED_REPORTS_KEY, DELIVERIES_KEY, FACILITY_BOARD_KEY } from '../lib/reportKeys';
import { CATEGORY_MARKERS, GUEST_REQUEST_TITLE, HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';
import { initialReportFilter, reportBranchId, reportPeriod, type ReportFilterValue } from '../lib/reportFilter';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

/** Read-only: nothing on this screen changes a record. */
const noop = async () => undefined;

const EMPTY_IN_RANGE = 'Không có vấn đề hoàn thành trong khoảng thời gian này.';

export function CompletedIssuesPage() {
  const queryClient = useQueryClient();
  const today = hcmToday();
  const [searchParams, setSearchParams] = useSearchParams();
  const verdict: ReportVerdict = searchParams.get('verdict') === 'INCORRECT' ? 'INCORRECT' : 'CORRECT';
  // The bare address is the "đúng" view; say so in the address, so the menu marks it.
  useEffect(() => {
    if (!searchParams.get('verdict')) setSearchParams({ verdict: 'CORRECT' }, { replace: true });
  }, [searchParams, setSearchParams]);

  const { user } = useAuth();
  // A supervisor picks a branch: the Admin any of them, a manager its own.
  const supervisor = !!user && isReceptionSupervisor(user.role);
  const [filter, setFilter] = useState<ReportFilterValue>(() =>
    initialReportFilter(today, {
      mode: 'RANGE',
      range: { from: daysBefore(today, 6), to: today },
      branch: supervisor ? 'ALL' : null,
    }),
  );
  const period = reportPeriod(filter, today);
  const branchId = reportBranchId(filter);
  const shiftType = filter.shiftType || undefined;

  // The reader's branches from the server's scope (every active one for the Admin).
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: supervisor });
  const issueSummary = useIssueSummary(supervisor);
  const unresolvedByBranch = new Map(
    (issueSummary.data?.summary.byBranch ?? []).map((b) => [b.branchId, b.totalUnresolved]),
  );

  const scope = {
    from: period?.from ?? '',
    to: period?.to ?? '',
    ...(branchId !== undefined ? { branchId } : {}),
    ...(shiftType ? { shiftType } : {}),
  };

  const journal = useQuery({
    queryKey: [...ARCHIVED_REPORTS_KEY, scope, verdict],
    queryFn: () => reportsApi.archive({ ...scope, verdict }),
    enabled: period !== null,
    refetchOnWindowFocus: true,
  });
  const incidents = useQuery({
    queryKey: [...FACILITY_BOARD_KEY, 'archive', scope, verdict],
    queryFn: () => issuesApi.list({ scope: 'archive', ...scope, verdict, pageSize: 100 }),
    enabled: period !== null,
    refetchOnWindowFocus: true,
  });

  // "Giao nhận hàng hóa" is never "reported wrong": it belongs to the "đúng" view.
  const showDeliveries = verdict === 'CORRECT';
  const deliveries = useDeliveries(
    'archived',
    period ? { from: period.from, to: period.to } : null,
    period !== null && showDeliveries,
    branchId,
    shiftType,
  );

  const reports = journal.data?.reports ?? [];
  const requests = reports.filter((r) => r.category === 'GUEST_REQUEST');
  const quality = reports.filter((r) => r.category === 'CUSTOMER_COMPLAINT');
  const issues = incidents.data?.issues ?? [];
  const hours = journal.data?.archiveAfterHours ?? 12;

  const journalState = {
    isLoading: journal.isLoading,
    isError: journal.isError,
    error: journal.error,
    onRetry: () => void journal.refetch(),
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ARCHIVED_REPORTS_KEY });
    await queryClient.invalidateQueries({ queryKey: [...FACILITY_BOARD_KEY, 'archive'] });
    await queryClient.invalidateQueries({ queryKey: DELIVERIES_KEY });
  };

  const title = verdict === 'INCORRECT' ? 'Vấn đề báo cáo sai' : 'Vấn đề báo cáo đúng';

  return (
    <div>
      <PageHeader
        title={title}
        description={`Hoàn thành vấn đề · ${
          verdict === 'INCORRECT' ? 'báo cáo được xác định là sai, kèm lý do' : 'vấn đề có thật đã được xử lý'
        } · từ ${hours} giờ trở lên kể từ lúc lễ tân tiếp nhận.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {supervisor && period
              ? [
                  // Supervisors export the same period, branch and shift through the one report engine.
                  [operationalPdfUrl(scope), 'Xuất PDF', 'completed-export-pdf'],
                  [operationalXlsxUrl(scope), 'Xuất Excel', 'completed-export-xlsx'],
                ].map(([href, text, testId]) => (
                  <a
                    key={testId}
                    href={href}
                    data-testid={testId}
                    className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {text}
                  </a>
                ))
              : null}
            <Button variant="secondary" onClick={() => void refresh()} aria-label="Làm mới" disabled={period === null}>
              <RefreshCw
                className={`h-4 w-4 ${journal.isFetching || incidents.isFetching || deliveries.isFetching ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Làm mới
            </Button>
          </div>
        }
      />

      <ReportFilterBar
        value={filter}
        onChange={setFilter}
        today={today}
        branches={supervisor ? (branches.data?.branches ?? []) : undefined}
        branchCounts={supervisor ? unresolvedByBranch : undefined}
        testId="completed-filters"
      />

      {period === null ? (
        <p
          data-testid="completed-range-invalid"
          className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900"
        >
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : (
        <div className="space-y-4" data-testid="completed-issues">
          <div>
            <GuestRequestTable
              rows={requests}
              title={GUEST_REQUEST_TITLE}
              onChanged={noop}
              onToast={() => undefined}
              {...journalState}
              canEdit={false}
              variant="summary"
              compact
              section={{ marker: CATEGORY_MARKERS.GUEST_REQUEST }}
              emptyTitle={EMPTY_IN_RANGE}
            />
            <MoreNote shown={requests.length} total={journal.data?.totals.GUEST_REQUEST} />
          </div>

          <div>
            <IncidentTable
              testId="completed-facility"
              title="Sự cố cơ sở vật chất"
              rows={issues}
              summary
              compact
              section={{ marker: CATEGORY_MARKERS.FACILITY_ISSUE }}
              isLoading={incidents.isLoading}
              isError={incidents.isError}
              error={incidents.error}
              onRetry={() => void incidents.refetch()}
              emptyTitle={EMPTY_IN_RANGE}
              emptyMessage="Sự cố đã sửa xong sẽ hiện tại đây sau 12 giờ kể từ lúc báo."
            />
            <MoreNote shown={issues.length} total={incidents.data?.pagination.total} />
          </div>

          <div>
            <ServiceQualityTable
              rows={quality}
              title="Vấn đề về chất lượng và dịch vụ"
              onChanged={noop}
              onToast={() => undefined}
              {...journalState}
              canEdit={false}
              variant="summary"
              compact
              section={{ marker: CATEGORY_MARKERS.CUSTOMER_COMPLAINT }}
              emptyTitle={EMPTY_IN_RANGE}
            />
            <MoreNote shown={quality.length} total={journal.data?.totals.CUSTOMER_COMPLAINT} />
          </div>

          {showDeliveries ? (
            <div>
              <DeliveryTable
                rows={deliveries.data?.deliveries ?? []}
                testId="completed-delivery-table"
                title={HOTEL_DELIVERY_TITLE}
                isLoading={deliveries.isLoading}
                isError={deliveries.isError}
                error={deliveries.error}
                onRetry={() => void deliveries.refetch()}
                emptyTitle={EMPTY_IN_RANGE}
                emptyMessage={`Các mục giao nhận sẽ xuất hiện ở đây sau ${hours} giờ kể từ khi hoàn thành.`}
                section={{ marker: CATEGORY_MARKERS.HOTEL_DELIVERY }}
              />
              <MoreNote shown={(deliveries.data?.deliveries ?? []).length} total={deliveries.data?.total} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
