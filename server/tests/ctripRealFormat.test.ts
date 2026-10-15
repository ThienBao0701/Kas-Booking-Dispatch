/**
 * CTrip's REAL reservation page, as it arrives when copied from the browser.
 *
 * A copied page is not just the reservation. It carries, in order: navigation,
 * a property switcher, a filter bar with its OWN dates, a reservation LIST
 * holding a shortened copy of several bookings, the detail block for the open
 * one, and a footer. Almost every field therefore appears more than once, and
 * the wrong copy is a plausible read rather than an obvious failure — a filter
 * date taken as a check-in, or the neighbouring cancelled reservation's code
 * taken as this one's.
 *
 * These tests pin the confirmed reservation 1658113703317875 end to end, and
 * the reading rules that keep the detail block authoritative.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detailBlock,
  extractCtripFields,
  parseCtripAmount,
  parseCtripRoomLine,
  parseCtripStayPeriod,
} from '../src/booking/ctripFields';
import { parseCtripBooking } from '../src/booking/ctrip';
import { ctripParsedFields } from '../src/booking/otaReviewService';
import { buildOtaReview, type OtaReviewBranch } from '../src/booking/otaReview';
import { normalizeText } from '../src/booking/text';
import { hcmDayMonthDots } from '../src/booking/otaPmsNote';

/**
 * CTrip's second line prints the day the booking is CREATED, so for a review
 * built now that is today in Ho Chi Minh City. The DD.MM formatting itself is
 * pinned against fixed dates in otaPmsNote.test.ts; here it only has to make
 * the whole-string comparison stable whatever day the suite runs.
 */
const CREATED = hcmDayMonthDots(new Date());

const REAL = readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '05-real-page-with-list.txt'),
  'utf8',
);

const fields = extractCtripFields(REAL);

function branch(
  id: number,
  code: string,
  address: string,
  rooms: { name: string; pms: string }[],
  validPmsCodes: string[],
): OtaReviewBranch {
  return {
    id,
    code,
    address,
    mappings: rooms.map((r) => ({
      otaRoomName: r.name,
      normalizedOtaRoomName: normalizeText(r.name),
      otaRoomTypeId: null,
      pmsCode: r.pms,
    })),
    validPmsCodes,
  };
}

/** CN5 — the branch in the confirmed sample. */
const CN5 = branch(
  5,
  'LE_THANH_TON_278',
  '278 Lê Thánh Tôn',
  [
    { name: 'Standard Double Room No Window', pms: 'STAN' },
    { name: 'Standard Double Room', pms: 'STAN' },
    { name: 'D-D Room', pms: 'TWIN' },
  ],
  ['STAN', 'SUP', 'TWIN', 'DEL', 'STU', 'SUITE'],
);

/** CN6 — a different branch whose Deluxe rooms map differently. */
const CN6 = branch(
  6,
  'BUI_THI_XUAN_40',
  '40 Bùi Thị Xuân',
  [
    { name: 'Deluxe Double Room with Window', pms: 'DEL' },
    { name: 'Deluxe Queen Room', pms: 'DELQUEEN' },
    { name: 'D-D Room', pms: 'DD' },
  ],
  ['STAN', 'SUP', 'DEL', 'DELQUEEN', 'DEBAL', 'DD', 'KING', 'FAM', 'DEFAM'],
);

/** Runs the REAL production path from raw text to review. */
function review(rawText: string, on: OtaReviewBranch | null, overrides = {}) {
  const booking = parseCtripBooking(rawText, []);
  return buildOtaReview({
    source: 'CTRIP',
    platform: 'CTRIP',
    parsed: { ...ctripParsedFields(booking, on?.id ?? null), resolvedBranchId: on?.id ?? null },
    branch: on,
    overrides,
  });
}

/* ================================================================== */
/* The detail block                                                    */
/* ================================================================== */
describe('CTrip detail block', () => {
  it('starts at the "Reservation:" line and drops everything above it', () => {
    const lines = REAL.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const block = detailBlock(lines);
    expect(block[0]).toMatch(/^Reservation:/);
    expect(block.join('\n')).not.toContain('Check-in date from');
    expect(block.join('\n')).not.toContain('Cancelled');
  });

  it('falls back to the whole text when there is no detail block', () => {
    const lines = ['Property name', 'KAS Dilly Hotel'];
    expect(detailBlock(lines)).toEqual(lines);
  });

  it('prefers the detail block over the reservation list', () => {
    // The list's first row also carries 1658113703317875, but the second row
    // holds a DIFFERENT reservation that must not leak in.
    expect(REAL).toContain('1658113703317111');
    expect(fields.reservationCode).toBe('1658113703317875');
  });

  it('ignores the filter dates', () => {
    // "May 1, 2026" and "Aug 1, 2026" are a search range, not a stay.
    expect(REAL).toContain('Check-in date from: May 1, 2026');
    expect(fields.checkIn).toBe('2026-08-01');
    expect(fields.checkOut).toBe('2026-08-08');
  });
});

/* ================================================================== */
/* Fields                                                              */
/* ================================================================== */
describe('CTrip fields', () => {
  it('extracts the reservation code without its status', () => {
    // "1658113703317875 · Confirmed" — the status must never reach a PMS note.
    expect(fields.reservationCode).toBe('1658113703317875');
  });

  it('extracts the property name', () => {
    expect(fields.propertyName).toBe('KAS Zody Boutique Hotel');
  });

  it('reads the "Property" label as well as "Property name"', () => {
    const f = extractCtripFields(
      ['Reservation: 900001 · Confirmed', 'Property', 'KAS Sonata Luxury Hotel'].join('\n'),
    );
    expect(f.propertyName).toBe('KAS Sonata Luxury Hotel');
  });

  it('preserves the slash and capitalisation in a guest name', () => {
    expect(fields.guestName).toBe('LEE/JENSON HWEE');
  });

  it('parses the stay period', () => {
    expect(fields.checkIn).toBe('2026-08-01');
    expect(fields.checkOut).toBe('2026-08-08');
    expect(fields.statedNights).toBe(7);
  });

  it.each([
    ['Jan 3, 2026 - Jan 5, 2026 2 night(s)', '2026-01-03', '2026-01-05', 2],
    ['February 1, 2026 - February 4, 2026 3 night(s)', '2026-02-01', '2026-02-04', 3],
    ['Sept 9, 2026 - Sept 10, 2026 1 night(s)', '2026-09-09', '2026-09-10', 1],
    ['Dec 30, 2026 - Dec 31, 2026 1 night', '2026-12-30', '2026-12-31', 1],
  ])('parses the stay period %s', (raw, checkIn, checkOut, nights) => {
    expect(parseCtripStayPeriod(raw)).toEqual({ checkIn, checkOut, statedNights: nights });
  });

  it('refuses to build a range from a single date', () => {
    expect(parseCtripStayPeriod('Aug 1, 2026')).toEqual({
      checkIn: null,
      checkOut: null,
      statedNights: null,
    });
  });

  it('extracts the room name and quantity', () => {
    expect(fields.roomType).toBe('Standard Double Room No Window');
    expect(fields.roomQuantity).toBe(1);
  });

  it.each([
    ['Standard Double Room No Window 1 room(s)', 'Standard Double Room No Window', 1],
    ['Deluxe Queen Room 2 rooms', 'Deluxe Queen Room', 2],
    ['Suite Room 3 room(s)', 'Suite Room', 3],
  ])('splits the room line %s', (raw, name, quantity) => {
    expect(parseCtripRoomLine(raw)).toEqual({ roomType: name, roomQuantity: quantity });
  });

  it('keeps numbers that belong to the room name', () => {
    // "Deluxe 1 - 2" is a room name at CN4; only a trailing count is removed.
    expect(parseCtripRoomLine('Deluxe 1 - 2 1 room(s)')).toEqual({
      roomType: 'Deluxe 1 - 2',
      roomQuantity: 1,
    });
  });
});

/* ================================================================== */
/* Nights validation                                                   */
/* ================================================================== */
describe('CTrip stated nights', () => {
  it('agrees with the dates on the confirmed sample', () => {
    const booking = parseCtripBooking(REAL, []);
    expect(booking.ctrip?.nights).toBe(7);
    expect(booking.warnings.map((w) => w.code)).not.toContain('CTRIP_NIGHTS_MISMATCH');
  });

  it('keeps the dates and warns when the stated count disagrees', () => {
    const text = REAL.replace('7 night(s)', '5 night(s)');
    const booking = parseCtripBooking(text, []);
    expect(booking.checkIn).toBe('2026-08-01');
    expect(booking.checkOut).toBe('2026-08-08');
    expect(booking.ctrip?.nights).toBe(7);
    expect(booking.warnings.map((w) => w.code)).toContain('CTRIP_NIGHTS_MISMATCH');
  });
});

/* ================================================================== */
/* Money                                                               */
/* ================================================================== */
describe('CTrip money', () => {
  it('uses Original room rate as the guest-booked price', () => {
    expect(fields.originalRoomRate).toBe(6_637_080);
  });

  it('uses Your payout as the branch price', () => {
    expect(fields.payout).toBe(4_645_956);
  });

  it('does not use Final room rate as the guest-booked price', () => {
    expect(fields.finalRoomRate).toBe(4_645_956);
    expect(fields.originalRoomRate).not.toBe(fields.finalRoomRate);
  });

  it('ignores Discounts', () => {
    expect(REAL).toContain('-1991124.00');
    expect(fields.originalRoomRate).not.toBe(1_991_124);
    expect(fields.payout).not.toBe(1_991_124);
  });

  it('ignores VAT', () => {
    expect(REAL).toContain('VAT:');
    expect(fields.payout).toBe(4_645_956);
  });

  it('drops a two-digit decimal fraction but keeps thousands groups', () => {
    // "6637080.00" read as digits-only becomes 663,708,000 — a hundredfold
    // overstatement of what the hotel is owed.
    expect(parseCtripAmount('6637080.00')).toBe(6_637_080);
    expect(parseCtripAmount('6,637,080.00')).toBe(6_637_080);
    expect(parseCtripAmount('6.637.080')).toBe(6_637_080);
    expect(parseCtripAmount('6637080')).toBe(6_637_080);
  });

  it('fabricates no nightly rates', () => {
    const r = review(REAL, CN5);
    expect(r.nightlyRates).toEqual([]);
    // Emphatically not payout ÷ nights, which would look like a stated figure.
    expect(4_645_956 / 7).toBeCloseTo(663_708, 0);
    expect(r.nightlyRates).toHaveLength(0);
  });
});

/* ================================================================== */
/* Branch and mapping                                                  */
/* ================================================================== */
describe('CTrip branch and mapping', () => {
  it('resolves CN5 Standard Double Room No Window to STAN', () => {
    const r = review(REAL, CN5);
    expect(r.rooms[0]?.pmsCode).toBe('STAN');
    expect(r.rooms[0]?.requiresManualMapping).toBe(false);
  });

  it('resolves CN6 Deluxe Double Room with Window to DEL', () => {
    const text = REAL.replace('Standard Double Room No Window 1', 'Deluxe Double Room with Window 1');
    const r = review(text, CN6);
    expect(r.rooms[0]?.otaRoomName).toBe('Deluxe Double Room with Window');
    expect(r.rooms[0]?.pmsCode).toBe('DEL');
  });

  it('resolves the same alias differently at different branches', () => {
    // "D-D Room" is TWIN at CN5 and DD at CN6. The name alone decides nothing.
    const text = REAL.replace('Standard Double Room No Window 1', 'D-D Room 1');
    expect(review(text, CN5).rooms[0]?.pmsCode).toBe('TWIN');
    expect(review(text, CN6).rooms[0]?.pmsCode).toBe('DD');
  });

  it('resolves nothing before the branch is known', () => {
    const r = review(REAL, null);
    expect(r.rooms[0]?.pmsCode).toBeNull();
    expect(r.rooms[0]?.requiresManualMapping).toBe(true);
    expect(r.requiresManualBranch).toBe(true);
    expect(r.canDispatch).toBe(false);
  });

  it('requires an Admin branch choice when Property is absent', () => {
    const text = REAL.replace('Property name\nKAS Zody Boutique Hotel', '');
    const r = review(text, null);
    expect(r.requiresManualBranch).toBe(true);
    expect(r.blockingReasons).toContain('Chưa chọn chi nhánh.');
  });
});

/* ================================================================== */
/* Breakfast                                                           */
/* ================================================================== */
describe('CTrip breakfast', () => {
  it('is false even though the page has no Meals section', () => {
    expect(REAL).not.toContain('Meals');
    expect(review(REAL, CN5).breakfastIncluded).toBe(false);
  });

  it('cannot be forced to true by an override', () => {
    const r = review(REAL, CN5, { breakfastIncluded: true });
    expect(r.breakfastIncluded).toBe(false);
    expect(r.note).toContain('KHONG AN SANG');
    expect(r.warnings.map((w) => w.code)).not.toContain('OTA_BREAKFAST_TEXT_UNAPPROVED');
  });
});

/* ================================================================== */
/* Payment mode                                                        */
/* ================================================================== */
describe('CTrip payment mode', () => {
  it('is not inferred from "Prepay"', () => {
    expect(REAL).toContain('Payment: Prepay');
    // The mode is always the Admin's explicit choice; the page never sets it.
    expect(review(REAL, CN5).paymentMode).toBe('CN');
    expect(review(REAL, CN5, { paymentMode: 'HOTEL_PAYMENT' }).paymentMode).toBe('HOTEL_PAYMENT');
  });
});

/* ================================================================== */
/* The confirmed reservation, end to end                               */
/* ================================================================== */
describe('confirmed CTrip reservation 1658113703317875', () => {
  it('produces the exact CN note', () => {
    const r = review(REAL, CN5, { paymentMode: 'CN' });
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.canDispatch).toBe(true);
  });

  it('produces the exact hotel-payment note', () => {
    const r = review(REAL, CN5, { paymentMode: 'HOTEL_PAYMENT' });
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN TẠI KHÁCH SẠN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.canDispatch).toBe(true);
  });

  it('reviews every field the Admin screen needs', () => {
    const r = review(REAL, CN5);
    expect(r).toMatchObject({
      source: 'CTRIP',
      branchCode: 'LE_THANH_TON_278',
      bookingCode: '1658113703317875',
      guestName: 'LEE/JENSON HWEE',
      checkIn: '2026-08-01',
      checkOut: '2026-08-08',
      nights: 7,
      branchPrice: 4_645_956,
      guestBookedPrice: 6_637_080,
      breakfastIncluded: false,
      requiresManualBranch: false,
    });
    expect(r.rooms).toEqual([
      {
        quantity: 1,
        otaRoomName: 'Standard Double Room No Window',
        rawOtaRoomName: 'Standard Double Room No Window',
        otaRoomTypeId: null,
        pmsCode: 'STAN',
        requiresManualMapping: false,
        // CTrip states no per-night breakdown, and none is invented.
        sourceNightlyTotal: null,
        perRoomNightlyRate: null,
      },
    ]);
  });

  it('raises no false missing-field warnings', () => {
    const r = review(REAL, CN5);
    expect(r.warnings).toEqual([]);
    expect(r.blockingReasons).toEqual([]);
    expect(r.noteError).toBeNull();
  });
});
