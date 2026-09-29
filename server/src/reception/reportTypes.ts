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
  HotelDeliveryDepartment,
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
  // 31 characters as well — this label names an XLSX sheet too.
  FACILITY_ISSUE: 'Sự cố cơ sở vật chất đang xử lý',
  // 31 characters: exactly Excel's sheet-name limit, which this label also is.
  CUSTOMER_COMPLAINT: 'Vấn đề về chất lượng và dịch vụ',
  ROOM_SERVICE: 'Dịch vụ phòng, KPI',
  /*
    SHORT ON PURPOSE. The operator's full name for this category is "Giao nhận
    hàng hóa của khách sạn" (the reception screens print it in full), but this
    string also names an XLSX sheet, and Excel refuses a sheet name over 31
    characters — the full name is 32.
  */
  HOTEL_DELIVERY: 'Giao nhận hàng hóa',
};

/** The category's full name, for screens and section headings that have room for it. */
export const HOTEL_DELIVERY_TITLE = 'Giao nhận hàng hóa của khách sạn';

/** Declaration order IS the order of the menu and of the report's sections. */
export const CATEGORIES: readonly OperationalReportCategory[] = [
  'PAYMENT',
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
  'HOTEL_DELIVERY',
];

/** Roman numerals I–VI, the way the PDF numbers its sections. */
export const CATEGORY_NUMERALS: Record<OperationalReportCategory, string> = {
  PAYMENT: 'I',
  GUEST_REQUEST: 'II',
  FACILITY_ISSUE: 'III',
  CUSTOMER_COMPLAINT: 'IV',
  ROOM_SERVICE: 'V',
  HOTEL_DELIVERY: 'VI',
};

export const PAYMENT_METHOD_LABELS: Record<ReceptionPaymentMethod, string> = {
  CASH: 'Tiền mặt',
  TRANSFER: 'Chuyển khoản',
  CARD: 'Cà thẻ',
  DEBT: 'Công nợ',
};

/** The order of the "Phương thức thanh toán" selector. */
export const PAYMENT_METHODS: readonly ReceptionPaymentMethod[] = ['CASH', 'TRANSFER', 'CARD', 'DEBT'];

/**
 * THE PRICE COLUMN'S NAME on every "Dịch vụ phòng" subtype — screen, PDF and
 * XLSX. "Tổng giá tiền": the total for the stay or the service, not a unit price.
 * (The client's own copy is `ROOM_SERVICE_PRICE_LABEL` in lib/roomServiceFields.ts.)
 */
export const ROOM_SERVICE_PRICE_LABEL = 'Tổng giá tiền';

export const ROOM_SERVICE_LABELS: Record<RoomServiceType, string> = {
  ROOM_SALE: 'Bán phòng',
  UPGRADE: 'Upgrade',
  SMOKING: 'Hút thuốc',
  LAUNDRY: 'Giặt ủi',
  OTHER: 'Dịch vụ khác',
  REVIEW: 'Review',
};

export const ROOM_SERVICE_TYPES: readonly RoomServiceType[] = [
  'ROOM_SALE',
  'UPGRADE',
  'SMOKING',
  'LAUNDRY',
  'OTHER',
  'REVIEW',
];

/**
 * "Review" is a KPI COUNT, not a sale. Its rows carry the number of reviews the
 * receptionist reports per site, store price 0, and are never revenue — every
 * revenue figure leaves them out by this one predicate.
 */
export function isRevenueService(serviceType: RoomServiceType): boolean {
  return serviceType !== 'REVIEW';
}

/** The most reviews one row may report per site — generous, and not unbounded. */
export const MAX_REVIEW_COUNT = 10_000;

/**
 * "Nguồn" on a payment — A CLOSED LIST, and REQUIRED, for new entries.
 *
 * The channels the desk actually takes money through, "Walking" being the guest
 * who walked in and "Khác" anything that is not a booking channel. The form
 * offers only these, and the service refuses anything else — including nothing
 * at all — on create, and on a correction that changes the value. A free-text source is how "Agoda", "agoda" and "AGD" became three
 * channels in one report; an optional one is how a third of the rows had none.
 *
 * OLDER ROWS ARE NOT REWRITTEN. They were typed freely, or left empty, and keep
 * exactly that; a correction that leaves the source untouched does not have to
 * "fix" it.
 */
export const PAYMENT_SOURCES = [
  'Booking',
  'Agoda',
  'Ctrip',
  'Traveloka',
  'Expedia',
  'Walking',
  'Khác',
] as const;

/** "Bộ phận" of a delivered item, in the order of the selector. */
export const DELIVERY_DEPARTMENT_LABELS: Record<HotelDeliveryDepartment, string> = {
  RECEPTION: 'Lễ tân',
  HOUSEKEEPING: 'Buồng phòng',
  TECHNICAL: 'Kỹ thuật',
};

export const DELIVERY_DEPARTMENTS: readonly HotelDeliveryDepartment[] = [
  'RECEPTION',
  'HOUSEKEEPING',
  'TECHNICAL',
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
