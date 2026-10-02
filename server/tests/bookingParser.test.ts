import { describe, expect, it } from 'vitest';
import { fixtureBranches } from './helpers/branchFixtures';
import { parseBooking, PARSER_VERSION } from '../src/booking/parser';
import { BRANCH_ALIASES, matchBranch, scoreHotel } from '../src/booking/branchMatcher';
import { generateStayDates } from '../src/booking/dates';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

function warningCodes(result: ReturnType<typeof parseBooking>): string[] {
  return result.warnings.map((w) => w.code);
}

const SINGLE_ROOM = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 1234567890
Khách: Nguyễn Văn A
Điện thoại: 0901234567
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-20: 850.000 VND
2026-07-21: 950.000 VND
Tổng cộng: 2.650.000 VND
Thanh toán: Thanh toán tại chỗ`;

const TWO_ROOMS = `INDOCHINA Premium
Mã đặt phòng: 9988776655
Khách: Trần Thị B
Điện thoại: 0912345678
Nhận phòng: 2026-08-01
Trả phòng: 2026-08-03
Phòng 1: Superior Twin Room
2026-08-01: 780.000 VND
2026-08-02: 780.000 VND
Phòng 2: Deluxe King Room
2026-08-01: 990.000 VND
2026-08-02: 990.000 VND
Tổng cộng: 3.540.000 VND
Thanh toán: Đã thanh toán`;

const THREE_ROOMS = `Modern Luxury Dilly Hotel
Mã đặt phòng: 5555000011
Khách: Lê Văn C
Nhận phòng: 2026-10-10
Trả phòng: 2026-10-11
Phòng 1: Standard Room
2026-10-10: 600.000 VND
Phòng 2: Deluxe Room
2026-10-10: 800.000 VND
Phòng 3: Suite
2026-10-10: 1.200.000 VND
Thanh toán: Thanh toán tại chỗ`;

describe('parseBooking — happy paths', () => {
  it('parses a single-room booking with no warnings', () => {
    const result = parseBooking(SINGLE_ROOM, branches);

    expect(result.parserVersion).toBe(PARSER_VERSION);
    expect(result.hotelName).toBe('Saigon Hotel & Ben Thanh');
    expect(result.guestName).toBe('Nguyễn Văn A');
    expect(result.phone).toBe('0901234567');
    expect(result.bookingCode).toBe('1234567890');
    expect(result.checkIn).toBe('2026-07-19');
    expect(result.checkOut).toBe('2026-07-22');
    expect(result.totalAmount).toBe(2_650_000);
    expect(result.currency).toBe('VND');
    expect(result.paymentStatus).toBe('PAY_AFTER');
    expect(result.paymentStatusKnown).toBe(true);

    expect(result.suggestedBranch?.id).toBe(1);
    expect(result.suggestedBranch?.address).toBe('05 Trương Định');

    expect(result.rooms).toHaveLength(1);
    const room = result.rooms[0]!;
    expect(room.roomName).toBe('Deluxe Double Room');
    expect(room.nights.map((n) => n.stayDate)).toEqual(['2026-07-19', '2026-07-20', '2026-07-21']);
    expect(room.nights.map((n) => n.amount)).toEqual([850_000, 850_000, 950_000]);
    expect(room.roomTotal).toBe(2_650_000);

    expect(result.warnings).toEqual([]);
  });

  it('keeps two rooms separate, each with its own night list', () => {
    const result = parseBooking(TWO_ROOMS, branches);

    expect(result.paymentStatus).toBe('PAY_BEFORE');
    expect(result.suggestedBranch?.address).toBe('170-172-174 Nguyễn Thái Bình');
    expect(result.rooms).toHaveLength(2);

    const [first, second] = result.rooms;
    expect(first!.roomName).toBe('Superior Twin Room');
    expect(first!.nights.map((n) => n.amount)).toEqual([780_000, 780_000]);
    expect(second!.roomName).toBe('Deluxe King Room');
    expect(second!.nights.map((n) => n.amount)).toEqual([990_000, 990_000]);
    // Rooms are never merged: distinct night arrays.
    expect(first!.nights).not.toBe(second!.nights);
    expect(result.warnings).toEqual([]);
  });

  it('parses three rooms without merging', () => {
    const result = parseBooking(THREE_ROOMS, branches);

    expect(result.rooms).toHaveLength(3);
    expect(result.rooms.map((r) => r.roomName)).toEqual(['Standard Room', 'Deluxe Room', 'Suite']);
    expect(result.rooms.map((r) => r.nights.length)).toEqual([1, 1, 1]);
    expect(result.rooms.map((r) => r.roomTotal)).toEqual([600_000, 800_000, 1_200_000]);
    expect(result.suggestedBranch?.address).toBe('191 Lê Thánh Tôn');
  });
});

describe('parseBooking — night generation', () => {
  it('generates one night per stay date, check-out exclusive', () => {
    expect(generateStayDates('2026-07-19', '2026-07-22')).toEqual([
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
    ]);
    const result = parseBooking(SINGLE_ROOM, branches);
    expect(result.rooms[0]!.nights).toHaveLength(3);
    expect(result.rooms[0]!.nights.every((n) => n.isEstimated === false)).toBe(true);
  });

  it('leaves an omitted nightly amount as null (never invents money) and warns', () => {
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 111
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-20:
2026-07-21: 950.000 VND
Thanh toán: Thanh toán tại chỗ`;
    const result = parseBooking(text, branches);

    const amounts = result.rooms[0]!.nights.map((n) => n.amount);
    expect(amounts).toEqual([850_000, null, 950_000]);
    expect(result.rooms[0]!.roomTotal).toBeNull();
    expect(warningCodes(result)).toContain('MISSING_NIGHTLY_PRICE');
  });

  it('warns on a night-count mismatch', () => {
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 222
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-20: 850.000 VND
Thanh toán: Thanh toán tại chỗ`;
    const result = parseBooking(text, branches);
    // Range spans 3 nights but only 2 were listed.
    expect(result.rooms[0]!.nights).toHaveLength(3);
    expect(warningCodes(result)).toContain('NIGHT_COUNT_MISMATCH');
  });
});

describe('parseBooking — payment status', () => {
  it('detects PAY_AFTER (pay at property)', () => {
    expect(parseBooking(SINGLE_ROOM, branches).paymentStatus).toBe('PAY_AFTER');
  });

  it('detects PAY_BEFORE (prepaid)', () => {
    expect(parseBooking(TWO_ROOMS, branches).paymentStatus).toBe('PAY_BEFORE');
  });

  it('defaults to PAY_AFTER when no prepaid trigger is present (never "unknown")', () => {
    // Authoritative rule: absent the credit-card-hidden sentence and any prepaid
    // label, the booking is pay-at-property. The status is always determined.
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 3334445556
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-20
Phòng 1: Standard Room
2026-07-19: 500.000 VND`;
    const result = parseBooking(text, branches);
    expect(result.paymentStatus).toBe('PAY_AFTER');
    expect(result.paymentStatusKnown).toBe(true);
    expect(warningCodes(result)).not.toContain('UNKNOWN_PAYMENT_STATUS');
  });

  it('applies the authoritative credit-card-hidden rule regardless of labels', () => {
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 3334445557
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-20
Phòng 1: Standard Room
2026-07-19: 500.000 VND
Quý vị không có quyền xem chi tiết thẻ tín dụng này.`;
    const result = parseBooking(text, branches);
    expect(result.paymentStatus).toBe('PAY_BEFORE');
    expect(result.paymentStatusKnown).toBe(true);
  });
});

describe('branch mapping', () => {
  const expectedMap: Array<[string, string]> = [
    ['Saigon Hotel & Ben Thanh', '05 Trương Định'],
    ['Luxury Elegance Hotel Ben Than', '260 Lý Tự Trọng'],
    ['Luxury Ancient Boutique Hotel', '47A Nguyễn Trãi'],
    ['INDOCHINA Premium', '170-172-174 Nguyễn Thái Bình'],
    ['Boutique Zody Hotel Ben Than', '278 Lê Thánh Tôn'],
    ['Ben Thanh Market - Luxur', '40-42 Bùi Thị Xuân'],
    ['Modern Luxury Eliana Hotel', '13 Bùi Thị Xuân'],
    ['Modern Luxury Dilly Hotel', '191 Lê Thánh Tôn'],
  ];

  it('maps every hotel name to the correct branch address', () => {
    for (const [hotel, address] of expectedMap) {
      const match = matchBranch(hotel, branches);
      expect(match?.score).toBe(1);
      expect(match?.branch.address).toBe(address);
    }
  });

  /**
   * A property can be renamed on Booking.com; the stable branch CODE is what the
   * system routes on. The current public name and the earlier ones all resolve to
   * the same branch, so historical emails keep parsing.
   */
  const renamedMap: Array<[name: string, code: string, address: string]> = [
    ['Bamboo Water Hotel', 'LY_TU_TRONG_260', '260 Lý Tự Trọng'],
    ['Kaliee Nata Hotel', 'NGUYEN_THAI_BINH_170', '170-172-174 Nguyễn Thái Bình'],
  ];

  it('the legacy similarity matcher still scores the superseded names (suggestions)', () => {
    for (const [name, code, address] of renamedMap) {
      const match = matchBranch(name, branches);
      expect(match?.branch.code, name).toBe(code);
      expect(match?.branch.address, name).toBe(address);
      expect(match?.score, name).toBe(1); // a perfect SIMILARITY score — still only a suggestion
    }
  });

  const bookingText = (name: string): string => `${name}
Mã đặt phòng: 777888999
Khách: Test Guest
Nhận phòng: 2026-09-01
Trả phòng: 2026-09-02
Phòng 1: Standard Room
2026-09-01: 500.000 VND
Thanh toán: Thanh toán tại chỗ`;

  it('a booking carrying the CURRENT platform identity is assigned automatically', () => {
    for (const branch of fixtureBranches) {
      const current = (branch.identities ?? []).find((i) => i.platform === 'BOOKING_COM');
      if (!current) continue;
      const result = parseBooking(bookingText(current.name), branches);
      expect(result.suggestedBranch?.code, current.name).toBe(branch.code);
      expect(result.suggestedBranch?.address, current.name).toBe(branch.address);
      expect(result.branchConfident, current.name).toBe(true);
      expect(result.requiresManualConfirmation, current.name).toBe(false);
      expect(result.branchConfidence, current.name).toBe(100);
      expect(warningCodes(result)).not.toContain('UNKNOWN_HOTEL');
      expect(warningCodes(result)).not.toContain('LOW_BRANCH_CONFIDENCE');
    }
  });

  it('a SUPERSEDED public name is suggested but never assigned automatically', () => {
    // These were the branch's Booking.com names before it was renamed. They stay
    // in the audit history, but recognition only ever assigns on the CURRENT
    // identity — an old name now needs an Admin to confirm the branch.
    for (const [name, code, address] of renamedMap) {
      const result = parseBooking(bookingText(name), branches);
      expect(result.suggestedBranch?.code, name).toBe(code);
      expect(result.suggestedBranch?.address, name).toBe(address);
      expect(result.branchConfident, name).toBe(false);
      expect(result.requiresManualConfirmation, name).toBe(true);
      // The source hotel name stays available for audit / parser review.
      expect(result.hotelName, name).toBe(name);
      expect(warningCodes(result), name).toContain('LOW_BRANCH_CONFIDENCE');
    }
  });

  it('resolution does not depend on branch-array order', () => {
    const reversed = [...branches].reverse();
    for (const [name, code, address] of renamedMap) {
      const match = matchBranch(name, reversed);
      expect(match?.branch.code, name).toBe(code);
      expect(match?.branch.address, name).toBe(address);
    }
  });

  it('earlier public names remain valid (historical emails still resolve)', () => {
    for (const old of ['Luxury Elegance Hotel Ben Than', 'Luxury Elegance Hotel Ben Thanh', 'Luxury Elegance Ben Thanh']) {
      expect(matchBranch(old, branches)?.branch.code, old).toBe('LY_TU_TRONG_260');
    }
    expect(matchBranch('INDOCHINA Premium', branches)?.branch.code).toBe('NGUYEN_THAI_BINH_170');
  });

  it('every configured alias resolves to exactly one branch (no ambiguity)', () => {
    for (const [code, aliases] of Object.entries(BRANCH_ALIASES)) {
      for (const alias of aliases) {
        const scored = branches
          .map((b) => ({ code: b.code, score: scoreHotel(alias, b) }))
          .sort((a, b) => b.score - a.score);
        expect(scored[0]!.code, alias).toBe(code);
        // The runner-up must be strictly worse, so the alias is unambiguous.
        expect(scored[1]!.score, alias).toBeLessThan(scored[0]!.score);
      }
    }
  });

  it('flags an unknown hotel with no suggested branch', () => {
    const text = `Some Random Guesthouse
Mã đặt phòng: 444
Khách: Test Guest
Nhận phòng: 2026-09-01
Trả phòng: 2026-09-02
Phòng 1: Standard Room
2026-09-01: 500.000 VND
Thanh toán: Thanh toán tại chỗ`;
    const result = parseBooking(text, branches);
    expect(result.suggestedBranch).toBeNull();
    expect(result.hotelName).toBe('Some Random Guesthouse');
    expect(warningCodes(result)).toContain('UNKNOWN_HOTEL');
  });
});

describe('parseBooking — validation warnings', () => {
  it('warns on missing guest, booking code, dates and room', () => {
    const result = parseBooking('Saigon Hotel & Ben Thanh', branches);
    const codes = warningCodes(result);
    expect(codes).toContain('MISSING_GUEST');
    expect(codes).toContain('MISSING_BOOKING_CODE');
    expect(codes).toContain('MISSING_DATES');
    expect(codes).toContain('MISSING_ROOM');
  });

  it('warns on an inverted date range', () => {
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 555
Khách: Test Guest
Nhận phòng: 2026-07-22
Trả phòng: 2026-07-19
Phòng 1: Standard Room
Thanh toán: Thanh toán tại chỗ`;
    expect(warningCodes(parseBooking(text, branches))).toContain('INVALID_DATE_RANGE');
  });
});

describe('parseBooking — malformed input', () => {
  it('handles an empty string without throwing', () => {
    const result = parseBooking('', branches);
    expect(result.rooms).toEqual([]);
    expect(result.checkIn).toBeNull();
    expect(warningCodes(result)).toContain('MISSING_ROOM');
    expect(warningCodes(result)).toContain('MISSING_DATES');
  });

  it('handles unstructured gibberish without throwing', () => {
    const result = parseBooking('xin chào\n???\n42\n\n---', branches);
    expect(result.suggestedBranch).toBeNull();
    expect(result.rooms).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
