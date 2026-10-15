/**
 * Agoda production certification.
 *
 * This suite exists to FALSIFY the parser rather than demonstrate it. Each
 * group corresponds to a certification matrix section, and the cases are
 * deliberately adversarial: the layouts a mail client produces by accident,
 * and the two failure modes that would reach a real guest —
 *
 *   dispatching the WRONG reservation out of a thread, and
 *   dispatching an INCOMPLETE booking when several room types were reserved.
 *
 * Both are covered below because both were real defects found here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgodaPartnerBooking, reservationBlocks } from '../src/booking/agodaPartner';
import { parseAgodaBooking } from '../src/booking/agoda';
import { agodaParsedFields } from '../src/booking/otaReviewService';
import { buildOtaReview, type OtaReviewBranch } from '../src/booking/otaReview';
import { normalizeText } from '../src/booking/text';

const read = (name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', 'agoda', name), 'utf8');

const BASE = read('10-list-page-above-reservation.txt');
const THREAD = read('09-amended-thread-two-bookings.txt');
const MULTI_ROOM = read('11-SYNTHETIC-multi-room-types.txt');

const p = (raw: string) => parseAgodaPartnerBooking(raw);

/** A second, DIFFERENT complete reservation appended to the first. */
const TWO_DISTINCT = `${BASE}\n\n${BASE
  .replace('1756224954', '1799999999')
  .replace('Tên Khách Hàng\tNga', 'Tên Khách Hàng\tOther')
  .replace('Họ Khách Hàng\tĐỗ', 'Họ Khách Hàng\tPerson')}`;

/* ================================================================== */
/* GROUP A — reservation detection                                     */
/* ================================================================== */
describe('A. reservation detection', () => {
  it('parses a standard booking', () => {
    expect(p(BASE).bookingId).toBe('1756224954');
    expect(p(BASE).bookingStatus).toBe('CONFIRMED');
  });

  it('parses an amended booking with the same parser', () => {
    expect(p(THREAD).bookingId).toBe('1753732591');
    expect(p(THREAD).bookingStatus).toBe('AMENDED');
  });

  it('records a cancelled booking as CANCELLED', () => {
    const cancelled = BASE.replace('Agoda Booking Confirmation', 'Agoda Booking Cancelled');
    expect(p(cancelled).bookingStatus).toBe('CANCELLED');
  });

  it('ignores the subject entirely — removed, edited or translated', () => {
    const edited = THREAD.replace('Agoda Booking ID 1753732591 - AMENDED', 'Agoda Booking ID 9999999999 - AMENDED');
    const removed = THREAD.split('\n').filter((l) => !l.includes('Agoda Booking ID')).join('\n');
    const translated = THREAD.replace(/Agoda Booking ID 1753732591 - AMENDED.*/, 'Xác Nhận Đặt Phòng Agoda Sửa Đổi');
    for (const [name, text] of [['edited', edited], ['removed', removed], ['translated', translated]] as const) {
      expect(p(text).bookingId, name).toBe('1753732591');
    }
  });

  it('reads the reservation that follows a YCS list page', () => {
    expect(p(BASE).sourceHotelName).toBe('KAS Zody Boutique Hotel');
    expect(p(BASE).checkIn).toBe('2026-08-04');
  });

  it('stays silent when the SAME reservation is quoted twice', () => {
    // Forwarded history repeats a booking; that is not ambiguity.
    const quoted = `${BASE}\n\n${BASE}`;
    const parsed = p(quoted);
    expect(parsed.bookingId).toBe('1756224954');
    expect(parsed.detectedReservationIds).toEqual(['1756224954']);
    expect(parsed.warnings.map((w) => w.code)).not.toContain('AGODA_MULTIPLE_RESERVATIONS');
  });

  it('never silently picks between two DIFFERENT reservations', () => {
    // The parser takes the first, but says so and lists every one it found —
    // dispatching the wrong booking must never be invisible.
    const parsed = p(TWO_DISTINCT);
    expect(parsed.detectedReservationIds).toEqual(['1756224954', '1799999999']);

    const warning = parsed.warnings.find((w) => w.code === 'AGODA_MULTIPLE_RESERVATIONS');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('1756224954');
    expect(warning!.message).toContain('1799999999');
  });

  it('carries that warning through to the review screen', () => {
    const booking = parseAgodaBooking(TWO_DISTINCT, []);
    const review = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: { ...agodaParsedFields(booking, null), resolvedBranchId: null },
      branch: null,
    });
    expect(review.warnings.map((w) => w.code)).toContain('AGODA_MULTIPLE_RESERVATIONS');
  });

  it('does not block a thread — every collected mail is one', () => {
    // Blocking would reject every production mail gathered so far. The choice
    // is surfaced instead, and the review's own checks decide dispatch.
    const errors = p(THREAD).warnings.filter((w) => w.severity === 'ERROR');
    expect(errors).toEqual([]);
  });

  it('survives a very long thread', () => {
    const long = Array.from({ length: 30 }, (_, i) => BASE.replace('1756224954', String(1700000000 + i))).join('\n\n');
    expect(reservationBlocks(long.split('\n'))).toHaveLength(30);
    expect(p(long).bookingId).toBe('1700000000');
  });
});

/* ================================================================== */
/* GROUP B — guest                                                     */
/* ================================================================== */
describe('B. guest', () => {
  const named = (first: string, last: string) =>
    p(
      BASE.replace('Customer First Name Tên Khách Hàng\tNga', `Customer First Name Tên Khách Hàng\t${first}`)
        .replace('Customer Last Name Họ Khách Hàng\tĐỗ', `Customer Last Name Họ Khách Hàng\t${last}`),
    ).customerFullName;

  it.each([
    ['English', 'John', 'Smith', 'John Smith'],
    ['Vietnamese accented', 'Tiến', 'Nguyễn Xuân', 'Tiến Nguyễn Xuân'],
    ['Chinese romanised', 'Yunning', 'Hsieh', 'Yunning Hsieh'],
    ['upper-case HO surname', 'THU UYEN', 'HO', 'THU UYEN HO'],
    ['mixed-case Ho surname', 'Anna', 'Ho', 'Anna Ho'],
    ['slashed name', 'LEE/JENSON', 'HWEE', 'LEE/JENSON HWEE'],
  ])('reads a %s name', (_label, first, last, expected) => {
    expect(named(first, last)).toBe(expected);
  });

  it('never lets Other Guests overwrite the primary guest', () => {
    expect(BASE).toContain('Guest of Nga Đỗ');
    expect(p(BASE).customerFullName).toBe('Nga Đỗ');

    // Even when the occupant list names somebody else entirely.
    const companion = BASE.replace('[RmNo.1] Guest of Nga Đỗ, [RmNo.1] Nga Đỗ', '[RmNo.1] Someone Else');
    expect(p(companion).customerFullName).toBe('Nga Đỗ');
  });
});

/* ================================================================== */
/* GROUP C — dates                                                     */
/* ================================================================== */
describe('C. dates', () => {
  const stay = (ci: string, co: string) =>
    p(
      BASE.replace('Check-in Nhận phòng\t4-Aug-2026 (4-08-2026)', `Check-in Nhận phòng\t${ci}`)
        .replace('Check-out Trả phòng\t5-Aug-2026 (5-08-2026)', `Check-out Trả phòng\t${co}`),
    );

  it.each([
    ['1-Aug-2026', '3-Aug-2026'],
    ['August 1, 2026', 'August 3, 2026'],
    ['1-Aug-2026 (1-08-2026)', '3-Aug-2026 (3-08-2026)'],
    ['August 01, 2026', 'August 03, 2026'],
    ['1-Aug-2026', 'August 3, 2026'],
  ])('normalises %s / %s', (ci, co) => {
    const r = stay(ci, co);
    expect(r.checkIn).toBe('2026-08-01');
    expect(r.checkOut).toBe('2026-08-03');
    expect(r.nights).toBe(2);
  });

  it('derives nights from the dates, never from the nightly rows', () => {
    // One nightly row, a four-night stay: the rows must not decide the count.
    const r = stay('1-Aug-2026', '5-Aug-2026');
    expect(r.nightlyRates).toHaveLength(1);
    expect(r.nights).toBe(4);
  });
});

/* ================================================================== */
/* GROUP D — rooms                                                     */
/* ================================================================== */
describe('D. rooms', () => {
  it('reads a single room with occupancy and extra beds', () => {
    const r = p(BASE);
    expect([r.roomQuantity, r.occupancy, r.extraBeds]).toEqual([1, '2 Adults', 0]);
  });

  it('reads a multi-room single type', () => {
    const r = p(BASE.replace('Superior Double Room\t1\t2 Adults\t0', 'Superior Double Room\t3\t6 Adults\t2'));
    expect([r.roomQuantity, r.occupancy, r.extraBeds]).toEqual([3, '6 Adults', 2]);
  });

  it('strips a trailing style marker before mapping', () => {
    expect(p(BASE.replace('Superior Double Room\t1', 'Standard (0)\t1')).roomTypeNormalized).toBe('Standard');
  });

  /**
   * SYNTHETIC EVIDENCE. No real Agoda mail with several room types has been
   * collected, so this fixture was built by hand from the confirmed layout.
   * The behaviour is certified against a design expectation, not observation.
   */
  describe('multiple room types (synthetic fixture)', () => {
    const parsed = p(MULTI_ROOM);

    it('reads every room row', () => {
      expect(parsed.roomLines).toHaveLength(3);
      expect(parsed.roomLines.map((r) => [r.roomTypeNormalized, r.quantity, r.occupancy, r.extraBeds])).toEqual([
        ['Deluxe Room', 2, '4 Adults', 1],
        ['King Room', 1, '2 Adults', 0],
        ['Standard Double Room', 3, '6 Adults', 0],
      ]);
    });

    it('carries every row to the review, not just the first', () => {
      // One line reached the review before this: a six-room booking was
      // presented, and would have been noted, as two rooms.
      const booking = parseAgodaBooking(MULTI_ROOM, []);
      const rooms = agodaParsedFields(booking, null).rooms;
      expect(rooms).toHaveLength(3);
      expect(rooms.map((r) => r.otaRoomName)).toEqual([
        'Deluxe Room',
        'King Room',
        'Standard Double Room',
      ]);
      expect(rooms.map((r) => r.quantity)).toEqual([2, 1, 3]);
    });

    it('attributes no per-line nightly figure when several types share one', () => {
      const booking = parseAgodaBooking(MULTI_ROOM, []);
      for (const room of agodaParsedFields(booking, null).rooms) {
        expect(room.sourceNightlyTotal).toBeNull();
        expect(room.perRoomNightlyRate).toBeNull();
      }
    });

    it('blocks dispatch until every type is mapped', () => {
      const branch: OtaReviewBranch = {
        id: 6,
        code: 'BUI_THI_XUAN_40',
        address: '40 Bùi Thị Xuân',
        mappings: [{ otaRoomName: 'Deluxe Room', pmsCode: 'DEL' }].map((m) => ({
          otaRoomName: m.otaRoomName,
          normalizedOtaRoomName: normalizeText(m.otaRoomName),
          otaRoomTypeId: null,
          pmsCode: m.pmsCode,
        })),
        validPmsCodes: ['DEL', 'KING', 'STAN'],
      };
      const booking = parseAgodaBooking(MULTI_ROOM, []);
      const review = buildOtaReview({
        source: 'AGODA',
        platform: 'AGODA',
        parsed: { ...agodaParsedFields(booking, branch.id), resolvedBranchId: branch.id },
        branch,
      });
      expect(review.rooms[0]?.pmsCode).toBe('DEL');
      expect(review.rooms[1]?.requiresManualMapping).toBe(true);
      expect(review.canDispatch).toBe(false);
      expect(review.blockingReasons).toContain('Còn hạng phòng chưa gán mã nội bộ.');
    });
  });
});

/* ================================================================== */
/* GROUP E — rates                                                     */
/* ================================================================== */
describe('E. rates', () => {
  it('reads both rates and the nightly rows', () => {
    const r = p(BASE);
    expect(r.netRate).toBe(529_537);
    expect(r.referenceSellRate).toBe(875_000);
    expect(r.nightlyRates.map((n) => n.amount)).toEqual([529_537]);
  });

  it('ignores commission', () => {
    expect(BASE).toContain('VND -175,000.00');
    expect(p(BASE).netRate).not.toBe(175_000);
    expect(p(BASE).referenceSellRate).not.toBe(175_000);
  });

  it('fabricates no nightly rows when Agoda states none', () => {
    expect(p(BASE.replace(/August 4, 2026.*\n/, '')).nightlyRates).toEqual([]);
  });

  it('reports a nightly/net mismatch at INFO and alters neither figure', () => {
    const tampered = BASE.replace('VND 529,537.00\nReference', 'VND 500,000.00\nReference');
    const r = p(tampered);
    const info = r.warnings.find((w) => w.code === 'AGODA_NIGHTLY_SUM_MISMATCH');
    expect(info?.severity).toBe('INFO');
    expect(r.netRate).toBe(529_537);
    expect(r.nightlyRates[0]?.amount).toBe(500_000);
  });
});

/* ================================================================== */
/* GROUP F — business rules                                            */
/* ================================================================== */
describe('F. business rules', () => {
  it('always reports breakfast false', () => {
    expect(p(BASE).breakfastIncluded).toBe(false);
    expect(p(BASE.replace('Coffee & tea', 'Breakfast buffet included')).breakfastIncluded).toBe(false);
    expect(p(BASE.replace('Coffee & tea', 'Room Only')).breakfastIncluded).toBe(false);
  });

  it('exposes no room-type id from the parser', () => {
    const booking = parseAgodaBooking(BASE, []);
    for (const room of agodaParsedFields(booking, null).rooms) {
      expect(room.otaRoomTypeId).toBeNull();
    }
  });
});

/* ================================================================== */
/* GROUP G — additional fields                                         */
/* ================================================================== */
describe('G. additional fields', () => {
  const r = p(BASE);

  it('returns every documented field', () => {
    expect(r).toMatchObject({
      countryOfResidence: 'Vietnam',
      sourceHotelName: 'KAS Zody Boutique Hotel',
      websiteLanguage: 'Vietnamese',
      paymentType: 'PREPAID',
      bookingStatus: 'CONFIRMED',
      benefitsIncluded: 'Coffee & tea, Free WiFi, Drinking water',
      specialRequests: 'NonSmoke',
    });
    expect(r.cancellationPolicy).not.toBeNull();
  });

  it('never reports a card row as the payment type', () => {
    const carded = BASE.replace('TRẢ TRƯỚC', 'Payment Model Hình thức thanh toán\tLOẠI THẺ');
    expect(p(carded).paymentType).not.toBe('LOẠI THẺ');
  });
});

/* ================================================================== */
/* GROUP H — validation hygiene                                        */
/* ================================================================== */
describe('H. validation hygiene', () => {
  it('raises no warning at all on a clean reservation', () => {
    expect(p(BASE).warnings).toEqual([]);
  });

  it('never duplicates a warning code', () => {
    for (const raw of [BASE, THREAD, MULTI_ROOM, TWO_DISTINCT]) {
      const codes = p(raw).warnings.map((w) => w.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('uses only the three defined severities', () => {
    for (const raw of [BASE, THREAD, MULTI_ROOM, TWO_DISTINCT]) {
      for (const w of p(raw).warnings) {
        expect(['INFO', 'WARNING', 'ERROR']).toContain(w.severity);
      }
    }
  });

  it('reports a genuinely missing field rather than inventing one', () => {
    const stripped = BASE.replace(/Net rate \(incl\. taxes & fees\)[\s\S]*?VND 529,537\.00/, '');
    const r = p(stripped);
    expect(r.netRate).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('AGODA_MISSING_NET_RATE');
  });
});

/* ================================================================== */
/* Whitespace and layout abuse                                         */
/* ================================================================== */
describe('layout abuse', () => {
  it.each([
    ['blank rows doubled', (s: string) => s.replace(/\n/g, '\n\n')],
    ['CRLF', (s: string) => s.replace(/\n/g, '\r\n')],
    ['trailing spaces', (s: string) => s.split('\n').map((l) => `${l}   `).join('\n')],
    ['leading indentation', (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n')],
    ['non-breaking spaces', (s: string) => s.replace(/ /g, ' ')],
    ['doubled tabs', (s: string) => s.replace(/\t/g, '\t\t')],
  ])('survives %s', (_label, transform) => {
    const r = p(transform(BASE));
    expect([r.bookingId, r.customerFullName, r.checkIn, r.netRate, r.roomQuantity]).toEqual([
      '1756224954',
      'Nga Đỗ',
      '2026-08-04',
      529_537,
      1,
    ]);
  });
});
