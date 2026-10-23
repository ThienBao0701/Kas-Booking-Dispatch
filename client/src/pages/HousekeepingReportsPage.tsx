/**
 * "BÁO CÁO VẤN ĐỀ" OF BỘ PHẬN BUỒNG PHÒNG — its own journal, apart from
 * Reception's.
 *
 *   Vấn đề khách yêu cầu · Sự cố cơ sở vật chất · Giao nhận hàng hóa — one
 *   category at a time, chosen in the side menu (no second set of buttons
 *   here), its "+ Thêm" on top, its list below; "Báo cáo các vấn
 *   đề và tình hình quan trọng" is its own page. ("Dịch vụ phòng, KPI" is
 *   Reception's only.)
 *
 * THE SAME FORMS, TABLES AND API AS RECEPTION, NOT A COPY. The server stamps
 * every record with the department, the account, the branch and the time; a
 * housekeeping record never appears in Reception's lists or totals, nor
 * Reception's here. A housekeeper sees what it reported; the Quản lý buồng
 * phòng, its branch's; the Admin reads any branch's, without writing.
 */
import { WorkDepartmentFilter } from '../components/Severity';
import type { WorkDepartment } from '../api/receptionReports';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { reportsApi, type ReportCategory } from '../api/receptionReports';
import { branchesApi } from '../api/bookings';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Toast } from '../components/Toast';
import { PageHeader } from '../components/PageState';
import { BranchPicker } from '../components/ReportFilter';
import { DeliveryForm, GuestRequestForm } from '../components/OperationalForms';
import { GuestRequestTable } from '../components/OperationalTables';
import { DataTable, type DataColumn } from '../components/DataTable';
import { SeverityBadge } from '../components/Severity';
import { IssueStageBadge } from '../components/IssueViews';
import type { OperationalReport } from '../api/receptionReports';

/**
 * The facility incidents Buồng phòng reported — part of "Công việc bộ phận
 * buồng phòng báo cáo vấn đề". The incident itself is Bộ phận kỹ thuật's to
 * repair: shown live (stage, who repairs it), with who reported it.
 */
function HousekeepingFacilityReports({ rows, isLoading }: { rows: OperationalReport[]; isLoading: boolean }) {
  const columns: DataColumn<OperationalReport>[] = [
    { key: 'stt', header: 'STT', className: 'w-[1%] whitespace-nowrap text-slate-400', render: (_r, i) => i + 1 },
    { key: 'place', header: 'Khu vực', className: 'min-w-[7rem] font-medium text-slate-800', render: (r) => r.facility?.issue.locationLabel ?? '—' },
    { key: 'issue', header: 'Sự cố', className: 'min-w-[10rem] whitespace-pre-wrap [overflow-wrap:anywhere]', render: (r) => r.facility?.issue.description ?? '—' },
    {
      key: 'severity',
      header: 'Mức độ',
      className: 'w-[1%] whitespace-nowrap',
      render: (r) => (r.facility ? <SeverityBadge severity={r.facility.issue.severity} label={r.facility.issue.severityLabel} /> : '—'),
    },
    { key: 'stage', header: 'Trạng thái', className: 'min-w-[6rem]', render: (r) => (r.facility ? <IssueStageBadge issue={r.facility.issue} /> : '—') },
    { key: 'receiver', header: 'Bộ phận nhận việc', className: 'whitespace-nowrap', render: () => 'Kỹ thuật' },
    { key: 'repairer', header: 'Người xử lý', className: 'whitespace-nowrap', render: (r) => r.facility?.issue.repairerName ?? '—' },
    { key: 'department', header: 'Bộ phận', className: 'whitespace-nowrap', render: (r) => r.departmentLabel ?? '—' },
    { key: 'creator', header: 'Người tạo', className: 'whitespace-nowrap', render: (r) => r.createdByName },
  ];
  return (
    <DataTable
      testId="hk-reported-facility"
      title="Sự cố cơ sở vật chất Buồng phòng đã báo"
      badge={rows.length}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      isLoading={isLoading}
      emptyTitle="Chưa có sự cố nào"
      emptyMessage="Sự cố Buồng phòng báo từ phòng hoặc khu vực sẽ hiện ở đây."
    />
  );
}
import { FacilityIssueBoard } from '../components/FacilityIssueBoard';
import { DeliveryTable } from '../components/HotelDelivery';
import { useDeliveries } from '../hooks/useDeliveries';
import { DELIVERIES_KEY, FACILITY_BOARD_KEY, REPORTS_KEY } from '../lib/reportKeys';
import { CATEGORY_FALLBACK_LABELS, GUEST_REQUEST_TITLE, HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';
import type { BranchChoice } from '../lib/reportFilter';

/** Bộ phận buồng phòng's categories, in the menu's order. */
const CATEGORIES = ['GUEST_REQUEST', 'FACILITY_ISSUE', 'HOTEL_DELIVERY'] as const satisfies readonly ReportCategory[];
type HkCategory = (typeof CATEGORIES)[number];

const TITLES: Record<HkCategory, string> = {
  GUEST_REQUEST: GUEST_REQUEST_TITLE,
  FACILITY_ISSUE: CATEGORY_FALLBACK_LABELS.FACILITY_ISSUE,
  HOTEL_DELIVERY: HOTEL_DELIVERY_TITLE,
};
const ADD: Record<HkCategory, string> = {
  GUEST_REQUEST: 'Thêm yêu cầu',
  FACILITY_ISSUE: 'Báo cáo sự cố',
  HOTEL_DELIVERY: 'Thêm giao nhận',
};

/** The journal's own key, under Reception's prefix so a save refreshes both the same way. */
const HK_JOURNAL_KEY = [...REPORTS_KEY, 'housekeeping'];

export function HousekeepingReportsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const wanted = params.get('category');
  const category: HkCategory = CATEGORIES.find((c) => c === wanted) ?? 'GUEST_REQUEST';
  // The bare address opens the first category; say so in the address, so the menu marks it.
  useEffect(() => {
    if (!wanted) setParams({ category: 'GUEST_REQUEST' }, { replace: true });
  }, [wanted, setParams]);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // The Admin reads one branch, or every branch; it does not write here.
  const [branch, setBranch] = useState<BranchChoice>('ALL');
  const branchId = isAdmin && typeof branch === 'number' ? branch : undefined;
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });

  const options = useQuery({ queryKey: ['reception', 'reports', 'options'], queryFn: () => reportsApi.options(), staleTime: 60 * 60 * 1000 });
  // "Bộ phận" on the request table — the server filters.
  const [department, setDepartment] = useState<WorkDepartment | ''>('');
  const journal = useQuery({
    queryKey: [...HK_JOURNAL_KEY, branchId ?? null, department],
    queryFn: () => reportsApi.housekeeping({ branchId, ...(department ? { workDepartment: department } : {}) }),
    refetchOnWindowFocus: true,
  });
  const deliveries = useDeliveries('active', null, category === 'HOTEL_DELIVERY', branchId, undefined, isAdmin ? 'HOUSEKEEPING' : undefined);
  const rows = journal.data?.reports ?? [];
  const of = (c: ReportCategory) => rows.filter((r) => r.category === c);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: HK_JOURNAL_KEY });
    await queryClient.invalidateQueries({ queryKey: DELIVERIES_KEY });
    await queryClient.invalidateQueries({ queryKey: FACILITY_BOARD_KEY });
  };
  const created = (message: string) => async () => {
    await refresh();
    setAdding(false);
    setToast(message);
  };
  const tableState = {
    isLoading: journal.isLoading,
    isError: journal.isError,
    error: journal.error,
    onRetry: () => void journal.refetch(),
    onChanged: refresh,
    onToast: setToast,
    canEdit: false,
  };

  return (
    <div>
      <PageHeader
        title="Báo cáo vấn đề"
        description={isAdmin ? 'Báo cáo của Bộ phận buồng phòng — chỉ xem.' : 'Báo cáo của Bộ phận buồng phòng. Chọn mục, rồi bấm “Thêm”.'}
        actions={
          <Button variant="secondary" onClick={() => void refresh()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${journal.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />
      {isAdmin ? (
        <div className="mb-4 sm:w-72">
          <BranchPicker value={branch} onChange={setBranch} branches={branches.data?.branches ?? []} testId="hk-reports-branch" />
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-900" data-testid="hk-report-title">
          {TITLES[category]}
        </h2>
        {isAdmin ? null : (
          <Button onClick={() => setAdding(true)} data-testid="hk-report-add">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {ADD[category]}
          </Button>
        )}
      </div>

      {category === 'GUEST_REQUEST' ? (
        <>
          {adding ? (
            <Modal open title={ADD.GUEST_REQUEST} onClose={() => setAdding(false)}>
              <GuestRequestForm bare onCancel={() => setAdding(false)} onCreated={created('Đã thêm yêu cầu của khách.')} />
            </Modal>
          ) : null}
          <WorkDepartmentFilter value={department} onChange={setDepartment} testId="hk-department" className="mb-3 w-full sm:w-60" />
          {/*
            TWO TABLES, ONE RECORD EACH. A: what other departments sent to
            Buồng phòng — every housekeeper of the branch sees it, one takes it.
            B: what Buồng phòng itself reported — whoever it went to. A request
            is under ONE of them (by where it came from), never both.
          */}
          <section className="space-y-2" data-testid="hk-incoming">
            <GuestRequestTable
              rows={of('GUEST_REQUEST').filter((r) => r.originDepartment !== 'HOUSEKEEPING')}
              title="Bộ phận buồng xử lý"
              emptyTitle="Chưa có yêu cầu nào gửi cho Buồng phòng"
              {...tableState}
              // The Admin reads; who reported and who completed are beside the status.
              {...(isAdmin ? { variant: 'summary' as const, showActors: true } : {})}
            />
          </section>
          <section className="mt-6 space-y-3" data-testid="hk-reported">
            <GuestRequestTable
              rows={of('GUEST_REQUEST').filter((r) => r.originDepartment === 'HOUSEKEEPING')}
              title="Công việc bộ phận buồng phòng báo cáo vấn đề"
              emptyTitle="Buồng phòng chưa báo cáo yêu cầu nào"
              {...tableState}
              {...(isAdmin ? { variant: 'summary' as const, showActors: true } : {})}
            />
            <HousekeepingFacilityReports rows={of('FACILITY_ISSUE')} isLoading={tableState.isLoading} />
          </section>
        </>
      ) : null}

      {category === 'FACILITY_ISSUE' ? (
        <FacilityIssueBoard
          title="Sự cố đang xử lý"
          onLogged={refresh}
          onToast={setToast}
          reportOpen={adding}
          onCloseReport={() => setAdding(false)}
          readOnly
        />
      ) : null}

      {category === 'HOTEL_DELIVERY' ? (
        <>
          {adding ? (
            <Modal open title={TITLES.HOTEL_DELIVERY} onClose={() => setAdding(false)}>
              <DeliveryForm bare options={options.data} onCancel={() => setAdding(false)} onCreated={created('Đã ghi nhận giao nhận hàng hóa.')} />
            </Modal>
          ) : null}
          <DeliveryTable
            rows={deliveries.data?.deliveries ?? []}
            options={options.data}
            isLoading={deliveries.isLoading}
            isError={deliveries.isError}
            error={deliveries.error}
            onRetry={() => void deliveries.refetch()}
            title="Danh sách giao nhận đang theo dõi"
          />
        </>
      ) : null}

      {/* "VII" — private, upward: its own page. */}
      <Link
        to="/app/reports/confidential"
        className="mt-5 flex min-h-[3rem] items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        data-testid="hk-report-confidential"
      >
        <ShieldAlert className="h-5 w-5 text-brand-600" aria-hidden="true" />
        Báo cáo các vấn đề và tình hình quan trọng
        <ChevronRight className="ml-auto h-4 w-4 text-slate-400" aria-hidden="true" />
      </Link>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
