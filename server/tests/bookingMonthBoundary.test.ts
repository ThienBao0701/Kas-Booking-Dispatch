import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { parseDateRangeStayDate } from '../src/booking/dates';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'booking', '27-real-sample-month-boundary.txt'),
  'utf8',
);

describe('nightly-rate range row — every month-transition format', () => {
  // The stay night is always the FIRST day of the range, in the correct month.
  const cases: { label: string; row: string; expected: string }[] = [
    { label: 'A — bare days, trailing VN month, same month', row: '26 - 27 Tháng 7', expected: '2026-07-26' },
    { label: 'A — start of month', row: '01 - 02 Tháng 8', expected: '2026-08-01' },
    { label: 'B — month boundary "31 - 01 Tháng 8" -> 31 July', row: '31 - 01 Tháng 8', expected: '2026-07-31' },
    { label: 'B — boundary "30 - 01 Tháng 5" -> 30 April', row: '30 - 01 Tháng 5', expected: '2026-04-30' },
    { label: 'C — explicit month on both endpoints', row: 'Tháng 7 31 - 01 Tháng 8', expected: '2026-07-31' },
    { label: 'C — leading month only', row: 'Tháng 7 31 - 01', expected: '2026-07-31' },
    { label: 'D — English day-first, month on both', row: '31 Jul - 01 Aug', expected: '2026-07-31' },
    { label: 'D — English within month', row: '26 Jul - 27 Jul', expected: '2026-07-26' },
    { label: 'E — English month-first, month on both', row: 'Jul 31 - Aug 01', expected: '2026-07-31' },
    { label: 'EN — trailing month only', row: '31 - 01 Aug', expected: '2026-07-31' },
    { label: 'EN — leading month only', row: 'Jul 31 - 01', expected: '2026-07-31' },
  ];

  for (const c of cases) {
    it(`Format ${c.label}`, () => {
      expect(parseDateRangeStayDate(c.row, 2026)).toBe(c.expected);
    });
  }

  it('rejects rate-plan descriptions and non-range prose', () => {
    expect(parseDateRangeStayDate('Fully flexible, Domestic rate', 2026)).toBeNull();
    expect(parseDateRangeStayDate('Bao gồm bữa sáng', 2026)).toBeNull();
    expect(parseDateRangeStayDate('VND 648.000', 2026)).toBeNull();
    expect(parseDateRangeStayDate('Tổng phụ', 2026)).toBeNull();
  });

  it('returns null without a year hint', () => {
    expect(parseDateRangeStayDate('26 - 27 Tháng 7', null)).toBeNull();
  });

  it('rejects an impossible rollover date (Feb 31)', () => {
    // "31 - 01 Tháng 3" would roll the start into February 31, which is invalid.
    expect(parseDateRangeStayDate('31 - 01 Tháng 3', 2026)).toBeNull();
  });
});

describe('real Booking.com month-boundary booking (end to end)', () => {
  const r: ParsedBooking = parseBooking(RAW, branches);
  const nights = r.rooms[0]!.nights;

  it('spans the full check-in..check-out range with no shift', () => {
    expect(r.checkIn).toBe('2026-07-26');
    expect(r.checkOut).toBe('2026-08-08');
    expect(nights.map((n) => n.stayDate)).toEqual([
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ]);
  });

  it('assigns exactly the required nightly prices across the month boundary', () => {
    const byDate = Object.fromEntries(nights.map((n) => [n.stayDate, n.amount]));
    expect(byDate).toEqual({
      '2026-07-26': 648_000,
      '2026-07-27': 648_000,
      '2026-07-28': 648_000,
      '2026-07-29': 648_000,
      '2026-07-30': 648_000,
      '2026-07-31': 891_000,
      '2026-08-01': 891_000,
      '2026-08-02': 648_000,
      '2026-08-03': 648_000,
      '2026-08-04': 648_000,
      '2026-08-05': 648_000,
      '2026-08-06': 648_000,
      '2026-08-07': 891_000,
    });
  });

  it('does not drop, duplicate or invent any night', () => {
    expect(nights).toHaveLength(13);
    expect(new Set(nights.map((n) => n.stayDate)).size).toBe(13);
    expect(nights.every((n) => n.amount !== null)).toBe(true);
  });

  it('keeps the room subtotal and booking total consistent, with no warnings', () => {
    expect(r.rooms[0]!.roomTotal).toBe(9_153_000);
    expect(r.totalAmount).toBe(9_153_000);
    expect(r.rooms).toHaveLength(1);
    // No warnings at all since 5.1: this sample's hotel line carries the
    // extranet property id around the internal name, which the resolver now
    // matches by containment instead of leaving for an Admin to confirm.
    expect(r.warnings.map((w) => w.code)).toEqual([]);
  });
});
