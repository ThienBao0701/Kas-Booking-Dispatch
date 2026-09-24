/**
 * The vocabulary of "Báo cáo vấn đề": the five categories, the three payment
 * methods, the five room-service subtypes — and their Vietnamese labels.
 *
 * WHY THE LABELS LIVE ON THE SERVER
 *
 * The same words appear on the reception journal, on the Admin drill-down, in
 * the PDF and in the XLSX. Two of those four are built here, so if React owned
 * the wording the exported file and the screen it was exported from would
 * eventually disagree about what a row is called — and a report whose column
 * says something different from the screen is a report nobody trusts. The client
 * fetches this list once; it does not keep its own copy.
 */
import type {
  OperationalReportCategory,
  ReceptionPaymentMethod,
  RoomServiceType,
} from '@prisma/client';

/**
 * THE OPERATOR'S OWN WORDS, and the only copy of them.
 *
 * These five strings are the category tabs, the PDF's section headings and the
 * XLSX's sheet names. Keeping them here means a rename lands on all three at
 * once — a label that says one thing on screen and another in the exported file
 * is how an operator stops trusting the export.
 *
 * "Dịch vụ phòng, KPI" is ONE category, not two. There is no KPI tab, and the
 * project has no KPI data source; the section shows the service records and
 * their totals, which is arithmetic on real rows rather than an invented metric.
 */
export const CATEGORY_LABELS: Record<OperationalReportCategory, string> = {
  PAYMENT: 'Theo dõi thanh toán',
  GUEST_REQUEST: 'Vấn đề khách yêu cầu',
  FACILITY_ISSUE: 'Sự cố vật chất đang xử lý',
  CUSTOMER_COMPLAINT: 'Vấn đề về chất lượng dịch vụ',
  ROOM_SERVICE: 'Dịch vụ phòng, KPI',
};

/** Declaration order IS the order of the menu and of the report's sections. */
export const CATEGORIES: readonly OperationalReportCategory[] = [
  'PAYMENT',
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
];

/** Roman numerals I–V, the way the PDF numbers its sections. */
export const CATEGORY_NUMERALS: Record<OperationalReportCategory, string> = {
  PAYMENT: 'I',
  GUEST_REQUEST: 'II',
  FACILITY_ISSUE: 'III',
  CUSTOMER_COMPLAINT: 'IV',
  ROOM_SERVICE: 'V',
};

export const PAYMENT_METHOD_LABELS: Record<ReceptionPaymentMethod, string> = {
  CASH: 'Thu tiền mặt',
  TRANSFER: 'Chuyển khoản',
  CARD: 'Cà thẻ',
};

export const PAYMENT_METHODS: readonly ReceptionPaymentMethod[] = ['CASH', 'TRANSFER', 'CARD'];

export const ROOM_SERVICE_LABELS: Record<RoomServiceType, string> = {
  ROOM_SALE: 'Bán phòng',
  UPGRADE: 'Upgrade',
  SMOKING: 'Hút thuốc',
  LAUNDRY: 'Giặt ủi',
  OTHER: 'Dịch vụ khác',
};

export const ROOM_SERVICE_TYPES: readonly RoomServiceType[] = [
  'ROOM_SALE',
  'UPGRADE',
  'SMOKING',
  'LAUNDRY',
  'OTHER',
];

/**
 * Suggestions for "Ký gửi", NOT a closed list.
 *
 * The specification names them as examples, and a guest leaving a wedding dress
 * or a bicycle must be recorded as that rather than forced into "Vật dụng khác",
 * which would lose the one fact the record exists to preserve. The form offers
 * these three as quick picks and still accepts anything typed.
 */
export const GUEST_REQUEST_ITEM_SUGGESTIONS: readonly string[] = [
  'Balo',
  'Hành lý',
  'Vật dụng khác',
];

/**
 * "7.570.000 ₫".
 *
 * Vietnamese grouping, whole đồng, no decimals — VND has no minor unit. Written
 * out rather than taken from `Intl.NumberFormat` so the server does not depend
 * on which ICU data a Node build happens to ship: a report that silently prints
 * "7,570,000" on one machine and "7.570.000" on another is a report that looks
 * forged to whoever receives the odd one.
 */
export function formatVnd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const negative = amount < 0;
  const digits = Math.abs(Math.round(amount)).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += '.';
    grouped += digits[i];
  }
  return `${negative ? '-' : ''}${grouped} ₫`;
}

/**
 * "7.570.000" — the same number with the symbol left off.
 *
 * FOR TABLE CELLS ONLY, where the unit belongs in the column header instead.
 * Repeating "₫" on every cell costs 6.6pt of an A4 landscape column at 8pt, five
 * columns wide — which is the difference between "100.000.000" fitting on one
 * line and a currency value breaking across two in the middle of the number.
 * Prose and summary lines keep the symbol: there the unit is the point.
 */
export function formatVndPlain(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return formatVnd(amount).replace(' ₫', '');
}

/** The same number without the symbol, for an XLSX cell that is a real number. */
export function vndOrNull(amount: number | null | undefined): number | null {
  return amount === null || amount === undefined ? null : amount;
}
