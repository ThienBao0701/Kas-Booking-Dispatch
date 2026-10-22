/**
 * "Hoàn thành vấn đề" in the report is a SELECTION of the rows the report
 * already printed, by the archive screen's own 12-hour rule — and "Đơn mới"
 * names each order's state in Reception's words.
 */
import { describe, expect, it } from 'vitest';
import type { OperationalReportCategory } from '@prisma/client';
import { bookingStateLabel, completionArchiveRows } from '../src/reception/reportSections';
import type { SerializedReport } from '../src/reception/reportService';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const OLD = '2026-09-29T20:00:00.000Z'; // 16 hours before NOW
const RECENT = '2026-09-30T06:00:00.000Z'; // 6 hours before NOW

function groups(rows: Partial<SerializedReport>[]): Record<OperationalReportCategory, SerializedReport[]> {
  const out: Record<OperationalReportCategory, SerializedReport[]> = {
    PAYMENT: [],
    GUEST_REQUEST: [],
    FACILITY_ISSUE: [],
    CUSTOMER_COMPLAINT: [],
    ROOM_SERVICE: [],
    HOTEL_DELIVERY: [],
  };
  for (const r of rows) out[r.category!].push({ voided: false, ...r } as SerializedReport);
  return out;
}

describe('completionArchiveRows', () => {
  it('takes what is finished and received 12 hours or more ago — and nothing else', () => {
    const rows = completionArchiveRows(
      groups([
        { id: 'req-old-done', category: 'GUEST_REQUEST', createdAt: OLD, guestRequest: { completed: true } as never },
        { id: 'req-recent-done', category: 'GUEST_REQUEST', createdAt: RECENT, guestRequest: { completed: true } as never },
        { id: 'req-old-open', category: 'GUEST_REQUEST', createdAt: OLD, guestRequest: { completed: false } as never },
        { id: 'qa-old-done', category: 'CUSTOMER_COMPLAINT', createdAt: OLD, complaint: { completed: true } as never },
        {
          id: 'fac-old-done',
          category: 'FACILITY_ISSUE',
          createdAt: RECENT,
          facility: { issueId: 'i', issue: { status: 'COMPLETED', createdAt: OLD } } as never,
        },
        {
          id: 'fac-old-open',
          category: 'FACILITY_ISSUE',
          createdAt: OLD,
          facility: { issueId: 'j', issue: { status: 'IN_PROGRESS', createdAt: OLD } } as never,
        },
        { id: 'del-archived', category: 'HOTEL_DELIVERY', createdAt: OLD, delivery: { archived: true } as never },
        { id: 'del-active', category: 'HOTEL_DELIVERY', createdAt: RECENT, delivery: { archived: false } as never },
        { id: 'void', category: 'GUEST_REQUEST', createdAt: OLD, voided: true, guestRequest: { completed: true } as never },
        { id: 'pay', category: 'PAYMENT', createdAt: OLD },
      ]),
      NOW,
    );
    // In the archive screen's order: requests, incidents, service quality, deliveries.
    expect(rows.map((r) => r.id)).toEqual(['req-old-done', 'fac-old-done', 'qa-old-done', 'del-archived']);
  });
});

describe('bookingStateLabel', () => {
  it('says a cancelled stay first, and otherwise Reception’s workflow word', () => {
    expect(bookingStateLabel('NEW', 'NOT_SUBMITTED')).toBe('Chờ chi nhánh tạo');
    expect(bookingStateLabel('NEW', 'REJECTED')).toBe('Cần tạo lại');
    expect(bookingStateLabel('COMPLETED', 'APPROVED')).toBe('Đã xác nhận đúng');
    expect(bookingStateLabel('CANCELLED', 'APPROVED')).toBe('Đã hủy');
  });
});
