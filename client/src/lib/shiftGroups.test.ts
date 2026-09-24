/**
 * DATE → SHIFT → EMPLOYEE, as pure data.
 *
 * The claim: the grouping keys come from the server's session data
 * (`shiftDate`, `shiftSessionId`), never from a record's own timestamp.
 */
import { describe, expect, it } from 'vitest';
import type { OperationalReport } from '../api/receptionReports';
import { daysBefore, groupByShift } from './shiftGroups';

function row(over: Partial<OperationalReport> & { id: string }): OperationalReport {
  return {
    category: 'CUSTOMER_COMPLAINT',
    categoryLabel: 'Vấn đề về chất lượng dịch vụ',
    branchId: 1,
    branch: { id: 1, code: 'X', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 },
    shiftSessionId: 's1',
    shiftType: 'A',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    shiftDate: '2026-09-19',
    shiftReceptionistName: 'Nguyễn Văn A',
    shiftClosed: true,
    createdBy: null,
    createdByName: 'Nguyễn Văn A',
    createdAt: '2026-09-19T01:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z',
    summary: '',
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    payment: null,
    guestRequest: null,
    facility: null,
    complaint: null,
    roomService: null,
    audits: [],
    ...over,
  };
}

describe('groupByShift', () => {
  it('orders days, then shifts by when they began, then rows oldest first', () => {
    const days = groupByShift([
      row({ id: 'b2', shiftSessionId: 'sB', shiftName: 'Ca B', createdAt: '2026-09-19T09:00:00.000Z' }),
      row({ id: 'd20', shiftDate: '2026-09-20', shiftSessionId: 's20', createdAt: '2026-09-20T01:00:00.000Z' }),
      row({ id: 'a2', createdAt: '2026-09-19T03:00:00.000Z' }),
      row({ id: 'b1', shiftSessionId: 'sB', shiftName: 'Ca B', createdAt: '2026-09-19T08:00:00.000Z' }),
      row({ id: 'a1', createdAt: '2026-09-19T01:00:00.000Z' }),
    ]);

    expect(days.map((d) => d.date)).toEqual(['2026-09-19', '2026-09-20']);
    const [a, b] = days[0]!.shifts;
    expect(a!.shiftName).toBe('Ca A');
    expect(a!.rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(b!.shiftName).toBe('Ca B');
    expect(b!.rows.map((r) => r.id)).toEqual(['b1', 'b2']);
  });

  it('files a record under its SHIFT’s day, not its own timestamp’s', () => {
    // 02:15 in HCM on the 20th, on Ca C of the 19th.
    const days = groupByShift([
      row({ id: 'late', shiftDate: '2026-09-19', shiftSessionId: 'sC', createdAt: '2026-09-19T19:15:00.000Z' }),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-09-19']);
  });

  it('names the person on the shift, from the session', () => {
    const [day] = groupByShift([row({ id: 'r', shiftReceptionistName: 'Trần Thị B', createdByName: 'Tài khoản cũ' })]);
    expect(day!.shifts[0]!.employee).toBe('Trần Thị B');
  });

  it('never merges two people’s sessionless records into one group', () => {
    const [day] = groupByShift([
      row({ id: 'p', shiftSessionId: null, shiftReceptionistName: null, createdByName: 'Người P' }),
      row({ id: 'q', shiftSessionId: null, shiftReceptionistName: null, createdByName: 'Người Q' }),
    ]);
    expect(day!.shifts.map((s) => s.employee).sort()).toEqual(['Người P', 'Người Q']);
  });
});

describe('daysBefore', () => {
  it('counts back across a month and a year', () => {
    expect(daysBefore('2026-09-23', 6)).toBe('2026-09-17');
    expect(daysBefore('2026-10-01', 1)).toBe('2026-09-30');
    expect(daysBefore('2027-01-05', 29)).toBe('2026-12-07');
  });

  it('is the same day for zero', () => {
    expect(daysBefore('2026-09-23', 0)).toBe('2026-09-23');
  });
});
