/**
 * Deterministic, stable mapping from field results to concise Vietnamese
 * suggestions. No free-form / AI text — every string is a fixed lookup so the
 * output is testable and never surprising.
 */
import type { FieldComparison, FieldKey, NoteComponent } from './types';

/** Full-sentence per-field hint shown on a non-matching row. */
export const FIELD_SUGGESTION: Record<FieldKey, string> = {
  BOOKING_CODE: 'Kiểm tra lại mã Booking trong ảnh PMS.',
  CHECK_IN: 'Đối chiếu lại ngày nhận phòng.',
  CHECK_OUT: 'Đối chiếu lại ngày trả phòng.',
  TOTAL_AMOUNT: 'Đối chiếu lại giá tổng.',
  ROOM_QUANTITY: 'Kiểm tra lại hạng phòng và số lượng phòng.',
  ROOM_TYPE: 'Kiểm tra lại hạng phòng và số lượng phòng.',
  PAYMENT_STATUS: 'Kiểm tra lại trạng thái thanh toán.',
  NIGHTS: 'Đối chiếu lại số đêm.',
  NIGHTLY_PRICES: 'Đối chiếu lại giá từng đêm.',
  CUSTOMER_NAME: 'Kiểm tra lại tên khách.',
  PMS_NOTE: 'Kiểm tra lại ghi chú tạo đơn.',
};

/** Short "what to check" label for the top-level checklist. */
const FIELD_CHECK_LABEL: Record<FieldKey, string> = {
  BOOKING_CODE: 'Mã Booking',
  CHECK_IN: 'Ngày nhận phòng',
  CHECK_OUT: 'Ngày trả phòng',
  TOTAL_AMOUNT: 'Giá tổng',
  ROOM_QUANTITY: 'Hạng phòng và số lượng phòng',
  ROOM_TYPE: 'Hạng phòng và số lượng phòng',
  PAYMENT_STATUS: 'Trạng thái thanh toán',
  NIGHTS: 'Số đêm',
  NIGHTLY_PRICES: 'Giá từng đêm',
  CUSTOMER_NAME: 'Tên khách',
  PMS_NOTE: 'PMS Note',
};

const NEEDS_CHECK = new Set(['MISMATCH', 'WARNING', 'NOT_FOUND']);

/**
 * De-duplicated, order-preserving list of short "Admin nên kiểm tra" items from
 * the non-matching fields, plus a missing-arrival note when relevant.
 */
export function suggestAdminChecks(fields: FieldComparison[], noteComponents: NoteComponent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const f of fields) {
    if (NEEDS_CHECK.has(f.result)) push(FIELD_CHECK_LABEL[f.field]);
  }
  const arrival = noteComponents.find((c) => c.key === 'ARRIVAL_NOTE');
  if (arrival && arrival.result === 'NOT_FOUND') push('Giờ đến trong ghi chú');
  return out;
}
