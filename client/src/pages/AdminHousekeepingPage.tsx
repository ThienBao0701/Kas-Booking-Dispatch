/**
 * "BUỒNG PHÒNG" — the Admin's management and reporting view.
 *
 * The combined picture of two departments' work on one data set: what Bộ phận
 * buồng phòng found (every branch), and what Reception did about each finding.
 * Filters are a period, a branch, a kind of issue and a collection status — all
 * applied by the SERVER, and the totals above the table cover EVERY matching
 * issue, not just the rows on screen (the list itself is capped, and says so).
 *
 * The Admin may settle any issue, as Reception does, and is the only role that
 * can void a mistaken one (with a reason; it stays on file).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  ROOM_COLLECTION_STATUSES,
  ROOM_ISSUES_KEY,
  ROOM_ISSUE_TYPES,
  housekeepingApi,
  type RoomCollectionStatus,
  type RoomIssue,
  type RoomIssueType,
} from '../api/housekeeping';
import { adminBranchesApi } from '../api/adminBranches';
import { Button } from '../components/Button';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { PageHeader } from '../components/PageState';
import {
  CollectionDialog,
  RoomIssueSummaryStrip,
  RoomIssueTable,
  VoidRoomIssueDialog,
} from '../components/RoomIssueViews';
import { Toast } from '../components/Toast';
import { branchOptionLabel } from '../lib/branchTone';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

const selectClass =
  'min-h-[2.75rem] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

export function AdminHousekeepingPage() {
  const today = hcmToday();
  const [range, setRange] = useState<DateRangeValue>({ from: daysBefore(today, 29), to: today });
  const [branchId, setBranchId] = useState<number | ''>('');
  const [type, setType] = useState<RoomIssueType | ''>('');
  const [status, setStatus] = useState<RoomCollectionStatus | ''>('');
  const [collecting, setCollecting] = useState<RoomIssue | null>(null);
  const [voiding, setVoiding] = useState<RoomIssue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const rangeValid = range.from !== '' && range.to !== '' && range.from <= range.to;

  // The branches are the branch table, so a new hotel is a new option here too.
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => adminBranchesApi.list() });

  const list = useQuery({
    queryKey: [...ROOM_ISSUES_KEY, 'admin', { range, branchId, type, status }],
    queryFn: () =>
      housekeepingApi.issues({
        from: range.from,
        to: range.to,
        branchId: branchId === '' ? undefined : branchId,
        type: type === '' ? undefined : type,
        status: status === '' ? undefined : status,
      }),
    enabled: rangeValid,
    refetchInterval: 30_000,
  });

  const summary = list.data?.summary ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Buồng phòng — tình trạng sử dụng phòng & thu tiền"
        description="Vấn đề Bộ phận buồng phòng ghi nhận và kết quả thu tiền của lễ tân, tất cả chi nhánh."
        actions={
          <Button variant="secondary" onClick={() => void list.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />

      <section aria-label="Bộ lọc" data-testid="housekeeping-filters" className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
        <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          Bộ lọc
        </p>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-4 py-3">
          <div className="min-w-[17rem]">
            <DateRangeField legend="Khoảng thời gian" value={range} onChange={setRange} max={today} testId="housekeeping-range" />
          </div>
          <label className="block min-w-[14rem] flex-1 text-xs font-medium text-slate-500">
            Chi nhánh
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value === '' ? '' : Number(e.target.value))}
              data-testid="housekeeping-branch"
              className={`${selectClass} mt-1`}
            >
              <option value="">Tất cả chi nhánh</option>
              {(branches.data?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {branchOptionLabel(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-[12rem] flex-1 text-xs font-medium text-slate-500">
            Loại vấn đề
            <select value={type} onChange={(e) => setType(e.target.value as RoomIssueType | '')} data-testid="housekeeping-type" className={`${selectClass} mt-1`}>
              <option value="">Tất cả</option>
              {ROOM_ISSUE_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-[10rem] flex-1 text-xs font-medium text-slate-500">
            Trạng thái thu tiền
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as RoomCollectionStatus | '')}
              data-testid="housekeeping-status"
              className={`${selectClass} mt-1`}
            >
              <option value="">Tất cả</option>
              {ROOM_COLLECTION_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {!rangeValid ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
        </p>
      ) : (
        <>
          {summary ? <RoomIssueSummaryStrip summary={summary} /> : null}
          {summary && summary.byType.length > 0 ? (
            <p data-testid="housekeeping-by-type" className="text-xs text-slate-600">
              Theo loại:{' '}
              {summary.byType.map((t) => `${t.label}: ${t.count}`).join(' · ')}
            </p>
          ) : null}
          <RoomIssueTable
            mode="admin"
            title="Vấn đề phòng"
            issues={list.data?.issues ?? []}
            isLoading={list.isLoading}
            isError={list.isError}
            error={list.error}
            onRetry={() => void list.refetch()}
            onCollect={setCollecting}
            onVoid={setVoiding}
            emptyTitle="Không có vấn đề phòng"
            emptyMessage="Không có vấn đề nào khớp với bộ lọc đang chọn."
          />
          {list.data?.truncated ? (
            <p data-testid="housekeeping-truncated" className="text-xs text-slate-500">
              Đang hiển thị {list.data.issues.length} trên tổng số {list.data.total} vấn đề mới nhất. Tổng hợp phía trên
              tính trên toàn bộ. Thu hẹp bộ lọc để xem đầy đủ.
            </p>
          ) : null}
        </>
      )}

      {collecting ? (
        <CollectionDialog
          issue={collecting}
          onClose={() => setCollecting(null)}
          onSaved={(message) => {
            setCollecting(null);
            setToast(message);
          }}
        />
      ) : null}
      {voiding ? (
        <VoidRoomIssueDialog
          issue={voiding}
          onClose={() => setVoiding(null)}
          onVoided={(message) => {
            setVoiding(null);
            setToast(message);
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
