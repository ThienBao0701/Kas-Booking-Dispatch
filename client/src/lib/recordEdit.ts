/**
 * WHAT A CORRECTION MAY TOUCH, per category — the ONE set of field lists behind
 * every "Sửa" dialog: Reception's own tables and the supervisors' (Admin, Quản lý
 * lễ tân, Tổng quản lý lễ tân). Both edit the SAME record through the SAME
 * endpoint; a second list would be the first thing to drift.
 *
 * The server is the authority (`EDITABLE` in reportService.ts): a field listed
 * here that it does not accept changes nothing.
 */
import type { EditField } from '../components/RecordDialogs';
import type { OperationalReport, ReportOptions, RoomServiceType } from '../api/receptionReports';
import { ROOM_SERVICE_PRICE_LABEL, roomServiceFields } from './roomServiceFields';
import { PAYMENT_SOURCE_FALLBACK } from './reportCategories';

export const GUEST_REQUEST_EDIT: EditField[] = [
  { name: 'guestName', label: 'Tên khách', required: true },
  { name: 'ezCode', label: 'Mã EZ' },
  { name: 'note', label: 'Nội dung', kind: 'textarea', required: true },
];

export const SERVICE_QUALITY_EDIT: EditField[] = [
  { name: 'guestName', label: 'Tên khách', required: true },
  { name: 'ezCode', label: 'Mã EZ' },
  { name: 'description', label: 'Mô tả', kind: 'textarea', required: true },
];

/** The correction fields for one service — the same rules the entry form renders. */
export function roomServiceEditFields(type: RoomServiceType): EditField[] {
  const needs = roomServiceFields(type);
  // "Review" corrects its guest and its two counts — it has no price or note.
  if (needs.review) {
    return [
      { name: 'guestName', label: 'Tên khách', required: true },
      { name: 'ezCode', label: 'Mã EZ' },
      { name: 'tripadvisorCount', label: 'Tripadvisor', kind: 'count', required: true },
      { name: 'googleCount', label: 'Google', kind: 'count', required: true },
    ];
  }
  return [
    { name: 'guestName', label: 'Tên khách', required: true },
    { name: 'ezCode', label: 'Mã EZ' },
    ...(needs.roomClass ? [{ name: 'roomClass', label: 'Hạng phòng', required: true } as EditField] : []),
    ...(needs.upgrade
      ? ([
          { name: 'fromRoomClass', label: 'Từ hạng phòng', required: true },
          { name: 'toRoomClass', label: 'Tới hạng phòng', required: true },
        ] as EditField[])
      : []),
    ...(needs.nights ? [{ name: 'nights', label: 'Số đêm', kind: 'integer', required: true } as EditField] : []),
    { name: 'price', label: ROOM_SERVICE_PRICE_LABEL, kind: 'money', required: true },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];
}

const DEPARTMENT_FALLBACK = [
  { code: 'RECEPTION', label: 'Lễ tân' },
  { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
  { code: 'TECHNICAL', label: 'Kỹ thuật' },
];

export function deliveryEditFields(options?: ReportOptions): EditField[] {
  const departments = options?.deliveryDepartments ?? DEPARTMENT_FALLBACK;
  return [
    {
      name: 'department',
      label: 'Bộ phận',
      kind: 'select',
      required: true,
      options: departments.map((d) => ({ value: d.code, label: d.label })),
    },
    { name: 'itemName', label: 'Tên hàng hóa', required: true },
    { name: 'quantity', label: 'Số lượng', kind: 'integer', required: true },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];
}

const METHOD_FALLBACK = [
  { code: 'CASH', label: 'Tiền mặt' },
  { code: 'TRANSFER', label: 'Chuyển khoản' },
  { code: 'CARD', label: 'Cà thẻ' },
  { code: 'DEBT', label: 'Công nợ' },
];

/** A payment's correctable fields — the ledger's own form, as a dialog. */
export function paymentEditFields(options?: ReportOptions): EditField[] {
  const sources = options?.paymentSources ?? PAYMENT_SOURCE_FALLBACK;
  const methods = options?.paymentMethods ?? METHOD_FALLBACK;
  return [
    { name: 'ezCode', label: 'Mã EZ' },
    {
      name: 'source',
      label: 'Nguồn',
      kind: 'select',
      required: true,
      options: sources.map((s) => ({ value: s, label: s })),
    },
    { name: 'guestName', label: 'Tên khách' },
    {
      name: 'method',
      label: 'Phương thức thanh toán',
      kind: 'select',
      required: true,
      options: methods.map((m) => ({ value: m.code, label: m.label })),
    },
    { name: 'amount', label: 'Thu tiền', kind: 'money', required: true },
    { name: 'expense', label: 'Chi tiền', kind: 'money' },
    { name: 'note', label: 'Ghi chú', kind: 'textarea' },
  ];
}

export type EditBlock = 'payment' | 'guestRequest' | 'complaint' | 'roomService' | 'delivery';

/**
 * The dialog configuration for a record, or null when it has nothing to correct
 * (a facility entry is a pointer — its incident is corrected through "Sửa vấn đề").
 */
export function recordEditConfig(
  report: OperationalReport,
  options?: ReportOptions,
): { block: EditBlock; fields: EditField[] } | null {
  if (report.voided) return null;
  switch (report.category) {
    case 'PAYMENT':
      return { block: 'payment', fields: paymentEditFields(options) };
    case 'GUEST_REQUEST':
      return { block: 'guestRequest', fields: GUEST_REQUEST_EDIT };
    case 'CUSTOMER_COMPLAINT':
      return { block: 'complaint', fields: SERVICE_QUALITY_EDIT };
    case 'ROOM_SERVICE':
      return report.roomService
        ? { block: 'roomService', fields: roomServiceEditFields(report.roomService.serviceType) }
        : null;
    case 'HOTEL_DELIVERY':
      return { block: 'delivery', fields: deliveryEditFields(options) };
    default:
      return null;
  }
}
