/**
 * "CÔNG VIỆC BELL" — the guest requests given to this Bell: "Nhận việc" to
 * acknowledge one, "Hoàn thành" to record how it was done. Open ones first, then
 * those completed in the last 12 hours (after that, they are history). Nothing
 * else of the desk's journal, and no booking screen — the server keeps Bell to
 * these.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsApi } from '../api/receptionReports';
import { REPORTS_KEY } from '../lib/reportKeys';
import { GuestRequestTable } from '../components/OperationalTables';
import { PageHeader } from '../components/PageState';
import { Toast } from '../components/Toast';

export const BELL_REQUESTS_KEY = [...REPORTS_KEY, 'assigned'] as const;

export function BellWorkPage() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const list = useQuery({
    queryKey: BELL_REQUESTS_KEY,
    queryFn: () => reportsApi.assigned(),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const rows = list.data?.reports ?? [];
  const open = rows.filter((r) => !r.guestRequest?.completed).length;
  return (
    <div>
      <PageHeader
        title="Công việc Bell"
        description={`Yêu cầu của khách được giao cho bạn${open > 0 ? ` — ${open} việc chưa xong` : ''}. Bấm “Nhận việc” khi nhận, “Hoàn thành” khi xong.`}
      />
      <GuestRequestTable
        rows={rows}
        title="Việc được giao"
        canEdit={false}
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => void list.refetch()}
        onChanged={async () => {
          await queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
        }}
        onToast={setToast}
        emptyTitle="Chưa có việc nào được giao"
      />
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
