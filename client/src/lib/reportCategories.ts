/**
 * The five categories, and the words to use before the server has spoken.
 *
 * THE LABELS BELONG TO THE SERVER. `/reception/reports/options` is the source,
 * because the same five words appear on reception's screen, on the Admin's, in
 * the exported PDF and in the XLSX — and two of those four are built server-side
 * (server/src/reception/reportTypes.ts). A copy in React is how an exported file
 * and the screen it was exported from start disagreeing about what a column is
 * called.
 *
 * SO WHY IS THERE A COPY HERE AT ALL? Because the options request can be in
 * flight, and a row of blank buttons is worse than a row of correct ones. It is
 * a FALLBACK, not a definition.
 *
 * IT LIVES IN ONE FILE BECAUSE IT DID NOT.
 *
 * Reception and the Admin each kept their own map. When the categories were
 * renamed, reception's was updated and the Admin's was not — so the Admin page
 * showed "Khách hàng complain" and "Thu tiền thanh toán" for as long as the
 * options request took, and nobody noticed, because the two files could not be
 * read side by side. One map cannot drift from itself.
 */
import type { ReportCategory } from '../api/receptionReports';

/**
 * EXACT LEFT-TO-RIGHT ORDER, everywhere. "KPI" is part of the fifth label, not
 * a sixth category.
 *
 * The wire values (`PAYMENT`, `GUEST_REQUEST`, …) are unchanged — only the
 * label a person sees changed, which is why nothing on the server, in the
 * database or in the export pipeline needed to move.
 */
export const CATEGORY_ORDER: ReportCategory[] = [
  'PAYMENT',
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
  'HOTEL_DELIVERY',
];

export const CATEGORY_FALLBACK_LABELS: Record<ReportCategory, string> = {
  PAYMENT: 'Theo dõi thanh toán',
  GUEST_REQUEST: 'Vấn đề khách yêu cầu',
  FACILITY_ISSUE: 'Sự cố cơ sở vật chất đang xử lý',
  CUSTOMER_COMPLAINT: 'Vấn đề về chất lượng và dịch vụ',
  ROOM_SERVICE: 'Dịch vụ phòng, KPI',
  HOTEL_DELIVERY: 'Giao nhận hàng hóa',
};

/**
 * The full name of the sixth category, which the server keeps short because it
 * also names an XLSX sheet (Excel's limit is 31 characters; this is 32). Every
 * screen with room for it prints this one; `/reception/reports/options` also
 * carries it as `deliveryTitle`.
 */
export const HOTEL_DELIVERY_TITLE = 'Giao nhận hàng hóa của khách sạn';

/** "Hoàn thành vấn đề" — where a delivery goes twelve hours after it was completed. */
export const COMPLETED_ISSUES_TITLE = 'Hoàn thành vấn đề';

/**
 * "Nguồn" for a new payment, before the server has spoken — a fallback copy of
 * its `PAYMENT_SOURCES`, for the same reason as the labels above. The server
 * refuses anything outside its own list whatever this one says.
 */
export const PAYMENT_SOURCE_FALLBACK = [
  'Booking',
  'Agoda',
  'Ctrip',
  'Traveloka',
  'Expedia',
  'Walking',
  'Khác',
  'Chi tiền',
];

/**
 * "Chi tiền" as a SOURCE: the row is a pure cash payout — no "Thu tiền", method
 * always cash. The server's `EXPENSE_SOURCE`; the rule is enforced there.
 */
export const EXPENSE_SOURCE = 'Chi tiền';

/**
 * The Request category's full name on every screen that has room for it — the
 * operator's own words, exactly.
 */
export const GUEST_REQUEST_TITLE = 'Vấn đề khách yêu cầu thực hiện (Request)- Các ghi chú, vấn đề cần theo dõi';

/**
 * Each category's number in the official report — the same I–V the exported PDF
 * heads its sections with (server `CATEGORY_NUMERALS`), so the overview and the
 * export mark a category identically.
 */
export const CATEGORY_MARKERS: Record<ReportCategory, string> = {
  PAYMENT: 'I',
  GUEST_REQUEST: 'II',
  FACILITY_ISSUE: 'III',
  CUSTOMER_COMPLAINT: 'IV',
  ROOM_SERVICE: 'V',
  HOTEL_DELIVERY: 'VI',
};

/**
 * Where reception's own screen names a category differently from the server.
 *
 * Only the Request category, spelled out in full on the reception journal. The
 * server label stays short because it also names the XLSX sheet — Excel refuses
 * a sheet name over 31 characters — and heads the export sections.
 */
export const RECEPTION_CATEGORY_TITLES: Partial<Record<ReportCategory, string>> = {
  GUEST_REQUEST: GUEST_REQUEST_TITLE,
  HOTEL_DELIVERY: HOTEL_DELIVERY_TITLE,
};
