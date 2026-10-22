/**
 * "CÔNG VIỆC BUỒNG PHÒNG" — the reception managers' own workspace: the day's
 * housekeeping work items of their branches, one row each, and "Giao lại" for
 * an item inspected and waiting for cleaning. Apart from "Phát hiện & thu tiền"
 * (findings and collection), which no longer carries it. The server scopes the
 * list and checks the role, branch and state of every "Giao lại".
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { ROOM_WORK_KEY, roomWorkApi, type RoomTask } from '../api/roomWork';
import { branchesApi } from '../api/bookings';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/capabilities';
import { Button } from '../components/Button';
import { ReassignDialog, WorkOrderTable } from '../components/HkWorkOrders';
import { PageHeader } from '../components/PageState';
import { Toast } from '../components/Toast';
import { branchOptionLabel } from '../lib/branchTone';
import { formatDate, hcmToday } from '../lib/format';

const FIELD = 'mt-1 min-h-[2.75rem] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

export function ReceptionWorkOrdersPage() {
  const today = hcmToday();
  const role = useAuth().user?.role;
  const [date, setDate] = useState(today);
  const [branchId, setBranchId] = useState<number | ''>('');
  const [reassigning, setReassigning] = useState<RoomTask | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The manager's own branches, from the server's scope.
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });
  const orders = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'work-orders', date, branchId === '' ? null : branchId],
    queryFn: () => roomWorkApi.workOrders({ date, branchId: branchId === '' ? undefined : branchId }),
    refetchInterval: 30_000,
  });
  const staff = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'work-orders', 'staff', reassigning?.branchId ?? null],
    queryFn: () => roomWorkApi.workOrderStaff(reassigning!.branchId),
    enabled: reassigning !== null,
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Công việc buồng phòng"
        description={`Các công việc buồng phòng ngày ${formatDate(date)} ở các chi nhánh bạn quản lý — giao lại phòng đã kiểm, đang chờ dọn.`}
        actions={
          <Button variant="secondary" onClick={() => void orders.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${orders.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-full min-w-0 text-xs font-medium text-slate-500 sm:w-48">
          Ngày
          <input
            type="date"
            className={FIELD}
            value={date}
            max={today}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            data-testid="work-orders-date"
          />
        </label>
        <label className="block w-full min-w-0 text-xs font-medium text-slate-500 sm:w-80">
          Chi nhánh
          <select value={branchId} onChange={(e) => setBranchId(e.target.value === '' ? '' : Number(e.target.value))} className={FIELD} data-testid="work-orders-branch">
            <option value="">Tất cả chi nhánh</option>
            {(branches.data?.branches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {branchOptionLabel(b)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div data-testid="supervisor-work-orders">
        <WorkOrderTable
          tasks={orders.data?.tasks ?? []}
          isLoading={orders.isLoading}
          isError={orders.isError}
          error={orders.error}
          onRetry={() => void orders.refetch()}
          onReassign={setReassigning}
          canReassign={can(role, 'housekeeping.reassignAwaitingCleaning')}
          showBranch={branchId === ''}
        />
      </div>
      {reassigning && staff.data ? (
        <ReassignDialog
          task={reassigning}
          staff={staff.data.staff}
          onClose={() => setReassigning(null)}
          onDone={(message) => {
            setReassigning(null);
            setToast(message);
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
