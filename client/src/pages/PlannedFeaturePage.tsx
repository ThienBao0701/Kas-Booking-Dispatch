/**
 * A SCREEN THAT IS PLANNED, NOT BUILT — "Theo dõi công việc đã giao", "Theo dõi
 * công việc được giao và phải xử lí", "Individual Performance". It says so
 * plainly: no figures, records or charts, and no request to any server.
 */
import { Hourglass } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageState';

const PLANNED_STATUS = 'Sẽ phát triển';

export function PlannedFeaturePage({ title, description }: { title: string; description: string }) {
  return (
    <div data-testid="planned-feature">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={<Hourglass className="h-6 w-6" aria-hidden="true" />}
        title={PLANNED_STATUS}
        message="Tính năng này đang được lên kế hoạch và chưa hoạt động. Chưa có dữ liệu nào được theo dõi hay tính toán tại đây."
      />
    </div>
  );
}
