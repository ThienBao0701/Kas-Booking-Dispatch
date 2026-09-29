/**
 * "HOÀN THÀNH VẤN ĐỀ" — the 12-hour completion archive, for Reception.
 *
 * A QUERY, NOT A PLACE. Requests (II), facility incidents (III) and
 * service-quality reports (IV) appear here once they are completed AND their
 * original Reception report is at least 12 hours old, by the server's clock.
 * Nothing is moved, copied or deleted to put them here: "Báo cáo vấn đề" simply
 * stops matching them and this screen starts. Everything about them — report
 * time, completion, employee, handling, repair history, audit — is exactly as
 * it was, and the Admin still reads all of it.
 *
 * BY THE DAY IT WAS RECEIVED. The period narrows the archive on the SERVER to
 * the records Reception received on those days (inclusive, Vietnamese calendar
 * days) — the same instant the 12-hour rule is measured from, never the day a
 * record was finished. A date can only narrow the archive; it never admits a
 * record the 12-hour rule still keeps on "Báo cáo vấn đề".
 *
 * THE DEFAULT IS THE LAST 7 DAYS, not today: a record reaches this screen at
 * least 12 hours after it was received, so "Hôm nay" is empty for most of the
 * morning and would read as "nothing was finished".
 *
 * COMPACT BY DESIGN: the summary form of each category's table, with the status
 * "Đã hoàn thành". Deliveries (VI) follow the same rule and are the fourth section.
 * Payments (I) and room services (V) are not part of this rule and never appear here.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { reportsApi } from '../api/receptionReports';
import { issuesApi } from '../api/issues';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageState';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { PeriodQuickPicks } from '../components/PeriodQuickPicks';
import { GuestRequestTable, ServiceQualityTable } from '../components/OperationalTables';
import { IncidentTable } from '../components/IncidentReporting';
import { MoreNote } from '../components/MoreNote';
import { DeliveryTable } from '../components/HotelDelivery';
import { useDeliveries } from '../hooks/useDeliveries';
import { ARCHIVED_REPORTS_KEY, DELIVERIES_KEY, FACILITY_BOARD_KEY } from '../lib/reportKeys';
import { CATEGORY_MARKERS, HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

/** Read-only: nothing on this screen changes a record. */
const noop = async () => undefined;

const EMPTY_IN_RANGE = 'Không có vấn đề hoàn thành trong khoảng thời gian này.';

export function CompletedIssuesPage() {
  const queryClient = useQueryClient();
  const today = hcmToday();
  const [range, setRange] = useState<DateRangeValue>(() => ({ from: daysBefore(today, 6), to: today }));
  // Both ends or nothing: a half range is never sent (the server refuses it too).
  const rangeValid = range.from !== '' && range.to !== '';
  const period = { from: range.from, to: range.to };

  const journal = useQuery({
    queryKey: [...ARCHIVED_REPORTS_KEY, period],
    queryFn: () => reportsApi.archive(period),
    enabled: rangeValid,
    refetchOnWindowFocus: true,
  });
  const incidents = useQuery({
    queryKey: [...FACILITY_BOARD_KEY, 'archive', period],
    queryFn: () => issuesApi.list({ scope: 'archive', from: period.from, to: period.to, pageSize: 100 }),
    enabled: rangeValid,
    refetchOnWindowFocus: true,
  });

  // "Giao nhận hàng hóa" is the fourth thing the 12-hour rule moves here. It is
  // read from its own branch-wide endpoint (a delivery outlives its shift), by the
  // same received-day window.
  const deliveries = useDeliveries('archived', rangeValid ? period : null, rangeValid);

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

  return (
    <div>
      <PageHeader
        title="Hoàn thành vấn đề"
        description={`Vấn đề đã hoàn thành, từ ${hours} giờ trở lên kể từ lúc lễ tân tiếp nhận.`}
      />

      {/* The same filter block as the Admin's reports: one frame, one row of choices. */}
      <section
        data-testid="completed-filters"
        aria-label="Bộ lọc ngày tiếp nhận"
        className="mb-4 overflow-hidden rounded-xl border-section border-line bg-white shadow-sm"
      >
        <p className="border-b-rule border-line bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          Lọc theo ngày tiếp nhận
        </p>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3">
          <div className="min-w-[17rem] max-w-full">
            <DateRangeField
              legend="Ngày tiếp nhận"
              value={range}
              onChange={setRange}
              max={today}
              testId="completed-range"
            />
          </div>
          <PeriodQuickPicks value={range} onChange={setRange} today={today} testId="completed-range" />
          <Button
            variant="secondary"
            onClick={() => void refresh()}
            aria-label="Làm mới"
            className="min-h-[2.75rem] shadow-sm"
            disabled={!rangeValid}
          >
            <RefreshCw
              className={`h-4 w-4 ${journal.isFetching || incidents.isFetching || deliveries.isFetching ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Làm mới
          </Button>
        </div>
      </section>

      {!rangeValid ? (
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
              title="Vấn đề khách yêu cầu thực hiện (Request)"
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
        </div>
      )}
    </div>
  );
}
