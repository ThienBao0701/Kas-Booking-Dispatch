/**
 * The vocabulary of "Buồng phòng — tình trạng sử dụng phòng & thu tiền".
 *
 * Served to the client (`/housekeeping/options`) rather than re-typed in React,
 * for the reason every other label list in this application lives on the server:
 * the same words appear on the housekeeping form, Reception's collection table,
 * the Admin report and any export, and a copy is how they start disagreeing.
 */
import type { RoomCollectionMethod, RoomCollectionStatus, RoomIssueType } from '@prisma/client';

/** Declaration order is the order of the form's checklist. */
export const ROOM_ISSUE_TYPES: readonly RoomIssueType[] = [
  'SMOKING',
  'ODOR',
  'DAMAGED_FACILITY',
  'LOST_ITEM',
  'UNREGISTERED_GUEST',
  'OTHER',
];

export const ROOM_ISSUE_TYPE_LABELS: Record<RoomIssueType, string> = {
  SMOKING: 'Hút thuốc',
  ODOR: 'Phòng có mùi',
  DAMAGED_FACILITY: 'Cơ sở vật chất hư hỏng',
  LOST_ITEM: 'Khách quên đồ',
  UNREGISTERED_GUEST: 'Phòng có khách nhưng hệ thống không có',
  OTHER: 'Vấn đề khác',
};

export const ROOM_COLLECTION_STATUSES: readonly RoomCollectionStatus[] = [
  'PENDING',
  'COLLECTED',
  'UNCOLLECTIBLE',
];

export const ROOM_COLLECTION_STATUS_LABELS: Record<RoomCollectionStatus, string> = {
  PENDING: 'Chưa thu',
  COLLECTED: 'Đã thu',
  UNCOLLECTIBLE: 'Không thu được',
};

/** Three methods — no "Công nợ": a collection is money received. */
export const ROOM_COLLECTION_METHODS: readonly RoomCollectionMethod[] = ['CASH', 'TRANSFER', 'CARD'];

export const ROOM_COLLECTION_METHOD_LABELS: Record<RoomCollectionMethod, string> = {
  CASH: 'Tiền mặt',
  TRANSFER: 'Chuyển khoản',
  CARD: 'Cà thẻ',
};
