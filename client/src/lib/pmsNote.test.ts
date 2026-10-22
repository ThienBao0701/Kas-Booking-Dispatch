import { describe, expect, it } from 'vitest';
import type { BookingDetail, RoomView } from '../api/bookings';
import {
  abbreviateRoomType,
  arrivalNote,
  buildPmsNote,
  contactLabel,
  contactSegment,
  noteNights,
  roomsAbbreviation,
} from './pmsNote';

// A fixed "now": 22 July 2026, 03:00 UTC = 10:00 in Asia/Ho_Chi_Minh → 22/07.
const NOW = new Date('2026-07-22T03:00:00.000Z');

function nightRow(stayDate: string, amount: number | null): RoomView['nights'][number] {
  return { id: stayDate, stayDate, amount, currency: 'VND', manuallyCorrected: false, isEstimated: false };
}

function room(roomType: string | null, nights = 1): RoomView {
  return {
    id: `r-${roomType}`,
    roomIndex: 1,
    roomType,
    roomSubtotal: null,
    taxAmount: null,
    feeAmount: null,
    nights: Array.from({ length: nights }, (_, i) => nightRow(`2026-07-${22 + i}`, 609_120)),
  };
}

function booking(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return {
    id: 'b1',
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    // Unclaimed: these fixtures are about note formatting, not ownership.
    claimedBy: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimCycle: 0,
    businessType: 'DIRECT',
    businessTypeManuallyConfirmed: false,
    hotelName: 'H',
    branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'H', address: '05 Trương Định' },
    branchId: 1,
    customerName: 'Khách',
    phone: null,
    bookingCode: '6037224525',
    checkInDate: '2026-07-22',
    checkOutDate: '2026-07-23',
    checkInTime: null,
    checkOutTime: null,
    totalAmount: 609_120,
    currency: 'VND',
    paymentStatus: 'PAY_AFTER',
    specialRequest: null,
    parserVersion: '4a',
    isLastMinute: false,
    rooms: [room('Standard Double Room')],
    warnings: [],
    // 5.2b: a Booking.com fixture collects no Admin note, so both are null.
    adminPmsNote: null,
    reviewedPaymentMode: null,
    // Phase 5 operational blocks — a Booking.com fixture stores none of the
    // OTA metadata, exactly as the database does.
    ota: { paymentType: null },
    operational: {
      receivedAt: null,
      receivedBy: null,
      actualCheckInAt: null,
      checkedInBy: null,
      actualCheckOutAt: null,
      checkedOutBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    },
    proofs: [],
    createdBy: null,
    sentBy: null,
    completedBy: null,
    reviewedBy: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    sentAt: '2026-07-22T00:00:00.000Z',
    completedAt: null,
    completionNote: null,
    reviewedAt: null,
    ...overrides,
  };
}

describe('room-class snapshot (C.3.8)', () => {
  /** A room carrying the immutable branch room-class snapshot. */
  function snapshotRoom(sourceText: string, pmsCode: string): RoomView {
    return {
      ...room(sourceText),
      roomClassPmsCode: pmsCode,
      roomClassDisplayName: sourceText,
      roomClassStatus: 'RESOLVED',
    };
  }

  it('uses the stored branch-specific code instead of the global keyword table', () => {
    // "Premium" is not in the legacy table at all — only the snapshot knows it.
    expect(roomsAbbreviation([snapshotRoom('Premium', 'LUXDEL')])).toBe('1LUXDEL');
    // Where the two disagree the snapshot wins: the legacy table maps any
    // "deluxe" to DLX, but this branch's configured code is DEBAL.
    expect(roomsAbbreviation([snapshotRoom('Deluxe-Bal', 'DEBAL')])).toBe('1DEBAL');
    expect(abbreviateRoomType('Deluxe-Bal')).toBe('DLX');
  });

  it('keeps the legacy abbreviation for a room with no snapshot', () => {
    // Pre-C.3.8 bookings must produce exactly the note they always produced.
    expect(roomsAbbreviation([room('Phòng Tiêu Chuẩn Giường Đôi')])).toBe('1STAN');
    expect(roomsAbbreviation([room('Superior Twin')])).toBe('1SUP');
  });

  it('groups and counts snapshot codes like any other', () => {
    expect(roomsAbbreviation([snapshotRoom('Premium', 'LUXDEL'), snapshotRoom('Premium', 'LUXDEL')]))
      .toBe('2LUXDEL');
    expect(roomsAbbreviation([snapshotRoom('King Bal', 'KINGBAL'), room('Standard')]))
      .toBe('1KINGBAL 1STAN');
  });

  it('an existing note is unaffected by a later mapping change', () => {
    // The booking stores LUXDEL; whatever the branch mapping says today, the
    // note still prints LUXDEL because nothing ever recomputes it.
    const b = booking({ rooms: [snapshotRoom('Premium', 'LUXDEL')] });
    expect(buildPmsNote(b, NOW).text).toContain('_1LUXDEL_');
  });
});

describe('abbreviateRoomType — most-specific wins', () => {
  it('resolves a Standard Double to STAN, not DBL', () => {
    expect(abbreviateRoomType('Phòng Tiêu Chuẩn Giường Đôi')).toBe('STAN');
    expect(abbreviateRoomType('Standard Double Room')).toBe('STAN');
  });

  it('maps the common room classes', () => {
    expect(abbreviateRoomType('Superior')).toBe('SUP');
    expect(abbreviateRoomType('Deluxe King')).toBe('DLX');
    expect(abbreviateRoomType('Executive Suite')).toBe('SUITE');
    expect(abbreviateRoomType('Family Room')).toBe('FAM');
    expect(abbreviateRoomType('Twin Room')).toBe('TWIN');
    expect(abbreviateRoomType('Double Room')).toBe('DBL');
  });

  it('never returns empty for an unknown type', () => {
    expect(abbreviateRoomType('Bungalow')).toBe('BUNG');
    expect(abbreviateRoomType('')).toBe('PHONG');
    expect(abbreviateRoomType(null)).toBe('PHONG');
  });
});

describe('roomsAbbreviation — quantity first, never dropped', () => {
  it('collapses identical types into one leading count', () => {
    expect(roomsAbbreviation([room('Standard'), room('Standard')])).toBe('2STAN');
  });

  it('prints the count even for a single room', () => {
    expect(roomsAbbreviation([room('Standard')])).toBe('1STAN');
    expect(roomsAbbreviation([room('Deluxe')])).toBe('1DLX');
  });

  it('joins different types with a single space', () => {
    expect(roomsAbbreviation([room('Deluxe'), room('Standard')])).toBe('1DLX 1STAN');
  });

  it('handles the operator-supplied mixes exactly', () => {
    // 2 DLX + 1 STAN
    expect(roomsAbbreviation([room('Deluxe'), room('Deluxe'), room('Standard')]))
      .toBe('2DLX 1STAN');
    // 1 DLX + 2 STAN
    expect(roomsAbbreviation([room('Deluxe'), room('Standard'), room('Standard')]))
      .toBe('1DLX 2STAN');
  });

  it('aggregates a repeated class wherever it appears and keeps first-seen order', () => {
    // STAN + STAN + DLX → "2STAN 1DLX": STAN was seen first, so it leads, and
    // the two STAN rooms are one fragment rather than two.
    expect(roomsAbbreviation([room('Standard'), room('Standard'), room('Deluxe')]))
      .toBe('2STAN 1DLX');
    // Interleaved: the count still aggregates, the order still follows first sight.
    expect(roomsAbbreviation([room('Standard'), room('Deluxe'), room('Standard')]))
      .toBe('2STAN 1DLX');
  });

  it('never alphabetises — DLX first stays DLX first', () => {
    expect(roomsAbbreviation([room('Standard'), room('Deluxe')])).toBe('1STAN 1DLX');
    expect(roomsAbbreviation([room('Deluxe'), room('Standard')])).toBe('1DLX 1STAN');
  });

  it('emits no "x" multiplier anywhere', () => {
    expect(roomsAbbreviation([room('Standard'), room('Standard')])).not.toContain('x');
    expect(roomsAbbreviation([room('Standard'), room('Deluxe')])).not.toContain('+');
  });
});

describe('noteNights', () => {
  it('uses the date range (check-out exclusive)', () => {
    expect(noteNights({ checkInDate: '2026-07-23', checkOutDate: '2026-07-24', rooms: [] })).toBe(1);
    expect(noteNights({ checkInDate: '2026-07-22', checkOutDate: '2026-07-24', rooms: [] })).toBe(2);
  });
  it('falls back to nightly rows only when dates are unusable', () => {
    expect(noteNights({ checkInDate: null, checkOutDate: null, rooms: [room('Standard', 3)] })).toBe(3);
  });
});

describe('contactLabel — one label, no channel guessing', () => {
  it('labels a Vietnamese number CÓ SĐT', () => {
    expect(contactLabel('+84 901 234 567')).toBe('CÓ SĐT');
    expect(contactLabel('0901 234 567')).toBe('CÓ SĐT');
  });

  it('labels a foreign number CÓ SĐT too', () => {
    expect(contactLabel('+64 210 812 1300')).toBe('CÓ SĐT');
    expect(contactLabel('0064 21 555 000')).toBe('CÓ SĐT');
    expect(contactLabel('+31 345 678 912')).toBe('CÓ SĐT');
  });

  it('never emits a messaging-channel label', () => {
    for (const phone of ['+84 901 234 567', '+64 210 812 1300', '0901234567', null]) {
      const label = contactLabel(phone);
      expect(label).not.toContain('ZL');
      expect(label).not.toContain('WA');
    }
  });

  it('returns KHÔNG CÓ SĐT when absent', () => {
    expect(contactLabel(null)).toBe('KHÔNG CÓ SĐT');
    expect(contactLabel(undefined)).toBe('KHÔNG CÓ SĐT');
    expect(contactLabel('')).toBe('KHÔNG CÓ SĐT');
    expect(contactLabel('   ')).toBe('KHÔNG CÓ SĐT');
  });

  it('treats a digit-free string as no number at all', () => {
    // Punctuation is not a phone number, and must not produce a note that
    // claims there is one.
    expect(contactLabel('---')).toBe('KHÔNG CÓ SĐT');
    expect(contactLabel('+')).toBe('KHÔNG CÓ SĐT');
    expect(contactLabel('()')).toBe('KHÔNG CÓ SĐT');
  });
});

describe('contactSegment', () => {
  it('prints the label then the number', () => {
    expect(contactSegment('+966598331083')).toBe('CÓ SĐT +966598331083');
    expect(contactSegment('+84912345678')).toBe('CÓ SĐT +84912345678');
    expect(contactSegment('+31 345 678 912')).toBe('CÓ SĐT +31 345 678 912');
    expect(contactSegment('+44 7889 293262')).toBe('CÓ SĐT +44 7889 293262');
  });

  it('preserves a leading + and never reformats the number', () => {
    // Whatever the guest gave is what the receptionist dials. Spacing,
    // grouping and the country prefix are all left exactly as received.
    expect(contactSegment('+966 598 331 083')).toBe('CÓ SĐT +966 598 331 083');
    expect(contactSegment('0901.234.567')).toBe('CÓ SĐT 0901.234.567');
    expect(contactSegment('0064 21 555 000')).toBe('CÓ SĐT 0064 21 555 000');
  });

  it('trims only the surrounding whitespace', () => {
    expect(contactSegment('  +84912345678  ')).toBe('CÓ SĐT +84912345678');
  });

  it('stands alone as KHÔNG CÓ SĐT when there is no number', () => {
    expect(contactSegment(null)).toBe('KHÔNG CÓ SĐT');
    expect(contactSegment('')).toBe('KHÔNG CÓ SĐT');
    expect(contactSegment('   ')).toBe('KHÔNG CÓ SĐT');
  });

  it('never emits undefined, null or a label with nothing after it', () => {
    for (const phone of [null, undefined, '', '   ', '--']) {
      const segment = contactSegment(phone);
      expect(segment).not.toContain('undefined');
      expect(segment).not.toContain('null');
      // The whole segment, not a bare "CÓ SĐT" left dangling with no number.
      expect(segment).toBe('KHÔNG CÓ SĐT');
    }
  });
});

describe('arrivalNote', () => {
  it('extracts a concise arrival time', () => {
    expect(arrivalNote('Khách dự kiến đến khoảng 13:00.')).toBe('KHÁCH ĐẾN KHOẢNG 13:00');
    expect(arrivalNote('Khách đến lúc 22:30.')).toBe('KHÁCH ĐẾN LÚC 22:30');
  });
  it('appends nothing without arrival-time info', () => {
    expect(arrivalNote('Yêu cầu phòng tầng cao, thêm giường.')).toBe('');
    expect(arrivalNote(null)).toBe('');
  });
});

describe('buildPmsNote — exact output', () => {
  it('A — no breakfast, no phone', () => {
    const res = buildPmsNote(booking(), NOW);
    expect(res.ok).toBe(true);
    expect(res.text).toBe(
      'BK 6037224525_1STAN_1 ĐÊM 609.120 PAY AFTER CHECK-IN CI\n22/07 KHÔNG CÓ SĐT',
    );
  });

  it('B — breakfast branch, Vietnamese phone', () => {
    const res = buildPmsNote(
      booking({
        bookingCode: '6339476198',
        branch: { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'L', address: '260 Lý Tự Trọng', breakfastIncluded: true },
        totalAmount: 510_138,
        paymentStatus: 'PAY_BEFORE',
        phone: '+84 901 234 567',
      }),
      NOW,
    );
    expect(res.text).toBe(
      'BK 6339476198_1STAN_1 ĐÊM 510.138 PAY BEFORE CHECK-IN CI\nĂN SÁNG 22/07 CÓ SĐT +84 901 234 567',
    );
  });

  it('C — breakfast branch, foreign phone and arrival note', () => {
    const res = buildPmsNote(
      booking({
        bookingCode: '6339476198',
        branch: { id: 3, code: 'NGUYEN_TRAI_47A', hotelName: 'L', address: '47A Nguyễn Trãi', breakfastIncluded: true },
        totalAmount: 510_138,
        paymentStatus: 'PAY_BEFORE',
        phone: '+64 210 812 1300',
        specialRequest: 'Khách dự kiến đến khoảng 13:00.',
      }),
      NOW,
    );
    expect(res.text).toBe(
      'BK 6339476198_1STAN_1 ĐÊM 510.138 PAY BEFORE CHECK-IN CI\n' +
        'ĂN SÁNG 22/07 CÓ SĐT +64 210 812 1300 KHÁCH ĐẾN KHOẢNG 13:00',
    );
  });

  it('D — non-breakfast branch, two-night Deluxe, foreign phone', () => {
    const res = buildPmsNote(
      booking({
        bookingCode: '6339476198',
        checkInDate: '2026-07-22',
        checkOutDate: '2026-07-24',
        totalAmount: 1_200_000,
        rooms: [room('Deluxe King', 2)],
        phone: '+64 210 812 1300',
      }),
      NOW,
    );
    expect(res.text).toBe(
      'BK 6339476198_1DLX_2 ĐÊM 1.200.000 PAY AFTER CHECK-IN CI\n22/07 CÓ SĐT +64 210 812 1300',
    );
  });

  it('E — PARTNER booking replaces the contact label with ĐƠN ĐỐI TÁC (breakfast kept)', () => {
    const res = buildPmsNote(
      booking({
        bookingCode: '6339476198',
        branch: { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'L', address: '260 Lý Tự Trọng', breakfastIncluded: true },
        totalAmount: 510_138,
        paymentStatus: 'PAY_AFTER',
        phone: '+84 901 234 567',
        businessType: 'PARTNER',
      }),
      NOW,
    );
    // No contact segment at all for a partner; breakfast + date preserved.
    expect(res.text).toBe(
      'BK 6339476198_1STAN_1 ĐÊM 510.138 PAY AFTER CHECK-IN CI\nĂN SÁNG 22/07 ĐƠN ĐỐI TÁC',
    );
    expect(res.text).not.toContain('CÓ SĐT');
    expect(res.text).not.toContain('CÓ ZL');
    expect(res.text).not.toContain('CÓ WA');
  });

  it('F — PARTNER booking keeps the arrival note after ĐƠN ĐỐI TÁC', () => {
    const res = buildPmsNote(
      booking({
        bookingCode: '6339476198',
        branch: { id: 3, code: 'NGUYEN_TRAI_47A', hotelName: 'L', address: '47A Nguyễn Trãi', breakfastIncluded: true },
        totalAmount: 510_138,
        paymentStatus: 'PAY_BEFORE',
        phone: '+84 901 234 567',
        businessType: 'PARTNER',
        specialRequest: 'Khách dự kiến đến khoảng 13:00.',
      }),
      NOW,
    );
    expect(res.text).toBe(
      'BK 6339476198_1STAN_1 ĐÊM 510.138 PAY BEFORE CHECK-IN CI\nĂN SÁNG 22/07 ĐƠN ĐỐI TÁC KHÁCH ĐẾN KHOẢNG 13:00',
    );
  });

  // ------------------------------------------------------------------
  // Breakfast is branch CONFIGURATION, not a branch code.
  //
  // These two cases are the regression guard: the note used to be driven by a
  // hardcoded set of three branch codes, so an Admin toggling "phục vụ ăn sáng"
  // in branch management changed nothing. Each case pairs a branch code with
  // the OPPOSITE of what that old table said, so the assertions can only pass
  // if Branch.breakfastIncluded is what decides. They also prove the behaviour
  // is available to every branch, not a privileged three.
  // ------------------------------------------------------------------
  it('B1 — a historically-breakfast branch code with breakfastIncluded=false gets NO ĂN SÁNG', () => {
    const res = buildPmsNote(
      booking({
        branch: {
          id: 2,
          code: 'LY_TU_TRONG_260',
          hotelName: 'L',
          address: '260 Lý Tự Trọng',
          breakfastIncluded: false,
        },
      }),
      NOW,
    );
    expect(res.text).not.toContain('ĂN SÁNG');
    expect(res.text!.split('\n')[1]).toBe('22/07 KHÔNG CÓ SĐT');
  });

  it('B2 — any other branch with breakfastIncluded=true gets ĂN SÁNG', () => {
    const res = buildPmsNote(
      booking({
        branch: {
          id: 8,
          code: 'LE_THANH_TON_191',
          hotelName: 'D',
          address: '191 Lê Thánh Tôn',
          breakfastIncluded: true,
        },
      }),
      NOW,
    );
    expect(res.text!.split('\n')[1]).toBe('ĂN SÁNG 22/07 KHÔNG CÓ SĐT');
  });

  it('B3 — a branch payload without the field is treated as no breakfast', () => {
    // Older cached payloads may predate the field; absence must never be read
    // as "serves breakfast".
    const res = buildPmsNote(booking(), NOW);
    expect(res.text).not.toContain('ĂN SÁNG');
  });

  it('G — first line has exactly one space after "BK" (never "BK<digit>")', () => {
    const res = buildPmsNote(booking(), NOW);
    const line1 = res.text!.split('\n')[0]!;
    expect(line1.startsWith('BK ')).toBe(true);
    expect(line1).not.toMatch(/^BK {2,}/); // no double space
    expect(line1).not.toMatch(/^BK\d/); // never glued to the code
    // Even a code with stray whitespace normalises to one space.
    const padded = buildPmsNote(booking({ bookingCode: '  6037224525  ' }), NOW);
    expect(padded.text!.split('\n')[0]).toMatch(/^BK 6037224525_/);
  });

  it('blocks generation when the booking code is missing', () => {
    const res = buildPmsNote(booking({ bookingCode: null }), NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Chưa có mã Booking để tạo ghi chú.');
  });
});
