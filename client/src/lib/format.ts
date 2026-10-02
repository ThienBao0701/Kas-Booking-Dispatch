/** Formatting helpers shared across the operational screens. */

const vndFormatter = new Intl.NumberFormat('vi-VN');

/** Whole VND with a đồng sign, or a dash when unknown. Money is never invented. */
export function formatMoney(amount: number | null | undefined, currency = 'VND'): string {
  if (amount === null || amount === undefined) return '—';
  if (currency === 'VND') return `${vndFormatter.format(amount)} ₫`;
  return `${vndFormatter.format(amount)} ${currency}`;
}

/** ISO "YYYY-MM-DD" -> "DD/MM/YYYY". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

const VI_WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** ISO "YYYY-MM-DD" -> "Thứ Bảy, 19/07/2026" (Vietnamese weekday + full date). */
export function formatViWeekdayDate(iso: string | null | undefined): string {
  if (!iso) return 'Chưa xác định';
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return 'Chưa xác định';
  return `${VI_WEEKDAYS[date.getUTCDay()]}, ${formatDate(iso)}`;
}

/** ISO datetime -> "DD/MM/YYYY HH:mm" in the viewer's locale time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const HCM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today's calendar date in Asia/Ho_Chi_Minh, as ISO "YYYY-MM-DD". */
export function hcmToday(now: Date = new Date()): string {
  return new Date(now.getTime() + HCM_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's date in Asia/Ho_Chi_Minh as "DD/MM" (no year) — for the PMS note. */
/**
 * "13:15" — the wall-clock time in Asia/Ho_Chi_Minh.
 *
 * Computed from the browser's UTC instant plus the fixed +7 offset, NOT from
 * `getHours()`. A reception PC whose timezone is set to somewhere else would
 * otherwise show a time several hours out in the very dialog where the operator
 * confirms when a shift changed hands. Its UTC clock being wrong is far less
 * likely than its timezone being wrong, and the server records the real instant
 * either way — this is what the operator READS, not what is stored.
 */
export function hcmTimeOfDay(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

export function hcmDayMonth(now: Date = new Date()): string {
  const iso = hcmToday(now);
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/**
 * The canonical plain-text amount format used for every *copyable* amount in the
 * app (nightly price, total, generated note): Vietnamese thousands separators,
 * whole đồng, no currency symbol — e.g. 609120 -> "609.120". Unknown -> the
 * agreed "Chưa xác định" placeholder so a missing amount is never blank.
 */
export function formatAmountCopy(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'Chưa xác định';
  return vndFormatter.format(Math.round(amount));
}

/** True when an ISO date equals today in Asia/Ho_Chi_Minh. */
export function isTodayHcm(iso: string | null | undefined): boolean {
  return !!iso && iso.slice(0, 10) === hcmToday();
}

/** Number of nights between two ISO dates (check-out exclusive). */
export function nightCount(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0;
  const ms = new Date(`${checkOut}T00:00:00Z`).getTime() - new Date(`${checkIn}T00:00:00Z`).getTime();
  return ms > 0 ? Math.round(ms / 86_400_000) : 0;
}

// Operational payment wording. Every user-facing screen shows exactly these
// (never the old "Đã thanh toán" / "Thanh toán tại khách sạn"); the DB enum
// values PAY_BEFORE / PAY_AFTER are unchanged internally.
const PAYMENT_LABELS: Record<string, string> = {
  PAY_BEFORE: 'PAY BEFORE CHECK-IN',
  PAY_AFTER: 'PAY AFTER CHECK-IN',
};

export function paymentLabel(status: string | null | undefined): string {
  return status ? (PAYMENT_LABELS[status] ?? status) : '—';
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Bản nháp',
  READY: 'Sẵn sàng',
  NEW: 'Chờ chi nhánh tạo',
  COMPLETED: 'Đã xác nhận tạo',
  ARCHIVED: 'Đã lưu trữ',
  // The Phase 5 operational lifecycle, in the receptionist's own words.
  RECEIVED: 'Đã nhận đơn',
  CHECKED_IN: 'Khách đã nhận phòng',
  CHECKED_OUT: 'Khách đã trả phòng',
  CANCELLED: 'Đã huỷ',
  NO_SHOW: 'Khách không đến',
};

export function statusLabel(status: string | null | undefined): string {
  return status ? (STATUS_LABELS[status] ?? status) : '—';
}

const VERIFICATION_LABELS: Record<string, string> = {
  NOT_SUBMITTED: 'Chưa gửi kiểm tra',
  PENDING_REVIEW: 'Chờ kiểm tra',
  APPROVED: 'Đã xác nhận đúng',
  REJECTED: 'Cần tạo lại',
};

export function verificationLabel(status: string | null | undefined): string {
  return status ? (VERIFICATION_LABELS[status] ?? status) : '—';
}

/** Human file size, e.g. 1536 -> "1,5 KB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0).replace('.', ',')} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')} MB`;
}

/** The exact payment token used in the "Sao chép toàn bộ" text. */
export function payStatusCopy(status: string | null | undefined): string {
  if (status === 'PAY_BEFORE') return 'PAY BEFORE CHECK-IN';
  if (status === 'PAY_AFTER') return 'PAY AFTER CHECK-IN';
  return 'Chưa xác định';
}

/** Short relative time in Vietnamese, e.g. "vừa xong", "5 phút trước". */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((now.getTime() - then) / 1000);
  if (diffSec < 45) return 'vừa xong';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay} ngày trước`;
  return formatDate(iso);
}
