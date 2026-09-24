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
];

export const CATEGORY_FALLBACK_LABELS: Record<ReportCategory, string> = {
  PAYMENT: 'Theo dõi thanh toán',
  GUEST_REQUEST: 'Vấn đề khách yêu cầu',
  FACILITY_ISSUE: 'Sự cố vật chất đang xử lý',
  CUSTOMER_COMPLAINT: 'Vấn đề về chất lượng dịch vụ',
  ROOM_SERVICE: 'Dịch vụ phòng, KPI',
};
