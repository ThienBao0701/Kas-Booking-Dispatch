/**
 * ONE JOURNAL RECORD, in full.
 *
 * WHY RECEPTION AND THE ADMIN SHARE THIS COMPONENT
 *
 * They are looking at the same thing for the same reason: what did the desk
 * record, who recorded it, on which shift, and was it changed afterwards. Two
 * renderers would drift, and the one that drifted would be the Admin's — the
 * one used to answer a question somebody is disputing.
 *
 * What differs is what each ROLE may DO with it, and that is passed in as
 * actions rather than decided here.
 */
import type { ReactNode } from 'react';
import { CircleAlert, History } from 'lucide-react';
import type { OperationalReport } from '../api/receptionReports';
import { formatVnd } from '../lib/money';
import { formatDateTime } from '../lib/format';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-800">{children || '—'}</dd>
    </div>
  );
}

/** The four context fields every record carries, whatever its category. */
function ShiftContext({ row }: { row: OperationalReport }) {
  return (
    <>
      <Field label="Nhân viên">{row.createdByName}</Field>
      <Field label="Ca">{row.shiftName ?? '—'}</Field>
      <Field label="Thời gian">{formatDateTime(row.createdAt)}</Field>
      {row.branch ? <Field label="Chi nhánh">{row.branch.address}</Field> : null}
    </>
  );
}

const ISSUE_STATUS_LABEL: Record<string, string> = {
  NEW: 'Chờ tiếp nhận',
  IN_PROGRESS: 'Đang sửa',
  COMPLETED: 'Hoàn thành',
};

export function OperationalRecordDetail({
  row,
  actions,
}: {
  row: OperationalReport;
  actions?: ReactNode;
}) {
  return (
    <div data-testid={`record-detail-${row.id}`} className="space-y-3">
      {row.voided ? (
        <p
          data-testid={`record-voided-${row.id}`}
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Đã hủy bởi {row.voidedByName ?? '—'} lúc {formatDateTime(row.voidedAt)} — {row.voidReason}
            <span className="mt-0.5 block text-xs">
              Bản ghi vẫn được lưu lại và không tính vào tổng.
            </span>
          </span>
        </p>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ShiftContext row={row} />

        {row.payment ? (
          <>
            <Field label="Mã EZ">{row.payment.ezCode}</Field>
            <Field label="Nguồn">{row.payment.source}</Field>
            <Field label="Tên khách">{row.payment.guestName}</Field>
            <Field label="Số phòng">{row.payment.roomNumber}</Field>
            <Field label="Phương thức">{row.payment.methodLabel}</Field>
            <Field label="Số tiền">{formatVnd(row.payment.amount)}</Field>
            <Field label="Công nợ">{formatVnd(row.payment.receivable)}</Field>
            <Field label="Chi tiền">{formatVnd(row.payment.expense)}</Field>
            <Field label="Ghi chú">{row.payment.note}</Field>
          </>
        ) : null}

        {row.guestRequest ? (
          <>
            <Field label="Ký gửi">{row.guestRequest.itemType}</Field>
            <Field label="Tên khách">{row.guestRequest.guestName}</Field>
            <Field label="Ghi chú">{row.guestRequest.note}</Field>
            {/*
              THE ACCEPTANCE IS ITS OWN SET OF FIELDS. The creator's row above is
              never overwritten by it — a bag taken on Ca A and returned on Ca B
              has two names on it, and the first is the answer to "who took it?".
            */}
            <Field label="Người tiếp nhận">
              {row.guestRequest.acceptedByName ?? 'Chưa tiếp nhận'}
            </Field>
            <Field label="Ca tiếp nhận">{row.guestRequest.acceptedShiftName}</Field>
            <Field label="Thời gian tiếp nhận">
              {row.guestRequest.acceptedAt ? formatDateTime(row.guestRequest.acceptedAt) : '—'}
            </Field>
          </>
        ) : null}

        {row.facility ? (
          <>
            <Field label="Mã sự cố">
              <span className="font-mono text-xs">{row.facility.issueId}</span>
            </Field>
            <Field label="Khu vực / Vị trí">{row.facility.issue.locationLabel}</Field>
            <Field label="Mô tả">{row.facility.issue.description}</Field>
            <Field label="Trạng thái kỹ thuật">
              {row.facility.issue.needsRework
                ? 'Cần xử lý lại'
                : (ISSUE_STATUS_LABEL[row.facility.issue.status] ?? row.facility.issue.status)}
            </Field>
            <Field label="Người xử lý">{row.facility.issue.technicianName}</Field>
            <Field label="SĐT kỹ thuật">{row.facility.issue.technicianPhone}</Field>
            <Field label="Thời gian sửa">{row.facility.issue.durationLabel}</Field>
            <Field label="Số lần sửa">{String(row.facility.issue.attempts.length)}</Field>
          </>
        ) : null}

        {row.complaint ? (
          <>
            <Field label="Tên khách">{row.complaint.guestName}</Field>
            <Field label="Phòng / Khác">{row.complaint.location}</Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <Field label="Mô tả">{row.complaint.description}</Field>
            </div>
          </>
        ) : null}

        {row.roomService ? (
          <>
            <Field label="Loại dịch vụ">{row.roomService.serviceTypeLabel}</Field>
            <Field label="Tên khách">{row.roomService.guestName}</Field>
            <Field label="SĐT">{row.roomService.phone}</Field>
            <Field label="Phòng">{row.roomService.roomNumber}</Field>
            <Field label="Hạng phòng">{row.roomService.roomClass}</Field>
            <Field label="Từ hạng phòng">{row.roomService.fromRoomClass}</Field>
            <Field label="Lên hạng phòng">{row.roomService.toRoomClass}</Field>
            <Field label="Loại hình dịch vụ">{row.roomService.serviceName}</Field>
            <Field label="Giá tiền">{formatVnd(row.roomService.price)}</Field>
            <Field label="Ghi chú">{row.roomService.note}</Field>
          </>
        ) : null}
      </dl>

      {row.audits.length > 0 ? <AuditTrail row={row} /> : null}
      {actions ? <div className="flex flex-wrap gap-2 pt-1">{actions}</div> : null}
    </div>
  );
}

/**
 * The correction history — old value, new value, who, when.
 *
 * Shown to reception as well as to the Admin, deliberately. A receptionist who
 * can see that their correction was recorded is a receptionist who knows the
 * trail exists, which is worth more than hiding it from them would ever be.
 */
function AuditTrail({ row }: { row: OperationalReport }) {
  return (
    <div data-testid={`record-audits-${row.id}`} className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        Lịch sử chỉnh sửa
      </p>
      <ul className="mt-1 space-y-1">
        {row.audits.map((a) => (
          <li key={a.id} className="text-xs text-slate-600">
            {a.action === 'VOID' ? (
              <>
                Hủy bản ghi — {a.reason}
              </>
            ) : (
              <>
                <span className="font-medium">{a.field}</span>: {a.oldValue ?? '—'} →{' '}
                {a.newValue ?? '—'}
                {a.reason ? ` (${a.reason})` : ''}
              </>
            )}{' '}
            · {a.actor.name} · {formatDateTime(a.createdAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}
