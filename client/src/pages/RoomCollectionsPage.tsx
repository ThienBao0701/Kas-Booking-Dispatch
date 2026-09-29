/**
 * "THU TIỀN BUỒNG PHÒNG" — Reception settles what Bộ phận buồng phòng found.
 *
 * Every issue of the branch, each settled on its OWN: how much, whether it was
 * collected, by which method, or why it could not be. This is deliberately not
 * part of "Theo dõi thanh toán": nothing here enters the drawer, and the two are
 * never summed. The branch is the receptionist's own, decided by the server.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { ROOM_ISSUES_KEY, housekeepingApi, type RoomCollectionStatus, type RoomIssue } from '../api/housekeeping';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageState';
import {
  CollectionDialog,
  RoomIssueSummaryStrip,
  RoomIssueTable,
} from '../components/RoomIssueViews';
import { Toast } from '../components/Toast';

type Filter = RoomCollectionStatus | 'ALL';

const FILTERS: { code: Filter; label: string }[] = [
  { code: 'ALL', label: 'Tất cả' },
  { code: 'PENDING', label: 'Chưa thu' },
  { code: 'COLLECTED', label: 'Đã thu' },
  { code: 'UNCOLLECTIBLE', label: 'Không thu được' },
];

export function RoomCollectionsPage() {
  const [filter, setFilter] = useState<Filter>('PENDING');
  const [collecting, setCollecting] = useState<RoomIssue | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const list = useQuery({
    queryKey: [...ROOM_ISSUES_KEY, 'reception', filter],
    queryFn: () => housekeepingApi.issues({ status: filter === 'ALL' ? undefined : filter }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const summary = list.data?.summary ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Thu tiền buồng phòng"
        description="Xử lý thu tiền cho từng vấn đề Bộ phận buồng phòng ghi nhận. Khoản thu này tách riêng khỏi sổ thanh toán."
        actions={
          <Button variant="secondary" onClick={() => void list.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />

      {summary ? <RoomIssueSummaryStrip summary={summary} /> : null}

      <nav aria-label="Lọc theo trạng thái thu tiền" className="overflow-x-auto">
        <div className="flex w-max gap-1 rounded-xl border border-slate-300 bg-slate-100 p-1">
          {FILTERS.map((f) => {
            const active = filter === f.code;
            const count =
              summary === null ? undefined : f.code === 'ALL' ? summary.total : summary.byStatus[f.code];
            return (
              <button
                key={f.code}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.code)}
                data-testid={`room-filter-${f.code}`}
                className={`inline-flex min-h-[2.5rem] items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                  active ? 'bg-white font-semibold text-brand-700 shadow-sm ring-1 ring-slate-300' : 'font-medium text-slate-600 hover:bg-white/70'
                }`}
              >
                {f.label}
                {count !== undefined ? (
                  <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${active ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      <RoomIssueTable
        mode="reception"
        title="Vấn đề phòng của chi nhánh"
        issues={list.data?.issues ?? []}
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => void list.refetch()}
        onCollect={setCollecting}
        emptyTitle={filter === 'PENDING' ? 'Không có khoản nào chờ thu' : 'Không có vấn đề phòng nào'}
        emptyMessage="Các vấn đề Bộ phận buồng phòng ghi nhận cho chi nhánh này sẽ hiện ở đây."
      />
      {list.data?.truncated ? (
        <p className="text-xs text-slate-500">
          Đang hiển thị {list.data.issues.length} trên tổng số {list.data.total} vấn đề mới nhất.
        </p>
      ) : null}

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
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
