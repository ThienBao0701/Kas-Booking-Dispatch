/**
 * "GIAO NHẬN HÀNG HÓA" — what Technical and Housekeeping may see of it.
 *
 * The SAME delivery records Reception writes, filtered by the server to the
 * caller's own department (a technician sees Kỹ thuật's items across every
 * branch; a housekeeper sees Buồng phòng's items at their own hotel). Read-only:
 * there is no form and no action here, and the endpoint would refuse a write.
 *
 * Two lists, split by the 12-hour rule the server applies: what is still being
 * followed, and "Hoàn thành vấn đề".
 */
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { DeliveryTable } from '../components/HotelDelivery';
import { useDeliveries } from '../hooks/useDeliveries';
import { PageHeader } from '../components/PageState';
import { COMPLETED_ISSUES_TITLE } from '../lib/reportCategories';

export function DepartmentDeliveriesPage() {
  const { user } = useAuth();
  const active = useDeliveries('active');
  const archived = useDeliveries('archived');
  const department = user?.role === 'TECHNICAL' ? 'Kỹ thuật' : 'Buồng phòng';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Giao nhận hàng hóa của khách sạn"
        description={`Hàng hóa giao nhận thuộc bộ phận ${department}, do lễ tân ghi nhận.`}
        actions={
          <Button
            variant="secondary"
            aria-label="Làm mới"
            onClick={() => {
              void active.refetch();
              void archived.refetch();
            }}
          >
            <RefreshCw className={`h-4 w-4 ${active.isFetching || archived.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />
      <DeliveryTable
        title="Đang theo dõi"
        testId="department-delivery-active"
        rows={active.data?.deliveries ?? []}
        isLoading={active.isLoading}
        isError={active.isError}
        error={active.error}
        onRetry={() => void active.refetch()}
        section={{}}
        emptyTitle="Chưa có mục nào đang theo dõi"
        emptyMessage={`Hàng hóa giao nhận cho ${department} sẽ hiện ở đây khi lễ tân ghi nhận.`}
      />
      <DeliveryTable
        title={COMPLETED_ISSUES_TITLE}
        testId="department-delivery-archived"
        rows={archived.data?.deliveries ?? []}
        isLoading={archived.isLoading}
        isError={archived.isError}
        error={archived.error}
        onRetry={() => void archived.refetch()}
        section={{}}
        emptyTitle="Chưa có mục nào hoàn thành quá thời hạn"
        emptyMessage="Các mục đã hoàn thành quá 12 giờ sẽ chuyển sang đây."
      />
    </div>
  );
}
