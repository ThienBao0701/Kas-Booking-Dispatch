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
 * can void a mistaken one (with a reason; it stays on file). Quản lý lễ tân and
 * Tổng quản lý lễ tân work the same page over their own branches, as Reception
 * does: they read and settle the collection; the void stays the Admin's. The
 * server scopes the list and checks the branch of every settlement.
 *
 * "Báo cáo vấn đề → Buồng phòng": the findings read Branch → Room → inspection
 * (one table per branch, rooms in order), the housekeeping workdays sit below
 * them ("Ca buồng phòng"), and the same period exports as PDF or Excel.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import {
  ROOM_COLLECTION_STATUSES,
  ROOM_ISSUES_KEY,
  ROOM_ISSUE_TYPES,
  housekeepingApi,
  type RoomCollectionStatus,
  type RoomIssue,
  type RoomIssueType,
  type WorkSegment,
  type WorkShift,
} from '../api/housekeeping';
import { operationalPdfUrl, operationalXlsxUrl } from '../api/receptionReports';
import { branchLabel } from '../auth/types';
import { DataTable, type DataColumn } from '../components/DataTable';
import { adminBranchesApi } from '../api/adminBranches';
import { branchesApi } from '../api/bookings';
import { useAuth } from '../auth/AuthProvider';
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
import { formatDateTime, hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

const selectClass =
  'min-h-[2.75rem] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

export function AdminHousekeepingPage() {
  const today = hcmToday();
  const isAdmin = useAuth().user?.role === 'ADMIN';
  const [range, setRange] = useState<DateRangeValue>({ from: daysBefore(today, 29), to: today });
  const [branchId, setBranchId] = useState<number | ''>('');
  const [type, setType] = useState<RoomIssueType | ''>('');
  const [status, setStatus] = useState<RoomCollectionStatus | ''>('');
  const [collecting, setCollecting] = useState<RoomIssue | null>(null);
  const [voiding, setVoiding] = useState<RoomIssue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const rangeValid = range.from !== '' && range.to !== '' && range.from <= range.to;

  // The branches are the branch table, so a new hotel is a new option here too.
  // A manager's list is their own branches, from the server's scope.
  const branches = useQuery({
    queryKey: isAdmin ? ['admin', 'branches'] : ['branches'],
    queryFn: () => (isAdmin ? adminBranchesApi.list() : branchesApi.list()),
  });

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

  /** Branch → its findings, rooms in order (newest first within a room). */
  const byBranch = useMemo(() => {
    const groups = new Map<number, RoomIssue[]>();
    for (const issue of list.data?.issues ?? []) groups.set(issue.branchId, [...(groups.get(issue.branchId) ?? []), issue]);
    return [...groups.values()]
      .map((rows) => rows.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true })))
      .sort((a, b) => a[0]!.branch.branchNumber - b[0]!.branch.branchNumber);
  }, [list.data]);

  const shifts = useQuery({
    queryKey: [...ROOM_ISSUES_KEY, 'shifts', { range, branchId }],
    queryFn: () =>
      housekeepingApi.shifts({ from: range.from, to: range.to, branchId: branchId === '' ? undefined : branchId }),
    enabled: rangeValid,
  });
  const segments = (shifts.data?.shifts ?? []).flatMap((day) => day.segments.map((seg) => ({ day, seg })));

  const exportScope = {
    from: range.from,
    to: range.to,
    branchId: branchId === '' ? undefined : branchId,
    section: 'HOUSEKEEPING' as const,
  };
  const exportLink = (href: string, text: string, testId: string) => (
    <a
      href={rangeValid ? href : undefined}
      aria-disabled={rangeValid ? undefined : true}
      data-testid={testId}
      className={`inline-flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${
        rangeValid ? '' : 'pointer-events-none opacity-50'
      }`}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {text}
    </a>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Buồng phòng — tình trạng sử dụng phòng & thu tiền"
        description={`Vấn đề Bộ phận buồng phòng ghi nhận và kết quả thu tiền của lễ tân, ${isAdmin ? 'tất cả chi nhánh' : 'các chi nhánh được phân công'}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {exportLink(operationalPdfUrl(exportScope), 'Xuất PDF', 'housekeeping-export-pdf')}
            {exportLink(operationalXlsxUrl(exportScope), 'Xuất Excel', 'housekeeping-export-xlsx')}
            <Button variant="secondary" onClick={() => void list.refetch()} aria-label="Làm mới">
              <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Làm mới
            </Button>
          </div>
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
          {byBranch.length === 0 ? (
            <RoomIssueTable
              mode="admin"
              title="Vấn đề phòng"
              issues={[]}
              isLoading={list.isLoading}
              isError={list.isError}
              error={list.error}
              onRetry={() => void list.refetch()}
              emptyTitle="Không có vấn đề phòng"
              emptyMessage="Không có vấn đề nào khớp với bộ lọc đang chọn."
            />
          ) : (
            byBranch.map((rows) => (
              <RoomIssueTable
                key={rows[0]!.branchId}
                mode="admin"
                testId={`room-issue-table-${rows[0]!.branchId}`}
                title={`${branchLabel(rows[0]!.branch)} — ${rows.length} vấn đề`}
                issues={rows}
                onCollect={setCollecting}
                onVoid={isAdmin ? setVoiding : undefined}
              />
            ))
          )}
          {list.data?.truncated ? (
            <p data-testid="housekeeping-truncated" className="text-xs text-slate-500">
              Đang hiển thị {list.data.issues.length} trên tổng số {list.data.total} vấn đề mới nhất. Tổng hợp phía trên
              tính trên toàn bộ. Thu hẹp bộ lọc để xem đầy đủ.
            </p>
          ) : null}
          <DataTable
            title="Ca buồng phòng"
            testId="housekeeping-shifts"
            columns={SEGMENT_COLUMNS}
            rows={segments}
            rowKey={(r) => r.seg.id}
            isLoading={shifts.isLoading}
            isError={shifts.isError}
            error={shifts.error}
            onRetry={() => void shifts.refetch()}
            emptyTitle="Chưa có ca buồng phòng"
            emptyMessage="Các ca “Vào ca” của Bộ phận buồng phòng trong khoảng này sẽ hiện ở đây."
          />
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

/** One row per branch segment of a workday: who, where, when, and what was found. */
const SEGMENT_COLUMNS: DataColumn<{ day: WorkShift; seg: WorkSegment }>[] = [
  { key: 'account', header: 'Tài khoản', render: (r) => r.day.user.fullName },
  { key: 'branch', header: 'Chi nhánh', render: (r) => branchLabel(r.seg.branch) },
  { key: 'staff', header: 'Người dọn buồng', render: (r) => r.seg.staffName },
  {
    key: 'time',
    header: 'Thời gian',
    render: (r) => `${formatDateTime(r.seg.startedAt)} – ${r.seg.endedAt ? formatDateTime(r.seg.endedAt) : 'đang làm'}`,
  },
  { key: 'rooms', header: 'Phòng', align: 'right', render: (r) => r.seg.rooms },
  { key: 'inspections', header: 'Kiểm tra', align: 'right', render: (r) => r.seg.inspections },
  { key: 'issues', header: 'Vấn đề', align: 'right', render: (r) => r.seg.issues },
  {
    key: 'types',
    header: 'Theo loại',
    secondary: true,
    render: (r) => r.seg.byType.map((t) => `${t.label}: ${t.count}`).join(' · ') || '—',
  },
];
