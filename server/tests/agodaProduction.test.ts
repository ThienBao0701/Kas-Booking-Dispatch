/**
 * The Agoda parser's production behaviour: how it FINDS the reservation, and
 * the full set of fields it is expected to return.
 *
 * Two properties are being protected.
 *
 * BLOCK DETECTION IS CONTENT-BASED. A subject line may be absent, forwarded,
 * edited or translated, so it is never consulted. The reservation that carries
 * a complete structure — its own id, a guest, a stay and a rate — is the one
 * parsed. That matters because a document routinely contains several: a mail
 * thread quotes previous bookings, and a partner page lists dozens.
 *
 * NOTHING IS INVENTED OR REPAIRED. Where Agoda's own figures disagree the
 * parser reports at INFO and leaves both values exactly as stated; a silently
 * corrected total would be pasted into the hotel PMS as though Agoda had said it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseAgodaPartnerBooking,
  reservationBlock,
  reservationBlocks,
} from '../src/booking/agodaPartner';

const read = (name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', 'agoda', name), 'utf8');

const THREAD = read('09-amended-thread-two-bookings.txt');
const LIST_PAGE = read('10-list-page-above-reservation.txt');

/* ================================================================== */
/* Block detection without a subject line                              */
/* ================================================================== */
describe('the reservation is found from content, never the subject', () => {
  it('ignores a subject naming a DIFFERENT booking', () => {
    // A forwarded mail keeps the original subject while the body is another
    // reservation entirely. Trusting the subject would parse neither.
    const misleading = THREAD.replace(
      'Agoda Booking ID 1753732591 - AMENDED',
      'Agoda Booking ID 9999999999 - AMENDED',
    );
    expect(parseAgodaPartnerBooking(misleading).bookingId).toBe('1753732591');
  });

  it('works with the subject removed entirely', () => {
    const noSubject = THREAD.split('\n').filter((l) => !l.includes('Agoda Booking ID')).join('\n');
    const p = parseAgodaPartnerBooking(noSubject);
    expect(p.bookingId).toBe('1753732591');
    expect(p.customerFullName).toBe('Mai Tran');
    expect(p.netRate).toBe(3_688_138);
  });

  it('works with a translated subject', () => {
    const translated = THREAD.replace(
      /Agoda Booking ID 1753732591 - AMENDED.*/,
      'Xác Nhận Đặt Phòng Agoda Sửa Đổi',
    );
    expect(parseAgodaPartnerBooking(translated).bookingId).toBe('1753732591');
  });

  it('skips a block that is only a passing mention', () => {
    // A quoted id with no reservation structure is not a reservation.
    const stub = ['Booking ID', 'Mã số đặt phòng', '1700000123', 'Sent from my phone', ''].join('\n');
    const p = parseAgodaPartnerBooking(stub + '\n' + THREAD);
    expect(p.bookingId).toBe('1753732591');
    expect(p.customerFullName).toBe('Mai Tran');
  });

  it('exposes every reservation in the document', () => {
    expect(reservationBlocks(THREAD.split('\n'))).toHaveLength(2);
    expect(reservationBlocks(LIST_PAGE.split('\n'))).toHaveLength(1);
  });
});

/* ================================================================== */
/* A partner LIST page above the reservation                           */
/* ================================================================== */
describe('a reservations list page above the reservation', () => {
  const parsed = parseAgodaPartnerBooking(LIST_PAGE);

  it('does not let the list’s column headers shadow the real fields', () => {
    // The list prints "Property name", "Guest(s)", "Check-in" and "Net rate" as
    // COLUMN HEADERS. Matching those as labels returned the hotel name
    // "Guest(s)" and lost the stay dates completely.
    expect(LIST_PAGE.indexOf('Property name')).toBeLessThan(LIST_PAGE.indexOf('Booking ID'));
    expect(parsed.sourceHotelName).toBe('KAS Zody Boutique Hotel');
    expect(parsed.checkIn).toBe('2026-08-04');
    expect(parsed.checkOut).toBe('2026-08-05');
    expect(parsed.nights).toBe(1);
  });

  it('takes no value from the listed bookings', () => {
    // The list rows carry other reservations' ids, guests and amounts.
    expect(parsed.bookingId).toBe('1756224954');
    expect(parsed.customerFullName).toBe('Nga Đỗ');
    expect(parsed.netRate).toBe(529_537);
    expect(parsed.netRate).not.toBe(4_645_956);
    expect(parsed.netRate).not.toBe(399_422);
  });

  it('still keeps the property header printed above the Booking ID label', () => {
    // A little of what precedes the label belongs to the reservation, so some
    // trailing list rows may come with it. That is harmless: they carry no
    // labels, and the property name is anchored to "(Property ID …)".
    const block = reservationBlock(LIST_PAGE.split('\n')).join('\n');
    expect(block).toContain('KAS Zody Boutique Hotel');
    expect(block).toContain('(Property ID 55198617)');
  });
});

/* ================================================================== */
/* The full field set                                                  */
/* ================================================================== */
describe('every field the review screen needs', () => {
  const parsed = parseAgodaPartnerBooking(LIST_PAGE);

  it('returns the reservation identity and stay', () => {
    expect(parsed).toMatchObject({
      bookingId: '1756224954',
      sourceHotelName: 'KAS Zody Boutique Hotel',
      customerFirstName: 'Nga',
      customerLastName: 'Đỗ',
      customerFullName: 'Nga Đỗ',
      countryOfResidence: 'Vietnam',
      checkIn: '2026-08-04',
      checkOut: '2026-08-05',
      nights: 1,
    });
  });

  it('returns the room line with occupancy and extra beds', () => {
    expect(parsed.roomTypeNormalized).toBe('Superior Double Room');
    expect(parsed.roomQuantity).toBe(1);
    expect(parsed.occupancy).toBe('2 Adults');
    expect(parsed.extraBeds).toBe(0);
    expect(parsed.roomLines).toHaveLength(1);
  });

  it('returns the rates and the nightly rows', () => {
    expect(parsed.netRate).toBe(529_537);
    expect(parsed.referenceSellRate).toBe(875_000);
    expect(parsed.nightlyRates).toEqual([
      { stayDate: '2026-08-04', amount: 529_537, perRoomAmount: 529_537 },
    ]);
  });

  it('returns status, payment type and language', () => {
    expect(parsed.bookingStatus).toBe('CONFIRMED');
    expect(parsed.paymentType).toBe('PREPAID');
    expect(parsed.websiteLanguage).toBe('Vietnamese');
  });

  it('returns the guest-facing text fields', () => {
    expect(parsed.specialRequests).toBe('NonSmoke');
    expect(parsed.benefitsIncluded).toBe('Coffee & tea, Free WiFi, Drinking water');
    expect(parsed.cancellationPolicy).not.toBeNull();
  });

  it('reports an amended confirmation as AMENDED', () => {
    expect(parseAgodaPartnerBooking(THREAD).bookingStatus).toBe('AMENDED');
  });

  it('raises no error-level warning on either layout', () => {
    for (const [name, raw] of [['list page', LIST_PAGE], ['thread', THREAD]] as const) {
      const errors = parseAgodaPartnerBooking(raw).warnings.filter((w) => w.severity === 'ERROR');
      expect(errors, name).toEqual([]);
    }
  });
});

/* ================================================================== */
/* Breakfast and commission                                            */
/* ================================================================== */
describe('business rules that are never inferred', () => {
  it('always reports breakfast as false, whatever the benefits say', () => {
    expect(LIST_PAGE).toContain('Coffee & tea');
    expect(parseAgodaPartnerBooking(LIST_PAGE).breakfastIncluded).toBe(false);

    const withBreakfast = LIST_PAGE.replace('Coffee & tea', 'Breakfast included, Coffee & tea');
    expect(parseAgodaPartnerBooking(withBreakfast).breakfastIncluded).toBe(false);
  });

  it('never takes commission as a rate', () => {
    const parsed = parseAgodaPartnerBooking(LIST_PAGE);
    expect(parsed.netRate).not.toBe(175_000);
    expect(parsed.referenceSellRate).not.toBe(175_000);
  });
});

/* ================================================================== */
/* Consistency is reported, never repaired                             */
/* ================================================================== */
describe('nightly rows against the Net rate', () => {
  it('stays silent when the rows add up', () => {
    const codes = parseAgodaPartnerBooking(LIST_PAGE).warnings.map((w) => w.code);
    expect(codes).not.toContain('AGODA_NIGHTLY_SUM_MISMATCH');
  });

  it('reports a mismatch at INFO and changes neither figure', () => {
    const tampered = LIST_PAGE.replace('August 4, 2026      \tVND 529,537.00', 'August 4, 2026      \tVND 500,000.00');
    const p = parseAgodaPartnerBooking(tampered);

    const mismatch = p.warnings.find((w) => w.code === 'AGODA_NIGHTLY_SUM_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe('INFO');
    // Both values stay exactly as Agoda stated them.
    expect(p.netRate).toBe(529_537);
    expect(p.nightlyRates[0]?.amount).toBe(500_000);
  });
});
