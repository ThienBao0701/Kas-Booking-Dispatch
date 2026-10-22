/**
 * "CÔNG VIỆC MỖI NGÀY CẦN LÀM" — one page, one selector, for the Quản lý buồng
 * phòng and the Admin:
 *
 *   Tổng                          today's work at a glance: counts, then every
 *                                 item with who has it and what comes next
 *   Dọn phòng                     the manager's own rooms (the Admin cleans none)
 *   Kiểm kho                      the physical count
 *   Phân công ca, việc làm        giving out today's work
 *   Phân công việc ngày hôm sau   preparing tomorrow's
 *
 * Each tab is the full screen it always was; `?tab=` keeps the choice in the
 * address, and the old addresses land on their tab.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { roomWorkApi, ROOM_WORK_KEY, type RoomTask } from '../api/roomWork';
import { useAuth } from '../auth/AuthProvider';
import { DataTable } from '../components/DataTable';
import { CONTROL, HkHeader } from '../components/HkManagerUi';
import { formatDate, hcmToday } from '../lib/format';
import { placeText } from '../lib/workPlaces';
import { useScope } from '../hooks/useHkScope';
import { HkCleaningPage, HkRoomBoardPage } from './HousekeepingManagerPages';
import { StockCountPage } from './HousekeepingInventoryPages';

export type DailyTab = 'overview' | 'clean' | 'count' | 'rooms' | 'tomorrow';

const TABS: { value: DailyTab; label: string; managerOnly?: boolean }[] = [
  { value: 'overview', label: 'Tổng' },
  // The manager cleans rooms itself; the Admin works no shift.
  { value: 'clean', label: 'Dọn phòng', managerOnly: true },
  { value: 'count', label: 'Kiểm kho' },
  { value: 'rooms', label: 'Phân công ca, việc làm' },
  { value: 'tomorrow', label: 'Phân công việc ngày hôm sau' },
];

/** What the item waits for next — the manager's reading of its phase. */
function nextAction(t: RoomTask): string {
  if (t.voided) return '—';
  if (t.noClean?.status === 'PENDING') return 'Duyệt “Không cần dọn”';
  if (t.review?.status === 'PENDING') return 'Đánh giá sau dọn';
  if (!t.assignee) return 'Giao người làm';
  switch (t.phase) {
    case 'UNCLAIMED':
    case 'ACCEPTED':
      return t.areaKind && t.areaKind !== 'ROOM' ? 'Kiểm tra tình trạng' : 'Kiểm phòng';
    case 'INSPECTING':
      return 'Hoàn tất kiểm tra';
    case 'AWAITING_CLEANING':
      return 'Bắt đầu dọn';
    case 'CLEANING':
      return 'Hoàn thành dọn';
    default:
      return '—';
  }
}

export function HkDailyWorkPage() {
  const { user } = useAuth();
  const manager = user?.role === 'HOUSEKEEPING_MANAGER';
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => manager || !t.managerOnly);
  const asked = params.get('tab') as DailyTab | null;
  const tab: DailyTab = tabs.some((t) => t.value === asked) ? asked! : 'overview';
  const choose = (next: DailyTab) =>
    // A tab's own query (the board's `?view=`) belongs to that tab only.
    setParams(next === 'overview' ? {} : { tab: next }, { replace: true });
  return (
    <div>
      <nav aria-label="Công việc mỗi ngày cần làm" className="mb-4 flex flex-wrap gap-2" data-testid="daily-tabs">
        {tabs.map((t) => {
          const on = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              aria-pressed={on}
              onClick={() => choose(t.value)}
              data-testid={`daily-tab-${t.value}`}
              className={`min-h-[2.5rem] rounded-lg border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                on ? 'border-brand-600 bg-brand-600 font-semibold text-white' : 'border-line-strong bg-white font-medium text-slate-700 hover:bg-slate-50'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      {tab === 'overview' ? (
        <DailyOverview />
      ) : tab === 'clean' ? (
        <HkCleaningPage />
      ) : tab === 'count' ? (
        <StockCountPage />
      ) : tab === 'rooms' ? (
        <HkRoomBoardPage key="rooms" />
      ) : (
        <HkRoomBoardPage key="tomorrow" planTomorrow />
      )}
    </div>
  );
}

/** "Tổng" — today's work items of the branch (the Admin: every branch, or one). */
function DailyOverview() {
  const date = hcmToday();
  const scope = useScope(true);
  const [search, setSearch] = useState('');
  const tasks = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, scope.branchId ?? null],
    queryFn: () => roomWorkApi.tasks({ date, branchId: scope.branchId }),
    enabled: scope.ready,
    refetchInterval: 30_000,
  });
  const all = tasks.data?.tasks ?? [];
  const term = search.trim().toLowerCase();
  const rows = all.filter(
    (t) =>
      !term ||
      [placeText(t), t.branch.address, t.assignee?.name ?? '', t.phaseLabel ?? t.stateLabel, t.taskLabel ?? ''].join(' ').toLowerCase().includes(term),
  );
  const cards = [
    { key: 'total', label: 'Tổng việc', value: all.length },
    { key: 'unassigned', label: 'Chưa có người làm', value: all.filter((t) => !t.assignee && t.phase !== 'COMPLETED').length },
    { key: 'working', label: 'Đang làm', value: all.filter((t) => t.phase === 'INSPECTING' || t.phase === 'AWAITING_CLEANING' || t.phase === 'CLEANING').length },
    { key: 'review', label: 'Chờ duyệt / đánh giá', value: all.filter((t) => t.review?.status === 'PENDING' || t.noClean?.status === 'PENDING').length },
    { key: 'done', label: 'Hoàn thành', value: all.filter((t) => t.phase === 'COMPLETED' || t.phase === 'NO_CLEAN').length },
  ];
  return (
    <div>
      <HkHeader
        title="Công việc mỗi ngày cần làm"
        description="Công việc buồng phòng hôm nay: ai đang làm gì và việc gì cần làm tiếp."
        branch={scope.label}
        period={{ label: 'Ngày nghiệp vụ', value: formatDate(date) }}
        controls={scope.picker}
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="daily-cards">
          {cards.map((c) => (
            <div key={c.key} className="rounded-xl border border-line-subtle bg-white px-3 py-2.5 text-center" data-testid={`daily-card-${c.key}`}>
              <p className="text-xs font-medium text-slate-600">{c.label}</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{c.value}</p>
            </div>
          ))}
        </div>
        <DataTable
          title="Công việc hôm nay"
          testId="daily-table"
          columns={[
            { key: 'date', header: 'Ngày', className: 'w-[1%] whitespace-nowrap', secondary: true, render: (t) => formatDate(t.workDate) },
            { key: 'branch', header: 'Chi nhánh', secondary: true, render: (t) => t.branch.address },
            { key: 'place', header: 'Phòng / khu vực', render: (t) => <span className="font-medium text-slate-900">{placeText(t)}</span> },
            { key: 'status', header: 'Trạng thái', render: (t) => t.phaseLabel ?? t.stateLabel },
            { key: 'who', header: 'Người làm', render: (t) => t.assignee?.name ?? <span className="text-slate-400">Chưa giao</span> },
            { key: 'next', header: 'Việc tiếp theo', render: (t) => nextAction(t) },
          ]}
          rows={rows}
          rowKey={(t) => t.id}
          isLoading={tasks.isLoading}
          isError={tasks.isError}
          error={tasks.error}
          onRetry={() => void tasks.refetch()}
          emptyTitle={term ? 'Không có công việc phù hợp' : 'Hôm nay chưa có công việc'}
          emptyMessage={term ? 'Thử từ khóa khác.' : 'Tạo công việc ở “Phân công ca, việc làm”.'}
          headerAction={
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm phòng, người làm…"
              aria-label="Tìm công việc"
              data-testid="daily-search"
              className={`${CONTROL} w-full max-w-[16rem]`}
            />
          }
        />
      </div>
    </div>
  );
}
