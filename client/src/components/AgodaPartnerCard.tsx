import { AlertTriangle, Plane } from 'lucide-react';
import type { AgodaPartnerExtras } from '../api/bookings';
import { Card } from './Card';
import { CopyButton } from './CopyButton';
import { formatDate, formatMoney } from '../lib/format';

/**
 * Preview of an extracted Agoda **hotel-partner** email: the fields the operator
 * checks plus the exact two-line PMS note, ready to copy. Rendered only when the
 * pasted text was recognised as an Agoda partner booking.
 */
export function AgodaPartnerCard({ agoda }: { agoda: AgodaPartnerExtras }) {
  return (
    <Card className="border-brand-200 bg-brand-50/30 p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <Plane className="h-4 w-4 text-brand-600" aria-hidden="true" />
        Đơn Agoda
      </p>

      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <Row label="Nguồn" value="AGODA" />
        {/* Like Booking.com, "Khách sạn" is the configured branch ADDRESS. */}
        <Row label="Khách sạn" value={agoda.branchAddress} />
        <Row label="Mã đặt phòng" value={agoda.bookingId} mono />
        <Row label="Tên khách" value={agoda.customerFullName} />
        <Row label="Ngày nhận" value={agoda.checkIn ? formatDate(agoda.checkIn) : null} />
        <Row label="Ngày trả" value={agoda.checkOut ? formatDate(agoda.checkOut) : null} />
        <Row label="Số đêm" value={agoda.nights != null ? String(agoda.nights) : null} />
        <Row label="Số phòng" value={agoda.roomQuantity != null ? String(agoda.roomQuantity) : null} />
        <Row label="Loại phòng" value={agoda.roomTypeOriginal} />
        <Row label="Mã phòng" value={agoda.roomCode} mono />
        <Row label="Tổng công nợ" value={agoda.totalDebtAmount != null ? formatMoney(agoda.totalDebtAmount, 'VND') : null} />
        <Row label="Giá khách đặt" value={agoda.referenceSellRate != null ? formatMoney(agoda.referenceSellRate, 'VND') : null} />
        <Row label="Thanh toán" value={agoda.payment} />
      </dl>

      {agoda.nightlyDebt.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Giá công nợ từng đêm</p>
          <ul className="grid gap-x-6 gap-y-0.5 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
            {agoda.nightlyDebt.map((n) => (
              <li key={n.stayDate} className="flex justify-between gap-3">
                <span className="text-slate-500">{formatDate(n.stayDate)}</span>
                <span className="font-medium">{n.amount != null ? formatMoney(n.amount, 'VND') : '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!agoda.branchAddress ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          Không xác định được địa chỉ chi nhánh từ tên khách sạn Agoda
          {agoda.sourceHotelName ? ` (“${agoda.sourceHotelName}”)` : ''}. Vui lòng chọn chi nhánh thủ công.
        </p>
      ) : null}

      {!agoda.roomTypeKnown && agoda.roomTypeOriginal ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          Hạng phòng “{agoda.roomTypeOriginal}” chưa có mã nội bộ — cần kiểm tra thủ công.
        </p>
      ) : null}

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">PMS Note (Agoda)</p>
          {agoda.pmsNote ? <CopyButton value={agoda.pmsNote} label="Sao chép PMS Note" /> : null}
        </div>
        {agoda.pmsNote ? (
          <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800">
            {agoda.pmsNote}
          </pre>
        ) : (
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
            {agoda.pmsNoteError ?? 'Chưa đủ dữ liệu để tạo ghi chú Agoda.'}
          </p>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm ${value ? 'font-medium text-slate-800' : 'italic text-slate-400'} ${mono && value ? 'font-mono' : ''}`}>
        {value ?? 'Không đọc được'}
      </dd>
    </div>
  );
}
