import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { resolvePaymentStatus } from '../src/booking/paymentStatus';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'booking', '25-real-sample-two-room-nightly.txt'),
  'utf8',
);

function parse(): ParsedBooking {
  return parseBooking(RAW, branches);
}

/**
 * Regression for a real multi-room, multi-night Booking.com extranet reservation:
 * two ordinal room sections, a nightly-rate table per room (year-less "23 - 24
 * Tháng 7" date ranges with the price two lines below), an appended property ID,
 * a guest phone with no label, a repeated room heading in the policy section and
 * a no-prepayment policy. The whole normalized output is asserted end to end.
 */
describe('real Booking.com extranet sample — two rooms, nightly-rate tables', () => {
  const r = parse();

  it('1. cleans the hotel name (strips the trailing property ID)', () => {
    expect(r.hotelName).toBe('Saigon Hotel & Ben Thanh Market');
    expect(r.hotelName).not.toMatch(/\d/);
  });

  it('2. resolves the correct branch from the property-ID-suffixed name (5.1)', () => {
    // The sample's hotel line is 'Saigon Hotel & Ben Thanh Market16806954'. It
    // carries the branch's internal name as a whole word sequence, so the 5.1
    // resolver assigns it. The branch is the same one that was previously
    // suggested — the hotfix changed whether it is assigned, never which.
    expect(r.suggestedBranch?.address).toBe('05 Trương Định');
    expect(r.branchConfident).toBe(true);
    expect(r.requiresManualConfirmation).toBe(false);
  });

  it('3. takes the main customer name', () => {
    expect(r.guestName).toBe('Thùy Chi Phan');
  });

  it('4. extracts the direct guest phone (from the guest block, unlabelled)', () => {
    expect(r.phone).toBe('+84 964 934 713');
  });

  it('5. ignores the hotel hotline', () => {
    expect(r.phone).not.toContain('3822'); // hotline +84 28 3822 9999
  });

  it('6. takes the labelled booking code', () => {
    expect(r.bookingCode).toBe('6312474567');
  });

  it('7. never uses the property ID as the booking code', () => {
    expect(r.bookingCode).not.toBe('16806954');
  });

  it('8. takes the booking-level total amount', () => {
    expect(r.totalAmount).toBe(3_078_000);
    expect(r.currency).toBe('VND');
  });

  it('9. ignores the commission figures for the total', () => {
    expect(r.totalAmount).not.toBe(461_700); // commission
    expect(r.totalAmount).not.toBe(1_539_000); // a single room total
  });

  it('10. reads the authoritative room count context (two rooms), not guest count', () => {
    // The "Tổng số căn: 2" field agrees with the two explicit sections; the
    // "3 người lớn" guest count is never used as a room count.
    expect(r.rooms).toHaveLength(2);
  });

  it('11. produces exactly two room sections', () => {
    expect(r.rooms).toHaveLength(2);
  });

  it('12. normalizes room 1 name (no leading ordinal, no English parenthetical)', () => {
    expect(r.rooms[0]!.roomName).toBe('Phòng Tiêu Chuẩn Giường Đôi');
  });

  it('13. normalizes room 2 name (no leading ordinal, no English parenthetical)', () => {
    expect(r.rooms[1]!.roomName).toBe('Phòng Tiêu Chuẩn Giường Đôi');
  });

  it('14. never treats the room ordinal as a quantity', () => {
    // Two ordinal headers = two rooms (not one room x2, not three rooms).
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((rm) => rm.roomIndex)).toEqual([1, 2]);
  });

  it('15. ignores the repeated room heading in the policy section', () => {
    expect(r.rooms).toHaveLength(2);
  });

  it('16. gives each room exactly two stay dates', () => {
    expect(r.rooms[0]!.nights.map((n) => n.stayDate)).toEqual(['2026-07-23', '2026-07-24']);
    expect(r.rooms[1]!.nights.map((n) => n.stayDate)).toEqual(['2026-07-23', '2026-07-24']);
  });

  it('17. excludes the check-out date from the stay nights', () => {
    expect(r.checkIn).toBe('2026-07-23');
    expect(r.checkOut).toBe('2026-07-25');
    for (const room of r.rooms) {
      expect(room.nights.map((n) => n.stayDate)).not.toContain('2026-07-25');
    }
  });

  it('18. room 1 night 23/07 = 648000', () => {
    expect(r.rooms[0]!.nights[0]).toMatchObject({ stayDate: '2026-07-23', amount: 648_000 });
  });

  it('19. room 1 night 24/07 = 891000', () => {
    expect(r.rooms[0]!.nights[1]).toMatchObject({ stayDate: '2026-07-24', amount: 891_000 });
  });

  it('20. room 2 night 23/07 = 648000', () => {
    expect(r.rooms[1]!.nights[0]).toMatchObject({ stayDate: '2026-07-23', amount: 648_000 });
  });

  it('21. room 2 night 24/07 = 891000', () => {
    expect(r.rooms[1]!.nights[1]).toMatchObject({ stayDate: '2026-07-24', amount: 891_000 });
  });

  it('22. each room subtotal = 1539000 (sum of its nights, not the table subtotal label)', () => {
    expect(r.rooms[0]!.roomTotal).toBe(1_539_000);
    expect(r.rooms[1]!.roomTotal).toBe(1_539_000);
  });

  it('23. booking total = 3078000', () => {
    expect(r.totalAmount).toBe(3_078_000);
  });

  it('24. PAY_AFTER from "Không cần thanh toán trước"', () => {
    expect(r.paymentStatus).toBe('PAY_AFTER');
  });

  it('25. negative prepayment text overrides a "Trả trước" / prepayment heading', () => {
    const mixed =
      'Trả trước\nKhách sẽ phải thanh toán trước toàn bộ tiền phòng.\nKhông cần thanh toán trước.';
    expect(resolvePaymentStatus(mixed, null)).toBe('PAY_AFTER');
    // Sanity: the prepayment phrase alone is still PAY_BEFORE.
    expect(resolvePaymentStatus('Khách sẽ phải thanh toán trước toàn bộ tiền phòng.', null)).toBe(
      'PAY_BEFORE',
    );
  });

  it('26. extracts the arrival window (13:00 - 14:00)', () => {
    expect(r.specialRequest).toContain('13:00 - 14:00');
  });

  it('27. merges the luggage note (composed as separate sentences)', () => {
    expect(r.specialRequest).toBe(
      'Khách dự kiến đến trong khoảng 13:00 - 14:00. Có thể gửi hành lý nếu phòng chưa sẵn sàng.',
    );
  });

  it('28. ignores automated hotel chat in the note', () => {
    expect(r.specialRequest).not.toMatch(/lễ tân|quầy/i);
  });

  it('29. ignores transfer prices in the note and the totals', () => {
    expect(r.specialRequest).not.toContain('350');
    expect(r.totalAmount).not.toBe(350_000);
  });

  it('30. ignores early-check-in fees in the totals and nights', () => {
    const nightAmounts = r.rooms.flatMap((rm) => rm.nights.map((n) => n.amount));
    expect(nightAmounts).not.toContain(200_000);
    expect(r.totalAmount).not.toBe(200_000);
  });

  it('31. emits no missing-nightly-price warning', () => {
    expect(codes(r)).not.toContain('MISSING_NIGHTLY_PRICE');
  });

  it('32. emits no night-count-mismatch warning', () => {
    expect(codes(r)).not.toContain('NIGHT_COUNT_MISMATCH');
  });

  it('33. emits no room-count-mismatch warning', () => {
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('34. produces no warnings at all', () => {
    // The branch-confirmation warning was the last one standing; since 5.1
    // resolves this hotel name outright, a clean sample extracts cleanly.
    expect(codes(r)).toEqual([]);
  });
});

function codes(r: ParsedBooking): string[] {
  return r.warnings.map((w) => w.code);
}
