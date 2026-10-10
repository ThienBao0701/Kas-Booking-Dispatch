import { Flame } from 'lucide-react';
import type { BookingSource, BookingStatus, BusinessType, PaymentStatus, VerificationStatus } from '../api/bookings';
import { SOURCE_LABEL } from '../api/bookings';
import { paymentLabel, statusLabel, verificationLabel } from '../lib/format';

const BUSINESS_TYPE_META: Record<BusinessType, { label: string; styles: string }> = {
  DIRECT: { label: 'ĐƠN THƯỜNG', styles: 'bg-green-100 text-green-700 ring-1 ring-inset ring-green-200' },
  PARTNER: { label: 'ĐƠN ĐỐI TÁC', styles: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200' },
  UNKNOWN: { label: 'CHƯA XÁC ĐỊNH', styles: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300' },
};

/**
 * Business-type badge with three distinct, colour-plus-text states (the label
 * carries the meaning, so screen readers and colour-blind users are covered):
 * ĐƠN THƯỜNG (green) / ĐƠN ĐỐI TÁC (orange) / CHƯA XÁC ĐỊNH (gray).
 */
export function BusinessTypeBadge({ type }: { type: BusinessType }) {
  const meta = BUSINESS_TYPE_META[type] ?? BUSINESS_TYPE_META.UNKNOWN;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${meta.styles}`}>
      {meta.label}
    </span>
  );
}

const PAYMENT_STYLES: Record<PaymentStatus, string> = {
  PAY_BEFORE: 'bg-green-100 text-green-700 ring-1 ring-inset ring-green-200',
  PAY_AFTER: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200',
};

/**
 * The single payment badge used everywhere payment is shown: PAY BEFORE CHECK-IN
 * (green) / PAY AFTER CHECK-IN (amber). Wording comes from `paymentLabel`; the DB
 * enum is unchanged. The text (not colour) conveys the status.
 */
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${PAYMENT_STYLES[status]}`}>
      {paymentLabel(status)}
    </span>
  );
}

const STATUS_STYLES: Record<BookingStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  READY: 'bg-blue-100 text-blue-700',
  NEW: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-slate-100 text-slate-500',
  // Operational states. Cancelled and no-show are the two that cost money, so
  // they are the two that read as warnings rather than progress.
  RECEIVED: 'bg-sky-100 text-sky-700',
  CHECKED_IN: 'bg-indigo-100 text-indigo-700',
  CHECKED_OUT: 'bg-teal-100 text-teal-700',
  CANCELLED: 'bg-red-100 text-red-700',
  NO_SHOW: 'bg-orange-100 text-orange-800',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {statusLabel(status)}
    </span>
  );
}

const VERIFICATION_STYLES: Record<VerificationStatus, string> = {
  NOT_SUBMITTED: 'bg-slate-100 text-slate-600',
  PENDING_REVIEW: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
};

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${VERIFICATION_STYLES[status]}`}>
      {verificationLabel(status)}
    </span>
  );
}

const SOURCE_STYLES: Record<BookingSource, string> = {
  BOOKING_COM: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200',
  AGODA: 'bg-fuchsia-50 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-200',
  CTRIP: 'bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-200',
};

/** A small chip naming the source platform a booking was imported from. */
export function SourceBadge({ source }: { source: BookingSource }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_STYLES[source]}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

/**
 * The 🔥 LAST MINUTE indicator for check-in-today bookings.
 * `withSubtitle` adds the "Nhận phòng hôm nay" line used on the detail/list header.
 */
export function LastMinuteBadge({ withSubtitle = false }: { withSubtitle?: boolean }) {
  if (withSubtitle) {
    return (
      <span className="inline-flex flex-col rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-red-700">
        <span className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide">
          <Flame className="h-3.5 w-3.5" aria-hidden="true" />
          Last minute
        </span>
        <span className="text-[0.7rem] font-medium text-red-600">Nhận phòng hôm nay</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-red-700"
      title="Nhận phòng hôm nay"
    >
      <Flame className="h-3.5 w-3.5" aria-hidden="true" />
      Last minute
    </span>
  );
}

/**
 * The ONE operational state a receptionist needs.
 *
 * The card used to carry three or four chips at once — dispatch status,
 * verification status, source, business type — and a receptionist scanning a
 * queue had to work out which of them meant "what do I do with this". There is
 * only ever one answer, so there is now only one chip.
 *
 * It reads the VERIFICATION status, because that is the axis reception acts on:
 * create the reservation, wait for review, or redo it. The dispatch status is
 * the same (`NEW`) for every booking in these queues, so showing it said
 * nothing.
 */
export function WorkflowBadge({ status }: { status: VerificationStatus }) {
  const meta: Record<VerificationStatus, { label: string; styles: string }> = {
    NOT_SUBMITTED: { label: 'Chờ chi nhánh tạo', styles: 'bg-amber-100 text-amber-800' },
    PENDING_REVIEW: { label: 'Chờ kiểm tra', styles: 'bg-blue-100 text-blue-700' },
    APPROVED: { label: 'Đã xác nhận đúng', styles: 'bg-green-100 text-green-700' },
    REJECTED: { label: 'Cần tạo lại', styles: 'bg-red-100 text-red-700' },
  };
  const { label, styles } = meta[status];
  return (
    <span
      data-testid="workflow-badge"
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {label}
    </span>
  );
}
