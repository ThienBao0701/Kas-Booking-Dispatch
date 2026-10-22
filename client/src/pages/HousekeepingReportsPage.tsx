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
  const journal = useQuery({
    queryKey: [...HK_JOURNAL_KEY, branchId ?? null],
    queryFn: () => reportsApi.housekeeping({ branchId }),
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
          <GuestRequestTable
            rows={of('GUEST_REQUEST')}
            title="Danh sách vấn đề khách yêu cầu"
            {...tableState}
            // The Admin reads; who reported and who completed are beside the status.
            {...(isAdmin ? { variant: 'summary' as const, showActors: true } : {})}
          />
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
