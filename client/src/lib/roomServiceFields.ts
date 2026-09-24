/**
 * WHICH FIELDS EACH "Dịch vụ phòng" SUBTYPE ASKS FOR.
 *
 * ONE TABLE, READ BY THREE PLACES: the entry form, the correction dialog and
 * the records table. They drifted before — the form asked for "Hạng phòng" on a
 * Bán phòng while the table had no column for it — and a field you can enter but
 * never see again is a field nobody trusts.
 *
 * THIS DOES NOT DECIDE VALIDITY. The server's `normaliseRoomService` does, and
 * refuses a request that omits what the subtype requires. This table decides
 * what to RENDER, which is the same split as `issueArea.ts`: a form that
 * validates itself is a form curl can skip.
 */
import type { RoomServiceType } from '../api/receptionReports';

export interface RoomServiceFieldRules {
  phone: boolean;
  roomClass: boolean;
  /** The from/to pair — only "Upgrade" has a direction. */
  upgrade: boolean;
  roomNumber: boolean;
  /** Free-text service name — only "Dịch vụ khác". */
  serviceName: boolean;
}

export function roomServiceFields(type: RoomServiceType): RoomServiceFieldRules {
  return {
    phone: type === 'ROOM_SALE',
    roomClass: type === 'ROOM_SALE',
    upgrade: type === 'UPGRADE',
    roomNumber: type === 'SMOKING' || type === 'LAUNDRY' || type === 'OTHER',
    serviceName: type === 'OTHER',
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
