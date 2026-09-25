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

export interface RoomServiceFieldRules {
  /** "Hạng phòng" — only "Bán phòng". */
  roomClass: boolean;
  /** The from/to pair — only "Upgrade" has a direction. */
  upgrade: boolean;
  /** "Số đêm" — the two subtypes that sell nights. */
  nights: boolean;
}

export function roomServiceFields(type: RoomServiceType): RoomServiceFieldRules {
  return {
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
];

export const ROOM_SERVICE_FALLBACK_LABELS: Record<RoomServiceType, string> = {
  ROOM_SALE: 'Bán phòng',
  UPGRADE: 'Upgrade',
  SMOKING: 'Hút thuốc',
  LAUNDRY: 'Giặt ủi',
  OTHER: 'Dịch vụ khác',
};
