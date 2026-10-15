/**
 * WHICH FIELDS EACH "Dịch vụ phòng" SUBTYPE ASKS FOR.
 *
 * ONE TABLE, READ BY FOUR PLACES: the entry form, the correction dialog, the
 * reception tables and the Admin's. They drifted before — the form asked for
 * "Hạng phòng" on a Bán phòng while the table had no column for it — and a field
 * you can enter but never see again is a field nobody trusts.
 *
 * Every subtype carries Tên khách, Mã EZ, Giá tiền and Ghi chú. On top of those:
 *   Bán phòng   Hạng phòng, Số đêm
 *   Upgrade     Từ hạng phòng, Tới hạng phòng, Số đêm
 *   the rest    nothing more
 *
 * THIS DOES NOT DECIDE VALIDITY. The server's `normaliseRoomService` does, and
 * refuses a request that omits what the subtype requires. This table decides
 * what to RENDER, which is the same split as `issueArea.ts`: a form that
 * validates itself is a form curl can skip.
 */
import type { RoomServiceType } from '../api/receptionReports';

/**
 * THE PRICE FIELD'S NAME, ON EVERY SERVICE TYPE.
 *
 * "Tổng giá tiền" — the total for the stay or the service, not a unit price. It
 * is one constant read by the entry form, the correction dialog, the reception
 * tables, the Admin's, and the record detail, so the five subtypes cannot be
 * renamed one at a time and left disagreeing (which is how "Giá tiền" survived
 * on Giặt ủi while Bán phòng had moved on).
 */
export const ROOM_SERVICE_PRICE_LABEL = 'Tổng giá tiền';

export interface RoomServiceFieldRules {
  /**
   * "Review" — a KPI COUNT, not a sale: Tên khách, Mã EZ, Tripadvisor and
   * Google, and nothing else (no price, no note, no room fields).
   */
  review: boolean;
  /** "Hạng phòng" — only "Bán phòng". */
  roomClass: boolean;
  /** The from/to pair — only "Upgrade" has a direction. */
  upgrade: boolean;
  /** "Số đêm" — the two subtypes that sell nights. */
  nights: boolean;
}

export function roomServiceFields(type: RoomServiceType): RoomServiceFieldRules {
  return {
    review: type === 'REVIEW',
    roomClass: type === 'ROOM_SALE',
    upgrade: type === 'UPGRADE',
    nights: type === 'ROOM_SALE' || type === 'UPGRADE',
  };
}

/** Declaration order is the order of the subtype selector, everywhere. */
export const ROOM_SERVICE_ORDER: RoomServiceType[] = [
  'ROOM_SALE',
  'UPGRADE',
  'SMOKING',
  'LAUNDRY',
  'OTHER',
  'REVIEW',
];

export const ROOM_SERVICE_FALLBACK_LABELS: Record<RoomServiceType, string> = {
  ROOM_SALE: 'Bán phòng',
  UPGRADE: 'Upgrade',
  SMOKING: 'Hút thuốc',
  LAUNDRY: 'Giặt ủi',
  OTHER: 'Dịch vụ khác',
  REVIEW: 'Review',
};

/**
 * REVENUE LEAVES "REVIEW" OUT — its rows are counts. Read from the server's
 * `countsAsRevenue`, with the type as the fallback for an older payload.
 */
export function isRevenue(row: { roomService: { serviceType: RoomServiceType; countsAsRevenue?: boolean } | null }): boolean {
  if (!row.roomService) return false;
  return row.roomService.countsAsRevenue ?? row.roomService.serviceType !== 'REVIEW';
}

/**
 * "Tổng doanh thu": the live (non-voided) services' prices — never a review.
 */
export function serviceRevenue(
  rows: { voided: boolean; roomService: { serviceType: RoomServiceType; price: number; countsAsRevenue?: boolean } | null }[],
): number {
  return rows.filter((r) => !r.voided && isRevenue(r)).reduce((sum, r) => sum + (r.roomService?.price ?? 0), 0);
}

/**
 * "Tổng đánh giá (review)": SUM(Tripadvisor) + SUM(Google) over the live
 * "Review" rows. A withdrawn review counts for nothing.
 */
export function reviewTotal(
  rows: {
    voided: boolean;
    roomService: { serviceType: RoomServiceType; tripadvisorCount?: number | null; googleCount?: number | null } | null;
  }[],
): number {
  return rows
    .filter((r) => !r.voided && r.roomService?.serviceType === 'REVIEW')
    .reduce((sum, r) => sum + (r.roomService?.tripadvisorCount ?? 0) + (r.roomService?.googleCount ?? 0), 0);
}
