/**
 * "KPI & THU TIỀN" — the worker's own record, and nobody else's.
 *
 * What it found during "Kiểm phòng", and what Reception collected against those
 * findings — credited to this account automatically, because the account saved
 * the inspection. The period is the shared filter (Hôm nay / Ngày cụ thể /
 * Khoảng ngày) over the days the findings were recorded.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Coins, Hourglass, TriangleAlert, Wallet } from 'lucide-react';
import { ROOM_WORK_KEY, roomWorkApi } from '../api/roomWork';
import { DataTable, type DataColumn } from '../components/DataTable';
import { PageHeader } from '../components/PageState';
import { ReportFilterBar } from '../components/ReportFilter';
import { StatCard } from '../components/StatCard';
import { initialReportFilter, reportPeriod, type ReportFilterValue } from '../lib/reportFilter';
import { formatVnd } from '../lib/money';
import { formatDateTime, hcmToday } from '../lib/format';
import type { FindingLine } from '../api/roomWork';

const COLUMNS: DataColumn<FindingLine>[] = [
  { key: 'when', header: 'Thời gian', render: (f) => formatDateTime(f.createdAt) },
  { key: 'room', header: 'Phòng', render: (f) => `${f.roomNumber} · CN ${f.branch.branchNumber}` },
  { key: 'type', header: 'Phát sinh', render: (f) => (f.note ? `${f.typeLabel} — ${f.note}` : f.typeLabel) },
  { key: 'status', header: 'Thu tiền', render: (f) => f.collectionStatusLabel },
  { key: 'amount', header: 'Số tiền', align: 'right', render: (f) => (f.amount === null ? '—' : formatVnd(f.amount)) },
  { key: 'by', header: 'Lễ tân xác nhận', secondary: true, render: (f) => f.collectedByName ?? '—' },
];

export function HousekeepingKpiPage() {
  const today = hcmToday();
  const [filter, setFilter] = useState<ReportFilterValue>(() => initialReportFilter(today));
  const period = reportPeriod(filter, today);
  const kpi = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'my-kpi', period],
    queryFn: () => roomWorkApi.myKpi(period!),
    enabled: period !== null,
  });
  const s = kpi.data?.summary;
  return (
    <div>
      <PageHeader title="KPI & Thu tiền" description="Phát sinh bạn ghi nhận khi kiểm phòng, và số tiền lễ tân đã thu từ các phát sinh đó." />
      <ReportFilterBar value={filter} onChange={setFilter} today={today} showShifts={false} testId="kpi-filter" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="my-kpi">
        <StatCard label="Lượt kiểm phòng" value={s?.inspections ?? 0} icon={ClipboardList} />
        <StatCard label="Số phát sinh" value={s?.findings ?? 0} icon={TriangleAlert} tone="amber" />
        <StatCard label="Đã thu" value={s?.collectedCount ?? 0} icon={Coins} />
        <StatCard label="Chưa thu" value={s?.pendingCount ?? 0} icon={Hourglass} />
        <StatCard label="Tổng tiền đã thu" value={formatVnd(s?.collectedAmount ?? 0)} icon={Wallet} />
      </div>
      <DataTable
        title="Phát sinh của tôi"
        testId="my-findings"
        columns={COLUMNS}
        rows={kpi.data?.findings ?? []}
        rowKey={(f) => f.id}
        isLoading={kpi.isLoading}
        isError={kpi.isError}
        error={kpi.error}
        onRetry={() => void kpi.refetch()}
        emptyTitle="Chưa có phát sinh trong khoảng này"
        emptyMessage="Phát sinh bạn ghi nhận khi kiểm phòng sẽ hiện ở đây."
      />
    </div>
  );
}
